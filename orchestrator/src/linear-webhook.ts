/**
 * Linear webhook handler.
 *
 * Receives Linear webhook events, matches them to products via team ID,
 * and dispatches agent tasks for new/updated issues.
 */

import { Hono } from "hono";
import { getProductByLinearTeam } from "./registry";
import type { Bindings } from "./index";

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
  };
}

linearWebhook.post("/", async (c) => {
  // Verify webhook signature if configured
  const webhookSecret = c.env.LINEAR_WEBHOOK_SECRET;
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
    const receivedBytes = new Uint8Array(
      signature.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
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

    // Parse from already-read body
    const payload = JSON.parse(rawBody) as LinearWebhookPayload;
    return handleEvent(payload, c.env);
  }

  const payload = await c.req.json<LinearWebhookPayload>();
  return handleEvent(payload, c.env);
});

async function handleEvent(payload: LinearWebhookPayload, env: Bindings) {
  // Only handle issue creation and updates
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
      JSON.stringify({ ok: true, ignored: true, reason: "action not relevant" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Look up which product this belongs to
  const match = getProductByLinearTeam(payload.data.teamId);
  if (!match) {
    return new Response(
      JSON.stringify({ ok: true, ignored: true, reason: "unknown team" }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Enqueue the task
  const taskMessage = {
    type: "ticket" as const,
    product: match.name,
    data: {
      id: payload.data.id,
      title: payload.data.title,
      description: payload.data.description || "",
      priority: payload.data.priority,
      labels: payload.data.labelIds || [],
    },
  };

  const queue = env.TASK_QUEUE;
  await queue.send(taskMessage);

  return new Response(
    JSON.stringify({
      ok: true,
      product: match.name,
      ticketId: payload.data.id,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

export { linearWebhook };
