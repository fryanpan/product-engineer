/**
 * Product Engineer Worker — stateless proxy to Orchestrator DO.
 *
 * Verifies webhook signatures. Proxies events to the singleton Orchestrator DO.
 * No queue, no sandbox launcher. All state lives in the Orchestrator.
 */

import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { linearWebhook } from "./linear-webhook";
import { githubWebhook } from "./github-webhook";
import type { Bindings } from "./types";

// Export DO classes for wrangler
export { Orchestrator } from "./orchestrator";
export { TicketAgent } from "./ticket-agent";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ ok: true, service: "product-engineer-worker" }));

app.route("/api/webhooks/linear", linearWebhook);
app.route("/api/webhooks/github", githubWebhook);

// Dispatch API — programmatic trigger
app.post("/api/dispatch", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.API_KEY) {
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
  if (!key || key !== c.env.SLACK_APP_TOKEN) {
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

app.get("/api/orchestrator/tickets", async (c) => {
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/tickets"));
});

export function getOrchestrator(env: Bindings): DurableObjectStub {
  const id = env.ORCHESTRATOR.idFromName("main");
  return env.ORCHESTRATOR.get(id);
}

export default Sentry.withSentry(
  (env: Bindings) => ({ dsn: env.SENTRY_DSN }),
  { fetch: app.fetch },
);
