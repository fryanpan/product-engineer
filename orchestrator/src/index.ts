/**
 * Product Engineer Worker — stateless proxy to Orchestrator DO.
 *
 * Verifies webhook signatures. Proxies events to the singleton Orchestrator DO.
 * No queue, no sandbox launcher. All state lives in the Orchestrator.
 */

import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { linearWebhook, githubWebhook } from "./webhooks";
import { dashboardRouter } from "./dashboard";
import type { Bindings } from "./types";
import { authHandlers, requireAuth } from "./auth";
import dashboardHTML from "./dashboard.html";

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

app.route("/dashboard", dashboardRouter);
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

// Internal: token usage reports from agent containers
app.post("/api/internal/token-usage", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || !timingSafeEqual(key, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/token-usage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await c.req.text(),
  }));
});

// Internal: heartbeat from agent containers
app.post("/api/orchestrator/heartbeat", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || !timingSafeEqual(key, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/heartbeat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await c.req.text(),
  }));
});

// Internal: transcript upload from agent containers
app.post("/api/internal/upload-transcript", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || !timingSafeEqual(key, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { ticketId, r2Key, transcript } = await c.req.json<{
    ticketId: string;
    r2Key: string;
    transcript: string;
  }>();

  try {
    // Upload to R2
    await c.env.TRANSCRIPTS.put(r2Key, transcript, {
      httpMetadata: { contentType: "application/x-ndjson" },
      customMetadata: { ticketId, uploadedAt: new Date().toISOString() },
    });

    // Update ticket record with R2 key
    const orchestrator = getOrchestrator(c.env);
    await orchestrator.fetch(new Request("http://internal/ticket/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticketId, transcript_r2_key: r2Key }),
    }));

    console.log(`[Worker] Transcript uploaded: ticket=${ticketId} key=${r2Key} size=${transcript.length}`);
    return c.json({ ok: true, r2Key });
  } catch (err) {
    console.error("[Worker] Transcript upload failed:", err);
    return c.json({ error: String(err) }, 500);
  }
});

app.get("/api/orchestrator/tickets", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/tickets"));
});

// API: list transcripts
app.get("/api/transcripts", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const limit = parseInt(c.req.query("limit") || "50", 10);
  const sinceHours = c.req.query("sinceHours") ? parseInt(c.req.query("sinceHours")!, 10) : undefined;

  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request(`http://internal/transcripts?limit=${limit}${sinceHours ? `&sinceHours=${sinceHours}` : ""}`));
});

// API: fetch a specific transcript
app.get("/api/transcripts/:r2Key", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const r2Key = decodeURIComponent(c.req.param("r2Key"));
  try {
    const obj = await c.env.TRANSCRIPTS.get(r2Key);
    if (!obj) {
      return c.json({ error: "Transcript not found" }, 404);
    }

    const transcript = await obj.text();
    return new Response(transcript, {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  } catch (err) {
    console.error("[Worker] Transcript fetch failed:", err);
    return c.json({ error: String(err) }, 500);
  }
});

// Internal: check orchestrator ticket state (used by agent auto-resume)
app.get("/api/orchestrator/ticket-status/:ticketId", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || !timingSafeEqual(key, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const ticketId = c.req.param("ticketId");
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request(`http://internal/ticket-status/${encodeURIComponent(ticketId)}`));
});

// Internal: drain buffered events from a ticket agent (called by agent on session start)
app.get("/api/agent/:ticketId/drain-events", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || !timingSafeEqual(key, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const ticketId = c.req.param("ticketId");
  const id = c.env.TICKET_AGENT.idFromName(ticketId);
  const agent = c.env.TICKET_AGENT.get(id);
  return agent.fetch(new Request("http://internal/drain-events"));
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

// Products API: list all products
app.get("/api/products", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/products"));
});

// Products API: get single product
app.get("/api/products/:slug", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const slug = c.req.param("slug");
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request(`http://internal/products/${slug}`));
});

// Products API: create product
app.post("/api/products", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await c.req.text(),
  }));
});

