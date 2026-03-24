import { Container } from "@cloudflare/containers";
import { TERMINAL_STATUSES, TICKET_STATES, type TicketEvent, type HeartbeatPayload, type Bindings } from "./types";
import type { ProductConfig, CloudflareAIGateway } from "./registry";
import { AgentManager, type SpawnConfig } from "./agent-manager";
import { configure as configureInjectionDetector } from "./security/injection-detector";
import type { ProjectAgentConfig } from "./project-agent";
import { initSchema, getSetting, setSetting, getGatewayConfig, getProductConfig, getAllProductConfigs, ensureTicketMetrics } from "./db";
import {
  ensureProjectAgent as ensureProjectAgentImpl,
  ensureConductor as ensureConductorImpl,
  routeToProjectAgent as routeToProjectAgentImpl,
  handleProjectAgentRoute as handleProjectAgentRouteImpl,
  restartProjectAgents as restartProjectAgentsImpl,
} from "./project-agent-router";
import {
  getSystemStatus as getSystemStatusData,
  getMetrics as getMetricsData,
  getMetricsSummary as getMetricsSummaryData,
  checkAgentHealth as checkAgentHealthData,
  listTickets as listTicketsData,
  listTranscripts as listTranscriptsData,
} from "./observability";
import {
  listProducts as listProductsHandler,
  getProduct as getProductHandler,
  createProduct as createProductHandler,
  updateProduct as updateProductHandler,
  deleteProduct as deleteProductHandler,
  listSettings as listSettingsHandler,
  updateSetting as updateSettingHandler,
  seedProducts as seedProductsHandler,
} from "./product-crud";
import { handleSlackEvent as handleSlackEventImpl, refreshLinearToken } from "./slack-handler";

function sanitizeTicketUUID(id: string): string {
  return String(id).slice(0, 128).replace(/[^a-zA-Z0-9_\-\.]/g, "_") || `unknown-${Date.now()}`;
}

