import { Container } from "@cloudflare/containers";
import { TERMINAL_STATUSES, TICKET_STATES, type TicketEvent, type Bindings } from "./types";
import type { ProductConfig } from "./registry";
import { DecisionEngine } from "./decision-engine";
import { ContextAssembler } from "./context-assembler";
import { AgentManager, type SpawnConfig } from "./agent-manager";

function sanitizeTicketUUID(id: string): string {
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
    ticketUUID: sanitizeTicketUUID((data.ticketUUID || data.id || `${source}-${Date.now()}`) as string),
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
  private agentManager!: AgentManager;

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

    // Run LLM supervisor tick — checks agent health, stale PRs, queued tickets
    try {
      await this.runSupervisorTick();
    } catch (err) {
      console.error("[Orchestrator] Supervisor tick failed:", err);
      // Don't let supervisor failures break the alarm loop
    }

    // Process pending merge gate retries (persisted in SQLite, survives DO restarts)
    const pendingRetries = this.ctx.storage.sql.exec(
      "SELECT ticket_uuid, product, retry_count FROM merge_gate_retries WHERE next_retry_at <= datetime('now')"
    ).toArray() as Array<{ ticket_uuid: string; product: string; retry_count: number }>;

    for (const retry of pendingRetries) {
      // Verify ticket is still eligible (pr_open, not terminal)
      const row = this.ctx.storage.sql.exec(
        "SELECT status, pr_url FROM tickets WHERE ticket_uuid = ?", retry.ticket_uuid
      ).toArray()[0] as { status: string; pr_url: string | null } | undefined;

      if (!row?.pr_url || this.agentManager.isTerminalStatus(row.status)) {
        console.log(`[Orchestrator] Merge gate retry skipped for ${retry.ticket_uuid} (status=${row?.status}, pr_url=${!!row?.pr_url})`);
        this.ctx.storage.sql.exec("DELETE FROM merge_gate_retries WHERE ticket_uuid = ?", retry.ticket_uuid);
        continue;
      }

      console.log(`[Orchestrator] Retrying merge gate for ${retry.ticket_uuid} (Copilot review pending, attempt ${retry.retry_count})`);
      this.evaluateMergeGate(retry.ticket_uuid, retry.product).catch(err =>
        console.error(`[Orchestrator] Merge gate retry failed for ${retry.ticket_uuid}:`, err)
      );
    }

    // Schedule next alarm — pick the earliest of: supervisor (5 min) or next pending retry
    const nextRetryRow = this.ctx.storage.sql.exec(
      "SELECT MIN(next_retry_at) as next_at FROM merge_gate_retries"
    ).toArray()[0] as { next_at: string | null } | undefined;
    let nextAlarmMs = Date.now() + 300_000; // default: 5 min supervisor tick
    if (nextRetryRow?.next_at) {
      // SQLite datetime() returns "YYYY-MM-DD HH:MM:SS" — add "T" separator and "Z" suffix
      // to form valid ISO-8601 for JS Date parsing
      const isoStr = nextRetryRow.next_at.replace(" ", "T") + "Z";
      const retryMs = new Date(isoStr).getTime();
      if (!Number.isNaN(retryMs)) {
        nextAlarmMs = Math.min(nextAlarmMs, retryMs);
      }
    }
    this.ctx.storage.setAlarm(nextAlarmMs);

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

  // Merge gate retry constants — state is persisted in SQLite (merge_gate_retries table)
  // Single retry (90s) to detect Copilot availability; if not present, assume not enabled
  private static MAX_MERGE_GATE_RETRIES = 1;
  private static MERGE_GATE_RETRY_DELAY_MS = 90_000; // 90 seconds
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

  /** Get the Slack bot token from env. */
  private getSlackBotToken(): string {
    return (this.env.SLACK_BOT_TOKEN as string) || "";
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
        ticket_uuid TEXT PRIMARY KEY,
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
        ticket_uuid TEXT PRIMARY KEY,
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
        ticket_uuid TEXT NOT NULL,
        product TEXT NOT NULL,
        priority INTEGER DEFAULT 3,
        payload TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Ticket metrics table — tracks outcome and efficiency metrics per ticket
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS ticket_metrics (
        ticket_uuid TEXT PRIMARY KEY,
        outcome TEXT,
        pr_count INTEGER NOT NULL DEFAULT 0,
        revision_count INTEGER NOT NULL DEFAULT 0,
        total_agent_time_ms INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0.0,
        hands_on_sessions INTEGER NOT NULL DEFAULT 0,
        hands_on_notes TEXT,
        first_response_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Decision feedback table — tracks human feedback on orchestrator decisions
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS decision_feedback (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL,
        feedback TEXT NOT NULL,
        details TEXT,
        given_by TEXT,
        given_at TEXT NOT NULL,
        slack_message_ts TEXT,
        UNIQUE(decision_id)
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
    // Migration: add slack_message_ts to decision_log for feedback tracking
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE decision_log ADD COLUMN slack_message_ts TEXT`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (!message.includes("duplicate column") && !message.includes("already exists")) {
        console.error("[Orchestrator] Failed to add slack_message_ts column:", err);
        throw err;
      }
    }
    // Migration: add identifier column to tickets for human-readable IDs like BC-137
    // (will be renamed to ticket_id by a later migration)
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tickets ADD COLUMN identifier TEXT`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (!message.includes("duplicate column") && !message.includes("already exists")) {
        console.error("[Orchestrator] Failed to add identifier column:", err);
        throw err;
      }
    }
    // Migration: add title column to tickets
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tickets ADD COLUMN title TEXT`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (!message.includes("duplicate column") && !message.includes("already exists")) {
        console.error("[Orchestrator] Failed to add title column:", err);
        throw err;
      }
    }
    // Migration: add agent_message column — stores last phone-home log message from agent (observability only)
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tickets ADD COLUMN agent_message TEXT`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
        console.error("[Orchestrator] Failed to add agent_message column:", err);
        throw err;
      }
    }
    // Migration: add checks_passed flag — set when check_suite webhook arrives before PR URL
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tickets ADD COLUMN checks_passed INTEGER DEFAULT 0`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
        console.error("[Orchestrator] Failed to add checks_passed column:", err);
        throw err;
      }
    }
    // Migration: add last_merge_decision_sha — stores composite fingerprint of merge-relevant state
    // (head SHA, CI status, Copilot review, mergeable state, review count) to deduplicate merge gate decisions
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tickets ADD COLUMN last_merge_decision_sha TEXT`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
        console.error("[Orchestrator] Failed to add last_merge_decision_sha column:", err);
        throw err;
      }
    }
    // Merge gate retry state — persisted so it survives DO restarts/deploys
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS merge_gate_retries (
        ticket_uuid TEXT PRIMARY KEY,
        product TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'copilot'
      )
    `);
    // Migration: add phase column if missing (existing deployments)
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE merge_gate_retries ADD COLUMN phase TEXT NOT NULL DEFAULT 'copilot'`);
    } catch {
      // Column already exists
    }

    // Migration: rename id → ticket_uuid
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tickets RENAME COLUMN id TO ticket_uuid`);
    } catch {
      // Column already renamed or table created with new name
    }
    // Migration: rename identifier → ticket_id
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE tickets RENAME COLUMN identifier TO ticket_id`);
    } catch {
      // Column already renamed or table created with new name
    }
    // Migration: rename ticket_id → ticket_uuid in merge_gate_retries
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE merge_gate_retries RENAME COLUMN ticket_id TO ticket_uuid`);
    } catch {}
    // Migration: rename ticket_id → ticket_uuid in token_usage
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE token_usage RENAME COLUMN ticket_id TO ticket_uuid`);
    } catch {}
    // Migration: rename ticket_id → ticket_uuid in ticket_queue
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE ticket_queue RENAME COLUMN ticket_id TO ticket_uuid`);
    } catch {}
    // Migration: rename ticket_id → ticket_uuid in ticket_metrics
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE ticket_metrics RENAME COLUMN ticket_id TO ticket_uuid`);
    } catch {}

    this.dbInitialized = true;

    // Initialize AgentManager after tables are created
    this.agentManager = new AgentManager(
      { exec: (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params) },
      this.env as Record<string, unknown>,
    );
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
      case "/slack-interactive":
        return this.handleSlackInteractive(request);
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
      case "/metrics":
        return this.getMetrics(request);
      case "/metrics/summary":
        return this.getMetricsSummary();
      case "/decision-feedback":
        return this.handleDecisionFeedback(request);
      default:
        // Handle dynamic routes
        if (url.pathname.startsWith("/ticket-status/")) {
          const ticketUUID = decodeURIComponent(url.pathname.slice("/ticket-status/".length));
          const ticket = this.agentManager.getTicket(ticketUUID);
          if (!ticket) return Response.json({ error: "not found" }, { status: 404 });
          return Response.json({
            agent_active: ticket.agent_active,
            status: ticket.status,
            product: ticket.product,
            terminal: this.agentManager.isTerminal(ticketUUID),
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
    event.ticketUUID = sanitizeTicketUUID(event.ticketUUID);
    console.log(`[Orchestrator] handleEvent: type=${event.type} ticketUUID=${event.ticketUUID} source=${event.source}`);

    // Resolve branch-extracted task IDs (e.g. "PES-5") to their UUID ticket.
    // GitHub webhooks extract taskId from branch names like "ticket/PES-5",
    // but the canonical ticket is stored under the Linear UUID. Look up by branch_name
    // first, then fall back to ticket_id (e.g., "PES-5" matches tickets.ticket_id).
    if (event.source === "github") {
      const byBranch = this.ctx.storage.sql.exec(
        "SELECT ticket_uuid FROM tickets WHERE branch_name = ? OR branch_name = ?",
        `ticket/${event.ticketUUID}`, `feedback/${event.ticketUUID}`,
      ).toArray()[0] as { ticket_uuid: string } | undefined;
      if (byBranch) {
        console.log(`[Orchestrator] Resolved branch task ID ${event.ticketUUID} → ${byBranch.ticket_uuid}`);
        event.ticketUUID = byBranch.ticket_uuid;
      } else {
        // branch_name may not be set yet — fall back to ticket_id lookup
        const byIdentifier = this.agentManager.getTicketByIdentifier(event.ticketUUID);
        if (byIdentifier) {
          console.log(`[Orchestrator] Resolved identifier ${event.ticketUUID} → ${byIdentifier.ticket_uuid}`);
          event.ticketUUID = byIdentifier.ticket_uuid;
        }
      }
    }

    // Check if this ticket is already in a terminal state — don't re-activate it
    if (this.agentManager.isTerminal(event.ticketUUID)) {
      const existing = this.agentManager.getTicket(event.ticketUUID);
      console.log(`[Orchestrator] Ignoring event for terminal ticket ${event.ticketUUID} (status: ${existing?.status})`);
      return Response.json({ ok: true, ticketUUID: event.ticketUUID, ignored: true, reason: "terminal ticket" });
    }

    // For Linear events, look up Slack thread from slack_thread_map (Slack-originated tickets)
    if (event.source === "linear" && !event.slackThreadTs) {
      const threadMap = this.ctx.storage.sql.exec(
        "SELECT slack_thread_ts, slack_channel FROM slack_thread_map WHERE linear_issue_id = ?",
        event.ticketUUID,
      ).toArray()[0] as { slack_thread_ts: string; slack_channel: string } | undefined;
      if (threadMap) {
        event.slackThreadTs = threadMap.slack_thread_ts || undefined;
        event.slackChannel = threadMap.slack_channel || undefined;
        console.log(`[Orchestrator] Linked Linear issue ${event.ticketUUID} to Slack thread ${threadMap.slack_thread_ts}`);
        // Clean up — one-time mapping
        this.ctx.storage.sql.exec("DELETE FROM slack_thread_map WHERE linear_issue_id = ?", event.ticketUUID);
      }
    }

    // Create or update ticket
    const payload = event.payload as Record<string, unknown>;
    const ticketId = (payload.identifier as string) || null;
    const title = (payload.title as string) || null;
    const existingTicket = this.agentManager.getTicket(event.ticketUUID);
    if (!existingTicket) {
      this.agentManager.createTicket({
        ticketUUID: event.ticketUUID,
        product: event.product,
        slackThreadTs: event.slackThreadTs || undefined,
        slackChannel: event.slackChannel || undefined,
        ticketId: ticketId || undefined,
        title: title || undefined,
      });
    } else {
      // Update metadata — preserve existing values when new ones are null
      const metadataUpdate: Record<string, string | undefined> = {};
      if (event.slackThreadTs) metadataUpdate.slack_thread_ts = event.slackThreadTs;
      if (event.slackChannel) metadataUpdate.slack_channel = event.slackChannel;
      if (Object.keys(metadataUpdate).length > 0) {
        this.agentManager.updateStatus(event.ticketUUID, metadataUpdate as any);
      }
    }

    // Initialize ticket_metrics row if not exists
    this.ctx.storage.sql.exec(
      `INSERT INTO ticket_metrics (ticket_uuid) VALUES (?)
       ON CONFLICT(ticket_uuid) DO NOTHING`,
      event.ticketUUID,
    );

    // For new tickets, use LLM ticket review instead of direct routing
    if (event.type === "ticket_created") {
      await this.handleTicketReview(event);
      return Response.json({ ok: true, ticketUUID: event.ticketUUID });
    }

    // For Linear comments, route to running agent or re-evaluate via ticket review
    if (event.type === "linear_comment") {
      const ticketRow = this.agentManager.getTicket(event.ticketUUID);

      if (ticketRow && this.agentManager.isTerminal(event.ticketUUID)) {
        console.log(`[Orchestrator] Ignoring linear_comment for terminal ticket ${event.ticketUUID} (status: ${ticketRow.status})`);
      } else if (ticketRow?.agent_active) {
        // Forward to running agent like a Slack reply
        await this.agentManager.sendEvent(event.ticketUUID, event);
      } else {
        // No agent running — re-evaluate via ticket review
        await this.handleTicketReview(event);
      }
      return Response.json({ ok: true, ticketUUID: event.ticketUUID });
    }

    // CI passed + PR exists → evaluate merge gate (orchestrator decides, not agent)
    if (event.type === "checks_passed") {
      let ticketRow = this.agentManager.getTicket(event.ticketUUID);

      // Branch names use the human-readable identifier (e.g., ticket/PES-23),
      // but the canonical ticket ID is the Linear UUID. Fall back to ticket_id lookup.
      if (!ticketRow) {
        const byIdentifier = this.agentManager.getTicketByIdentifier(event.ticketUUID);
        if (byIdentifier) {
          console.log(`[Orchestrator] checks_passed: resolved identifier ${event.ticketUUID} → ticket ${byIdentifier.ticket_uuid}`);
          ticketRow = byIdentifier;
        }
      }

      if (ticketRow?.pr_url) {
        await this.evaluateMergeGate(ticketRow.ticket_uuid, event.product);
        return Response.json({ ok: true, ticketUUID: ticketRow.ticket_uuid });
      }

      // PR URL not set yet — store checks_passed flag so merge gate triggers
      // when the agent later reports the PR URL via handleStatusUpdate.
      if (ticketRow) {
        console.log(`[Orchestrator] checks_passed for ${ticketRow.ticket_uuid} but no PR URL yet — storing flag for deferred merge gate`);
        this.ctx.storage.sql.exec(
          "UPDATE tickets SET checks_passed = 1, updated_at = datetime('now') WHERE ticket_uuid = ?",
          ticketRow.ticket_uuid,
        );
        return Response.json({ ok: true, ticketUUID: ticketRow.ticket_uuid, deferred: true });
      }
      // Ticket not found — route to agent normally
    }

    // Handle PR merged/closed events directly in orchestrator — don't route to agent.
    // The agent container may have already exited, so routing via sendEvent would silently
    // drop the event (sendEvent requires agent_active=1). Update status here instead.
    if (event.type === "pr_merged") {
      const ticketRow = this.agentManager.getTicket(event.ticketUUID);
      if (ticketRow) {
        console.log(`[Orchestrator] PR merged for ${event.ticketUUID} — marking terminal`);
        try {
          this.agentManager.updateStatus(event.ticketUUID, { status: "merged" });
        } catch {
          // Force update if state transition is invalid (e.g., already in a terminal state)
          this.ctx.storage.sql.exec(
            "UPDATE tickets SET status = 'merged', agent_active = 0, updated_at = datetime('now') WHERE ticket_uuid = ?",
            event.ticketUUID,
          );
        }
        // Clean up merge gate retries
        this.ctx.storage.sql.exec("DELETE FROM merge_gate_retries WHERE ticket_uuid = ?", event.ticketUUID);
        await this.agentManager.stopAgent(event.ticketUUID, "pr_merged").catch(err =>
          console.warn(`[Orchestrator] Failed to stop agent on pr_merged:`, err)
        );
        return Response.json({ ok: true, ticketUUID: event.ticketUUID, status: "merged" });
      }
    }

    if (event.type === "pr_closed") {
      const ticketRow = this.agentManager.getTicket(event.ticketUUID);
      if (ticketRow) {
        console.log(`[Orchestrator] PR closed (not merged) for ${event.ticketUUID} — marking terminal`);
        try {
          this.agentManager.updateStatus(event.ticketUUID, { status: "closed" });
        } catch {
          // Force update if state transition is invalid
          this.ctx.storage.sql.exec(
            "UPDATE tickets SET status = 'closed', agent_active = 0, updated_at = datetime('now') WHERE ticket_uuid = ?",
            event.ticketUUID,
          );
        }
        // Clean up merge gate retries
        this.ctx.storage.sql.exec("DELETE FROM merge_gate_retries WHERE ticket_uuid = ?", event.ticketUUID);
        await this.agentManager.stopAgent(event.ticketUUID, "pr_closed").catch(err =>
          console.warn(`[Orchestrator] Failed to stop agent on pr_closed:`, err)
        );
        return Response.json({ ok: true, ticketUUID: event.ticketUUID, status: "closed" });
      }
    }

    // Route to TicketAgent for all other event types
    await this.agentManager.sendEvent(event.ticketUUID, event);

    return Response.json({ ok: true, ticketUUID: event.ticketUUID });
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
    const ticketRow = this.agentManager.getTicket(event.ticketUUID) as Record<string, unknown> | null;

    // Skip ticket review if agent is already running or ticket is past initial triage.
    // Linear sends multiple webhooks (create + update) and we don't want to re-review
    // a ticket that already has an active agent.
    if (ticketRow) {
      const status = ticketRow.status as string;
      const agentActive = ticketRow.agent_active as number;
      if (agentActive === 1 || (status !== "created" && status !== "needs_info")) {
        console.log(`[Orchestrator] Skipping ticket review for ${event.ticketUUID} — already active (status=${status}, agent_active=${agentActive})`);
        return;
      }
    }

    // Transition to reviewing state (ticket review = the review phase)
    try {
      this.agentManager.updateStatus(event.ticketUUID, { status: "reviewing" });
    } catch {
      // May already be in reviewing state — ignore
    }

    const context = await assembler.forTicketReview({
      ticketUUID: event.ticketUUID,
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
    const displayId = (payload.identifier as string) || event.ticketUUID;
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
      linearIssueId: event.ticketUUID,
    });

    // Act on decision
    switch (decision.action) {
      case "start_agent": {
        const model = decision.model || "sonnet";

        // Build spawn config from product
        const gatewayRows = this.ctx.storage.sql.exec(
          "SELECT value FROM settings WHERE key = 'cloudflare_ai_gateway'"
        ).toArray() as Array<{ value: string }>;
        const gatewayConfig = gatewayRows.length > 0 ? JSON.parse(gatewayRows[0].value) : null;

        const spawnConfig: SpawnConfig = {
          product: event.product,
          repos: productConfig.repos,
          slackChannel: productConfig.slack_channel_id || productConfig.slack_channel,
          slackThreadTs: event.slackThreadTs || (ticketRow?.slack_thread_ts as string) || undefined,
          secrets: productConfig.secrets,
          gatewayConfig,
          model,
        };

        try {
          await this.agentManager.spawnAgent(event.ticketUUID, spawnConfig);
          await this.agentManager.sendEvent(event.ticketUUID, event);
        } catch (err) {
          console.error(`[Orchestrator] Failed to spawn agent for ${event.ticketUUID}:`, err);
        }
        break;
      }
      case "ask_questions": {
        // Update status to needs_info
        try {
          this.agentManager.updateStatus(event.ticketUUID, { status: "needs_info" });
        } catch (err) {
          console.warn(`[Orchestrator] Failed to set needs_info for ${event.ticketUUID}:`, err);
        }

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
                variables: { issueId: event.ticketUUID, body: linearBody },
              }),
            }).catch((err) => console.error("[Orchestrator] Failed to post questions to Linear:", err));
          }
        }
        break;
      }
      case "mark_duplicate": {
        try {
          this.agentManager.updateStatus(event.ticketUUID, { status: "closed" });
        } catch (err) {
          console.warn(`[Orchestrator] Failed to mark duplicate for ${event.ticketUUID}:`, err);
        }
        break;
      }
      case "queue": {
        this.ctx.storage.sql.exec(
          `INSERT INTO ticket_queue (id, ticket_uuid, product, priority, payload)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          crypto.randomUUID(), event.ticketUUID, event.product,
          (payload.priority as number) || 3, JSON.stringify(event),
        );
        try {
          this.agentManager.updateStatus(event.ticketUUID, { status: "queued" });
        } catch (err) {
          console.warn(`[Orchestrator] Failed to set queued for ${event.ticketUUID}:`, err);
        }
        break;
      }
      case "expand_existing": {
        // Route the event to the existing ticket's agent
        // decision.expand_ticket contains the ticket ID to expand
        const expandTicketId = (decision as unknown as Record<string, unknown>).expand_ticket as string | undefined;
        if (expandTicketId) {
          const expandedEvent = { ...event, ticketUUID: expandTicketId };
          await this.agentManager.sendEvent(expandTicketId, expandedEvent);
        }
        break;
      }
    }
  }

  /**
   * LLM Merge Gate — evaluates whether a PR is ready to auto-merge.
   * Called when CI passes and PR exists for a tracked ticket.
   *
   * Deduplicates decisions using composite fingerprint: only makes a new decision if any
   * merge-relevant state has changed since the last decision:
   * - Head SHA (new commits)
   * - CI status (passed/failed)
   * - Copilot review status (complete/pending)
   * - Mergeable state (MERGEABLE/CONFLICTING/UNKNOWN)
   * - Review count (new human reviews)
   * - Copilot comment content (new/updated comments)
   */
  private async evaluateMergeGate(
    ticketUUID: string,
    product: string,
  ): Promise<void> {
    let ticketRow = this.ctx.storage.sql.exec(
      "SELECT * FROM tickets WHERE ticket_uuid = ?", ticketUUID
    ).toArray()[0] as Record<string, unknown> | undefined;

    // Fall back to ticket_id lookup (branch names use human-readable identifiers)
    if (!ticketRow?.pr_url) {
      const byIdentifier = this.ctx.storage.sql.exec(
        "SELECT * FROM tickets WHERE ticket_id = ?", ticketUUID
      ).toArray()[0] as Record<string, unknown> | undefined;
      if (byIdentifier?.pr_url) {
        console.log(`[Orchestrator] evaluateMergeGate: resolved identifier ${ticketUUID} → ticket ${byIdentifier.ticket_uuid}`);
        ticketRow = byIdentifier;
        // Use canonical UUID for all downstream operations
        ticketUUID = ticketRow.ticket_uuid as string;
      }
    }

    if (!ticketRow?.pr_url) {
      console.log(`[Orchestrator] No PR URL for ${ticketUUID}, skipping merge gate`);
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
      ticketUUID,
      identifier: null,
      title: "",
      product,
      pr_url: ticketRow.pr_url as string,
      branch: (ticketRow.branch_name as string) || "",
      repo: productConfig.repos[0],
    });

    // If PR fetch failed, escalate immediately instead of proceeding with bogus data
    if (context.error === "pr_fetch_failed") {
      console.error(`[Orchestrator] PR fetch failed for ${ticketUUID}, escalating to human`);
      if (ticketRow.slack_channel && ticketRow.slack_thread_ts) {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: ticketRow.slack_channel,
            text: `⚠️ *Merge Gate — API Error*\n${ticketRow.pr_url}\n*Reason:* ${context.errorMessage}\n\nThis is likely a transient GitHub API issue. You can manually re-trigger the merge gate by pushing a new commit or commenting on the PR.`,
            thread_ts: ticketRow.slack_thread_ts,
          }),
        });
      }
      return;
    }

    // --- Wait for CI and/or Copilot review before proceeding ---
    // Retry logic: CI and Copilot share a retry counter with separate phases.
    // Phase "ci" = waiting for CI. Phase "copilot" = waiting for Copilot review.
    const checksPassedFlag = (ticketRow.checks_passed as number) === 1;
    const ciReady = !context.hasCI || context.ciPassed || checksPassedFlag;
    const copilotReady = context.copilotReviewComplete as boolean;

    const waitReason = !ciReady ? "ci" : !copilotReady ? "copilot" : null;

    if (waitReason) {
      const retryRow = this.ctx.storage.sql.exec(
        "SELECT retry_count, phase FROM merge_gate_retries WHERE ticket_uuid = ?", ticketUUID
      ).toArray()[0] as { retry_count: number; phase: string } | undefined;
      let retryCount = retryRow?.retry_count ?? 0;

      // Reset counter when transitioning from CI wait → Copilot wait
      if (retryRow?.phase === "ci" && waitReason === "copilot") {
        retryCount = 0;
      }

      // Heuristic: if this is retry 0 (first check), schedule one retry to give Copilot time.
      // If retry >= 1 and still no Copilot review, assume Copilot isn't enabled and proceed.
      const shouldRetry = retryCount === 0;

      if (shouldRetry) {
        const nextRetryAt = new Date(Date.now() + Orchestrator.MERGE_GATE_RETRY_DELAY_MS).toISOString().replace("T", " ").replace("Z", "");
        const label = waitReason === "ci" ? `CI pending (${context.ciFailureDetails})` : "Copilot review pending";
        console.log(
          `[Orchestrator] ${label} for ${ticketUUID}, scheduling retry ${retryCount + 1}/${Orchestrator.MAX_MERGE_GATE_RETRIES}`
        );
        this.ctx.storage.sql.exec(
          `INSERT INTO merge_gate_retries (ticket_uuid, product, retry_count, next_retry_at, phase)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(ticket_uuid) DO UPDATE SET retry_count = ?, next_retry_at = ?, phase = ?`,
          ticketUUID, product, retryCount + 1, nextRetryAt, waitReason,
          retryCount + 1, nextRetryAt, waitReason,
        );
        this.ctx.storage.setAlarm(Date.now() + Orchestrator.MERGE_GATE_RETRY_DELAY_MS);
        return;
      }

      // Exhausted retries — proceed anyway
      const exhaustedLabel = waitReason === "ci" ? "CI" : "Copilot review";
      console.log(
        `[Orchestrator] ${exhaustedLabel} not ready after ${Orchestrator.MAX_MERGE_GATE_RETRIES} retries for ${ticketUUID}, proceeding`
      );
    }

    // Clear retries — either everything is ready, or we've exhausted retries
    this.ctx.storage.sql.exec("DELETE FROM merge_gate_retries WHERE ticket_uuid = ?", ticketUUID);
    // Deduplication: skip decision if PR state hasn't materially changed since last decision
    // Track composite fingerprint of all merge-relevant state (not just commit SHA)
    const copilotComments = context.copilotComments as Array<{ path: string; body: string }>;
    const copilotCommentsHash = copilotComments.length > 0
      ? copilotComments.map(c => `${c.path}:${c.body.slice(0, 100)}`).join(";").slice(0, 200)
      : "none";

    const currentFingerprint = [
      `sha:${context.headSha}`,
      `ci:${context.ciPassed}`,
      `copilot:${context.copilotReviewComplete}`,
      `mergeable:${context.mergeable}`,
      `reviews:${(context.reviewComments as unknown[]).length}`,
      `copilot_comments:${copilotCommentsHash}`,
    ].join("|");

    const lastFingerprint = ticketRow.last_merge_decision_sha as string | null;

    if (lastFingerprint === currentFingerprint) {
      console.log(`[Orchestrator] Skipping merge gate for ${ticketUUID} — no changes since last decision`);
      return;
    }

    // Detect what changed since last decision for the decision log
    const changes: string[] = [];
    if (!lastFingerprint) {
      changes.push("initial evaluation");
    } else {
      const lastParts = Object.fromEntries(lastFingerprint.split("|").map(p => p.split(":")));
      const currentParts = Object.fromEntries(currentFingerprint.split("|").map(p => p.split(":")));

      if (lastParts.sha !== currentParts.sha) {
        changes.push(`new commits (${lastParts.sha?.slice(0, 7) || "?"} → ${currentParts.sha?.slice(0, 7) || "?"})`);
      }
      if (lastParts.ci !== currentParts.ci) {
        changes.push(`CI ${currentParts.ci === "true" ? "passed" : "failed"}`);
      }
      if (lastParts.copilot !== currentParts.copilot) {
        changes.push(currentParts.copilot === "true" ? "Copilot review complete" : "Copilot review pending");
      }
      if (lastParts.mergeable !== currentParts.mergeable) {
        changes.push(`mergeable state: ${lastParts.mergeable} → ${currentParts.mergeable}`);
      }
      if (lastParts.reviews !== currentParts.reviews) {
        changes.push(`reviews: ${lastParts.reviews} → ${currentParts.reviews}`);
      }
      if (lastParts.copilot_comments !== currentParts.copilot_comments) {
        changes.push("Copilot comments updated");
      }
    }

    let decision;
    try {
      decision = await engine.makeDecision("merge-gate", context);
    } catch (err) {
      console.error("[Orchestrator] Merge gate LLM call failed:", err);
      // Don't auto-merge on failure — escalate instead
      decision = { action: "escalate", reason: "Merge gate LLM call failed", confidence: 0 };
    }

    // Update last decision fingerprint to prevent re-evaluating on identical state
    this.ctx.storage.sql.exec(
      "UPDATE tickets SET last_merge_decision_sha = ?, updated_at = datetime('now') WHERE ticket_uuid = ?",
      currentFingerprint, ticketUUID
    );

    // Log the decision (use human-readable identifier like BC-156, fall back to UUID)
    const displayId = (ticketRow.ticket_id as string) || ticketUUID;
    const reasonWithChanges = changes.length > 0
      ? `${decision.reason} (changes: ${changes.join(", ")})`
      : decision.reason;

    await engine.logDecision({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: "merge_gate",
      ticket_id: displayId,
      context_summary: `PR: ${ticketRow.pr_url}`,
      action: decision.action,
      reason: reasonWithChanges,
      confidence: decision.confidence || 0,
    }, {
      sqlExec: (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params),
      slackChannel: (ticketRow.slack_channel as string) || undefined,
      slackThreadTs: (ticketRow.slack_thread_ts as string) || undefined,
      linearIssueId: ticketUUID,
    });

    switch (decision.action) {
      case "auto_merge":
        await this.autoMergePR(ticketUUID, product, ticketRow);
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
        // Increment revision count for metrics
        this.ctx.storage.sql.exec(
          `UPDATE ticket_metrics SET revision_count = revision_count + 1, updated_at = datetime('now') WHERE ticket_uuid = ?`,
          ticketUUID,
        );

        // Route back to agent
        const sendBackEvent: TicketEvent = {
          type: "merge_feedback",
          source: "orchestrator",
          ticketUUID,
          product,
          payload: { feedback: decision.reason, missing: (decision as unknown as Record<string, unknown>).missing },
        };
        await this.agentManager.sendEvent(ticketUUID, sendBackEvent);
        break;
      }
    }
  }

  /**
   * Auto-merge a PR via GitHub API (squash merge).
   */
  private async autoMergePR(
    ticketUUID: string,
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

      // Notify Slack thread about the merge
      if (ticketRow.slack_thread_ts && ticketRow.slack_channel) {
        fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: ticketRow.slack_channel,
            thread_ts: ticketRow.slack_thread_ts,
            text: `✅ PR #${prNumber} merged successfully.`,
          }),
        }).catch(err => console.warn("[Orchestrator] Failed to notify Slack of merge:", err));
      }

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
      const rebaseEvent: TicketEvent = {
        type: "merge_conflict",
        source: "github",
        ticketUUID,
        product,
        payload: { error: errorText, pr_url: ticketRow.pr_url, action: "rebase_and_push" },
        slackThreadTs: ticketRow.slack_thread_ts as string | undefined,
        slackChannel: ticketRow.slack_channel as string | undefined,
      };
      await this.agentManager.sendEvent(ticketUUID, rebaseEvent);
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

      // Resolve target to UUID — defense in depth if LLM returns human-readable ID
      let resolvedTarget = action.target;
      if (action.target !== "system") {
        const direct = this.agentManager.getTicket(action.target);
        if (!direct) {
          const byIdentifier = this.agentManager.getTicketByIdentifier(action.target);
          if (byIdentifier) {
            console.log(`[Orchestrator] Resolved supervisor target ${action.target} → ${byIdentifier.ticket_uuid}`);
            resolvedTarget = byIdentifier.ticket_uuid;
          } else {
            console.warn(`[Orchestrator] Supervisor target not found: ${action.target}`);
            continue; // Skip this action — target doesn't exist
          }
        }
      }

      // Log each action (use human-readable identifier for display)
      let displayId = resolvedTarget;
      if (resolvedTarget !== "system") {
        // Look up the human-readable ticket_id from the tickets table
        const ticketRow = this.ctx.storage.sql.exec(
          "SELECT ticket_id FROM tickets WHERE ticket_uuid = ?", resolvedTarget
        ).toArray()[0] as { ticket_id: string | null } | undefined;
        displayId = ticketRow?.ticket_id || resolvedTarget;
      }

      await engine.logDecision({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: "supervisor",
        ticket_id: resolvedTarget !== "system" ? displayId : null,
        context_summary: `Supervisor: ${action.action} on ${displayId}`,
        action: action.action,
        reason: action.reason,
        confidence: 0,
      }, {
        sqlExec: (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params),
      });

      switch (action.action) {
        case "kill": {
          if (resolvedTarget !== "system") {
            try {
              this.agentManager.updateStatus(resolvedTarget, { status: "failed" });
            } catch {
              // Force stop even if state transition is invalid
              this.ctx.storage.sql.exec(
                "UPDATE tickets SET status = 'failed', agent_active = 0, updated_at = datetime('now') WHERE ticket_uuid = ?",
                resolvedTarget,
              );
            }
            await this.agentManager.stopAgent(resolvedTarget, `supervisor: ${action.reason}`).catch(err =>
              console.warn(`[Orchestrator] Failed to kill agent for ${resolvedTarget}:`, err)
            );
          }
          break;
        }
        case "trigger_merge_eval": {
          if (resolvedTarget !== "system") {
            const ticket = this.agentManager.getTicket(resolvedTarget);
            if (ticket) {
              await this.evaluateMergeGate(resolvedTarget, ticket.product);
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
              text: `\u26A0\uFE0F *Supervisor Escalation*\n*Target:* ${resolvedTarget}\n*Reason:* ${action.reason}`,
            }),
          });
          break;
        }
        case "start_queued": {
          // Pop the highest-priority ticket from the queue
          const queuedRow = this.ctx.storage.sql.exec(
            "SELECT id, ticket_uuid, payload FROM ticket_queue ORDER BY priority ASC, created_at ASC LIMIT 1"
          ).toArray()[0] as { id: string; ticket_uuid: string; payload: string } | undefined;
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
    const body = await request.json<{
      ticketUUID: string;
      status?: string;
      pr_url?: string;
      branch_name?: string;
      slack_thread_ts?: string;
      transcript_r2_key?: string;
      agent_active?: number;
    }>();
    const { ticketUUID, status, pr_url, branch_name, slack_thread_ts, transcript_r2_key, agent_active } = body;

    // Log payloads so they appear in wrangler tail
    console.log(`[Orchestrator] status update: ticket=${ticketUUID} status=${status || ""} branch=${branch_name || ""} agent_active=${agent_active ?? "unset"}`);

    // Reject heartbeats/status updates for tickets already in a terminal state.
    // This prevents agent containers from overwriting supervisor kill decisions.
    if (this.agentManager.isTerminal(ticketUUID)) {
      // Allow explicit agent_active=0 (dashboard kill) but block heartbeats
      if (agent_active === undefined || agent_active !== 0) {
        const currentTicket = this.agentManager.getTicket(ticketUUID);
        console.log(`[Orchestrator] Ignoring status update for terminal ticket ${ticketUUID} (current: ${currentTicket?.status})`);
        return Response.json({ ok: true, ignored: true, reason: "terminal ticket" });
      }
    }

    const updates: string[] = ["updated_at = datetime('now')", "last_heartbeat = datetime('now')"];
    const values: (string | number | null)[] = [];

    // Allow explicit control of agent_active flag (for dashboard kill operations)
    if (agent_active !== undefined) {
      updates.push("agent_active = ?");
      values.push(agent_active);
      console.log(`[Orchestrator] Explicitly setting agent_active=${agent_active} for ticket ${ticketUUID}`);
    }

    if (status) {
      // Only accept valid ticket states — reject agent lifecycle messages (e.g., "agent:*")
      // that old agent code may still send to this endpoint instead of /heartbeat.
      if (!(TICKET_STATES as readonly string[]).includes(status)) {
        console.log(`[Orchestrator] Rejecting invalid status "${status}" for ticket ${ticketUUID} — use /heartbeat for lifecycle messages`);
        // Still process other fields (pr_url, branch_name, etc.) below
      } else {
        updates.push("status = ?");
        values.push(status);
      }

      // Track first_response_at when agent starts working
      if (status === "in_progress") {
        this.ctx.storage.sql.exec(
          `UPDATE ticket_metrics SET first_response_at = COALESCE(first_response_at, datetime('now')), updated_at = datetime('now') WHERE ticket_uuid = ?`,
          ticketUUID,
        );
      }

      // Terminal states: mark agent as inactive so we don't spawn new agents
      // on deployment-triggered events
      if ((TERMINAL_STATUSES as readonly string[]).includes(status)) {
        updates.push("agent_active = 0");
        console.log(`[Orchestrator] Marking agent inactive for terminal state: ${status}`);

        // Update ticket_metrics with outcome and completion time
        const outcome = status === "merged" ? "automerge_success" : status;
        this.ctx.storage.sql.exec(
          `UPDATE ticket_metrics SET outcome = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE ticket_uuid = ?`,
          outcome,
          ticketUUID,
        );

        // Stop the agent container
        await this.agentManager.stopAgent(ticketUUID, `terminal status: ${status}`).catch(err =>
          console.error(`[Orchestrator] Failed to stop agent for ${ticketUUID}:`, err)
        );
      }
    }
    if (pr_url) {
      updates.push("pr_url = ?");
      values.push(pr_url);

      // Increment pr_count only when the PR URL actually changes
      const currentTicket = this.agentManager.getTicket(ticketUUID);
      if (!currentTicket || currentTicket.pr_url !== pr_url) {
        this.ctx.storage.sql.exec(
          `UPDATE ticket_metrics SET pr_count = pr_count + 1, updated_at = datetime('now') WHERE ticket_uuid = ?`,
          ticketUUID,
        );
      }
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

    values.push(ticketUUID);
    this.ctx.storage.sql.exec(
      `UPDATE tickets SET ${updates.join(", ")} WHERE ticket_uuid = ?`,
      ...values,
    );

    // Handle explicit agent_active=0 (dashboard kill) — stop the container
    if (agent_active !== undefined && agent_active === 0) {
      await this.agentManager.stopAgent(ticketUUID, "explicit agent_active=0").catch(err =>
        console.error(`[Orchestrator] Failed to stop agent for ${ticketUUID}:`, err)
      );
    }

    // Trigger merge gate when PR URL is reported.
    // Always trigger — evaluateMergeGate handles all cases:
    // - Repos with CI: checks already passed (via webhook) or will pass later
    // - Repos without CI: fetchCIStatus returns passed when no statuses exist
    // - Copilot review: retry loop waits for Copilot if enabled, proceeds after timeout
    if (pr_url) {
      const ticket = this.agentManager.getTicket(ticketUUID);
      if (ticket) {
        console.log(`[Orchestrator] PR URL reported for ${ticketUUID}, triggering merge gate (status=${status}, checks_passed=${ticket.checks_passed})`);
        this.evaluateMergeGate(ticketUUID, ticket.product).catch(err =>
          console.error(`[Orchestrator] Merge gate check on PR report failed for ${ticketUUID}:`, err)
        );
      }
    }

    return Response.json({ ok: true });
  }

  private async handleTokenUsage(request: Request): Promise<Response> {
    const body = await request.json<{
      ticketUUID: string;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      totalCostUsd: number;
      turns: number;
      sessionMessageCount: number;
    }>();
    const { ticketUUID, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens, totalCostUsd, turns, sessionMessageCount } = body;

    console.log(
      `[Orchestrator] Token usage: ticket=${ticketUUID} input=${totalInputTokens} output=${totalOutputTokens} cost=$${totalCostUsd.toFixed(2)}`
    );

    // Upsert token usage data
    this.ctx.storage.sql.exec(
      `INSERT INTO token_usage (
        ticket_uuid, total_input_tokens, total_output_tokens,
        total_cache_read_tokens, total_cache_creation_tokens,
        total_cost_usd, turns, session_message_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_uuid) DO UPDATE SET
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cache_read_tokens = excluded.total_cache_read_tokens,
        total_cache_creation_tokens = excluded.total_cache_creation_tokens,
        total_cost_usd = excluded.total_cost_usd,
        turns = excluded.turns,
        session_message_count = excluded.session_message_count,
        updated_at = datetime('now')`,
      ticketUUID,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalCostUsd,
      turns,
      sessionMessageCount,
    );

    // Sync cost to ticket_metrics for unified reporting
    this.ctx.storage.sql.exec(
      `UPDATE ticket_metrics SET total_cost_usd = ?, updated_at = datetime('now') WHERE ticket_uuid = ?`,
      totalCostUsd,
      ticketUUID,
    );

    return Response.json({ ok: true });
  }

  private async handleHeartbeat(request: Request): Promise<Response> {
    const { ticketUUID, message } = await request.json<{ ticketUUID: string; message?: string }>();

    console.log(`[Orchestrator] heartbeat: ticket=${ticketUUID} ${message || ""}`);
    this.agentManager.recordPhoneHome(ticketUUID, message);

    // Auto-transition spawning → active on first heartbeat.
    // The agent sends heartbeats once it's running — this replaces the old
    // pattern where phoneHome side-effects would overwrite the status field.
    const ticket = this.agentManager.getTicket(ticketUUID);
    if (ticket?.status === "spawning") {
      this.ctx.storage.sql.exec(
        "UPDATE tickets SET status = 'active', updated_at = datetime('now') WHERE ticket_uuid = ?",
        ticketUUID,
      );
      console.log(`[Orchestrator] Auto-transitioned ticket ${ticketUUID} from spawning → active`);
    }

    return Response.json({ ok: true });
  }

  private async checkAgentHealth(): Promise<Response> {
    // Report-only: find active tickets with stale heartbeats for diagnostics.
    // No longer marks agents inactive or creates investigation tickets.
    const stuckThreshold = 30; // minutes
    const rows = this.ctx.storage.sql.exec(
      `SELECT ticket_uuid, product, status, last_heartbeat
       FROM tickets
       WHERE agent_active = 1
         AND last_heartbeat IS NOT NULL
         AND (julianday('now') - julianday(last_heartbeat)) * 24 * 60 > ?`,
      stuckThreshold,
    ).toArray() as Array<{
      ticket_uuid: string;
      product: string;
      status: string;
      last_heartbeat: string;
    }>;

    const staleAgents = rows.map((ticket) => ({
      ticketUUID: ticket.ticket_uuid,
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
    // Force shutdown of containers for tickets marked inactive (agent_active = 0)
    // or terminal but still marked active.
    await this.agentManager.cleanupInactive();

    // Also stop containers for all inactive tickets (agent_active = 0)
    const inactiveTickets = this.ctx.storage.sql.exec(
      `SELECT ticket_uuid FROM tickets WHERE agent_active = 0`
    ).toArray() as Array<{ ticket_uuid: string }>;

    console.log(`[Orchestrator] Cleanup: found ${inactiveTickets.length} inactive tickets`);

    const results: Array<{ ticketUUID: string; success: boolean; error?: string }> = [];

    for (const ticket of inactiveTickets) {
      try {
        await this.agentManager.stopAgent(ticket.ticket_uuid, "cleanup inactive");
        results.push({ ticketUUID: ticket.ticket_uuid, success: true });
      } catch (err) {
        results.push({ ticketUUID: ticket.ticket_uuid, success: false, error: String(err) });
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

    // Get ALL tickets for response details before stopping
    const allTickets = this.ctx.storage.sql.exec(
      `SELECT ticket_uuid, status, agent_active FROM tickets`
    ).toArray() as Array<{ ticket_uuid: string; status: string; agent_active: number }>;

    console.log(`[Orchestrator] Shutdown all: found ${allTickets.length} total tickets`);

    // Stop each ticket individually to track per-ticket success/failure
    const results: Array<{ ticketUUID: string; previousStatus: string; success: boolean; error?: string }> = [];

    for (const ticket of allTickets) {
      try {
        await this.agentManager.stopAgent(ticket.ticket_uuid, "shutdown all requested");
        results.push({ ticketUUID: ticket.ticket_uuid, previousStatus: ticket.status, success: true });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Orchestrator] Failed to stop ${ticket.ticket_uuid}:`, errorMsg);
        results.push({ ticketUUID: ticket.ticket_uuid, previousStatus: ticket.status, success: false, error: errorMsg });
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
      SELECT
        ticket_uuid as ticketUUID,
        COALESCE(ticket_id, ticket_uuid) as ticketId,
        product,
        status,
        transcript_r2_key as r2Key,
        updated_at as uploadedAt
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
      ticketUUID: string;
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
      `SELECT ticket_uuid, ticket_id, product, status, agent_message, last_heartbeat, created_at, updated_at, pr_url, branch_name, slack_thread_ts, slack_channel
       FROM tickets
       WHERE agent_active = 1
       ORDER BY updated_at DESC`,
    ).toArray() as Array<{
      ticket_uuid: string;
      ticket_id: string | null;
      product: string;
      status: string;
      agent_message: string | null;
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
      `SELECT ticket_uuid, ticket_id, product, status, updated_at, pr_url
       FROM tickets
       WHERE agent_active = 0
         AND (julianday('now') - julianday(updated_at)) * 24 < 24
       ORDER BY updated_at DESC
       LIMIT 10`,
    ).toArray() as Array<{
      ticket_uuid: string;
      ticket_id: string | null;
      product: string;
      status: string;
      updated_at: string;
      pr_url: string | null;
    }>;

    // Get stale agents (no heartbeat in 30 minutes)
    const staleAgents = this.ctx.storage.sql.exec(
      `SELECT ticket_uuid, product, status, last_heartbeat
       FROM tickets
       WHERE agent_active = 1
         AND last_heartbeat IS NOT NULL
         AND (julianday('now') - julianday(last_heartbeat)) * 24 * 60 > 30`,
    ).toArray() as Array<{
      ticket_uuid: string;
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
          ticket_uuid: string;
          ticket_id: string | null;
          product: string;
          status: string;
          agent_message: string | null;
          last_heartbeat: string | null;
          created_at: string;
          updated_at: string;
          pr_url: string | null;
          branch_name: string | null;
          slack_thread_ts: string | null;
          slack_channel: string | null;
        }>;
        recentCompleted: Array<{
          ticket_uuid: string;
          ticket_id: string | null;
          product: string;
          status: string;
          updated_at: string;
          pr_url: string | null;
        }>;
        staleAgents: Array<{
          ticket_uuid: string;
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
          const ticketDisplay = agent.ticket_id ?? agent.ticket_uuid;

          message += `${healthEmoji} ${statusEmoji} \`${ticketDisplay}\` (${agent.product})\n`;
          const phaseInfo = agent.agent_message ? ` (${agent.agent_message})` : "";
          message += `   Status: ${agent.status}${phaseInfo} · Updated: ${timeSinceUpdate}\n`;
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
          message += `• \`${agent.ticket_uuid}\` (${agent.product}) - ${minutesStale}m ago\n`;
        }
        message += `\n`;
      }

      // Recent completions
      if (statusData.recentCompleted.length > 0) {
        message += `*Recent Completions (24h):*\n`;
        for (const ticket of statusData.recentCompleted.slice(0, 5)) {
          const statusEmoji = this.getStatusEmoji(ticket.status);
          const timeAgo = this.getTimeAgo(ticket.updated_at);
          const ticketDisplay = ticket.ticket_id ?? ticket.ticket_uuid;
          message += `${statusEmoji} \`${ticketDisplay}\` (${ticket.product}) - ${timeAgo}\n`;
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
      // Reaction event fields
      reaction?: string;
      item?: { ts: string; channel: string };
    }>();

    // Handle reaction_added events for decision feedback
    if (slackEvent.type === "reaction_added" && slackEvent.item?.ts) {
      const reactionTs = slackEvent.item.ts;
      const reaction = slackEvent.reaction;

      // Check if this reaction is on a decision message
      const decision = this.ctx.storage.sql.exec(
        `SELECT id FROM decision_log WHERE slack_message_ts = ?`,
        reactionTs,
      ).toArray()[0] as { id: string } | undefined;

      if (decision) {
        let feedback: "good" | "bad" | null = null;
        if (reaction === "+1" || reaction === "thumbsup" || reaction === "white_check_mark" || reaction === "heavy_check_mark") {
          feedback = "good";
        } else if (reaction === "-1" || reaction === "thumbsdown" || reaction === "x" || reaction === "no_entry_sign") {
          feedback = "bad";
        }

        if (feedback) {
          console.log(`[Orchestrator] Decision feedback: ${feedback} for decision ${decision.id} from user ${slackEvent.user}`);
          this.ctx.storage.sql.exec(
            `INSERT INTO decision_feedback (id, decision_id, feedback, given_by, given_at, slack_message_ts)
             VALUES (?, ?, ?, ?, datetime('now'), ?)
             ON CONFLICT(decision_id) DO UPDATE SET
               feedback = excluded.feedback,
               given_by = excluded.given_by,
               given_at = datetime('now')`,
            crypto.randomUUID(),
            decision.id,
            feedback,
            slackEvent.user || null,
            reactionTs,
          );
          return Response.json({ ok: true, handled: "decision_feedback", feedback });
        }
      }
    }

    // Handle reply to a decision message with feedback details
    if (slackEvent.type === "message" && slackEvent.thread_ts && slackEvent.text) {
      const decision = this.ctx.storage.sql.exec(
        `SELECT id FROM decision_log WHERE slack_message_ts = ?`,
        slackEvent.thread_ts,
      ).toArray()[0] as { id: string } | undefined;

      if (decision) {
        // User is replying to a decision message with details
        // Update or insert feedback with the details
        const existingFeedback = this.ctx.storage.sql.exec(
          `SELECT feedback FROM decision_feedback WHERE decision_id = ?`,
          decision.id,
        ).toArray()[0] as { feedback: string } | undefined;

        // Infer feedback from text if not already set
        const textLower = slackEvent.text.toLowerCase();
        let feedback = existingFeedback?.feedback || null;
        if (!feedback) {
          if (textLower.includes("bad") || textLower.includes("wrong") || textLower.includes("incorrect")) {
            feedback = "bad";
          } else if (textLower.includes("good") || textLower.includes("correct") || textLower.includes("right")) {
            feedback = "good";
          }
        }

        if (feedback) {
          console.log(`[Orchestrator] Decision feedback reply: ${feedback} for decision ${decision.id} with details`);
          this.ctx.storage.sql.exec(
            `INSERT INTO decision_feedback (id, decision_id, feedback, details, given_by, given_at, slack_message_ts)
             VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
             ON CONFLICT(decision_id) DO UPDATE SET
               feedback = excluded.feedback,
               details = excluded.details,
               given_by = excluded.given_by,
               given_at = datetime('now')`,
            crypto.randomUUID(),
            decision.id,
            feedback,
            slackEvent.text,
            slackEvent.user || null,
            slackEvent.thread_ts,
          );
          return Response.json({ ok: true, handled: "decision_feedback_reply", feedback });
        }
      }
    }

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
        "SELECT ticket_uuid, product, status, agent_active FROM tickets WHERE slack_thread_ts = ?",
        slackEvent.thread_ts,
      ).toArray() as { ticket_uuid: string; product: string; status: string; agent_active: number }[];

      if (rows.length > 0) {
        const ticket = rows[0];
        console.log(`[Orchestrator] Thread reply matched ticket=${ticket.ticket_uuid} product=${ticket.product}`);

        // Don't re-activate terminal tickets
        if (this.agentManager.isTerminalStatus(ticket.status)) {
          console.log(`[Orchestrator] Thread reply for terminal ticket ${ticket.ticket_uuid} (status=${ticket.status}) — ignoring`);
          return Response.json({ ok: true, ignored: true, reason: "terminal ticket" });
        }

        // Re-activate agent on thread reply — user is explicitly engaging
        this.agentManager.reactivate(ticket.ticket_uuid);
        const event: TicketEvent = {
          type: "slack_reply",
          source: "slack",
          ticketUUID: ticket.ticket_uuid,
          product: ticket.product,
          payload: slackEvent,
          slackThreadTs: slackEvent.thread_ts,
          slackChannel: slackEvent.channel,
        };
        console.log(`[Orchestrator] Routing thread reply to agent for ticket=${ticket.ticket_uuid}`);
        await this.agentManager.sendEvent(ticket.ticket_uuid, event);
        return Response.json({ ok: true, ticketUUID: ticket.ticket_uuid });
      } else {
        console.log(`[Orchestrator] No ticket found for thread_ts=${slackEvent.thread_ts}`);
      }

      // Thread reply but no ticket found — silently ignore.
      // Previously this posted an info message, but that was too noisy
      // (deploy restarts, Socket Mode re-deliveries, etc. caused spam).
      if (slackEvent.type === "message") {
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
    const title = rawText
      ? (rawText.length <= 80
        ? rawText
        : rawText.split(/[.!?\n]/)[0].slice(0, 80).trim() || rawText.slice(0, 80).trim())
      : "Slack request (no description)";

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

    // Post acknowledgment as a NEW top-level message (not a reply).
    // This message becomes the ticket thread — all future updates reply here.
    let ticketThreadTs: string | null = null;
    try {
      const ackRes = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${(this.env as Record<string, unknown>).SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: slackEvent.channel,
          // No thread_ts — creates a new top-level message
          text: `📋 Created <${issue.url}|${issue.identifier}>: ${title}\n⏳ Working on it...`,
        }),
      });
      const ackData = await ackRes.json() as { ok: boolean; ts?: string; error?: string };
      if (ackData.ok && ackData.ts) {
        ticketThreadTs = ackData.ts;
      } else {
        console.warn("[Orchestrator] Ack message failed:", ackData.error);
      }
    } catch (err) {
      console.warn("[Orchestrator] Failed to post ack:", err);
    }

    // Reply briefly in the user's original thread pointing to the ticket thread
    if (ticketThreadTs) {
      fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${(this.env as Record<string, unknown>).SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: slackEvent.channel,
          thread_ts: slackThreadTs,
          text: `👋 On it! Follow progress in the thread above.`,
        }),
      }).catch(err => console.warn("[Orchestrator] Failed to post thread pointer:", err));
    }

    // Store the Slack thread association so the Linear webhook handler can link them.
    // Use the ack message ts (ticket thread) — NOT the user's original message ts.
    const threadTsToStore = ticketThreadTs || slackThreadTs || null;
    this.ctx.storage.sql.exec(
      `INSERT INTO slack_thread_map (linear_issue_id, slack_thread_ts, slack_channel)
       VALUES (?, ?, ?)
       ON CONFLICT(linear_issue_id) DO UPDATE SET
         slack_thread_ts = excluded.slack_thread_ts,
         slack_channel = excluded.slack_channel`,
      issue.id, threadTsToStore, slackEvent.channel || null,
    );

    // Dispatch ticket review directly instead of waiting for the Linear webhook
    // roundtrip. This is more resilient — works even if assignee can't be set (OAuth app
    // users can't be assigned in Linear) or the webhook is delayed/fails.
    const ticketEvent: TicketEvent = {
      type: "ticket_created",
      source: "slack",
      ticketUUID: issue.id,
      product,
      payload: {
        id: issue.id,
        identifier: issue.identifier,
        title,
        description: rawText,
        priority: 3,
        labels: [],
      },
      slackThreadTs: threadTsToStore || undefined,
      slackChannel: slackEvent.channel || undefined,
    };

    // Create ticket in DB before review — handleTicketReview requires the ticket to exist
    // for updateStatus/spawnAgent. Use createTicket which is safe if Linear webhook
    // already created it (handles terminal re-creation and throws for active duplicates).
    try {
      this.agentManager.createTicket({
        ticketUUID: issue.id,
        product,
        slackThreadTs: threadTsToStore || undefined,
        slackChannel: slackEvent.channel || undefined,
        ticketId: issue.identifier,
        title,
      });
    } catch {
      // Ticket already exists (from a fast Linear webhook) — safe to proceed
    }

    // Initialize ticket_metrics row
    this.ctx.storage.sql.exec(
      `INSERT INTO ticket_metrics (ticket_uuid) VALUES (?)
       ON CONFLICT(ticket_uuid) DO NOTHING`,
      issue.id,
    );

    this.handleTicketReview(ticketEvent)
      .catch(err => console.error("[Orchestrator] Direct ticket review failed:", err));

    return Response.json({ ok: true, linearIssue: issue.identifier });
  }

  private async handleSlackInteractive(request: Request): Promise<Response> {
    const payload = await request.json<{
      type: string;
      user: { id: string };
      actions?: Array<{ action_id: string; value: string }>;
      channel?: { id: string };
      message?: { ts: string; blocks?: unknown[] };
      view?: {
        id: string;
        state: {
          values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>>;
        };
        private_metadata?: string;
      };
      trigger_id?: string;
    }>();

    // Handle button clicks for decision feedback
    if (payload.type === "block_actions" && payload.actions && payload.actions.length > 0) {
      const action = payload.actions[0];
      const decisionId = action.value;
      const userId = payload.user.id;

      if (action.action_id === "decision_feedback_good") {
        // Record "correct" feedback
        this.ctx.storage.sql.exec(
          `INSERT INTO decision_feedback (id, decision_id, feedback, given_by, given_at, slack_message_ts)
           VALUES (?, ?, ?, ?, datetime('now'), ?)
           ON CONFLICT(decision_id) DO UPDATE SET
             feedback = excluded.feedback,
             given_by = excluded.given_by,
             given_at = datetime('now')`,
          crypto.randomUUID(),
          decisionId,
          "good",
          userId,
          payload.message?.ts || null,
        );
        console.log(`[Orchestrator] Decision feedback (button): good for ${decisionId} from user ${userId}`);

        // Replace buttons with confirmation
        if (payload.channel?.id && payload.message?.ts && payload.message?.blocks) {
          const originalSection = payload.message.blocks[0];
          await this.updateSlackMessage(payload.channel.id, payload.message.ts, [
            originalSection,
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: `✓ Marked as *correct* by <@${userId}>` }],
            },
          ]);
        }

        return Response.json({ ok: true });
      }

      if (action.action_id === "decision_feedback_bad") {
        // Record "incorrect" feedback
        this.ctx.storage.sql.exec(
          `INSERT INTO decision_feedback (id, decision_id, feedback, given_by, given_at, slack_message_ts)
           VALUES (?, ?, ?, ?, datetime('now'), ?)
           ON CONFLICT(decision_id) DO UPDATE SET
             feedback = excluded.feedback,
             given_by = excluded.given_by,
             given_at = datetime('now')`,
          crypto.randomUUID(),
          decisionId,
          "bad",
          userId,
          payload.message?.ts || null,
        );
        console.log(`[Orchestrator] Decision feedback (button): bad for ${decisionId} from user ${userId}`);

        // Replace buttons with confirmation
        if (payload.channel?.id && payload.message?.ts && payload.message?.blocks) {
          const originalSection = payload.message.blocks[0];
          await this.updateSlackMessage(payload.channel.id, payload.message.ts, [
            originalSection,
            {
              type: "context",
              elements: [{ type: "mrkdwn", text: `✗ Marked as *incorrect* by <@${userId}>` }],
            },
          ]);
        }

        return Response.json({ ok: true });
      }

      if (action.action_id === "decision_feedback_details" && payload.trigger_id) {
        // Encode message context so modal submission can update the original message
        const metadata = JSON.stringify({
          decisionId,
          channel: payload.channel?.id || null,
          messageTs: payload.message?.ts || null,
          originalSection: payload.message?.blocks?.[0] || null,
        });

        const modalView = {
          type: "modal",
          callback_id: "decision_feedback_modal",
          private_metadata: metadata,
          title: { type: "plain_text", text: "Decision Feedback" },
          submit: { type: "plain_text", text: "Submit" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "feedback_choice",
              label: { type: "plain_text", text: "Was this decision correct?" },
              element: {
                type: "radio_buttons",
                action_id: "feedback_radio",
                options: [
                  {
                    text: { type: "plain_text", text: "✓ Correct" },
                    value: "good",
                  },
                  {
                    text: { type: "plain_text", text: "✗ Incorrect" },
                    value: "bad",
                  },
                ],
              },
            },
            {
              type: "input",
              block_id: "feedback_details",
              label: { type: "plain_text", text: "Additional context" },
              element: {
                type: "plain_text_input",
                action_id: "details_input",
                multiline: true,
                placeholder: {
                  type: "plain_text",
                  text: "What was right or wrong about this decision...",
                },
              },
              optional: true,
            },
          ],
        };

        try {
          await fetch("https://slack.com/api/views.open", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.getSlackBotToken()}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              trigger_id: payload.trigger_id,
              view: modalView,
            }),
          });
        } catch (err) {
          console.error("[Orchestrator] Failed to open modal:", err);
        }

        return Response.json({ ok: true });
      }
    }

    // Handle modal submission for detailed feedback
    if (payload.type === "view_submission" && payload.view) {
      const decisionId = payload.view.private_metadata || "";
      const values = payload.view.state.values;
      const feedbackChoice = values.feedback_choice?.feedback_radio?.selected_option?.value as "good" | "bad" | undefined;
      const details = values.feedback_details?.details_input?.value || null;
      const userId = payload.user.id;

      if (feedbackChoice) {
        this.ctx.storage.sql.exec(
          `INSERT INTO decision_feedback (id, decision_id, feedback, details, given_by, given_at, slack_message_ts)
           VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
           ON CONFLICT(decision_id) DO UPDATE SET
             feedback = excluded.feedback,
             details = excluded.details,
             given_by = excluded.given_by,
             given_at = datetime('now')`,
          crypto.randomUUID(),
          decisionId,
          feedbackChoice,
          details,
          userId,
          null,
        );
        console.log(`[Orchestrator] Decision feedback (modal): ${feedbackChoice} for ${decisionId} from user ${userId} with details`);
      }

      return Response.json({ response_action: "clear" });
    }

    return Response.json({ ok: true });
  }

  private async updateSlackMessage(channel: string, ts: string, blocks: unknown[]): Promise<void> {
    try {
      await fetch("https://slack.com/api/chat.update", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.getSlackBotToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channel, ts, blocks }),
      });
    } catch (err) {
      console.error("[Orchestrator] Failed to update Slack message:", err);
    }
  }

  // --- Metrics endpoints ---

  private getMetrics(request: Request): Response {
    const url = new URL(request.url);
    const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
    const limit = Number.isNaN(rawLimit) ? 50 : Math.max(1, Math.min(500, rawLimit));
    const rawDays = parseInt(url.searchParams.get("days") || "30", 10);
    const days = Number.isNaN(rawDays) ? 30 : Math.max(1, Math.min(365, rawDays));

    // Get ticket metrics with joined data
    const metrics = this.ctx.storage.sql.exec(`
      SELECT
        m.*,
        t.ticket_id,
        t.title,
        t.product,
        t.status as ticket_status,
        t.created_at as ticket_created_at,
        u.total_input_tokens,
        u.total_output_tokens,
        u.total_cache_read_tokens,
        u.total_cache_creation_tokens,
        u.turns,
        u.session_message_count
      FROM ticket_metrics m
      LEFT JOIN tickets t ON m.ticket_uuid = t.ticket_uuid
      LEFT JOIN token_usage u ON m.ticket_uuid = u.ticket_uuid
      WHERE t.created_at > datetime('now', '-' || ? || ' days')
      ORDER BY t.created_at DESC
      LIMIT ?
    `, days, limit).toArray();

    return Response.json({ metrics });
  }

  private getMetricsSummary(): Response {
    // Overall statistics
    const totalTickets = this.ctx.storage.sql.exec(
      `SELECT COUNT(*) as count FROM ticket_metrics`
    ).toArray()[0] as { count: number };

    // Outcome distribution
    const outcomes = this.ctx.storage.sql.exec(`
      SELECT
        outcome,
        COUNT(*) as count
      FROM ticket_metrics
      WHERE outcome IS NOT NULL
      GROUP BY outcome
    `).toArray() as Array<{ outcome: string; count: number }>;

    // Calculate automerge rate (automerge_success / total completed)
    const completed = outcomes.reduce((sum, o) => sum + o.count, 0);
    const automergeSuccess = outcomes.find(o => o.outcome === "automerge_success")?.count || 0;
    const automergeRate = completed > 0 ? (automergeSuccess / completed * 100).toFixed(1) : "N/A";

    // Failure rate (failed / total)
    const failed = outcomes.find(o => o.outcome === "failed")?.count || 0;
    const failureRate = completed > 0 ? (failed / completed * 100).toFixed(1) : "N/A";

    // Multi-PR rate (tickets needing 2+ PRs)
    const multiPrTickets = this.ctx.storage.sql.exec(
      `SELECT COUNT(*) as count FROM ticket_metrics WHERE pr_count >= 2`
    ).toArray()[0] as { count: number };
    const multiPrRate = completed > 0 ? (multiPrTickets.count / completed * 100).toFixed(1) : "N/A";

    // Multi-revision rate (tickets sent back 2+ times for 3+ total attempts)
    const multiRevisionTickets = this.ctx.storage.sql.exec(
      `SELECT COUNT(*) as count FROM ticket_metrics WHERE revision_count >= 2`
    ).toArray()[0] as { count: number };
    const multiRevisionRate = completed > 0 ? (multiRevisionTickets.count / completed * 100).toFixed(1) : "N/A";

    // Cost statistics
    const costStats = this.ctx.storage.sql.exec(`
      SELECT
        SUM(total_cost_usd) as total_cost,
        AVG(total_cost_usd) as avg_cost,
        MAX(total_cost_usd) as max_cost
      FROM ticket_metrics
      WHERE total_cost_usd > 0
    `).toArray()[0] as { total_cost: number; avg_cost: number; max_cost: number } | undefined;

    // Daily cost (last 7 days)
    const dailyCost = this.ctx.storage.sql.exec(`
      SELECT
        date(created_at) as day,
        SUM(total_cost_usd) as cost,
        COUNT(*) as tickets
      FROM ticket_metrics
      WHERE created_at > datetime('now', '-7 days')
      GROUP BY date(created_at)
      ORDER BY day DESC
    `).toArray() as Array<{ day: string; cost: number; tickets: number }>;

    // Decision correctness (from feedback)
    const decisionFeedback = this.ctx.storage.sql.exec(`
      SELECT
        feedback,
        COUNT(*) as count
      FROM decision_feedback
      GROUP BY feedback
    `).toArray() as Array<{ feedback: string; count: number }>;

    const goodDecisions = decisionFeedback.find(f => f.feedback === "good")?.count || 0;
    const badDecisions = decisionFeedback.find(f => f.feedback === "bad")?.count || 0;
    const totalFeedback = goodDecisions + badDecisions;
    const decisionAccuracy = totalFeedback > 0 ? (goodDecisions / totalFeedback * 100).toFixed(1) : "N/A";

    // Decisions without feedback (assumed good)
    const totalDecisions = this.ctx.storage.sql.exec(
      `SELECT COUNT(*) as count FROM decision_log`
    ).toArray()[0] as { count: number };
    const decisionsWithoutFeedback = totalDecisions.count - totalFeedback;

    // Average time to completion
    const avgCompletionTime = this.ctx.storage.sql.exec(`
      SELECT AVG(
        (julianday(completed_at) - julianday(created_at)) * 24 * 60
      ) as avg_minutes
      FROM ticket_metrics
      WHERE completed_at IS NOT NULL
    `).toArray()[0] as { avg_minutes: number | null };

    return Response.json({
      summary: {
        totalTickets: totalTickets.count,
        completed,
        automergeRate: automergeRate === "N/A" ? "N/A" : `${automergeRate}%`,
        failureRate: failureRate === "N/A" ? "N/A" : `${failureRate}%`,
        multiPrRate: multiPrRate === "N/A" ? "N/A" : `${multiPrRate}%`,
        multiRevisionRate: multiRevisionRate === "N/A" ? "N/A" : `${multiRevisionRate}%`,
        avgCompletionMinutes: avgCompletionTime.avg_minutes?.toFixed(1) || "N/A",
      },
      outcomes,
      costs: {
        total: costStats?.total_cost?.toFixed(2) || "0",
        average: costStats?.avg_cost?.toFixed(2) || "0",
        max: costStats?.max_cost?.toFixed(2) || "0",
        daily: dailyCost,
      },
      decisions: {
        total: totalDecisions.count,
        withFeedback: totalFeedback,
        withoutFeedback: decisionsWithoutFeedback,
        accuracy: decisionAccuracy === "N/A" ? "N/A" : `${decisionAccuracy}%`,
        goodCount: goodDecisions,
        badCount: badDecisions,
      },
    });
  }

  private async handleDecisionFeedback(request: Request): Promise<Response> {
    const { decisionId, feedback, details, givenBy, slackMessageTs } = await request.json<{
      decisionId?: string;
      slackMessageTs?: string;
      feedback: "good" | "bad";
      details?: string;
      givenBy?: string;
    }>();

    if (!feedback || (feedback !== "good" && feedback !== "bad")) {
      return Response.json({ error: "feedback must be 'good' or 'bad'" }, { status: 400 });
    }

    // If slackMessageTs is provided, look up the decision by slack_message_ts
    let resolvedDecisionId = decisionId;
    if (!resolvedDecisionId && slackMessageTs) {
      const decision = this.ctx.storage.sql.exec(
        `SELECT id FROM decision_log WHERE slack_message_ts = ?`,
        slackMessageTs,
      ).toArray()[0] as { id: string } | undefined;
      if (decision) {
        resolvedDecisionId = decision.id;
      }
    }

    if (!resolvedDecisionId) {
      return Response.json({ error: "decisionId or slackMessageTs required" }, { status: 400 });
    }

    // Insert or update feedback
    this.ctx.storage.sql.exec(
      `INSERT INTO decision_feedback (id, decision_id, feedback, details, given_by, given_at, slack_message_ts)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(decision_id) DO UPDATE SET
         feedback = excluded.feedback,
         details = excluded.details,
         given_by = excluded.given_by,
         given_at = datetime('now')`,
      crypto.randomUUID(),
      resolvedDecisionId,
      feedback,
      details || null,
      givenBy || null,
      slackMessageTs || null,
    );

    return Response.json({ ok: true, decisionId: resolvedDecisionId });
  }

}