// Products API: update product
app.put("/api/products/:slug", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const slug = c.req.param("slug");
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request(`http://internal/products/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: await c.req.text(),
  }));
});

// Products API: delete product
app.delete("/api/products/:slug", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const slug = c.req.param("slug");
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request(`http://internal/products/${slug}`, {
    method: "DELETE",
  }));
});

// Products API: seed from old registry.json format
app.post("/api/products/seed", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/products/seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await c.req.text(),
  }));
});

// Settings API: list all settings
app.get("/api/settings", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/settings"));
});

// Settings API: update a setting
app.put("/api/settings/:key", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const key = c.req.param("key");
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request(`http://internal/settings/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: await c.req.text(),
  }));
});

// Orchestrator: system status
app.get("/api/orchestrator/status", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/status"));
});

// Orchestrator: cleanup inactive agents
app.post("/api/orchestrator/cleanup-inactive", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/cleanup-inactive", {
    method: "POST",
  }));
});

// Orchestrator: shutdown all agents (emergency stop)
app.post("/api/orchestrator/shutdown-all", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/shutdown-all", {
    method: "POST",
  }));
});

// === Dashboard & Auth ===

// Auth routes
app.get("/api/auth/login", authHandlers.login);
app.get("/api/auth/callback", authHandlers.callback);
app.get("/api/auth/user", authHandlers.user);
app.post("/api/auth/logout", authHandlers.logout);

// Dashboard UI
app.get("/dashboard", async (c) => {
  const authResult = await requireAuth(c);
  if (authResult instanceof Response) return authResult;

  return c.html(dashboardHTML);
});

// Dashboard API: list active agents
app.get("/api/dashboard/agents", async (c) => {
  const authResult = await requireAuth(c);
  if (authResult instanceof Response) return authResult;

  const orchestrator = getOrchestrator(c.env);
  const response = await orchestrator.fetch(new Request("http://internal/status"));
  const data = await response.json<{
    activeAgents: Array<{
      id: string;
      product: string;
      status: string;
      last_heartbeat: string | null;
      created_at: string;
      updated_at: string;
      pr_url: string | null;
      branch_name: string | null;
      slack_thread_ts: string | null;
      slack_channel: string | null;
    }>;
  }>();

  return c.json({ agents: data.activeAgents });
});

// Dashboard API: kill a specific agent
app.post("/api/dashboard/agents/:ticketId/kill", async (c) => {
  const authResult = await requireAuth(c);
  if (authResult instanceof Response) return authResult;

  const ticketId = c.req.param("ticketId");

  // Mark agent as inactive in orchestrator
  const orchestrator = getOrchestrator(c.env);
  const statusResponse = await orchestrator.fetch(new Request("http://internal/ticket/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticketId, agent_active: 0 }),
  }));

  // If the orchestrator failed to mark the agent inactive, abort shutdown
  if (!statusResponse.ok) {
    let errorBody: string | undefined;
    try {
      errorBody = await statusResponse.text();
    } catch {
      // ignore body parsing errors
    }

    return c.json(
      {
        ok: false,
        ticketId,
        error: "Failed to mark agent inactive in orchestrator",
        status: statusResponse.status,
        body: errorBody,
      },
      502,
    );
  }

  // Request shutdown of the container
  const id = c.env.TICKET_AGENT.idFromName(ticketId);
  const agent = c.env.TICKET_AGENT.get(id);
  await agent.fetch(new Request("http://internal/mark-terminal", {
    method: "POST",
  }));

  return c.json({ ok: true, ticketId });
});

// Dashboard API: kill all agents
app.post("/api/dashboard/agents/shutdown-all", async (c) => {
  const authResult = await requireAuth(c);
  if (authResult instanceof Response) return authResult;

  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/shutdown-all", {
    method: "POST",
  }));
});

export function getOrchestrator(env: Bindings): DurableObjectStub {
  const id = env.ORCHESTRATOR.idFromName("main");
  return env.ORCHESTRATOR.get(id);
}

export default Sentry.withSentry(
  (env: Bindings) => ({ dsn: env.SENTRY_DSN }),
  {
    fetch: app.fetch,
  },
);
