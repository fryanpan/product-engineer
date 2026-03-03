import { Container } from "@cloudflare/containers";
import { getProduct, getProducts } from "./registry";
import type { TicketEvent, TicketAgentConfig, Bindings } from "./types";

function sanitizeTicketId(id: string): string {
  return String(id).slice(0, 128).replace(/[^a-zA-Z0-9_\-\.]/g, "_") || `unknown-${Date.now()}`;
}

// Pure helper — exported for testing
export function resolveProductFromChannel(channel: string): string | null {
  const products = getProducts();
  for (const [name, config] of Object.entries(products)) {
    // Match on channel ID (from Socket Mode events) or channel name
    if (config.slack_channel_id === channel || config.slack_channel === channel) {
      return name;
    }
  }
  return null;
}

// Pure helper — exported for testing
export function buildTicketEvent(
  source: string,
  type: string,
  data: Record<string, unknown>,
): TicketEvent {
  return {
    type,
    source,
    ticketId: sanitizeTicketId((data.ticketId || data.id || `${source}-${Date.now()}`) as string),
    product: data.product as string,
    payload: data,
    slackThreadTs: data.threadTs as string | undefined,
    slackChannel: data.channel as string | undefined,
  };
}

export class Orchestrator extends Container<Bindings> {
  defaultPort = 3000;
  // No sleepAfter — always on

  private dbInitialized = false;
  private containerStarted = false;

  constructor(ctx: DurableObjectState, env: Bindings) {
    // @ts-expect-error — DurableObjectState generic mismatch between Container SDK and Workers types
    super(ctx, env);
    // Set envVars in constructor to overwrite the base class field (envVars={}).
    // Using a getter doesn't work — the base class field creates an own property
    // that shadows prototype getters.
    this.envVars = {
      SLACK_APP_TOKEN: (env as any).SLACK_APP_TOKEN,
      SLACK_BOT_TOKEN: (env as any).SLACK_BOT_TOKEN,
      SENTRY_DSN: (env as any).SENTRY_DSN || "",
      WORKER_URL: (env as any).WORKER_URL || "https://product-engineer.fryanpan.workers.dev",
    };
  }

  override onStop(params: { exitCode: number; reason: string }) {
    console.error(`[Orchestrator] Container stopped: exitCode=${params.exitCode} reason=${params.reason}`);
    this.containerStarted = false;
  }

  override onError(error: unknown) {
    console.error("[Orchestrator] Container error:", error);
    throw error;
  }

  // Always-on: when the SDK's alarm loop fires and the container is dead,
  // restart it before handing control to the base class. This ensures the
  // Slack Socket Mode container self-heals after crashes or deployments.
  override async alarm(alarmProps: { isRetry: boolean; retryCount: number }) {
    await this.ensureContainerRunning();
    return super.alarm(alarmProps);
  }

  // Start the Slack Socket Mode container on first request (and after crashes)
  private async ensureContainerRunning() {
    if (this.containerStarted) return;
    await this.startAndWaitForPorts(this.defaultPort);
    this.containerStarted = true;
  }

