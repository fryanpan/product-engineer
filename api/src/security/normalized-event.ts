/**
 * NormalizedEvent envelope — a uniform wrapper for all webhook events.
 * Validates required fields and scans free-text for injection before accepting.
 */

import { scanEventFields, type FieldDetection } from "./injection-detector";

export interface NormalizedEvent {
  id: string;
  source: "slack" | "linear" | "github" | "heartbeat" | "internal";
  type: string;
  product?: string;
  timestamp: string;
  actor?: { id: string; name: string };
  payload: unknown;
  raw_hash: string;
}

type NormalizeResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; error: string; detections?: FieldDetection[] };

// --- Helpers ---

async function hashPayload(data: unknown): Promise<string> {
  const str = JSON.stringify(data);
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(str));
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateId(): string {
  return crypto.randomUUID();
}

function checkInjection(data: unknown): FieldDetection[] {
  return scanEventFields(data);
}

async function makeEvent(
  source: NormalizedEvent["source"],
  type: string,
  raw: unknown,
  actor?: { id: string; name: string },
  product?: string,
): Promise<NormalizedEvent> {
  return {
    id: generateId(),
    source,
    type,
    product,
    timestamp: new Date().toISOString(),
    actor,
    payload: raw,
    raw_hash: await hashPayload(raw),
  };
}

// --- Normalizers ---

/**
 * Normalize a Slack event (app_mention, message, etc.)
 * Required fields: type, user, text, ts
 */
export async function normalizeSlackEvent(raw: Record<string, unknown>, product?: string): Promise<NormalizeResult> {
  // Validate required fields
  if (!raw.type || !raw.user || !raw.text || !raw.ts) {
    return { ok: false, error: "Missing required Slack fields: type, user, text, ts" };
  }

  // Scan the entire payload for injection (covers text, blocks, attachments, file titles)
  const detections = checkInjection(raw);
  if (detections.length > 0) {
    return {
      ok: false,
      error: `Slack event rejected: injection detected in ${detections.map((d) => d.field).join(", ")}`,
      detections,
    };
  }

  const event = await makeEvent(
    "slack",
    raw.type as string,
    raw,
    { id: raw.user as string, name: raw.user as string },
    product,
  );

  return { ok: true, event };
}

/**
 * Normalize a Linear webhook event (Issue or Comment).
 * Required fields: action, type, data (with id)
 */
export async function normalizeLinearEvent(raw: Record<string, unknown>, product?: string): Promise<NormalizeResult> {
  if (!raw.action || !raw.type || !raw.data) {
    return { ok: false, error: "Missing required Linear fields: action, type, data" };
  }

  const data = raw.data as Record<string, unknown>;
  if (!data.id) {
    return { ok: false, error: "Missing required Linear field: data.id" };
  }

  // Scan free-text fields: title, description, body (for comments)
  const fieldsToScan: Record<string, unknown> = {};
  if (typeof data.title === "string") fieldsToScan.title = data.title;
  if (typeof data.description === "string") fieldsToScan.description = data.description;
  if (typeof data.body === "string") fieldsToScan.body = data.body;

  const detections = checkInjection(fieldsToScan);
  if (detections.length > 0) {
    return {
      ok: false,
      error: `Linear event rejected: injection detected in ${detections.map((d) => d.field).join(", ")}`,
      detections,
    };
  }

  // Extract actor from assignee or user
  let actor: { id: string; name: string } | undefined;
  const assignee = data.assignee as Record<string, unknown> | undefined;
  const user = data.user as Record<string, unknown> | undefined;
  if (assignee?.id && assignee?.name) {
    actor = { id: assignee.id as string, name: assignee.name as string };
  } else if (user?.id && user?.name) {
    actor = { id: user.id as string, name: user.name as string };
  }

  const event = await makeEvent(
    "linear",
    `${raw.type}.${raw.action}`,
    raw,
    actor,
    product,
  );

  return { ok: true, event };
}

/**
 * Normalize a GitHub webhook event.
 * Required fields: action, sender (with login & id)
 * The githubEventType comes from the X-GitHub-Event header.
 */
export async function normalizeGitHubEvent(
  githubEventType: string,
  raw: Record<string, unknown>,
  product?: string,
): Promise<NormalizeResult> {
  if (!raw.action) {
    return { ok: false, error: "Missing required GitHub field: action" };
  }

  const sender = raw.sender as Record<string, unknown> | undefined;
  if (!sender?.login || sender?.id === undefined) {
    return { ok: false, error: "Missing required GitHub field: sender (login, id)" };
  }

  // Scan free-text fields that exist in different event types
  const fieldsToScan: Record<string, unknown> = {};

  // PR review body
  const review = raw.review as Record<string, unknown> | undefined;
  if (typeof review?.body === "string") fieldsToScan["review.body"] = review.body;

  // Comment body
  const comment = raw.comment as Record<string, unknown> | undefined;
  if (typeof comment?.body === "string") fieldsToScan["comment.body"] = comment.body;

  // PR title/body
  const pr = raw.pull_request as Record<string, unknown> | undefined;
  if (typeof pr?.title === "string") fieldsToScan["pull_request.title"] = pr.title;
  if (typeof pr?.body === "string") fieldsToScan["pull_request.body"] = pr.body;

  const detections = checkInjection(fieldsToScan);
  if (detections.length > 0) {
    return {
      ok: false,
      error: `GitHub event rejected: injection detected in ${detections.map((d) => d.field).join(", ")}`,
      detections,
    };
  }

  const event = await makeEvent(
    "github",
    `${githubEventType}.${raw.action}`,
    raw,
    { id: String(sender.id), name: sender.login as string },
    product,
  );

  return { ok: true, event };
}
