/**
 * Dispatch API — receives task dispatch requests and enqueues them.
 *
 * This is the main entry point for programmatic dispatch from
 * per-product workers (e.g., health-tool's feedback queue).
 *
 * POST /api/dispatch
 * {
 *   "product": "health-tool",
 *   "type": "feedback",
 *   "data": { ... }
 * }
 */

import { Hono } from "hono";
import { getProduct } from "./registry";
import type { Bindings } from "./index";

const dispatch = new Hono<{ Bindings: Bindings }>();

dispatch.post("/", async (c) => {
  // Verify API key
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json<{
    product: string;
    type: "feedback" | "ticket" | "command";
    data: unknown;
    slack_thread_ts?: string;
  }>();

  if (!body.product || !body.type || !body.data) {
    return c.json({ error: "Missing product, type, or data" }, 400);
  }

  const product = getProduct(body.product);
  if (!product) {
    return c.json({ error: `Unknown product: ${body.product}` }, 404);
  }

  // Enqueue the task
  await c.env.TASK_QUEUE.send({
    type: body.type,
    product: body.product,
    data: body.data,
    slack_thread_ts: body.slack_thread_ts,
  });

  return c.json({ ok: true, product: body.product, type: body.type }, 202);
});

// Task status update endpoint (called by the agent)
dispatch.patch("/tasks/:taskId/status", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const taskId = c.req.param("taskId");
  const body = await c.req.json<{
    status: string;
    reason?: string;
    pr_url?: string;
    linear_ticket_id?: string;
  }>();

  // For now, log the status update. Could persist to D1 later.
  console.log(
    `[Dispatch] Task ${taskId} status: ${body.status}`,
    body.reason ? `reason: ${body.reason}` : "",
    body.pr_url ? `pr: ${body.pr_url}` : "",
  );

  return c.json({ ok: true, taskId, status: body.status });
});

export { dispatch };