// Re-export from slack-handler for backward compatibility with tests
export { resolveProductFromChannel } from "./slack-handler";

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
  private agentManager!: AgentManager;

  /** Reusable SqlExec wrapper for db.ts helpers. */
  private get sqlExec() {
    return { exec: (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params) };
  }

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

    // Configure injection detector with per-environment secret delimiter
    configureInjectionDetector((env as any).PROMPT_DELIMITER);
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

    // Schedule next alarm — 5 min supervisor tick
    this.ctx.storage.setAlarm(Date.now() + 300_000);

    // Refresh Linear OAuth token every 12h (alarm fires every 5min, so check timestamp)
    try {
      const lastRefreshValue = getSetting(this.sqlExec, "linear_token_refreshed_at");
      const lastRefresh = lastRefreshValue ? parseInt(lastRefreshValue, 10) : 0;
      const twelveHours = 12 * 60 * 60 * 1000;
      if (Date.now() - lastRefresh > twelveHours) {
        const refreshed = await refreshLinearToken(this.sqlExec, this.env as Record<string, unknown>);
        if (refreshed) {
          setSetting(this.sqlExec, "linear_token_refreshed_at", String(Date.now()));
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


  private getGithubTokens(): Record<string, string> {
    const tokens: Record<string, string> = {};
    try {
      const allProducts = getAllProductConfigs(this.sqlExec);
      for (const [slug, config] of Object.entries(allProducts)) {
        const tokenBinding = config.secrets?.GITHUB_TOKEN;
        if (tokenBinding && (this.env as Record<string, unknown>)[tokenBinding]) {
          tokens[slug] = (this.env as Record<string, unknown>)[tokenBinding] as string;
        }
      }
    } catch (err) {
      console.error("[Orchestrator] Failed to load product configs for GitHub tokens:", err);
    }
    return tokens;
  }


  private initDb() {
    if (this.dbInitialized) return;

    initSchema({ exec: (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params) });

    this.dbInitialized = true;

    // Initialize AgentManager after tables are created
    this.agentManager = new AgentManager(
      { exec: (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params) },
      this.env as Record<string, unknown>,
    );
  }

  async fetch(request: Request): Promise<Response> {
    this.initDb();
    await this.ensureContainerRunning();
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/event":
        return this.handleEvent(request);
      case "/health":
        return Response.json({ ok: true, service: "orchestrator-do" });
      case "/tickets":
        return Response.json(listTicketsData(this.sqlExec));
      case "/ticket/status":
        return this.handleStatusUpdate(request);
      case "/token-usage":
        return this.handleTokenUsage(request);
      case "/slack-event":
        return this.handleSlackEvent(request);
      case "/slack-interactive":
        return Response.json({ ok: true });
      case "/heartbeat":
        return this.handleHeartbeat(request);
      case "/check-health":
        return Response.json({ ok: true, stale_agents: checkAgentHealthData(this.sqlExec).staleAgents });
      case "/transcripts": {
        const limit = parseInt(url.searchParams.get("limit") || "50", 10);
        const sinceHours = url.searchParams.get("sinceHours") ? parseInt(url.searchParams.get("sinceHours")!, 10) : undefined;
        return Response.json(listTranscriptsData(this.sqlExec, { limit, sinceHours }));
      }
      case "/status":
        return Response.json(getSystemStatusData(this.sqlExec));
      case "/cleanup-inactive":
        return this.cleanupInactiveAgents();
      case "/shutdown-all":
        return this.shutdownAllAgents();
      case "/restart-project-agents":
        return restartProjectAgentsImpl(this.env, this.sqlExec);
      case "/products":
        if (request.method === "GET") return listProductsHandler(this.sqlExec);
        { const { slug, config } = await request.json<{ slug: string; config: unknown }>(); return createProductHandler(this.sqlExec, slug, config); }
      case "/settings":
        return listSettingsHandler(this.sqlExec);
      case "/metrics": {
        const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
        const limit = Number.isNaN(rawLimit) ? 50 : Math.max(1, Math.min(500, rawLimit));
        const rawDays = parseInt(url.searchParams.get("days") || "30", 10);
        const days = Number.isNaN(rawDays) ? 30 : Math.max(1, Math.min(365, rawDays));
        return Response.json(getMetricsData(this.sqlExec, { limit, days }));
      }
      case "/metrics/summary":
        return Response.json(getMetricsSummaryData(this.sqlExec));
      default:
        return this.handleDynamicRoute(url, request);
    }
  }

  private async handleDynamicRoute(url: URL, request: Request): Promise<Response> {
    if (url.pathname.startsWith("/ticket-status/")) {
      const ticketUUID = decodeURIComponent(url.pathname.slice("/ticket-status/".length));
      const ticket = this.agentManager.getTicket(ticketUUID);
      if (!ticket) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({
        agent_active: ticket.agent_active,
        status: ticket.status,
        product: ticket.product,
        terminal: this.agentManager.isTerminal(ticketUUID),
        session_id: ticket.session_id,
        transcript_r2_key: ticket.transcript_r2_key,
      });
    }
    if (url.pathname.startsWith("/products/")) {
      const slug = url.pathname.split("/").pop()!;
      if (url.pathname === "/products/seed") {
        return seedProductsHandler(this.sqlExec, await request.json());
      }
      if (request.method === "GET") return getProductHandler(this.sqlExec, slug);
      if (request.method === "PUT") { const { config } = await request.json<{ config: unknown }>(); return updateProductHandler(this.sqlExec, slug, config); }
      if (request.method === "DELETE") return deleteProductHandler(this.sqlExec, slug);
    }
    if (url.pathname.startsWith("/settings/")) {
      const key = url.pathname.split("/").pop()!;
      if (request.method === "PUT") { const { value } = await request.json<{ value: string }>(); return updateSettingHandler(this.sqlExec, key, value); }
    }
    if (url.pathname.startsWith("/project-agent/")) {
      const subpath = url.pathname.replace("/project-agent/", "");
      return handleProjectAgentRouteImpl(subpath, request, this.env, this.sqlExec, this.agentManager);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // --- Project Agent routing (delegated to project-agent-router.ts) ---

  private async routeToProjectAgent(
    product: string,
    event: TicketEvent,
  ): Promise<void> {
    return routeToProjectAgentImpl(product, event, this.env, this.sqlExec);
  }

  private async ensureConductor(): Promise<DurableObjectStub> {
    return ensureConductorImpl(this.env, this.sqlExec);
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
    ensureTicketMetrics(this.sqlExec, event.ticketUUID);

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
   * Review a new ticket and decide how to handle it.
   *
   * v3 flow: Routes the event to the persistent ProjectAgent for the product.
   * The ProjectAgent (via coding-project-lead SKILL.md) decides whether to:
   * - Spawn a TicketAgent for coding tasks
   * - Handle directly (quick answers, research)
   * - Ask for clarification
   *
   * Fallback: If ProjectAgent routing fails, spawns a TicketAgent directly
   * (preserves v2 behavior as safety net).
   */
  private async handleTicketReview(event: TicketEvent): Promise<void> {
    const payload = event.payload as Record<string, unknown>;

    // Load product config from database
    const productConfig = getProductConfig(this.sqlExec, event.product);

    if (!productConfig) {
      console.error(`[Orchestrator] No product config for ${event.product}`);
      return;
    }

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

    // v3: Route to ProjectAgent — let it decide what to do
    try {
      await this.routeToProjectAgent(event.product, event);
      console.log(`[Orchestrator] Routed ticket ${event.ticketUUID} to ProjectAgent for ${event.product}`);
      return; // ProjectAgent will handle spawning if needed via /project-agent/spawn-task
    } catch (err) {
      console.error(`[Orchestrator] ProjectAgent routing failed for ${event.ticketUUID}, falling back to direct spawn:`, err);
    }

    // Fallback: spawn TicketAgent directly (v2 behavior)
    const model = "sonnet";
    console.log(`[Orchestrator] Fallback: Starting agent for ticket ${event.ticketUUID} (model=${model})`);

    // Build spawn config from product
    const gatewayConfig = getGatewayConfig(this.sqlExec);

    const spawnConfig: SpawnConfig = {
      product: event.product,
      repos: productConfig.repos,
      slackChannel: productConfig.slack_channel_id || productConfig.slack_channel,
      slackThreadTs: event.slackThreadTs || (ticketRow?.slack_thread_ts as string) || undefined,
      secrets: productConfig.secrets,
      gatewayConfig,
      model,
      mode: productConfig.mode,
      slackPersona: productConfig.slack_persona,
    };

    try {
      await this.agentManager.spawnAgent(event.ticketUUID, spawnConfig);
      await this.agentManager.sendEvent(event.ticketUUID, event);
    } catch (err) {
      console.error(`[Orchestrator] Failed to spawn agent for ${event.ticketUUID}:`, err);
    }
  }

  /**
   * Re-spawn a container for a suspended ticket and send the triggering event.
   * Uses the product config from the registry to reconstruct spawn config.
   */
  private async respawnSuspendedAgent(ticketUUID: string, product: string, event: TicketEvent): Promise<void> {
    const productConfig = getProductConfig(this.sqlExec, product);
    if (!productConfig) throw new Error(`Product ${product} not found in registry`);

    const gatewayConfig = getGatewayConfig(this.sqlExec);

    const ticket = this.agentManager.getTicket(ticketUUID);

    const spawnConfig: SpawnConfig = {
      product,
      repos: productConfig.repos,
      slackChannel: productConfig.slack_channel_id || productConfig.slack_channel,
      slackThreadTs: event.slackThreadTs || ticket?.slack_thread_ts || undefined,
      secrets: productConfig.secrets,
      gatewayConfig,
      model: productConfig.model || "sonnet",
      mode: productConfig.mode,
      slackPersona: productConfig.slack_persona,
    };

    // spawnAgent accepts active status as a re-spawn
    await this.agentManager.spawnAgent(ticketUUID, spawnConfig);
    await this.agentManager.sendEvent(ticketUUID, event);
  }

  /**
   * Supervisor tick — heartbeat-only staleness check.
   *
   * Agents now manage their own PR lifecycle (merge gate, CI checks) via
   * agent/src/merge-gate.ts. The supervisor only detects stale agents
   * (no heartbeat in 5+ minutes) and flags them for observability.
   */
  private async runSupervisorTick(): Promise<void> {
    const staleAgents = this.ctx.storage.sql.exec(`
      SELECT ticket_uuid, product, last_heartbeat
      FROM tickets
      WHERE agent_active = 1
        AND last_heartbeat IS NOT NULL
        AND last_heartbeat < datetime('now', '-5 minutes')
    `).toArray() as Array<{
      ticket_uuid: string;
      product: string;
      last_heartbeat: string;
    }>;

    for (const agent of staleAgents) {
      console.log(`[Supervisor] Agent stale: ${agent.ticket_uuid} (last heartbeat: ${agent.last_heartbeat})`);
      this.ctx.storage.sql.exec(
        "UPDATE tickets SET agent_message = 'heartbeat timeout — agent may be stuck', updated_at = datetime('now') WHERE ticket_uuid = ?",
        agent.ticket_uuid,
      );
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
      session_id?: string;
      agent_active?: number;
    }>();
    const { ticketUUID, status, pr_url, branch_name, slack_thread_ts, transcript_r2_key, session_id, agent_active } = body;

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

    const updates: string[] = ["updated_at = datetime('now')"];
    const values: (string | number | null)[] = [];

    // Allow explicit control of agent_active flag (for dashboard kill operations)
    if (agent_active !== undefined) {
      updates.push("agent_active = ?");
      values.push(agent_active);
      console.log(`[Orchestrator] Explicitly setting agent_active=${agent_active} for ticket ${ticketUUID}`);
    }

    if (status) {
      // Map agent tool status names to valid ticket states
      const statusAliases: Record<string, string> = {
        in_progress: "active",
        in_review: "pr_open",
        needs_revision: "active",
        asking: "needs_info",
      };
      const resolvedStatus = statusAliases[status] || status;

      // Only accept valid ticket states — reject agent lifecycle messages (e.g., "agent:*")
      // that old agent code may still send to this endpoint instead of /heartbeat.
      if (!(TICKET_STATES as readonly string[]).includes(resolvedStatus)) {
        console.log(`[Orchestrator] Rejecting invalid status "${status}" for ticket ${ticketUUID} — use /heartbeat for lifecycle messages`);
        // Still process other fields (pr_url, branch_name, etc.) below
      } else {
        updates.push("status = ?");
        values.push(resolvedStatus);
      }

      // Track first_response_at when agent starts working
      if (resolvedStatus === "active") {
        this.ctx.storage.sql.exec(
          `UPDATE ticket_metrics SET first_response_at = COALESCE(first_response_at, datetime('now')), updated_at = datetime('now') WHERE ticket_uuid = ?`,
          ticketUUID,
        );
      }

      // Suspended state: mark agent inactive — container has exited
      if (resolvedStatus === "suspended") {
        updates.push("agent_active = 0");
        console.log(`[Orchestrator] Marking agent inactive for suspended state: ${ticketUUID}`);
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
    if (session_id) {
      updates.push("session_id = ?");
      values.push(session_id);
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
      model?: string;
    }>();
    const { ticketUUID, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens, totalCostUsd, turns, sessionMessageCount, model } = body;

    console.log(
      `[Orchestrator] Token usage: ticket=${ticketUUID} input=${totalInputTokens} output=${totalOutputTokens} cost=$${totalCostUsd.toFixed(2)}`
    );

    // Upsert token usage data
    this.ctx.storage.sql.exec(
      `INSERT INTO token_usage (
        ticket_uuid, total_input_tokens, total_output_tokens,
        total_cache_read_tokens, total_cache_creation_tokens,
        total_cost_usd, turns, session_message_count, model
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_uuid) DO UPDATE SET
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cache_read_tokens = excluded.total_cache_read_tokens,
        total_cache_creation_tokens = excluded.total_cache_creation_tokens,
        total_cost_usd = excluded.total_cost_usd,
        turns = excluded.turns,
        session_message_count = excluded.session_message_count,
        model = excluded.model,
        updated_at = datetime('now')`,
      ticketUUID,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalCostUsd,
      turns,
      sessionMessageCount,
      model,
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
    const payload = await request.json<HeartbeatPayload>();
    const { ticketUUID, message, ci_status, needs_attention, needs_attention_reason } = payload;

    console.log(`[Orchestrator] heartbeat: ticket=${ticketUUID} ${message || ""}`);
    this.agentManager.recordPhoneHome(ticketUUID, message);

    // Store expanded heartbeat fields if provided
    const extraUpdates: string[] = [];
    const extraValues: (string | number | null)[] = [];

    if (ci_status !== undefined) {
      extraUpdates.push("ci_status = ?");
      extraValues.push(ci_status);
    }
    if (needs_attention !== undefined) {
      extraUpdates.push("needs_attention = ?");
      extraValues.push(needs_attention ? 1 : 0);
    }
    if (needs_attention_reason !== undefined) {
      extraUpdates.push("needs_attention_reason = ?");
      extraValues.push(needs_attention_reason);
    }

    if (extraUpdates.length > 0) {
      this.ctx.storage.sql.exec(
        `UPDATE tickets SET ${extraUpdates.join(", ")}, updated_at = datetime('now') WHERE ticket_uuid = ?`,
        ...extraValues, ticketUUID,
      );
    }

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

  private async handleSlackEvent(request: Request): Promise<Response> {
    const slackEvent = await request.json<{
      type: string;
      text?: string;
      user?: string;
      channel?: string;
      thread_ts?: string;
      ts?: string;
      slash_command?: string;
      reaction?: string;
      item?: { ts: string; channel: string };
    }>();

    return handleSlackEventImpl(slackEvent, {
      sql: this.sqlExec,
      env: this.env as Record<string, unknown>,
      agentManager: this.agentManager,
      routeToProjectAgent: (product, event) => this.routeToProjectAgent(product, event),
      ensureConductor: () => this.ensureConductor(),
      handleTicketReview: (event) => this.handleTicketReview(event),
      respawnSuspendedAgent: (ticketUUID, product, event) => this.respawnSuspendedAgent(ticketUUID, product, event),
    });
  }

}