  private initDb() {
    if (this.dbInitialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        product TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        slack_thread_ts TEXT,
        slack_channel TEXT,
        pr_url TEXT,
        branch_name TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.dbInitialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.initDb();
    // Start the Slack Socket Mode companion container on first request
    await this.ensureContainerRunning();
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/event":
        return this.handleEvent(request);
      case "/health":
        return Response.json({ ok: true, service: "orchestrator-do" });
      case "/tickets":
        return this.listTickets();
      case "/ticket/status":
        return this.handleStatusUpdate(request);
      case "/slack-event":
        return this.handleSlackEvent(request);
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  private async handleEvent(request: Request): Promise<Response> {
    const event = await request.json<TicketEvent>();
    event.ticketId = sanitizeTicketId(event.ticketId);

    // Upsert ticket
    this.ctx.storage.sql.exec(
      `INSERT INTO tickets (id, product, slack_thread_ts, slack_channel)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         slack_thread_ts = COALESCE(excluded.slack_thread_ts, tickets.slack_thread_ts),
         slack_channel = COALESCE(excluded.slack_channel, tickets.slack_channel),
         updated_at = datetime('now')`,
      event.ticketId,
      event.product,
      event.slackThreadTs || null,
      event.slackChannel || null,
    );

    // Route to TicketAgent
    await this.routeToAgent(event);

    return Response.json({ ok: true, ticketId: event.ticketId });
  }

  private async routeToAgent(event: TicketEvent) {
    const productConfig = getProduct(event.product);
    if (!productConfig) {
      console.error(`[Orchestrator] Unknown product: ${event.product}`);
      return;
    }

    const id = this.env.TICKET_AGENT.idFromName(event.ticketId);
    const agent = this.env.TICKET_AGENT.get(id) as DurableObjectStub;

    const config: TicketAgentConfig = {
      ticketId: event.ticketId,
      product: event.product,
      repos: productConfig.repos,
      slackChannel: productConfig.slack_channel,
      secrets: productConfig.secrets,
    };

    const initRes = await agent.fetch(new Request("http://internal/initialize", {
      method: "POST",
      body: JSON.stringify(config),
    }));

    if (!initRes.ok) {
      console.error(`[Orchestrator] Failed to initialize agent for ${event.ticketId}: ${initRes.status}`);
      return;
    }

    // Retry event delivery with backoff for cold starts
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const eventRes = await agent.fetch(new Request("http://internal/event", {
        method: "POST",
        body: JSON.stringify(event),
      }));
      lastStatus = eventRes.status;

      if (eventRes.ok) return;
      if (eventRes.status !== 503) {
        console.error(`[Orchestrator] Agent event delivery failed for ${event.ticketId}: ${eventRes.status}`);
        return;
      }

      // Container not ready, wait and retry
      console.warn(`[Orchestrator] Agent container not ready for ${event.ticketId}, retrying (${attempt + 1}/3)...`);
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }

    console.error(`[Orchestrator] Agent event delivery failed after retries for ${event.ticketId}: ${lastStatus}`);
  }

  private async handleStatusUpdate(request: Request): Promise<Response> {
    const { ticketId, status, pr_url, branch_name, slack_thread_ts } = await request.json<{
      ticketId: string;
      status?: string;
      pr_url?: string;
      branch_name?: string;
      slack_thread_ts?: string;
    }>();

    // Log phone-home payloads so they appear in wrangler tail
    console.log(`[Orchestrator] status update: ticket=${ticketId} status=${status} branch=${branch_name || ""}`);

    const updates: string[] = ["updated_at = datetime('now')"];
    const values: (string | null)[] = [];

    if (status) {
      updates.push("status = ?");
      values.push(status);
    }
    if (pr_url) {
      updates.push("pr_url = ?");
      values.push(pr_url);
    }
    if (branch_name) {
      updates.push("branch_name = ?");
      values.push(branch_name);
    }
    if (slack_thread_ts) {
      updates.push("slack_thread_ts = ?");
      values.push(slack_thread_ts);
    }

    values.push(ticketId);
    this.ctx.storage.sql.exec(
      `UPDATE tickets SET ${updates.join(", ")} WHERE id = ?`,
      ...values,
    );

    return Response.json({ ok: true });
  }

  private listTickets(): Response {
    const rows = this.ctx.storage.sql.exec(
      "SELECT * FROM tickets ORDER BY updated_at DESC LIMIT 50",
    ).toArray();
    return Response.json({ tickets: rows });
  }

  private async handleSlackEvent(request: Request): Promise<Response> {
    const slackEvent = await request.json<{
      type: string;
      text?: string;
      user?: string;
      channel?: string;
      thread_ts?: string;
      ts?: string;
    }>();

    // If it's a thread reply, look up existing ticket by thread_ts
    if (slackEvent.thread_ts) {
      const rows = this.ctx.storage.sql.exec(
        "SELECT id, product FROM tickets WHERE slack_thread_ts = ?",
        slackEvent.thread_ts,
      ).toArray() as { id: string; product: string }[];

      if (rows.length > 0) {
        const ticket = rows[0];
        const event: TicketEvent = {
          type: "slack_reply",
          source: "slack",
          ticketId: ticket.id,
          product: ticket.product,
          payload: slackEvent,
          slackThreadTs: slackEvent.thread_ts,
          slackChannel: slackEvent.channel,
        };
        await this.routeToAgent(event);
        return Response.json({ ok: true, ticketId: ticket.id });
      }
    }

    // Only create tickets from app_mention events
    if (slackEvent.type !== "app_mention") {
      return Response.json({ ok: true, ignored: true, reason: "not an app mention" });
    }

    // New mention — resolve product from channel
    const product = this.resolveProductFromChannel(slackEvent.channel || "");
    if (!product) {
      console.warn(`[Orchestrator] No product mapped to channel ${slackEvent.channel}`);
      return Response.json({ error: "no product for channel" }, { status: 404 });
    }

    const ticketId = sanitizeTicketId(`slack-${slackEvent.ts || Date.now()}`);
    const event: TicketEvent = {
      type: "slack_mention",
      source: "slack",
      ticketId,
      product,
      payload: slackEvent,
      slackThreadTs: slackEvent.ts, // Use the message ts as thread ts for future replies
      slackChannel: slackEvent.channel,
    };

    // Use handleEvent which does upsert + route
    return this.handleEvent(new Request("http://internal/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }));
  }

  private resolveProductFromChannel(channel: string): string | null {
    return resolveProductFromChannel(channel);
  }
}
