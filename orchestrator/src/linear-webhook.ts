/**
 * Linear webhook handler.
 *
 * All products share one Linear team ("Team Bryan"). Issues are routed
 * to products based on their Linear project name (e.g., "Health Tool" → health-tool).
 *
 * Issues without a project are ignored — the agent needs to know which
 * product/repos to work with.
 */

import { Hono } from "hono";
import { getProductByLinearProject, isOurTeam } from "./registry";
import type { Bindings } from "./types";

const linearWebhook = new Hono<{ Bindings: Bindings }>();

interface LinearWebhookPayload {
  action: string;
  type: string;
  data: {
    id: string;
    title: string;
    description: string;
    priority: number;
    teamId: string;
    labelIds?: string[];
    state?: { name: string };
    assignee?: { name: string };
    project?: { id: string; name: string };
  };
}

linearWebhook.post("/", async (c) => {
  // Verify webhook signature if configured
  const webhookSecret = c.env.LINEAR_WEBHOOK_SECRET;
  let payload: LinearWebhookPayload;

  if (webhookSecret) {
    const signature = c.req.header("Linear-Signature");
    if (!signature) {
      return c.json({ error: "Missing signature" }, 401);
    }

    const rawBody = await c.req.text();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const hexPairs = signature.match(/.{2}/g);
    if (!hexPairs) {
      return c.json({ error: "Malformed signature" }, 401);
    }
    const receivedBytes = new Uint8Array(
      hexPairs.map((b) => parseInt(b, 16)),
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      receivedBytes,
      new TextEncoder().encode(rawBody),
    );
    if (!valid) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    payload = JSON.parse(rawBody) as LinearWebhookPayload;
  } else {
    return c.json({ error: "Webhook not configured" }, 500);
  }

  return handleEvent(payload, c.env);
});

async function handleEvent(payload: LinearWebhookPayload, env: Bindings) {
  // Only handle issues
  if (payload.type !== "Issue") {
    return new Response(JSON.stringify({ ok: true, ignored: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Only trigger on create or status changes to "In Progress"
  const shouldTrigger =
    payload.action === "create" ||
    (payload.action === "update" &&
      payload.data.state?.name === "In Progress");

  if (!shouldTrigger) {
    return new Response(
      JSON.stringify({
        ok: true,
        ignored: true,
        reason: "action not relevant",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Verify this is from our team
  if (!isOurTeam(payload.data.teamId)) {
    return new Response(
      JSON.stringify({ ok: true, ignored: true, reason: "not our team" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Issue must belong to a project so we know which product/repos to use
  const projectName = payload.data.project?.name;
  if (!projectName) {
    return new Response(
      JSON.stringify({
        ok: true,
        ignored: true,
        reason: "no project — cannot determine product",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Look up the product by project name
  const match = getProductByLinearProject(projectName);
  if (!match) {
    return new Response(
      JSON.stringify({
        ok: true,
        ignored: true,
        reason: `unknown project: ${projectName}`,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Forward to Orchestrator DO
  const id = env.ORCHESTRATOR.idFromName("main");
  const orchestrator = env.ORCHESTRATOR.get(id);
  await orchestrator.fetch(new Request("http://internal/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "ticket_created",
      source: "linear",
      ticketId: payload.data.id,
      product: match.name,
      payload: {
        id: payload.data.id,
        title: payload.data.title,
        description: payload.data.description || "",
        priority: payload.data.priority,
        labels: payload.data.labelIds || [],
      },
    }),
  }));

  return new Response(
    JSON.stringify({
      ok: true,
      product: match.name,
      project: projectName,
      ticketId: payload.data.id,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

export { linearWebhook };
