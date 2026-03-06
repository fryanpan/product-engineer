import { Container } from "@cloudflare/containers";
import type { TicketEvent, TicketAgentConfig, Bindings } from "./types";
import type { ProductConfig } from "./registry";
import { selectModelForTicket } from "./model-selection";

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
  private lastHealthCheck = 0;
  private static HEALTH_CHECK_TTL = 60_000; // 60 seconds

  private async ensureContainerRunning() {
    if (this.containerStarted) {
      // Skip the expensive HTTP health probe if we checked recently
      if (Date.now() - this.lastHealthCheck < Orchestrator.HEALTH_CHECK_TTL) return;
      try {
        // Container handle exists at runtime (from Container SDK) but isn't in Workers types
        const port = (this.ctx as any).container.getTcpPort(this.defaultPort);
        const res = await port.fetch("http://localhost/health", { signal: AbortSignal.timeout(2000) }) as Response;
        if (res.ok) {
          this.lastHealthCheck = Date.now();
          return;
        }
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

    // Token usage table
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        ticket_id TEXT PRIMARY KEY,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0.0,
        turns INTEGER NOT NULL DEFAULT 0,
        session_message_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
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
    const settingsToUpsert: [string, string][] = [];
    if (registry.linear_team_id) settingsToUpsert.push(["linear_team_id", registry.linear_team_id]);
    if (registry.agent_linear_email) settingsToUpsert.push(["agent_linear_email", registry.agent_linear_email]);
    if (registry.agent_linear_name) settingsToUpsert.push(["agent_linear_name", registry.agent_linear_name]);
    if (registry.cloudflare_ai_gateway) settingsToUpsert.push(["cloudflare_ai_gateway", JSON.stringify(registry.cloudflare_ai_gateway)]);

    for (const [key, value] of settingsToUpsert) {
      this.ctx.storage.sql.exec(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        key,
        value,
      );
      settingsUpdated++;
    }

    // Upsert products
    for (const [slug, config] of Object.entries(registry.products)) {
      this.ctx.storage.sql.exec(
        `INSERT INTO products (slug, config) VALUES (?, ?)
         ON CONFLICT(slug) DO UPDATE SET config = excluded.config, updated_at = datetime('now')`,
        slug,
        JSON.stringify(config),
      );
      // Count as created or updated based on whether rows changed
      const changes = this.ctx.storage.sql.exec("SELECT changes() as count").toArray() as Array<{ count: number }>;
      if (changes[0].count > 0) productsCreated++;
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
      case "/token-usage":
        return this.handleTokenUsage(request);
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

    const id = this.env.TICKET_AGENT.idFromName(event.ticketId);
    const agent = this.env.TICKET_AGENT.get(id) as DurableObjectStub;

    // Skip /initialize for thread replies — the agent is already configured.
    // containerFetch in /event auto-starts the container using envVars from SQLite.
    // This avoids redundant config writes and port checks on every reply.
    if (event.type !== "slack_reply") {
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

      // Load AI Gateway config from settings
      const gatewayRows = this.ctx.storage.sql.exec(
        "SELECT value FROM settings WHERE key = 'cloudflare_ai_gateway'"
      ).toArray() as Array<{ value: string }>;
      const gatewayConfig = gatewayRows.length > 0 ? JSON.parse(gatewayRows[0].value) : null;

      // Analyze ticket complexity and select appropriate model
      const payload = event.payload as any;
      const modelSelection = selectModelForTicket({
        priority: payload.priority,
        title: payload.title,
        description: payload.description,
        labels: payload.labels,
      });

      console.log(`[Orchestrator] Model selection for ${event.ticketId}: ${modelSelection.model} (${modelSelection.complexity} complexity) - ${modelSelection.reason}`);

      const config: TicketAgentConfig = {
        ticketId: event.ticketId,
        product: event.product,
        repos: productConfig.repos,
        slackChannel: productConfig.slack_channel_id || productConfig.slack_channel,
        secrets: productConfig.secrets,
        gatewayConfig,
        model: modelSelection.model,
      };

      const initRes = await agent.fetch(new Request("http://internal/initialize", {
        method: "POST",
        body: JSON.stringify(config),
      }));

      if (!initRes.ok) {
        console.error(`[Orchestrator] Failed to initialize agent for ${event.ticketId}: ${initRes.status}`);
        return;
      }
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

        // Notify the TicketAgent DO so it marks itself terminal and stops
        // restarting containers on alarm
        try {
          const id = this.env.TICKET_AGENT.idFromName(ticketId);
          const agent = this.env.TICKET_AGENT.get(id);
          await agent.fetch(new Request("http://internal/mark-terminal", { method: "POST" }));
        } catch (err) {
          console.error(`[Orchestrator] Failed to mark TicketAgent terminal for ${ticketId}:`, err);
        }
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

  private async handleTokenUsage(request: Request): Promise<Response> {
    const {
      ticketId,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalCostUsd,
      turns,
      sessionMessageCount,
    } = await request.json<{
      ticketId: string;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      totalCostUsd: number;
      turns: number;
      sessionMessageCount: number;
    }>();

    console.log(
      `[Orchestrator] Token usage: ticket=${ticketId} input=${totalInputTokens} output=${totalOutputTokens} cost=$${totalCostUsd.toFixed(2)}`
    );

    // Upsert token usage data
    this.ctx.storage.sql.exec(
      `INSERT INTO token_usage (
        ticket_id, total_input_tokens, total_output_tokens,
        total_cache_read_tokens, total_cache_creation_tokens,
        total_cost_usd, turns, session_message_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_id) DO UPDATE SET
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cache_read_tokens = excluded.total_cache_read_tokens,
        total_cache_creation_tokens = excluded.total_cache_creation_tokens,
        total_cost_usd = excluded.total_cost_usd,
        turns = excluded.turns,
        session_message_count = excluded.session_message_count,
        updated_at = datetime('now')`,
      ticketId,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalCostUsd,
      turns,
      sessionMessageCount,
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
    // Report-only: find active tickets with stale heartbeats for diagnostics.
    // No longer marks agents inactive or creates investigation tickets.
    const stuckThreshold = 30; // minutes
    const rows = this.ctx.storage.sql.exec(
      `SELECT id, product, status, last_heartbeat
       FROM tickets
       WHERE agent_active = 1
         AND last_heartbeat IS NOT NULL
         AND (julianday('now') - julianday(last_heartbeat)) * 24 * 60 > ?`,
      stuckThreshold,
    ).toArray() as Array<{
      id: string;
      product: string;
      status: string;
      last_heartbeat: string;
    }>;

    const staleAgents = rows.map((ticket) => ({
      ticketId: ticket.id,
      product: ticket.product,
      status: ticket.status,
      minutesStuck: Math.floor(
        (Date.now() - new Date(ticket.last_heartbeat).getTime()) / 60000,
      ),
      lastHeartbeat: ticket.last_heartbeat,
    }));

    if (staleAgents.length > 0) {
      console.log(`[Orchestrator] Health check: ${staleAgents.length} stale agents found`);
    }

    return Response.json({ ok: true, stale_agents: staleAgents });
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

    const params: (string | number)[] = [];
    let query = `
      SELECT id as ticketId, product, status, transcript_r2_key as r2Key, updated_at as uploadedAt
      FROM tickets
      WHERE transcript_r2_key IS NOT NULL
    `;

    if (sinceHours) {
      query += ` AND (julianday('now') - julianday(updated_at)) * 24 < ?`;
      params.push(sinceHours);
    }

    query += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.ctx.storage.sql.exec(query, ...params).toArray() as Array<{
      ticketId: string;
      product: string;
      status: string;
      r2Key: string;
      uploadedAt: string;
    }>;

    return Response.json({ transcripts: rows });
  }

  private async postSlackError(channel: string, threadTs: string, message: string): Promise<void> {
    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${(this.env as any).SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel,
          thread_ts: threadTs,
          text: message,
        }),
      });

      if (!res.ok) {
        console.error(`[Orchestrator] Failed to post Slack error: ${res.status}`);
        return;
      }

      const data = await res.json() as { ok: boolean; error?: string };
      if (!data.ok) {
        console.error(`[Orchestrator] Slack API error: ${data.error}`);
      }
    } catch (err) {
      console.error("[Orchestrator] Failed to post Slack error:", err);
    }
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
      console.log(`[Orchestrator] Thread reply received: thread_ts=${slackEvent.thread_ts} type=${slackEvent.type} user=${slackEvent.user || "unknown"}`);
      const rows = this.ctx.storage.sql.exec(
        "SELECT id, product FROM tickets WHERE slack_thread_ts = ?",
        slackEvent.thread_ts,
      ).toArray() as { id: string; product: string }[];

      if (rows.length > 0) {
        const ticket = rows[0];
        console.log(`[Orchestrator] Thread reply matched ticket=${ticket.id} product=${ticket.product}`);
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
        console.log(`[Orchestrator] Routing thread reply to agent for ticket=${ticket.id}`);
        await this.routeToAgent(event);
        return Response.json({ ok: true, ticketId: ticket.id });
      } else {
        console.log(`[Orchestrator] No ticket found for thread_ts=${slackEvent.thread_ts}`);
      }

      // Thread reply but no ticket found - user is replying to something that's not tracked
      if (slackEvent.type === "message") {
        await this.postSlackError(
          slackEvent.channel || "",
          slackEvent.thread_ts,
          `ℹ️ This thread is not associated with an active Product Engineer task.\n\n` +
          `If you want to start a new task, mention me with @product-engineer in your message.`
        );
        return Response.json({ ok: true, ignored: true, reason: "thread not tracked" });
      }
    }

    // Only create tickets from app_mention events
    if (slackEvent.type !== "app_mention") {
      // This shouldn't happen (Socket Mode only forwards app_mention and thread messages),
      // but if it does, let the user know
      await this.postSlackError(
        slackEvent.channel || "",
        slackEvent.ts || "",
        `ℹ️ I only respond to direct mentions (@product-engineer).\n\n` +
        `Please mention me to start a new task.`
      );
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

      // Post error message to Slack so users know what went wrong
      const registeredChannels = Object.values(products)
        .map(p => `• <#${p.slack_channel_id || p.slack_channel}>`)
        .join("\n");

      await this.postSlackError(
        slackEvent.channel || "",
        slackEvent.ts || "",
        `❌ This channel is not registered with Product Engineer.\n\n` +
        `**Registered channels:**\n${registeredChannels}\n\n` +
        `To register this channel, update the product registry in the Orchestrator database.`
      );

      return Response.json({ error: "no product for channel" }, { status: 404 });
    }

    const ticketId = sanitizeTicketId(`slack-${slackEvent.ts || Date.now()}`);
    const event: TicketEvent = {
      type: "slack_mention",
      source: "slack",
      ticketId,
      product,
      payload: slackEvent,
      slackThreadTs: undefined, // Don't set thread_ts — let agent create its own thread
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
