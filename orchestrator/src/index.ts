/**
 * Product Engineer Worker — stateless proxy to Orchestrator DO.
 *
 * Verifies webhook signatures. Proxies events to the singleton Orchestrator DO.
 * No queue, no sandbox launcher. All state lives in the Orchestrator.
 */

import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { linearWebhook, githubWebhook } from "./webhooks";
import type { Bindings } from "./types";

// Export DO classes for wrangler
export { Orchestrator } from "./orchestrator";
export { TicketAgent } from "./ticket-agent";

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return (crypto.subtle as unknown as { timingSafeEqual(a: BufferSource, b: BufferSource): boolean }).timingSafeEqual(bufA, bufB);
}

const app = new Hono<{ Bindings: Bindings }>();

// Reject oversized request bodies (1MB limit)
const MAX_BODY_SIZE = 1024 * 1024;
app.use("*", async (c, next) => {
  const contentLength = c.req.header("Content-Length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return c.json({ error: "Request body too large" }, 413);
  }
  await next();
});

app.get("/health", async (c) => {
  // Wake the Orchestrator DO so its Socket Mode container stays alive
  const orchestrator = getOrchestrator(c.env);
  const doHealth = await orchestrator.fetch(new Request("http://internal/health"));
  const doStatus = await doHealth.json<{ ok: boolean }>();
  return c.json({ ok: true, service: "product-engineer-worker", orchestrator: doStatus });
});

app.route("/api/webhooks/linear", linearWebhook);
app.route("/api/webhooks/github", githubWebhook);

// Dispatch API — programmatic trigger
app.post("/api/dispatch", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json<{
    product: string;
    type: string;
    data: unknown;
    slack_thread_ts?: string;
  }>();

  if (!body.product || !body.type || !body.data) {
    return c.json({ error: "Missing product, type, or data" }, 400);
  }

  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: body.type,
      source: "api",
      ticketId: (body.data as Record<string, unknown>).id || `api-${Date.now()}`,
      product: body.product,
      payload: body.data,
      slackThreadTs: body.slack_thread_ts,
    }),
  }));
});

// Internal: Slack events from orchestrator container's Socket Mode
app.post("/api/internal/slack-event", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || !timingSafeEqual(key, c.env.SLACK_APP_TOKEN)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const event = await c.req.json();
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/slack-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }));
});

// Internal: status updates from agent containers
app.post("/api/internal/status", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || !timingSafeEqual(key, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/ticket/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await c.req.text(),
  }));
});

app.get("/api/orchestrator/tickets", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/tickets"));
});

// Debug: query a specific ticket agent's container status
app.get("/api/agent/:ticketId/status", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const ticketId = c.req.param("ticketId");
  const id = c.env.TICKET_AGENT.idFromName(ticketId);
  const agent = c.env.TICKET_AGENT.get(id);
  return agent.fetch(new Request("http://internal/status"));
});

export function getOrchestrator(env: Bindings): DurableObjectStub {
  const id = env.ORCHESTRATOR.idFromName("main");
  return env.ORCHESTRATOR.get(id);
}

export default Sentry.withSentry(
  (env: Bindings) => ({ dsn: env.SENTRY_DSN }),
  {
    fetch: app.fetch,
    // No-op: absorbs any lingering cron triggers during rollout transitions
    async scheduled() {},
  },
);
