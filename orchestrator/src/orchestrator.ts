import { Container } from "@cloudflare/containers";
import type { TicketEvent, TicketAgentConfig, Bindings } from "./types";
import type { ProductConfig } from "./registry";

function sanitizeTicketId(id: string): string {
  return String(id).slice(0, 128).replace(/[^a-zA-Z0-9_\-\.]/g, "_") || `unknown-${Date.now()}`;
}

// Pure helper — exported for testing
export function resolveProductFromChannel(
  products: Record<string, ProductConfig>,
  channel: string,
): string | null {
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
      WORKER_URL: (env as any).WORKER_URL || (() => { console.error("[Orchestrator] WORKER_URL not configured — run: wrangler secret put WORKER_URL"); return ""; })(),
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

  // Start the Slack Socket Mode container on first request (and after crashes/deploys).
  // Verifies the container is actually responsive — the in-memory flag alone isn't
  // reliable across deploys (the flag survives but the container gets replaced).
  private async ensureContainerRunning() {
    if (this.containerStarted) {
      try {
        // Container handle exists at runtime (from Container SDK) but isn't in Workers types
        const port = (this.ctx as any).container.getTcpPort(this.defaultPort);
        const res = await port.fetch("http://localhost/health", { signal: AbortSignal.timeout(2000) }) as Response;
        if (res.ok) return;
      } catch {
        console.warn("[Orchestrator] Container flag was set but container is not responsive — restarting");
        this.containerStarted = false;
      }
    }

    console.log("[Orchestrator] Starting container (deployment or first start)...");
    try {
      await this.startAndWaitForPorts(this.defaultPort);
      this.containerStarted = true;
      console.log("[Orchestrator] Container started successfully");
    } catch (err) {
      console.error("[Orchestrator] Container start failed:", err);
      throw err;
    }
  }

  private initDb() {
    if (this.dbInitialized) return;

    // Tickets table
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
        updated_at TEXT DEFAULT (datetime('now')),
        agent_active INTEGER NOT NULL DEFAULT 1,
        last_heartbeat TEXT,
        transcript_r2_key TEXT
      )
    `);

    // Products table
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS products (
        slug TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Settings table
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Migration: add agent_active column for existing deployments
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tickets ADD COLUMN agent_active INTEGER NOT NULL DEFAULT 1`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (!message.includes("duplicate column") && !message.includes("already exists")) {
        console.error("[Orchestrator] Failed to add agent_active column:", err);
        throw err;
      }
    }
    // Migration: add last_heartbeat column for monitoring
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tickets ADD COLUMN last_heartbeat TEXT`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (!message.includes("duplicate column") && !message.includes("already exists")) {
        console.error("[Orchestrator] Failed to add last_heartbeat column:", err);
        throw err;
      }
    }
    // Migration: add transcript_r2_key column for transcript storage
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tickets ADD COLUMN transcript_r2_key TEXT`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (!message.includes("duplicate column") && !message.includes("already exists")) {
        console.error("[Orchestrator] Failed to add transcript_r2_key column:", err);
        throw err;
      }
    }
    this.dbInitialized = true;
  }

  // --- Product registry CRUD methods ---

  private listProducts(): Response {
    const rows = this.ctx.storage.sql.exec(
      "SELECT slug, config, updated_at FROM products ORDER BY slug",
    ).toArray() as Array<{ slug: string; config: string; updated_at: string }>;

    const products = rows.reduce((acc, row) => {
      acc[row.slug] = JSON.parse(row.config);
      return acc;
    }, {} as Record<string, unknown>);

    return Response.json({ products });
  }

  private getProduct(request: Request): Response {
    const url = new URL(request.url);
    const slug = url.pathname.split("/").pop();
    if (!slug) {
      return Response.json({ error: "Missing slug" }, { status: 400 });
    }

    const rows = this.ctx.storage.sql.exec(
      "SELECT config FROM products WHERE slug = ?",
      slug,
    ).toArray() as Array<{ config: string }>;

    if (rows.length === 0) {
      return Response.json({ error: "Product not found" }, { status: 404 });
    }

    return Response.json({ product: JSON.parse(rows[0].config) });
  }

  private async createProduct(request: Request): Promise<Response> {
    const { slug, config } = await request.json<{ slug: string; config: unknown }>();

    if (!slug || !config) {
      return Response.json({ error: "Missing slug or config" }, { status: 400 });
    }

    try {
      this.ctx.storage.sql.exec(
        "INSERT INTO products (slug, config) VALUES (?, ?)",
        slug,
        JSON.stringify(config),
      );
      return Response.json({ ok: true, slug });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE constraint")) {
        return Response.json({ error: "Product already exists" }, { status: 409 });
      }
      return Response.json({ error: message }, { status: 500 });
    }
  }

  private async updateProduct(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const slug = url.pathname.split("/").pop();
    if (!slug) {
      return Response.json({ error: "Missing slug" }, { status: 400 });
    }

    const { config } = await request.json<{ config: unknown }>();
    if (!config) {
      return Response.json({ error: "Missing config" }, { status: 400 });
    }

    this.ctx.storage.sql.exec(
      "UPDATE products SET config = ?, updated_at = datetime('now') WHERE slug = ?",
      JSON.stringify(config),
      slug,
    );

    const rows = this.ctx.storage.sql.exec(
      "SELECT changes() as count",
    ).toArray() as Array<{ count: number }>;

    if (rows[0].count === 0) {
      return Response.json({ error: "Product not found" }, { status: 404 });
    }

    return Response.json({ ok: true, slug });
  }

  private deleteProduct(request: Request): Response {
    const url = new URL(request.url);
    const slug = url.pathname.split("/").pop();
    if (!slug) {
      return Response.json({ error: "Missing slug" }, { status: 400 });
    }

    this.ctx.storage.sql.exec("DELETE FROM products WHERE slug = ?", slug);

    const rows = this.ctx.storage.sql.exec(
      "SELECT changes() as count",
    ).toArray() as Array<{ count: number }>;

    if (rows[0].count === 0) {
      return Response.json({ error: "Product not found" }, { status: 404 });
    }

    return Response.json({ ok: true, slug });
  }

  private listSettings(): Response {
    const rows = this.ctx.storage.sql.exec(
      "SELECT key, value FROM settings ORDER BY key",
    ).toArray() as Array<{ key: string; value: string }>;

    const settings = rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {} as Record<string, string>);

    return Response.json({ settings });
  }

  private async updateSetting(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname.split("/").pop();
    if (!key) {
      return Response.json({ error: "Missing key" }, { status: 400 });
    }

    const { value } = await request.json<{ value: string }>();
    if (value === undefined || value === null) {
      return Response.json({ error: "Missing value" }, { status: 400 });
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      key,
      value,
    );

    return Response.json({ ok: true, key, value });
  }

  private async seedProducts(request: Request): Promise<Response> {
    const registry = await request.json<{
      linear_team_id?: string;
      agent_linear_email?: string;
      agent_linear_name?: string;
      cloudflare_ai_gateway?: { account_id: string; gateway_id: string };
      products: Record<string, unknown>;
    }>();

    let productsCreated = 0;
    let productsUpdated = 0;
    let settingsUpdated = 0;

    // Insert global settings
    if (registry.linear_team_id) {
      this.ctx.storage.sql.exec(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        "linear_team_id",
        registry.linear_team_id,
      );
      settingsUpdated++;
    }
    if (registry.agent_linear_email) {
      this.ctx.storage.sql.exec(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        "agent_linear_email",
        registry.agent_linear_email,
      );
      settingsUpdated++;
    }
    if (registry.agent_linear_name) {
      this.ctx.storage.sql.exec(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        "agent_linear_name",
        registry.agent_linear_name,
      );
      settingsUpdated++;
    }
    if (registry.cloudflare_ai_gateway) {
      this.ctx.storage.sql.exec(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        "cloudflare_ai_gateway",
        JSON.stringify(registry.cloudflare_ai_gateway),
      );
      settingsUpdated++;
    }

    // Insert products
    for (const [slug, config] of Object.entries(registry.products)) {
      const existing = this.ctx.storage.sql.exec(
        "SELECT 1 FROM products WHERE slug = ?",
        slug,
      ).toArray();

      if (existing.length > 0) {
        this.ctx.storage.sql.exec(
          "UPDATE products SET config = ?, updated_at = datetime('now') WHERE slug = ?",
          JSON.stringify(config),
          slug,
        );
        productsUpdated++;
      } else {
        this.ctx.storage.sql.exec(
          "INSERT INTO products (slug, config) VALUES (?, ?)",
          slug,
          JSON.stringify(config),
        );
        productsCreated++;
      }
    }

    return Response.json({
      ok: true,
      products_created: productsCreated,
      products_updated: productsUpdated,
      settings_updated: settingsUpdated,
    });
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
      case "/heartbeat":
        return this.handleHeartbeat(request);
      case "/check-health":
        return this.checkAgentHealth();
      case "/transcripts":
        return this.listTranscripts(request);
      case "/products":
        return request.method === "GET" ? this.listProducts() : this.createProduct(request);
      case "/settings":
        return this.listSettings();
      default:
        // Handle dynamic routes
        if (url.pathname.startsWith("/products/")) {
          if (url.pathname === "/products/seed") {
            return this.seedProducts(request);
          }
          if (request.method === "GET") return this.getProduct(request);
          if (request.method === "PUT") return this.updateProduct(request);
          if (request.method === "DELETE") return this.deleteProduct(request);
        }
        if (url.pathname.startsWith("/settings/")) {
          if (request.method === "PUT") return this.updateSetting(request);
        }
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  private async handleEvent(request: Request): Promise<Response> {
    const event = await request.json<TicketEvent>();
    event.ticketId = sanitizeTicketId(event.ticketId);

    // Upsert ticket — re-activate agent on new events (handles re-assignment after
    // the health monitor marked a stuck ticket inactive)
    this.ctx.storage.sql.exec(
      `INSERT INTO tickets (id, product, slack_thread_ts, slack_channel)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         slack_thread_ts = COALESCE(excluded.slack_thread_ts, tickets.slack_thread_ts),
         slack_channel = COALESCE(excluded.slack_channel, tickets.slack_channel),
         agent_active = 1,
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
    // Check if agent is still active (not in terminal state)
    const ticket = this.ctx.storage.sql.exec(
      "SELECT agent_active, status FROM tickets WHERE id = ?",
      event.ticketId,
    ).toArray()[0] as { agent_active: number; status: string } | undefined;

    if (ticket && ticket.agent_active === 0) {
      console.log(`[Orchestrator] Skipping inactive agent for ${event.ticketId} (status: ${ticket.status})`);
      return;
    }

    // Load product config from database
    const productRows = this.ctx.storage.sql.exec(
      "SELECT config FROM products WHERE slug = ?",
      event.product,
    ).toArray() as Array<{ config: string }>;

    if (productRows.length === 0) {
      console.error(`[Orchestrator] Unknown product: ${event.product}`);
      return;
    }

    const productConfig = JSON.parse(productRows[0].config) as ProductConfig;

    const id = this.env.TICKET_AGENT.idFromName(event.ticketId);
    const agent = this.env.TICKET_AGENT.get(id) as DurableObjectStub;

    const config: TicketAgentConfig = {
      ticketId: event.ticketId,
      product: event.product,
      repos: productConfig.repos,
      slackChannel: productConfig.slack_channel_id || productConfig.slack_channel,
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
    const { ticketId, status, pr_url, branch_name, slack_thread_ts, transcript_r2_key } = await request.json<{
      ticketId: string;
      status?: string;
      pr_url?: string;
      branch_name?: string;
      slack_thread_ts?: string;
      transcript_r2_key?: string;
    }>();

    // Log phone-home payloads so they appear in wrangler tail
    console.log(`[Orchestrator] status update: ticket=${ticketId} status=${status} branch=${branch_name || ""}`);

    const updates: string[] = ["updated_at = datetime('now')", "last_heartbeat = datetime('now')"];
    const values: (string | null)[] = [];

    if (status) {
      updates.push("status = ?");
      values.push(status);

      // Terminal states: mark agent as inactive so we don't spawn new agents
      // on deployment-triggered events
      const terminalStates = ["merged", "closed", "deferred", "failed"];
      if (terminalStates.includes(status)) {
        updates.push("agent_active = 0");
        console.log(`[Orchestrator] Marking agent inactive for terminal state: ${status}`);
      }
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
    if (transcript_r2_key) {
      updates.push("transcript_r2_key = ?");
      values.push(transcript_r2_key);
    }

    values.push(ticketId);
    this.ctx.storage.sql.exec(
      `UPDATE tickets SET ${updates.join(", ")} WHERE id = ?`,
      ...values,
    );

    return Response.json({ ok: true });
  }

  private async handleHeartbeat(request: Request): Promise<Response> {
    const { ticketId } = await request.json<{ ticketId: string }>();

    this.ctx.storage.sql.exec(
      "UPDATE tickets SET last_heartbeat = datetime('now') WHERE id = ?",
      ticketId,
    );

    return Response.json({ ok: true });
  }

  private async checkAgentHealth(): Promise<Response> {
    // Find all active tickets (agent_active = 1) that haven't sent a heartbeat in 30+ minutes
    const stuckThreshold = 30; // minutes
    const rows = this.ctx.storage.sql.exec(
      `SELECT id, product, status, last_heartbeat, slack_thread_ts, slack_channel, created_at
       FROM tickets
       WHERE agent_active = 1
         AND id NOT LIKE 'investigation-%'
         AND last_heartbeat IS NOT NULL
         AND (julianday('now') - julianday(last_heartbeat)) * 24 * 60 > ?`,
      stuckThreshold,
    ).toArray() as Array<{
      id: string;
      product: string;
      status: string;
      last_heartbeat: string;
      slack_thread_ts: string | null;
      slack_channel: string | null;
      created_at: string;
    }>;

    if (rows.length === 0) {
      return Response.json({ ok: true, stuck_agents: [] });
    }

    console.log(`[Orchestrator] Found ${rows.length} stuck agents`);

    const results = [];
    for (const ticket of rows) {
      const minutesStuck = Math.floor(
        (Date.now() - new Date(ticket.last_heartbeat).getTime()) / 60000,
      );

      console.log(
        `[Orchestrator] Stuck agent detected: ${ticket.id} (${minutesStuck}min since last heartbeat)`,
      );

      // Try to fetch agent status for diagnostics
      let agentStatus = "unknown";
      let agentError = "";
      try {
        const id = this.env.TICKET_AGENT.idFromName(ticket.id);
        const agent = this.env.TICKET_AGENT.get(id) as DurableObjectStub;
        const statusRes = await agent.fetch(new Request("http://internal/status"));
        if (statusRes.ok) {
          const status = await statusRes.json<{
            sessionActive: boolean;
            sessionStatus: string;
            sessionError: string;
            sessionMessageCount: number;
          }>();
          agentStatus = status.sessionStatus;
          agentError = status.sessionError;
        }
      } catch (err) {
        console.error(`[Orchestrator] Failed to fetch status for ${ticket.id}:`, err);
        agentError = String(err);
      }

      // Mark the stuck ticket inactive so subsequent cron runs don't create duplicate investigations
      this.ctx.storage.sql.exec(
        "UPDATE tickets SET agent_active = 0, updated_at = datetime('now') WHERE id = ?",
        ticket.id,
      );
      console.log(`[Orchestrator] Marked stuck ticket ${ticket.id} as inactive`);

      // Create investigation ticket
      await this.createInvestigationTicket({
        stuckTicketId: ticket.id,
        product: ticket.product,
        minutesStuck,
        lastHeartbeat: ticket.last_heartbeat,
        status: ticket.status,
        agentStatus,
        agentError,
        slackChannel: ticket.slack_channel || undefined,
        slackThreadTs: ticket.slack_thread_ts || undefined,
      });

      results.push({
        ticketId: ticket.id,
        product: ticket.product,
        minutesStuck,
        agentStatus,
        investigationCreated: true,
      });
    }

    return Response.json({ ok: true, stuck_agents: results });
  }

  private async createInvestigationTicket(details: {
    stuckTicketId: string;
    product: string;
    minutesStuck: number;
    lastHeartbeat: string;
    status: string;
    agentStatus: string;
    agentError: string;
    slackChannel?: string;
    slackThreadTs?: string;
  }) {
    const {
      stuckTicketId,
      product,
      minutesStuck,
      lastHeartbeat,
      status,
      agentStatus,
      agentError,
      slackChannel,
      slackThreadTs,
    } = details;

    // Create a Linear ticket for investigation
    const title = `Stuck agent detected: ${stuckTicketId}`;
    const description = `## Agent Stuck Alert

**Ticket:** ${stuckTicketId}
**Product:** ${product}
**Minutes stuck:** ${minutesStuck}
**Last heartbeat:** ${lastHeartbeat}
**Ticket status:** ${status}
**Agent session status:** ${agentStatus}
${agentError ? `**Agent error:** \`\`\`\n${agentError}\n\`\`\`` : ""}

The agent has not sent a heartbeat in over ${minutesStuck} minutes. This typically indicates:
- Agent process crashed
- Agent is in an infinite loop
- Container was terminated
- Network connectivity issue

## Next Steps
1. Check wrangler tail logs for the ticket
2. Inspect agent /status endpoint
3. If stuck in a loop, kill the agent container
4. If a bug is identified, fix and deploy
5. Restart the ticket if fixable

## Logs
Check \`wrangler tail\` output for ticket ID: ${stuckTicketId}
`;

    try {
      // Post notification to Slack
      if (slackChannel) {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${(this.env as any).SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: slackChannel,
            text: `🚨 *Agent stuck detected*\nTicket: ${stuckTicketId}\nStuck for: ${minutesStuck} minutes\nCreating investigation ticket...`,
            ...(slackThreadTs && { thread_ts: slackThreadTs }),
          }),
        });
      }

      // Deterministic ID — ensures only one investigation per stuck ticket
      const investigationId = sanitizeTicketId(`investigation-${stuckTicketId}`);
      const event: TicketEvent = {
        type: "ticket_created",
        source: "monitoring",
        ticketId: investigationId,
        product,
        payload: {
          title,
          description,
          priority: 1, // High priority
          ticketId: investigationId,
          stuckTicketId,
        },
        slackChannel,
        slackThreadTs,
      };

      // Upsert — idempotent if cron fires twice simultaneously
      this.ctx.storage.sql.exec(
        `INSERT INTO tickets (id, product, slack_thread_ts, slack_channel)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')`,
        investigationId,
        product,
        slackThreadTs || null,
        slackChannel || null,
      );

      // Route to a new agent
      await this.routeToAgent(event);

      console.log(`[Orchestrator] Investigation ticket created: ${investigationId}`);
    } catch (err) {
      console.error(`[Orchestrator] Failed to create investigation ticket:`, err);
    }
  }

  private listTickets(): Response {
    const rows = this.ctx.storage.sql.exec(
      "SELECT * FROM tickets ORDER BY updated_at DESC LIMIT 50",
    ).toArray();
    return Response.json({ tickets: rows });
  }

  private listTranscripts(request: Request): Response {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const sinceHours = url.searchParams.get("sinceHours") ? parseInt(url.searchParams.get("sinceHours")!, 10) : undefined;

    let query = `
      SELECT id as ticketId, product, status, transcript_r2_key as r2Key, updated_at as uploadedAt
      FROM tickets
      WHERE transcript_r2_key IS NOT NULL
    `;

    if (sinceHours) {
      query += ` AND (julianday('now') - julianday(updated_at)) * 24 < ${sinceHours}`;
    }

    query += ` ORDER BY updated_at DESC LIMIT ${limit}`;

    const rows = this.ctx.storage.sql.exec(query).toArray() as Array<{
      ticketId: string;
      product: string;
      status: string;
      r2Key: string;
      uploadedAt: string;
    }>;

    return Response.json({ transcripts: rows });
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
        // Re-activate agent on thread reply — user is explicitly engaging
        this.ctx.storage.sql.exec(
          "UPDATE tickets SET agent_active = 1, updated_at = datetime('now') WHERE id = ?",
          ticket.id,
        );
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
    // Load all products from database
    const productRows = this.ctx.storage.sql.exec(
      "SELECT slug, config FROM products",
    ).toArray() as Array<{ slug: string; config: string }>;

    const products = productRows.reduce((acc, row) => {
      acc[row.slug] = JSON.parse(row.config);
      return acc;
    }, {} as Record<string, ProductConfig>);

    const product = resolveProductFromChannel(products, slackEvent.channel || "");
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

}
