import { Container } from "@cloudflare/containers";
import { TERMINAL_STATUSES, type TicketEvent, type TicketAgentConfig, type Bindings } from "./types";
import type { ProductConfig } from "./registry";
import { DecisionEngine } from "./decision-engine";
import { ContextAssembler } from "./context-assembler";

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
  private _decisionEngine: DecisionEngine | null = null;
  private _contextAssembler: ContextAssembler | null = null;

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
  // Also runs the LLM supervisor tick every 5 minutes.
  override async alarm(alarmProps: { isRetry: boolean; retryCount: number }) {
    this.initDb();
    await this.ensureContainerRunning();

    // Schedule next alarm (5 minutes) for supervisor tick
    this.ctx.storage.setAlarm(Date.now() + 300_000);

    // Run LLM supervisor tick — checks agent health, stale PRs, queued tickets
    try {
      await this.runSupervisorTick();
    } catch (err) {
      console.error("[Orchestrator] Supervisor tick failed:", err);
      // Don't let supervisor failures break the alarm loop
    }

    // Refresh Linear OAuth token every 12h (alarm fires every 5min, so check timestamp)
    try {
      const lastRefreshRow = this.ctx.storage.sql.exec(
        "SELECT value FROM settings WHERE key = 'linear_token_refreshed_at'"
      ).toArray()[0] as { value: string } | undefined;
      const lastRefresh = lastRefreshRow ? parseInt(lastRefreshRow.value, 10) : 0;
      const twelveHours = 12 * 60 * 60 * 1000;
      if (Date.now() - lastRefresh > twelveHours) {
        const refreshed = await this.refreshLinearToken();
        if (refreshed) {
          this.ctx.storage.sql.exec(
            `INSERT INTO settings (key, value) VALUES ('linear_token_refreshed_at', ?)
             ON CONFLICT(key) DO UPDATE SET value = ?`,
            String(Date.now()), String(Date.now()),
          );
        }
      }
    } catch (err) {
      console.error("[Orchestrator] Linear token refresh check failed:", err);
    }

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

  private getDecisionEngine(): DecisionEngine {
    if (!this._decisionEngine) {
      this._decisionEngine = new DecisionEngine({
        anthropicApiKey: (this.env.ANTHROPIC_API_KEY as string) || "",
        slackBotToken: (this.env.SLACK_BOT_TOKEN as string) || "",
        decisionsChannel: (this.env as any).DECISIONS_CHANNEL || "#product-engineer-decisions",
        linearAppToken: this.getLinearAppToken(),
      });
    }
    return this._decisionEngine;
  }

  private getContextAssembler(): ContextAssembler {
    if (!this._contextAssembler) {
      this._contextAssembler = new ContextAssembler({
        sqlExec: (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params),
        slackBotToken: (this.env.SLACK_BOT_TOKEN as string) || "",
        linearAppToken: this.getLinearAppToken(),
        githubTokens: this.getGithubTokens(),
      });
    }
    return this._contextAssembler;
  }

  private getGithubTokens(): Record<string, string> {
    // Build product→token map from per-product token bindings in env
    const tokens: Record<string, string> = {};
    // Load product configs to map slug → secret binding name
    const productRows = this.ctx.storage.sql.exec(
      "SELECT slug, config FROM products",
    ).toArray() as Array<{ slug: string; config: string }>;

    for (const row of productRows) {
      try {
        const config = JSON.parse(row.config) as ProductConfig;
        const tokenBinding = config.secrets?.GITHUB_TOKEN;
        if (tokenBinding && (this.env as Record<string, unknown>)[tokenBinding]) {
          tokens[row.slug] = (this.env as Record<string, unknown>)[tokenBinding] as string;
        }
      } catch {
        // Skip malformed configs
      }
    }
    return tokens;
  }

  /** Get the Linear OAuth app token — checks SQLite settings for a stored token, falls back to env binding. */
  private getLinearAppToken(): string {
    try {
      const row = this.ctx.storage.sql.exec(
        "SELECT value FROM settings WHERE key = 'linear_app_token'"
      ).toArray()[0] as { value: string } | undefined;
      if (row?.value) return row.value;
    } catch {
      // Settings table may not exist yet during early init
    }
    return (this.env.LINEAR_APP_TOKEN as string) || "";
  }

  /** Refresh the Linear OAuth token using the stored refresh token. */
  private async refreshLinearToken(): Promise<boolean> {
    try {
      const refreshRow = this.ctx.storage.sql.exec(
        "SELECT value FROM settings WHERE key = 'linear_refresh_token'"
      ).toArray()[0] as { value: string } | undefined;

      if (!refreshRow?.value) {
        console.log("[Orchestrator] No Linear refresh token stored, skipping refresh");
        return false;
      }

      const clientId = (this.env.LINEAR_APP_CLIENT_ID as string) || "";
      const clientSecret = (this.env.LINEAR_APP_CLIENT_SECRET as string) || "";
      if (!clientId || !clientSecret) {
        console.warn("[Orchestrator] LINEAR_APP_CLIENT_ID or LINEAR_APP_CLIENT_SECRET not set, cannot refresh");
        return false;
      }

      const res = await fetch("https://api.linear.app/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshRow.value,
        }),
      });

      if (!res.ok) {
        console.error(`[Orchestrator] Linear token refresh failed: ${res.status}`);
        return false;
      }

      const data = await res.json() as { access_token: string; refresh_token?: string };
      this.ctx.storage.sql.exec(
        `INSERT INTO settings (key, value) VALUES ('linear_app_token', ?)
         ON CONFLICT(key) DO UPDATE SET value = ?`,
        data.access_token, data.access_token,
      );

      if (data.refresh_token) {
        this.ctx.storage.sql.exec(
          `INSERT INTO settings (key, value) VALUES ('linear_refresh_token', ?)
           ON CONFLICT(key) DO UPDATE SET value = ?`,
          data.refresh_token, data.refresh_token,
        );
      }

      // Invalidate cached engine/assembler so they pick up the new token
      this._decisionEngine = null;
      this._contextAssembler = null;

      console.log("[Orchestrator] Linear token refreshed successfully");
      return true;
    } catch (err) {
      console.error("[Orchestrator] Linear token refresh error:", err);
      return false;
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
    // Decision log table — records orchestrator decisions for observability
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS decision_log (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        ticket_id TEXT,
        context_summary TEXT,
        action TEXT NOT NULL,
        reason TEXT,
        confidence REAL DEFAULT 0
      )
    `);

    // Slack thread → Linear issue mapping (for linking Slack-originated tickets)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS slack_thread_map (
        linear_issue_id TEXT PRIMARY KEY,
        slack_thread_ts TEXT NOT NULL,
        slack_channel TEXT NOT NULL
      )
    `);

    // Ticket queue table — pending tickets awaiting agent assignment
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ticket_queue (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        product TEXT NOT NULL,
        priority INTEGER DEFAULT 3,
        payload TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
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
      linear_app_user_id?: string;
      cloudflare_ai_gateway?: { account_id: string; gateway_id: string };
      products: Record<string, unknown>;
    }>();

    let productsCreated = 0;
    let productsUpdated = 0;
    let settingsUpdated = 0;

    // Insert global settings
    const settingsToUpsert: [string, string][] = [];
    if (registry.linear_team_id) settingsToUpsert.push(["linear_team_id", registry.linear_team_id]);
    if (registry.linear_app_user_id) settingsToUpsert.push(["linear_app_user_id", registry.linear_app_user_id]);
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
      case "/status":
        return this.getSystemStatus();
      case "/cleanup-inactive":
        return this.cleanupInactiveAgents();
      case "/shutdown-all":
        return this.shutdownAllAgents();
      case "/products":
        return request.method === "GET" ? this.listProducts() : this.createProduct(request);
      case "/settings":
        return this.listSettings();
      case "/decisions":
        return Response.json(this.ctx.storage.sql.exec(
          "SELECT * FROM decision_log ORDER BY timestamp DESC LIMIT 20"
        ).toArray());
      default:
        // Handle dynamic routes
        if (url.pathname.startsWith("/ticket-status/")) {
          const ticketId = decodeURIComponent(url.pathname.slice("/ticket-status/".length));
          const row = this.ctx.storage.sql.exec(
            "SELECT agent_active, status, product FROM tickets WHERE id = ?",
            ticketId,
          ).toArray()[0] as { agent_active: number; status: string; product: string } | undefined;
          if (!row) return Response.json({ error: "not found" }, { status: 404 });
          return Response.json({
            ...row,
            terminal: (TERMINAL_STATUSES as readonly string[]).includes(row.status),
          });
        }
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
    console.log(`[Orchestrator] handleEvent: type=${event.type} ticketId=${event.ticketId} source=${event.source}`);

    // Resolve branch-extracted task IDs (e.g. "PES-5") to their UUID ticket.
    // GitHub webhooks extract taskId from branch names like "ticket/PES-5",
    // but the canonical ticket is stored under the Linear UUID. Look up by branch_name.
    if (event.source === "github") {
      const byBranch = this.ctx.storage.sql.exec(
        "SELECT id FROM tickets WHERE branch_name = ? OR branch_name = ?",
        `ticket/${event.ticketId}`, `feedback/${event.ticketId}`,
      ).toArray()[0] as { id: string } | undefined;
      if (byBranch) {
        console.log(`[Orchestrator] Resolved branch task ID ${event.ticketId} → ${byBranch.id}`);
        event.ticketId = byBranch.id;
      }
    }

    // Check if this ticket is already in a terminal state — don't re-activate it
    const existing = this.ctx.storage.sql.exec(
      "SELECT status FROM tickets WHERE id = ?",
      event.ticketId,
    ).toArray()[0] as { status: string } | undefined;

    if (existing && (TERMINAL_STATUSES as readonly string[]).includes(existing.status)) {
      console.log(`[Orchestrator] Ignoring event for terminal ticket ${event.ticketId} (status: ${existing.status})`);
      return Response.json({ ok: true, ticketId: event.ticketId, ignored: true, reason: "terminal ticket" });
    }

    // For Linear events, look up Slack thread from slack_thread_map (Slack-originated tickets)
    if (event.source === "linear" && !event.slackThreadTs) {
      const threadMap = this.ctx.storage.sql.exec(
        "SELECT slack_thread_ts, slack_channel FROM slack_thread_map WHERE linear_issue_id = ?",
        event.ticketId,
      ).toArray()[0] as { slack_thread_ts: string; slack_channel: string } | undefined;
      if (threadMap) {
        event.slackThreadTs = threadMap.slack_thread_ts || undefined;
        event.slackChannel = threadMap.slack_channel || undefined;
        console.log(`[Orchestrator] Linked Linear issue ${event.ticketId} to Slack thread ${threadMap.slack_thread_ts}`);
        // Clean up — one-time mapping
        this.ctx.storage.sql.exec("DELETE FROM slack_thread_map WHERE linear_issue_id = ?", event.ticketId);
      }
    }

    // Upsert ticket — only re-activate non-terminal tickets
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

    // For new tickets, use LLM ticket review instead of direct routing
    if (event.type === "ticket_created") {
      await this.handleTicketReview(event);
      return Response.json({ ok: true, ticketId: event.ticketId });
    }

    // For Linear comments, route to running agent or re-evaluate via ticket review
    if (event.type === "linear_comment") {
      const ticketRow = this.ctx.storage.sql.exec(
        "SELECT agent_active FROM tickets WHERE id = ?", event.ticketId,
      ).toArray()[0] as { agent_active: number } | undefined;

      if (ticketRow?.agent_active) {
        // Forward to running agent like a Slack reply
        await this.sendEventToAgent(event);
      } else {
        // No agent running — re-evaluate via ticket review
        await this.handleTicketReview(event);
      }
      return Response.json({ ok: true, ticketId: event.ticketId });
    }

    // CI passed + PR exists → evaluate merge gate (orchestrator decides, not agent)
    if (event.type === "checks_passed") {
      const ticketRow = this.ctx.storage.sql.exec(
        "SELECT pr_url FROM tickets WHERE id = ?", event.ticketId
      ).toArray()[0] as { pr_url: string | null } | undefined;

      if (ticketRow?.pr_url) {
        await this.evaluateMergeGate(event.ticketId, event.product);
        return Response.json({ ok: true, ticketId: event.ticketId });
      }
      // No PR yet — route to agent normally
    }

    // Route to TicketAgent for all other event types
    await this.routeToAgent(event);

    return Response.json({ ok: true, ticketId: event.ticketId });
  }

  private async routeToAgent(event: TicketEvent, model: string = "sonnet") {
    // Check if agent is still active (not in terminal state) and load thread_ts
    const ticket = this.ctx.storage.sql.exec(
      "SELECT agent_active, status, slack_thread_ts, slack_channel FROM tickets WHERE id = ?",
      event.ticketId,
    ).toArray()[0] as { agent_active: number; status: string; slack_thread_ts: string | null; slack_channel: string | null } | undefined;

    if (ticket && ticket.agent_active === 0) {
      console.log(`[Orchestrator] Skipping inactive agent for ${event.ticketId} (status: ${ticket.status})`);
      return;
    }

    // Populate thread_ts from database if not already set in the event
    // This ensures Linear tickets (which don't have thread_ts in the webhook) can reply in-thread
    if (ticket && ticket.slack_thread_ts && !event.slackThreadTs) {
      event.slackThreadTs = ticket.slack_thread_ts;
    }
    if (ticket && ticket.slack_channel && !event.slackChannel) {
      event.slackChannel = ticket.slack_channel;
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

      console.log(`[Orchestrator] Routing ${event.ticketId} to agent with model=${model}`);

      // Load slack_thread_ts from database (set by initial event or subsequent updates)
      const ticketRow = this.ctx.storage.sql.exec(
        "SELECT slack_thread_ts FROM tickets WHERE id = ?",
        event.ticketId,
      ).toArray()[0] as { slack_thread_ts: string | null } | undefined;

      const config: TicketAgentConfig = {
        ticketId: event.ticketId,
        product: event.product,
        repos: productConfig.repos,
        slackChannel: productConfig.slack_channel_id || productConfig.slack_channel,
        slackThreadTs: event.slackThreadTs || ticketRow?.slack_thread_ts || undefined,
        secrets: productConfig.secrets,
        gatewayConfig,
        model,
      };

      const initRes = await agent.fetch(new Request("http://internal/initialize", {
        method: "POST",
        body: JSON.stringify(config),
      }));

      if (!initRes.ok) {
        console.error(`[Orchestrator] Failed to initialize agent for ${event.ticketId}: ${initRes.status}`);
        // Mark inactive so the orphaned container doesn't block future attempts
        this.ctx.storage.sql.exec(
          "UPDATE tickets SET agent_active = 0, updated_at = datetime('now') WHERE id = ?",
          event.ticketId,
        );
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
    // Mark inactive to prevent orphaned container from blocking future events
    this.ctx.storage.sql.exec(
      "UPDATE tickets SET agent_active = 0, updated_at = datetime('now') WHERE id = ?",
      event.ticketId,
    );
  }

  /**
   * Send an event to a running TicketAgent container without re-initializing it.
   * Used for forwarding linear_comment events and other supplementary events
   * to agents that are already configured and running.
   */
  private async sendEventToAgent(event: TicketEvent): Promise<void> {
    const id = this.env.TICKET_AGENT.idFromName(event.ticketId);
    const agent = this.env.TICKET_AGENT.get(id) as DurableObjectStub;

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

  /**
   * Use LLM decision engine to review a new ticket and decide what to do:
   * start_agent, ask_questions, mark_duplicate, queue, or expand_existing.
   */
  private async handleTicketReview(event: TicketEvent): Promise<void> {
    const engine = this.getDecisionEngine();
    const assembler = this.getContextAssembler();

    const payload = event.payload as Record<string, unknown>;

    // Load product config from database
    const productRows = this.ctx.storage.sql.exec(
      "SELECT config FROM products WHERE slug = ?",
      event.product,
    ).toArray() as Array<{ config: string }>;

    if (productRows.length === 0) {
      console.error(`[Orchestrator] No product config for ${event.product}`);
      return;
    }

    const productConfig = JSON.parse(productRows[0].config) as ProductConfig;

    // Get ticket record for slack info
    const ticketRow = this.ctx.storage.sql.exec(
      "SELECT * FROM tickets WHERE id = ?", event.ticketId,
    ).toArray()[0] as Record<string, unknown> | undefined;

    // Skip ticket review if agent is already running or ticket is past initial triage.
    // Linear sends multiple webhooks (create + update) and we don't want to re-review
    // a ticket that already has an active agent.
    if (ticketRow) {
      const status = ticketRow.status as string;
      const agentActive = ticketRow.agent_active as number;
      if (agentActive === 1 || (status !== "created" && status !== "needs_info")) {
        console.log(`[Orchestrator] Skipping ticket review for ${event.ticketId} — already active (status=${status}, agent_active=${agentActive})`);
        return;
      }
    }

    const context = await assembler.forTicketReview({
      ticketId: event.ticketId,
      identifier: (payload.identifier as string) || null,
      title: (payload.title as string) || "",
      description: (payload.description as string) || "",
      priority: (payload.priority as number) || 3,
      labels: (payload.labels as string[]) || [],
      product: event.product,
      repos: productConfig.repos,
      slackThreadTs: event.slackThreadTs || (ticketRow?.slack_thread_ts as string) || null,
      slackChannel: event.slackChannel || (ticketRow?.slack_channel as string) || null,
    });

    let decision;
    try {
      decision = await engine.makeDecision("ticket-review", context);
    } catch (err) {
      console.error("[Orchestrator] LLM ticket review failed, defaulting to start_agent with sonnet:", err);
      decision = { action: "start_agent", model: "sonnet", reason: "LLM review failed, using default", confidence: 0 };
    }

    // Log the decision (use human-readable identifier like PES-8, fall back to UUID)
    const displayId = (payload.identifier as string) || event.ticketId;
    await engine.logDecision({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: "ticket_review",
      ticket_id: displayId,
      context_summary: `${displayId}: ${((payload.title as string) || "").slice(0, 100)}`,
      action: decision.action,
      reason: decision.reason,
      confidence: decision.confidence || 0,
    }, {
      sqlExec: (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params),
      slackChannel: event.slackChannel || (ticketRow?.slack_channel as string) || undefined,
      slackThreadTs: event.slackThreadTs || (ticketRow?.slack_thread_ts as string) || undefined,
      linearIssueId: event.ticketId,
    });

    // Act on decision
    switch (decision.action) {
      case "start_agent": {
        const model = decision.model || "sonnet";
        await this.routeToAgent(event, model);
        break;
      }
      case "ask_questions": {
        // Update status to needs_info
        this.ctx.storage.sql.exec(
          "UPDATE tickets SET status = 'needs_info', updated_at = datetime('now') WHERE id = ?",
          event.ticketId,
        );

        // Post questions to Slack thread and Linear
        const questions = (decision as unknown as Record<string, unknown>).questions as string[] | undefined;
        if (questions && questions.length > 0) {
          const numberedQuestions = questions.map((q, i) => `${i + 1}. ${q}`).join("\n");

          // Post to Slack thread
          const slackChannel = event.slackChannel || (ticketRow?.slack_channel as string) || undefined;
          const slackThreadTs = event.slackThreadTs || (ticketRow?.slack_thread_ts as string) || undefined;
          if (slackChannel && slackThreadTs) {
            const slackText = `❓ Before I start, a couple questions:\n${numberedQuestions}`;
            await fetch("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                channel: slackChannel,
                text: slackText,
                thread_ts: slackThreadTs,
              }),
            }).catch((err) => console.error("[Orchestrator] Failed to post questions to Slack:", err));
          }

          // Post to Linear as a comment
          const linearToken = this.getLinearAppToken();
          if (linearToken) {
            const linearBody = `❓ **Before I start, a couple questions:**\n${numberedQuestions}`;
            await fetch("https://api.linear.app/graphql", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${linearToken}`,
              },
              body: JSON.stringify({
                query: `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
                variables: { issueId: event.ticketId, body: linearBody },
              }),
            }).catch((err) => console.error("[Orchestrator] Failed to post questions to Linear:", err));
          }
        }
        break;
      }
      case "mark_duplicate": {
        this.ctx.storage.sql.exec(
          "UPDATE tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?",
          event.ticketId,
        );
        break;
      }
      case "queue": {
        this.ctx.storage.sql.exec(
          `INSERT INTO ticket_queue (id, ticket_id, product, priority, payload)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          crypto.randomUUID(), event.ticketId, event.product,
          (payload.priority as number) || 3, JSON.stringify(event),
        );
        this.ctx.storage.sql.exec(
          "UPDATE tickets SET status = 'queued', updated_at = datetime('now') WHERE id = ?",
          event.ticketId,
        );
        break;
      }
      case "expand_existing": {
        // Route the event to the existing ticket's agent
        // decision.expand_ticket contains the ticket ID to expand
        const expandTicketId = (decision as unknown as Record<string, unknown>).expand_ticket as string | undefined;
        if (expandTicketId) {
          const expandedEvent = { ...event, ticketId: expandTicketId };
          await this.sendEventToAgent(expandedEvent);
        }
        break;
      }
    }
  }

  /**
   * LLM Merge Gate — evaluates whether a PR is ready to auto-merge.
   * Called when CI passes and PR exists for a tracked ticket.
   */
  private async evaluateMergeGate(
    ticketId: string,
    product: string,
  ): Promise<void> {
    const ticketRow = this.ctx.storage.sql.exec(
      "SELECT * FROM tickets WHERE id = ?", ticketId
    ).toArray()[0] as Record<string, unknown> | undefined;

    if (!ticketRow?.pr_url) {
      console.log(`[Orchestrator] No PR URL for ${ticketId}, skipping merge gate`);
      return;
    }

    // Load product config directly from SQLite (avoid loadRegistry which calls back to self)
    const productRows = this.ctx.storage.sql.exec(
      "SELECT config FROM products WHERE slug = ?",
      product,
    ).toArray() as Array<{ config: string }>;

    if (productRows.length === 0) {
      console.log(`[Orchestrator] No product config for ${product}, skipping merge gate`);
      return;
    }

    const productConfig = JSON.parse(productRows[0].config) as ProductConfig;

    const engine = this.getDecisionEngine();
    const assembler = this.getContextAssembler();

    const context = await assembler.forMergeGate({
      ticketId,
      identifier: null,
      title: "",
      product,
      pr_url: ticketRow.pr_url as string,
      branch: (ticketRow.branch_name as string) || "",
      repo: productConfig.repos[0],
    });

    let decision;
    try {
      decision = await engine.makeDecision("merge-gate", context);
    } catch (err) {
      console.error("[Orchestrator] Merge gate LLM call failed:", err);
      // Don't auto-merge on failure — escalate instead
      decision = { action: "escalate", reason: "Merge gate LLM call failed", confidence: 0 };
    }

    // Log the decision
    await engine.logDecision({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: "merge_gate",
      ticket_id: ticketId,
      context_summary: `PR: ${ticketRow.pr_url}`,
      action: decision.action,
      reason: decision.reason,
      confidence: decision.confidence || 0,
    }, {
      sqlExec: (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params),
      slackChannel: (ticketRow.slack_channel as string) || undefined,
      slackThreadTs: (ticketRow.slack_thread_ts as string) || undefined,
      linearIssueId: ticketId,
    });

    switch (decision.action) {
      case "auto_merge":
        await this.autoMergePR(ticketId, product, ticketRow);
        break;
      case "escalate":
        // Post escalation to Slack
        if (ticketRow.slack_channel && ticketRow.slack_thread_ts) {
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              channel: ticketRow.slack_channel,
              text: `\u26A0\uFE0F *Merge Gate \u2014 Human Review Needed*\n${ticketRow.pr_url}\n*Reason:* ${decision.reason}`,
              thread_ts: ticketRow.slack_thread_ts,
            }),
          });
        }
        break;
      case "send_back": {
        // Route back to agent
        const sendBackEvent: TicketEvent = {
          type: "merge_feedback",
          source: "orchestrator",
          ticketId,
          product,
          payload: { feedback: decision.reason, missing: (decision as unknown as Record<string, unknown>).missing },
        };
        await this.sendEventToAgent(sendBackEvent);
        break;
      }
    }
  }

  /**
   * Auto-merge a PR via GitHub API (squash merge).
   */
  private async autoMergePR(
    ticketId: string,
    product: string,
    ticketRow: Record<string, unknown>,
  ): Promise<void> {
    const ghTokens = this.getGithubTokens();
    const ghToken = ghTokens[product];
    const prUrl = ticketRow.pr_url as string;
    if (!ghToken || !prUrl) return;

    const prMatch = prUrl.match(/\/pull\/(\d+)/);
    if (!prMatch) return;

    // Load repo from product config directly from SQLite
    const productRows = this.ctx.storage.sql.exec(
      "SELECT config FROM products WHERE slug = ?",
      product,
    ).toArray() as Array<{ config: string }>;

    if (productRows.length === 0) return;

    const productConfig = JSON.parse(productRows[0].config) as ProductConfig;
    const repo = productConfig.repos[0];
    const prNumber = prMatch[1];

    console.log(`[Orchestrator] Auto-merging PR #${prNumber} on ${repo}`);

    const mergeRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "product-engineer-orchestrator",
      },
      body: JSON.stringify({ merge_method: "squash" }),
    });

    if (mergeRes.ok) {
      console.log(`[Orchestrator] PR #${prNumber} merged successfully`);
      // The pr_merged webhook will trigger handleStatusUpdate -> terminal state
    } else {
      const errorText = await mergeRes.text();
      console.error(`[Orchestrator] Failed to merge PR #${prNumber}: ${mergeRes.status} ${errorText}`);

      // Notify via Slack if thread available
      if (ticketRow.slack_thread_ts && ticketRow.slack_channel) {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: ticketRow.slack_channel,
            thread_ts: ticketRow.slack_thread_ts,
            text: `Auto-merge failed for PR #${prNumber}: ${mergeRes.status === 405 || mergeRes.status === 409 ? "merge conflict or branch not mergeable" : `API error ${mergeRes.status}`}. Sending back to agent for rebase.`,
          }),
        }).catch(err => console.warn("[Orchestrator] Failed to notify Slack:", err));
      }

      // Route back to agent with rebase instruction
      const event: TicketEvent = {
        type: "merge_conflict",
        source: "github",
        ticketId,
        product,
        payload: { error: errorText, pr_url: ticketRow.pr_url, action: "rebase_and_push" },
        slackThreadTs: ticketRow.slack_thread_ts as string | undefined,
        slackChannel: ticketRow.slack_channel as string | undefined,
      };
      await this.routeToAgent(event);
    }
  }

  /**
   * LLM Supervisor — runs on every alarm tick to check system health.
   * Evaluates active agents, stale PRs, and queued tickets, then takes
   * action (kill stuck agents, trigger merge evals, escalate, start queued).
   */
  private async runSupervisorTick(): Promise<void> {
    const assembler = this.getContextAssembler();
    const engine = this.getDecisionEngine();

    const context = await assembler.forSupervisor();

    // Skip LLM call if nothing needs attention
    if ((context.agentCount as number) === 0 &&
        (context.stalePRs as unknown[]).length === 0 &&
        (context.queuedTickets as unknown[]).length === 0) {
      return;
    }

    let actions: Array<{ target: string; action: string; reason: string }>;
    try {
      const response = await engine.makeDecision("supervisor", context);
      // Supervisor template asks for a JSON array
      // The response might be a single object or an array
      if (Array.isArray(response)) {
        actions = response;
      } else {
        actions = [response as unknown as { target: string; action: string; reason: string }];
      }
    } catch (err) {
      console.error("[Orchestrator] Supervisor LLM call failed:", err);
      return; // Don't take action on LLM failure
    }

    for (const action of actions) {
      if (action.action === "none") continue;

      // Log each action
      await engine.logDecision({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: "supervisor",
        ticket_id: action.target !== "system" ? action.target : null,
        context_summary: `Supervisor: ${action.action} on ${action.target}`,
        action: action.action,
        reason: action.reason,
        confidence: 0,
      }, {
        sqlExec: (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params),
      });

      switch (action.action) {
        case "kill": {
          // Mark agent inactive and tell container to shut down
          if (action.target !== "system") {
            this.ctx.storage.sql.exec(
              "UPDATE tickets SET agent_active = 0, status = 'failed', updated_at = datetime('now') WHERE id = ?",
              action.target,
            );
            try {
              const agentId = this.env.TICKET_AGENT.idFromName(action.target);
              const agentStub = this.env.TICKET_AGENT.get(agentId);
              await agentStub.fetch(new Request("http://internal/mark-terminal", { method: "POST" }));
            } catch (err) {
              console.warn(`[Orchestrator] Failed to kill agent for ${action.target}:`, err);
            }
          }
          break;
        }
        case "trigger_merge_eval": {
          if (action.target !== "system") {
            const ticketRow = this.ctx.storage.sql.exec(
              "SELECT product FROM tickets WHERE id = ?", action.target
            ).toArray()[0] as { product: string } | undefined;
            if (ticketRow) {
              await this.evaluateMergeGate(action.target, ticketRow.product);
            }
          }
          break;
        }
        case "escalate": {
          // Post to decisions channel
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              channel: (this.env as Record<string, unknown>).DECISIONS_CHANNEL as string || "#product-engineer-decisions",
              text: `\u26A0\uFE0F *Supervisor Escalation*\n*Target:* ${action.target}\n*Reason:* ${action.reason}`,
            }),
          });
          break;
        }
        case "start_queued": {
          // Pop the highest-priority ticket from the queue
          const queuedRow = this.ctx.storage.sql.exec(
            "SELECT id, ticket_id, payload FROM ticket_queue ORDER BY priority ASC, created_at ASC LIMIT 1"
          ).toArray()[0] as { id: string; ticket_id: string; payload: string } | undefined;
          if (queuedRow) {
            this.ctx.storage.sql.exec("DELETE FROM ticket_queue WHERE id = ?", queuedRow.id);
            const queuedEvent = JSON.parse(queuedRow.payload) as TicketEvent;
            await this.handleTicketReview(queuedEvent);
          }
          break;
        }
        // "restart", "redeliver_events", "defer_new_tickets" — can be added later
      }
    }
  }

  private async handleStatusUpdate(request: Request): Promise<Response> {
    const { ticketId, status, pr_url, branch_name, slack_thread_ts, transcript_r2_key, agent_active } = await request.json<{
      ticketId: string;
      status?: string;
      pr_url?: string;
      branch_name?: string;
      slack_thread_ts?: string;
      transcript_r2_key?: string;
      agent_active?: number;
    }>();

    // Log phone-home payloads so they appear in wrangler tail
    console.log(`[Orchestrator] status update: ticket=${ticketId} status=${status} branch=${branch_name || ""} agent_active=${agent_active ?? "unset"}`);

    // Reject heartbeats/status updates for tickets already in a terminal state.
    // This prevents agent containers from overwriting supervisor kill decisions.
    const currentRow = this.ctx.storage.sql.exec(
      "SELECT status FROM tickets WHERE id = ?", ticketId
    ).toArray()[0] as { status: string } | undefined;
    if (currentRow && (TERMINAL_STATUSES as readonly string[]).includes(currentRow.status)) {
      // Allow explicit agent_active=0 (dashboard kill) but block heartbeats
      if (agent_active === undefined || agent_active !== 0) {
        console.log(`[Orchestrator] Ignoring status update for terminal ticket ${ticketId} (current: ${currentRow.status})`);
        return Response.json({ ok: true, ignored: true, reason: "terminal ticket" });
      }
    }

    const updates: string[] = ["updated_at = datetime('now')", "last_heartbeat = datetime('now')"];
    const values: (string | number | null)[] = [];

    // Allow explicit control of agent_active flag (for dashboard kill operations)
    if (agent_active !== undefined) {
      updates.push("agent_active = ?");
      values.push(agent_active);
      console.log(`[Orchestrator] Explicitly setting agent_active=${agent_active} for ticket ${ticketId}`);
    }

    if (status) {
      updates.push("status = ?");
      values.push(status);

      // Terminal states: mark agent as inactive so we don't spawn new agents
      // on deployment-triggered events
      if ((TERMINAL_STATUSES as readonly string[]).includes(status)) {
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

    // When a PR URL is first reported, check if CI already passed and trigger merge gate.
    // This closes the race condition where check_suite webhook arrives before the agent
    // reports the PR URL, causing the merge gate to be skipped.
    if (pr_url && status === "pr_open") {
      const ticketRow = this.ctx.storage.sql.exec(
        "SELECT product FROM tickets WHERE id = ?", ticketId
      ).toArray()[0] as { product: string } | undefined;
      if (ticketRow) {
        console.log(`[Orchestrator] PR URL reported for ${ticketId}, checking CI status for merge gate...`);
        // Run async — don't block the status update response
        this.evaluateMergeGate(ticketId, ticketRow.product).catch(err =>
          console.error(`[Orchestrator] Merge gate check on PR report failed for ${ticketId}:`, err)
        );
      }
    }

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

  private async cleanupInactiveAgents(): Promise<Response> {
    // Force shutdown of containers for tickets marked inactive (agent_active = 0).
    // This handles the case where agents transitioned to terminal state before the
    // /shutdown fix was deployed — their containers are still running but should stop.
    const inactiveTickets = this.ctx.storage.sql.exec(
      `SELECT id FROM tickets WHERE agent_active = 0`
    ).toArray() as Array<{ id: string }>;

    console.log(`[Orchestrator] Cleanup: found ${inactiveTickets.length} inactive tickets`);

    const results: Array<{ ticketId: string; success: boolean; error?: string }> = [];

    for (const ticket of inactiveTickets) {
      try {
        const id = this.env.TICKET_AGENT.idFromName(ticket.id);
        const agent = this.env.TICKET_AGENT.get(id);

        // Call /mark-terminal which will invoke /shutdown on the container
        const res = await agent.fetch(new Request("http://internal/mark-terminal", {
          method: "POST",
        }));

        if (res.ok) {
          console.log(`[Orchestrator] Cleanup: shutdown requested for ${ticket.id}`);
          results.push({ ticketId: ticket.id, success: true });
        } else {
          console.warn(`[Orchestrator] Cleanup: failed to shutdown ${ticket.id}: ${res.status}`);
          results.push({ ticketId: ticket.id, success: false, error: `HTTP ${res.status}` });
        }
      } catch (err) {
        console.error(`[Orchestrator] Cleanup: error shutting down ${ticket.id}:`, err);
        results.push({ ticketId: ticket.id, success: false, error: String(err) });
      }
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`[Orchestrator] Cleanup complete: ${successCount}/${results.length} successful`);

    return Response.json({
      ok: true,
      total: inactiveTickets.length,
      successful: successCount,
      results,
    });
  }

  private async shutdownAllAgents(): Promise<Response> {
    // Force shutdown of ALL agent containers, regardless of state.
    // Use case: operator wants to stop all work immediately.

    // Get ALL tickets (active and inactive)
    const allTickets = this.ctx.storage.sql.exec(
      `SELECT id, status, agent_active FROM tickets`
    ).toArray() as Array<{ id: string; status: string; agent_active: number }>;

    console.log(`[Orchestrator] Shutdown all: found ${allTickets.length} total tickets`);

    // Mark all as inactive
    this.ctx.storage.sql.exec(`UPDATE tickets SET agent_active = 0`);
    console.log(`[Orchestrator] Marked all agents as inactive`);

    const results: Array<{ ticketId: string; previousStatus: string; success: boolean; error?: string }> = [];

    // Shut down all containers
    for (const ticket of allTickets) {
      try {
        const id = this.env.TICKET_AGENT.idFromName(ticket.id);
        const agent = this.env.TICKET_AGENT.get(id);

        // Call /mark-terminal which will invoke /shutdown on the container
        const res = await agent.fetch(new Request("http://internal/mark-terminal", {
          method: "POST",
        }));

        if (res.ok) {
          console.log(`[Orchestrator] Shutdown all: shutdown requested for ${ticket.id}`);
          results.push({ ticketId: ticket.id, previousStatus: ticket.status, success: true });
        } else {
          console.warn(`[Orchestrator] Shutdown all: failed to shutdown ${ticket.id}: ${res.status}`);
          results.push({ ticketId: ticket.id, previousStatus: ticket.status, success: false, error: `HTTP ${res.status}` });
        }
      } catch (err) {
        console.error(`[Orchestrator] Shutdown all: error shutting down ${ticket.id}:`, err);
        results.push({ ticketId: ticket.id, previousStatus: ticket.status, success: false, error: String(err) });
      }
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`[Orchestrator] Shutdown all complete: ${successCount}/${results.length} successful`);

    return Response.json({
      ok: true,
      total: allTickets.length,
      successful: successCount,
      failed: results.length - successCount,
      results,
    });
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

  private getSystemStatus(): Response {
    // Get active agents
    const activeAgents = this.ctx.storage.sql.exec(
      `SELECT id, product, status, last_heartbeat, created_at, updated_at, pr_url, branch_name, slack_thread_ts, slack_channel
       FROM tickets
       WHERE agent_active = 1
       ORDER BY updated_at DESC`,
    ).toArray() as Array<{
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

    // Get recent completed tickets (last 24 hours)
    const recentCompleted = this.ctx.storage.sql.exec(
      `SELECT id, product, status, updated_at, pr_url
       FROM tickets
       WHERE agent_active = 0
         AND (julianday('now') - julianday(updated_at)) * 24 < 24
       ORDER BY updated_at DESC
       LIMIT 10`,
    ).toArray() as Array<{
      id: string;
      product: string;
      status: string;
      updated_at: string;
      pr_url: string | null;
    }>;

    // Get stale agents (no heartbeat in 30 minutes)
    const staleAgents = this.ctx.storage.sql.exec(
      `SELECT id, product, status, last_heartbeat
       FROM tickets
       WHERE agent_active = 1
         AND last_heartbeat IS NOT NULL
         AND (julianday('now') - julianday(last_heartbeat)) * 24 * 60 > 30`,
    ).toArray() as Array<{
      id: string;
      product: string;
      status: string;
      last_heartbeat: string;
    }>;

    return Response.json({
      activeAgents,
      recentCompleted,
      staleAgents,
      summary: {
        totalActive: activeAgents.length,
        totalCompleted: recentCompleted.length,
        totalStale: staleAgents.length,
      },
    });
  }

  private async handleStatusCommand(channel: string, threadTs: string): Promise<void> {
    try {
      const statusData = (await this.getSystemStatus().json()) as {
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
        recentCompleted: Array<{
          id: string;
          product: string;
          status: string;
          updated_at: string;
          pr_url: string | null;
        }>;
        staleAgents: Array<{
          id: string;
          product: string;
          status: string;
          last_heartbeat: string;
        }>;
        summary: {
          totalActive: number;
          totalCompleted: number;
          totalStale: number;
        };
      };

      let message = `*🤖 Product Engineer Status*\n\n`;

      // Summary
      message += `*Summary:*\n`;
      message += `• Active agents: ${statusData.summary.totalActive}\n`;
      message += `• Completed (24h): ${statusData.summary.totalCompleted}\n`;
      if (statusData.summary.totalStale > 0) {
        message += `• ⚠️ Stale agents: ${statusData.summary.totalStale}\n`;
      }
      message += `\n`;

      // Active agents
      if (statusData.activeAgents.length > 0) {
        message += `*Active Agents:*\n`;
        for (const agent of statusData.activeAgents) {
          const healthEmoji = agent.last_heartbeat
            ? this.getHealthEmoji(agent.last_heartbeat)
            : "❓";
          const statusEmoji = this.getStatusEmoji(agent.status);
          const timeSinceUpdate = this.getTimeAgo(agent.updated_at);

          message += `${healthEmoji} ${statusEmoji} \`${agent.id}\` (${agent.product})\n`;
          message += `   Status: ${agent.status} · Updated: ${timeSinceUpdate}\n`;
          if (agent.pr_url) {
            message += `   PR: ${agent.pr_url}\n`;
          }
          if (agent.slack_thread_ts) {
            const threadChannel = agent.slack_channel || channel;
            message += `   Thread: <#${threadChannel}|thread> (${agent.slack_thread_ts})\n`;
          }
        }
        message += `\n`;
      } else {
        message += `*No active agents*\n\n`;
      }

      // Stale agents warning
      if (statusData.staleAgents.length > 0) {
        message += `*⚠️ Stale Agents (no heartbeat >30min):*\n`;
        for (const agent of statusData.staleAgents) {
          const minutesStale = Math.floor(
            (Date.now() - new Date(agent.last_heartbeat).getTime()) / 60000
          );
          message += `• \`${agent.id}\` (${agent.product}) - ${minutesStale}m ago\n`;
        }
        message += `\n`;
      }

      // Recent completions
      if (statusData.recentCompleted.length > 0) {
        message += `*Recent Completions (24h):*\n`;
        for (const ticket of statusData.recentCompleted.slice(0, 5)) {
          const statusEmoji = this.getStatusEmoji(ticket.status);
          const timeAgo = this.getTimeAgo(ticket.updated_at);
          message += `${statusEmoji} \`${ticket.id}\` (${ticket.product}) - ${timeAgo}\n`;
          if (ticket.pr_url) {
            message += `   ${ticket.pr_url}\n`;
          }
        }
      }

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
        console.error(`[Orchestrator] Slack API error: ${res.status} ${res.statusText}`);
        return;
      }

      const json = (await res.json()) as { ok: boolean; error?: string };
      if (!json.ok) {
        console.error(`[Orchestrator] Slack API error: ${json.error}`);
        return;
      }

      console.log(`[Orchestrator] Posted status to channel=${channel}`);
    } catch (err) {
      console.error("[Orchestrator] Failed to handle status command:", err);
    }
  }

  private getHealthEmoji(lastHeartbeat: string): string {
    const minutesSinceHeartbeat = Math.floor(
      (Date.now() - new Date(lastHeartbeat).getTime()) / 60000
    );
    if (minutesSinceHeartbeat < 5) return "💚"; // Fresh
    if (minutesSinceHeartbeat < 15) return "💛"; // Recent
    if (minutesSinceHeartbeat < 30) return "🧡"; // Getting stale
    return "❤️"; // Stale
  }

  private getStatusEmoji(status: string): string {
    const statusMap: Record<string, string> = {
      in_progress: "⏳",
      pr_open: "👀",
      in_review: "👀",
      needs_revision: "🔄",
      merged: "✅",
      closed: "✅",
      failed: "❌",
      deferred: "⏸️",
      asking: "❓",
    };
    return statusMap[status] || "⏳";
  }

  private getTimeAgo(timestamp: string): string {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
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
      slash_command?: string;
    }>();

    // Handle slash commands or /pe-status mentions
    const isStatusCommand =
      slackEvent.slash_command === "agent-status" ||
      (slackEvent.type === "app_mention" &&
        typeof slackEvent.text === "string" &&
        /(^|\s)\/agent-status(\s|$)/.test(slackEvent.text));

    if (isStatusCommand) {
      console.log(
        `[Orchestrator] Received /agent-status command from user=${slackEvent.user} channel=${slackEvent.channel}`,
      );
      const targetTs = slackEvent.thread_ts || slackEvent.ts || "";
      await this.handleStatusCommand(slackEvent.channel || "", targetTs);
      return Response.json({ ok: true, handled: "status_command" });
    }

    // If it's a thread reply, look up existing ticket by thread_ts
    if (slackEvent.thread_ts) {
      console.log(`[Orchestrator] Thread reply received: thread_ts=${slackEvent.thread_ts} type=${slackEvent.type} user=${slackEvent.user || "unknown"}`);
      const rows = this.ctx.storage.sql.exec(
        "SELECT id, product, status, agent_active FROM tickets WHERE slack_thread_ts = ?",
        slackEvent.thread_ts,
      ).toArray() as { id: string; product: string; status: string; agent_active: number }[];

      if (rows.length > 0) {
        const ticket = rows[0];
        console.log(`[Orchestrator] Thread reply matched ticket=${ticket.id} product=${ticket.product}`);

        // Don't re-activate terminal tickets
        if ((TERMINAL_STATUSES as readonly string[]).includes(ticket.status)) {
          console.log(`[Orchestrator] Thread reply for terminal ticket ${ticket.id} (status=${ticket.status}) — ignoring`);
          return Response.json({ ok: true, ignored: true, reason: "terminal ticket" });
        }

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

    const slackThreadTs = slackEvent.thread_ts || slackEvent.ts;

    // Create a Linear ticket instead of spawning an agent directly.
    // The Linear webhook will handle ticket creation → agent spawning.
    const productConfig = products[product];
    const projectName = productConfig.triggers?.linear?.project_name;
    if (!projectName) {
      await this.postSlackError(
        slackEvent.channel || "",
        slackThreadTs || "",
        `❌ No Linear project configured for this product. Cannot create ticket.`,
      );
      return Response.json({ error: "no linear project for product" }, { status: 400 });
    }

    // Load settings for Linear API
    const settings = this.ctx.storage.sql.exec("SELECT key, value FROM settings").toArray() as Array<{ key: string; value: string }>;
    const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const teamId = settingsMap.linear_team_id;
    const appUserId = settingsMap.linear_app_user_id;
    const linearToken = this.getLinearAppToken();

    if (!teamId || !linearToken) {
      await this.postSlackError(
        slackEvent.channel || "",
        slackThreadTs || "",
        `❌ Linear integration not configured (missing team ID or token).`,
      );
      return Response.json({ error: "linear not configured" }, { status: 500 });
    }

    // Strip the @mention from the text to get the raw request
    const rawText = (slackEvent.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();

    // Generate a concise title from the request (first sentence or first 80 chars)
    const title = rawText.length <= 80
      ? rawText
      : rawText.split(/[.!?\n]/)[0].slice(0, 80).trim() || rawText.slice(0, 80).trim();

    // Look up the Linear project ID by name
    const projectRes = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${linearToken}`,
      },
      body: JSON.stringify({
        query: `query($teamId: String!) {
          team(id: $teamId) {
            projects { nodes { id name } }
          }
        }`,
        variables: { teamId },
      }),
    });

    let projectId: string | null = null;
    if (projectRes.ok) {
      const projectData = await projectRes.json() as {
        data?: { team?: { projects?: { nodes?: Array<{ id: string; name: string }> } } };
        errors?: Array<{ message: string }>;
      };
      if (projectData.errors) {
        console.error(`[Orchestrator] Linear project lookup errors:`, JSON.stringify(projectData.errors));
      }
      const normalizedName = projectName.toLowerCase();
      const projects = projectData.data?.team?.projects?.nodes || [];
      projectId = projects.find(p => p.name.toLowerCase() === normalizedName)?.id || null;
      console.log(`[Orchestrator] Project lookup: name="${projectName}" found=${!!projectId} (${projects.length} projects in team)`);
    } else {
      console.error(`[Orchestrator] Linear project lookup failed: ${projectRes.status} ${await projectRes.text().catch(() => "")}`);
    }

    // Create the Linear issue
    console.log(`[Orchestrator] Creating Linear issue: team=${teamId} project=${projectId} assignee=${appUserId} title="${title}"`);
    const createRes = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${linearToken}`,
      },
      body: JSON.stringify({
        query: `mutation($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id identifier url }
          }
        }`,
        variables: {
          input: {
            teamId,
            title,
            description: `**Slack request from <@${slackEvent.user}>:**\n\n${rawText}`,
            ...(projectId && { projectId }),
            ...(appUserId && { assigneeId: appUserId }),
          },
        },
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error(`[Orchestrator] Failed to create Linear issue: ${createRes.status} ${errText}`);
      await this.postSlackError(
        slackEvent.channel || "",
        slackThreadTs || "",
        `❌ Failed to create Linear ticket. Please try again or create one manually.`,
      );
      return Response.json({ error: "linear issue creation failed" }, { status: 500 });
    }

    const createData = await createRes.json() as {
      data?: { issueCreate?: { success: boolean; issue?: { id: string; identifier: string; url: string } } }
    };
    const issue = createData.data?.issueCreate?.issue;

    if (!issue) {
      console.error("[Orchestrator] Linear issueCreate returned no issue:", JSON.stringify(createData));
      await this.postSlackError(
        slackEvent.channel || "",
        slackThreadTs || "",
        `❌ Failed to create Linear ticket. Please try again or create one manually.`,
      );
      return Response.json({ error: "linear issue creation failed" }, { status: 500 });
    }

    console.log(`[Orchestrator] Created Linear issue ${issue.identifier} (${issue.id}) from Slack mention`);

    // Post acknowledgment with Linear ticket link
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${(this.env as Record<string, unknown>).SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: slackEvent.channel,
        thread_ts: slackThreadTs,
        text: `📋 Created <${issue.url}|${issue.identifier}>: ${title}\n⏳ Working on it...`,
      }),
    }).catch(err => console.warn("[Orchestrator] Failed to post ack:", err));

    // Store the Slack thread association so the Linear webhook handler can link them.
    // The webhook will arrive shortly and create the ticket entry via handleEvent.
    this.ctx.storage.sql.exec(
      `INSERT INTO slack_thread_map (linear_issue_id, slack_thread_ts, slack_channel)
       VALUES (?, ?, ?)
       ON CONFLICT(linear_issue_id) DO UPDATE SET
         slack_thread_ts = excluded.slack_thread_ts,
         slack_channel = excluded.slack_channel`,
      issue.id, slackThreadTs || null, slackEvent.channel || null,
    );

    return Response.json({ ok: true, linearIssue: issue.identifier });
  }

}
