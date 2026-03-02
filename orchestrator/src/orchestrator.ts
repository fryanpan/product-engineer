import { Container } from "@cloudflare/containers";
import { getProduct, getProducts } from "./registry";
import type { TicketEvent, TicketAgentConfig, Bindings } from "./types";

// Pure helper — exported for testing
export function buildTicketEvent(
  source: string,
  type: string,
  data: Record<string, unknown>,
): TicketEvent {
  return {
    type,
    source,
    ticketId: (data.ticketId || data.id || `${source}-${Date.now()}`) as string,
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

  get envVars() {
    return {
      SLACK_APP_TOKEN: this.env.SLACK_APP_TOKEN,
      SLACK_BOT_TOKEN: this.env.SLACK_BOT_TOKEN,
      SENTRY_DSN: this.env.SENTRY_DSN || "",
      WORKER_URL: this.env.WORKER_URL || "https://product-engineer.fryanpan.workers.dev",
    };
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

    // Upsert ticket
    this.ctx.storage.sql.exec(
      `INSERT INTO tickets (id, product, slack_thread_ts, slack_channel)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')`,
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

    await agent.fetch(new Request("http://internal/initialize", {
      method: "POST",
      body: JSON.stringify(config),
    }));

    await agent.fetch(new Request("http://internal/event", {
      method: "POST",
      body: JSON.stringify(event),
    }));
  }

  private async handleStatusUpdate(request: Request): Promise<Response> {
    const { ticketId, status, pr_url, branch_name } = await request.json<{
      ticketId: string;
      status: string;
      pr_url?: string;
      branch_name?: string;
    }>();

    const updates: string[] = ["status = ?", "updated_at = datetime('now')"];
    const values: (string | null)[] = [status];

    if (pr_url) {
      updates.push("pr_url = ?");
      values.push(pr_url);
    }
    if (branch_name) {
      updates.push("branch_name = ?");
      values.push(branch_name);
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

    // New mention — resolve product from channel
    const product = this.resolveProductFromChannel(slackEvent.channel || "");
    if (!product) {
      console.warn(`[Orchestrator] No product mapped to channel ${slackEvent.channel}`);
      return Response.json({ error: "no product for channel" }, { status: 404 });
    }

    const ticketId = `slack-${slackEvent.ts || Date.now()}`;
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
    const products = getProducts();
    for (const [name, config] of Object.entries(products)) {
      // Match on channel ID (from Socket Mode events) or channel name
      if (config.slack_channel_id === channel || config.slack_channel === channel) {
        return name;
      }
    }
    return null;
  }
}
