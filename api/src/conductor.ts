import { Container } from "@cloudflare/containers";
import { TERMINAL_STATUSES, TASK_STATES, type TaskEvent, type HeartbeatPayload, type Bindings } from "./types";
import type { ProductConfig, CloudflareAIGateway } from "./registry";
import { TaskManager, type SpawnConfig } from "./task-manager";
import { configure as configureInjectionDetector } from "./security/injection-detector";
import type { ProjectLeadConfig } from "./project-lead";
import { initSchema, getSetting, setSetting, getGatewayConfig, getProductConfig, getAllProductConfigs, ensureTaskMetrics } from "./db";
import {
  ensureProjectLead as ensureProjectLeadImpl,
  ensureConductor as ensureConductorImpl,
  routeToProjectLead as routeToProjectLeadImpl,
  handleProjectLeadRoute as handleProjectLeadRouteImpl,
  restartProjectLeads as restartProjectLeadsImpl,
} from "./project-lead-router";
import {
  getSystemStatus as getSystemStatusData,
  getMetrics as getMetricsData,
  getMetricsSummary as getMetricsSummaryData,
  checkAgentHealth as checkAgentHealthData,
  listTasks as listTasksData,
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

function sanitizeTaskUUID(id: string): string {
  return String(id).slice(0, 128).replace(/[^a-zA-Z0-9_\-\.]/g, "_") || `unknown-${Date.now()}`;
}

// Re-export from slack-handler for backward compatibility with tests
export { resolveProductFromChannel } from "./slack-handler";

// Pure helper — exported for testing
export function buildTaskEvent(
  source: string,
  type: string,
  data: Record<string, unknown>,
): TaskEvent {
  return {
    type,
    source,
    taskUUID: sanitizeTaskUUID((data.taskUUID || data.id || `${source}-${Date.now()}`) as string),
    product: data.product as string,
    payload: data,
    slackThreadTs: data.threadTs as string | undefined,
    slackChannel: data.channel as string | undefined,
  };
}

export class Conductor extends Container<Bindings> {
  defaultPort = 3000;
  // No sleepAfter — always on

  private dbInitialized = false;
  private containerStarted = false;
  private taskManager!: TaskManager;

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
      WORKER_URL: (env as any).WORKER_URL || (() => { console.error("[Conductor] WORKER_URL not configured — run: wrangler secret put WORKER_URL"); return ""; })(),
    };

    // Configure injection detector with per-environment secret delimiter
    configureInjectionDetector((env as any).PROMPT_DELIMITER);
  }

  override onStop(params: { exitCode: number; reason: string }) {
    console.error(`[Conductor] Container stopped: exitCode=${params.exitCode} reason=${params.reason}`);
    this.containerStarted = false;
  }

  override onError(error: unknown) {
    console.error("[Conductor] Container error:", error);
    throw error;
  }

  // Always-on: when the SDK's alarm loop fires and the container is dead,
  // restart it before handing control to the base class. This ensures the
  // Slack Socket Mode container self-heals after crashes or deployments.
  // Also runs the LLM supervisor tick every 5 minutes.
  override async alarm(alarmProps: { isRetry: boolean; retryCount: number }) {
    this.initDb();
    await this.ensureContainerRunning();

    // Run LLM supervisor tick — checks agent health, stale PRs, queued tasks
    try {
      await this.runSupervisorTick();
    } catch (err) {
      console.error("[Conductor] Supervisor tick failed:", err);
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
      console.error("[Conductor] Linear token refresh check failed:", err);
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
      if (Date.now() - this.lastHealthCheck < Conductor.HEALTH_CHECK_TTL) return;
      try {
        // Container handle exists at runtime (from Container SDK) but isn't in Workers types
        const port = (this.ctx as any).container.getTcpPort(this.defaultPort);
        const res = await port.fetch("http://localhost/health", { signal: AbortSignal.timeout(2000) }) as Response;
        if (res.ok) {
          this.lastHealthCheck = Date.now();
          return;
        }
      } catch {
        console.warn("[Conductor] Container flag was set but container is not responsive — restarting");
        this.containerStarted = false;
      }
    }

    console.log("[Conductor] Starting container (deployment or first start)...");
    try {
      await this.startAndWaitForPorts(this.defaultPort);
      this.containerStarted = true;
      console.log("[Conductor] Container started successfully");
    } catch (err) {
      console.error("[Conductor] Container start failed:", err);
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
      console.error("[Conductor] Failed to load product configs for GitHub tokens:", err);
    }
    return tokens;
  }


  private initDb() {
    if (this.dbInitialized) return;

    initSchema({ exec: (sql: string, ...params: unknown[]) => this.ctx.storage.sql.exec(sql, ...params) });

    this.dbInitialized = true;

    // Initialize TaskManager after tables are created
    this.taskManager = new TaskManager(
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
        return Response.json({ ok: true, service: "conductor-do" });
      case "/tickets":
        return Response.json(listTasksData(this.sqlExec));
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
      case "/restart-project-leads":
        return restartProjectLeadsImpl(this.env, this.sqlExec);
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
    if (url.pathname.startsWith("/task-status/")) {
      const taskUUID = decodeURIComponent(url.pathname.slice("/task-status/".length));
      const task = this.taskManager.getTask(taskUUID);
      if (!task) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({
        agent_active: task.agent_active,
        status: task.status,
        product: task.product,
        terminal: this.taskManager.isTerminal(taskUUID),
        session_id: task.session_id,
        transcript_r2_key: task.transcript_r2_key,
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
    if (url.pathname.startsWith("/project-lead/")) {
      const subpath = url.pathname.replace("/project-lead/", "");
      return handleProjectLeadRouteImpl(subpath, request, this.env, this.sqlExec, this.taskManager);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // --- Project Lead routing (delegated to project-lead-router.ts) ---

  private async routeToProjectLead(
    product: string,
    event: TaskEvent,
  ): Promise<void> {
    return routeToProjectLeadImpl(product, event, this.env, this.sqlExec);
  }

  private async ensureConductor(): Promise<DurableObjectStub> {
    return ensureConductorImpl(this.env, this.sqlExec);
  }

  private async handleEvent(request: Request): Promise<Response> {
    const event = await request.json<TaskEvent>();
    event.taskUUID = sanitizeTaskUUID(event.taskUUID);
    console.log(`[Conductor] handleEvent: type=${event.type} taskUUID=${event.taskUUID} source=${event.source}`);

    // Resolve branch-extracted task IDs (e.g. "PES-5") to their UUID task.
    // GitHub webhooks extract taskId from branch names like "ticket/PES-5",
    // but the canonical task is stored under the Linear UUID. Look up by branch_name
    // first, then fall back to task_id (e.g., "PES-5" matches tasks.task_id).
    if (event.source === "github") {
      const byBranch = this.ctx.storage.sql.exec(
        "SELECT task_uuid FROM tasks WHERE branch_name = ? OR branch_name = ?",
        `ticket/${event.taskUUID}`, `feedback/${event.taskUUID}`,
      ).toArray()[0] as { task_uuid: string } | undefined;
      if (byBranch) {
        console.log(`[Conductor] Resolved branch task ID ${event.taskUUID} → ${byBranch.task_uuid}`);
        event.taskUUID = byBranch.task_uuid;
      } else {
        // branch_name may not be set yet — fall back to task_id lookup
        const byIdentifier = this.taskManager.getTaskByIdentifier(event.taskUUID);
        if (byIdentifier) {
          console.log(`[Conductor] Resolved identifier ${event.taskUUID} → ${byIdentifier.task_uuid}`);
          event.taskUUID = byIdentifier.task_uuid;
        }
      }
    }

    // Check if this task is already in a terminal state — don't re-activate it
    if (this.taskManager.isTerminal(event.taskUUID)) {
      const existing = this.taskManager.getTask(event.taskUUID);
      console.log(`[Conductor] Ignoring event for terminal task ${event.taskUUID} (status: ${existing?.status})`);
      return Response.json({ ok: true, taskUUID: event.taskUUID, ignored: true, reason: "terminal task" });
    }

    // For Linear events, look up Slack thread from slack_thread_map (Slack-originated tasks)
    if (event.source === "linear" && !event.slackThreadTs) {
      const threadMap = this.ctx.storage.sql.exec(
        "SELECT slack_thread_ts, slack_channel FROM slack_thread_map WHERE linear_issue_id = ?",
        event.taskUUID,
      ).toArray()[0] as { slack_thread_ts: string; slack_channel: string } | undefined;
      if (threadMap) {
        event.slackThreadTs = threadMap.slack_thread_ts || undefined;
        event.slackChannel = threadMap.slack_channel || undefined;
        console.log(`[Conductor] Linked Linear issue ${event.taskUUID} to Slack thread ${threadMap.slack_thread_ts}`);
        // Clean up — one-time mapping
        this.ctx.storage.sql.exec("DELETE FROM slack_thread_map WHERE linear_issue_id = ?", event.taskUUID);
      }
    }

    // Create or update task
    const payload = event.payload as Record<string, unknown>;
    const taskId = (payload.identifier as string) || null;
    const title = (payload.title as string) || null;
    const existingTicket = this.taskManager.getTask(event.taskUUID);
    if (!existingTicket) {
      this.taskManager.createTask({
        taskUUID: event.taskUUID,
        product: event.product,
        slackThreadTs: event.slackThreadTs || undefined,
        slackChannel: event.slackChannel || undefined,
        taskId: taskId || undefined,
        title: title || undefined,
      });
    } else {
      // Update metadata — preserve existing values when new ones are null
      const metadataUpdate: Record<string, string | undefined> = {};
      if (event.slackThreadTs) metadataUpdate.slack_thread_ts = event.slackThreadTs;
      if (event.slackChannel) metadataUpdate.slack_channel = event.slackChannel;
      if (Object.keys(metadataUpdate).length > 0) {
        this.taskManager.updateStatus(event.taskUUID, metadataUpdate as any);
      }
    }

    // Initialize task_metrics row if not exists
    ensureTaskMetrics(this.sqlExec, event.taskUUID);

    // For new tasks, use LLM task review instead of direct routing
    if (event.type === "task_created") {
      await this.handleTaskReview(event);
      return Response.json({ ok: true, taskUUID: event.taskUUID });
    }

    // For Linear comments, route to running agent or re-evaluate via task review
    if (event.type === "linear_comment") {
      const taskRow = this.taskManager.getTask(event.taskUUID);

      if (taskRow && this.taskManager.isTerminal(event.taskUUID)) {
        console.log(`[Conductor] Ignoring linear_comment for terminal task ${event.taskUUID} (status: ${taskRow.status})`);
      } else if (taskRow?.agent_active) {
        // Forward to running agent like a Slack reply
        await this.taskManager.sendEvent(event.taskUUID, event);
      } else {
        // No agent running — re-evaluate via task review
        await this.handleTaskReview(event);
      }
      return Response.json({ ok: true, taskUUID: event.taskUUID });
    }

    // Handle PR merged/closed events directly in conductor — don't route to agent.
    // The agent container may have already exited, so routing via sendEvent would silently
    // drop the event (sendEvent requires agent_active=1). Update status here instead.
    if (event.type === "pr_merged") {
      const taskRow = this.taskManager.getTask(event.taskUUID);
      if (taskRow) {
        console.log(`[Conductor] PR merged for ${event.taskUUID} — marking terminal`);
        try {
          this.taskManager.updateStatus(event.taskUUID, { status: "merged" });
        } catch {
          // Force update if state transition is invalid (e.g., already in a terminal state)
          this.ctx.storage.sql.exec(
            "UPDATE tasks SET status = 'merged', agent_active = 0, updated_at = datetime('now') WHERE task_uuid = ?",
            event.taskUUID,
          );
        }
        // Clean up merge gate retries
        this.ctx.storage.sql.exec("DELETE FROM merge_gate_retries WHERE task_uuid = ?", event.taskUUID);
        await this.taskManager.stopAgent(event.taskUUID, "pr_merged").catch(err =>
          console.warn(`[Conductor] Failed to stop agent on pr_merged:`, err)
        );
        return Response.json({ ok: true, taskUUID: event.taskUUID, status: "merged" });
      }
    }

    if (event.type === "pr_closed") {
      const taskRow = this.taskManager.getTask(event.taskUUID);
      if (taskRow) {
        console.log(`[Conductor] PR closed (not merged) for ${event.taskUUID} — marking terminal`);
        try {
          this.taskManager.updateStatus(event.taskUUID, { status: "closed" });
        } catch {
          // Force update if state transition is invalid
          this.ctx.storage.sql.exec(
            "UPDATE tasks SET status = 'closed', agent_active = 0, updated_at = datetime('now') WHERE task_uuid = ?",
            event.taskUUID,
          );
        }
        // Clean up merge gate retries
        this.ctx.storage.sql.exec("DELETE FROM merge_gate_retries WHERE task_uuid = ?", event.taskUUID);
        await this.taskManager.stopAgent(event.taskUUID, "pr_closed").catch(err =>
          console.warn(`[Conductor] Failed to stop agent on pr_closed:`, err)
        );
        return Response.json({ ok: true, taskUUID: event.taskUUID, status: "closed" });
      }
    }

    // Route to TaskAgent for all other event types
    await this.taskManager.sendEvent(event.taskUUID, event);

    return Response.json({ ok: true, taskUUID: event.taskUUID });
  }

  /**
   * Review a new task and decide how to handle it.
   *
   * v3 flow: Routes the event to the persistent ProjectLead for the product.
   * The ProjectLead (via coding-project-lead SKILL.md) decides whether to:
   * - Spawn a TaskAgent for coding tasks
   * - Handle directly (quick answers, research)
   * - Ask for clarification
   *
   * Fallback: If ProjectLead routing fails, spawns a TaskAgent directly
   * (preserves v2 behavior as safety net).
   */
  private async handleTaskReview(event: TaskEvent): Promise<void> {
    const payload = event.payload as Record<string, unknown>;

    // Load product config from database
    const productConfig = getProductConfig(this.sqlExec, event.product);

    if (!productConfig) {
      console.error(`[Conductor] No product config for ${event.product}`);
      return;
    }

    // Get task record for slack info
    const taskRow = this.taskManager.getTask(event.taskUUID) as Record<string, unknown> | null;

    // Skip task review if agent is already running or task is past initial triage.
    // Linear sends multiple webhooks (create + update) and we don't want to re-review
    // a task that already has an active agent.
    if (taskRow) {
      const status = taskRow.status as string;
      const agentActive = taskRow.agent_active as number;
      if (agentActive === 1 || (status !== "created" && status !== "needs_info")) {
        console.log(`[Conductor] Skipping task review for ${event.taskUUID} — already active (status=${status}, agent_active=${agentActive})`);
        return;
      }
    }

    // Transition to reviewing state (task review = the review phase)
    try {
      this.taskManager.updateStatus(event.taskUUID, { status: "reviewing" });
    } catch {
      // May already be in reviewing state — ignore
    }

    // v3: Route to ProjectLead — let it decide what to do
    try {
      await this.routeToProjectLead(event.product, event);
      console.log(`[Conductor] Routed task ${event.taskUUID} to ProjectLead for ${event.product}`);
      return; // ProjectLead will handle spawning if needed via /project-lead/spawn-task
    } catch (err) {
      console.error(`[Conductor] ProjectLead routing failed for ${event.taskUUID}, falling back to direct spawn:`, err);
    }

    // Fallback: spawn TaskAgent directly (v2 behavior)
    const model = "sonnet";
    console.log(`[Conductor] Fallback: Starting agent for task ${event.taskUUID} (model=${model})`);

    // Build spawn config from product
    const gatewayConfig = getGatewayConfig(this.sqlExec);

    const spawnConfig: SpawnConfig = {
      product: event.product,
      repos: productConfig.repos,
      slackChannel: productConfig.slack_channel_id || productConfig.slack_channel,
      slackThreadTs: event.slackThreadTs || (taskRow?.slack_thread_ts as string) || undefined,
      secrets: productConfig.secrets,
      gatewayConfig,
      model,
      mode: productConfig.mode,
      slackPersona: productConfig.slack_persona,
    };

    try {
      await this.taskManager.spawnAgent(event.taskUUID, spawnConfig);
      await this.taskManager.sendEvent(event.taskUUID, event);
    } catch (err) {
      console.error(`[Conductor] Failed to spawn agent for ${event.taskUUID}:`, err);
    }
  }

  /**
   * Re-spawn a container for a suspended task and send the triggering event.
   * Uses the product config from the registry to reconstruct spawn config.
   */
  private async respawnSuspendedTask(taskUUID: string, product: string, event: TaskEvent): Promise<void> {
    const productConfig = getProductConfig(this.sqlExec, product);
    if (!productConfig) throw new Error(`Product ${product} not found in registry`);

    const gatewayConfig = getGatewayConfig(this.sqlExec);

    const task = this.taskManager.getTask(taskUUID);

    const spawnConfig: SpawnConfig = {
      product,
      repos: productConfig.repos,
      slackChannel: productConfig.slack_channel_id || productConfig.slack_channel,
      slackThreadTs: event.slackThreadTs || task?.slack_thread_ts || undefined,
      secrets: productConfig.secrets,
      gatewayConfig,
      model: "sonnet",
      mode: productConfig.mode,
      slackPersona: productConfig.slack_persona,
    };

    // spawnAgent accepts active status as a re-spawn
    await this.taskManager.spawnAgent(taskUUID, spawnConfig);
    await this.taskManager.sendEvent(taskUUID, event);
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
      SELECT task_uuid, product, last_heartbeat
      FROM tasks
      WHERE agent_active = 1
        AND last_heartbeat IS NOT NULL
        AND last_heartbeat < datetime('now', '-5 minutes')
    `).toArray() as Array<{
      task_uuid: string;
      product: string;
      last_heartbeat: string;
    }>;

    for (const agent of staleAgents) {
      console.log(`[Supervisor] Agent stale: ${agent.task_uuid} (last heartbeat: ${agent.last_heartbeat})`);
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET agent_message = 'heartbeat timeout — agent may be stuck', updated_at = datetime('now') WHERE task_uuid = ?",
        agent.task_uuid,
      );
    }

    // Detect "ghost" agents — agent_active=1 but never received a heartbeat
    // and created > 5 minutes ago. This catches containers that started but
    // never received their task event (event lost during delivery).
    const ghostAgents = this.ctx.storage.sql.exec(`
      SELECT task_uuid, product, created_at
      FROM tasks
      WHERE agent_active = 1
        AND last_heartbeat IS NULL
        AND status IN ('spawning', 'active')
        AND created_at < datetime('now', '-5 minutes')
    `).toArray() as Array<{
      task_uuid: string;
      product: string;
      created_at: string;
    }>;

    for (const agent of ghostAgents) {
      console.log(`[Supervisor] Ghost agent: ${agent.task_uuid} (created: ${agent.created_at}, no heartbeat ever received)`);
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET agent_active = 0, agent_message = 'no heartbeat since spawn — event may have been lost', needs_attention = 1, needs_attention_reason = 'ghost agent: started but never received task event', updated_at = datetime('now') WHERE task_uuid = ?",
        agent.task_uuid,
      );
    }
  }

  private async handleStatusUpdate(request: Request): Promise<Response> {
    const body = await request.json<{
      taskUUID: string;
      status?: string;
      pr_url?: string;
      branch_name?: string;
      slack_thread_ts?: string;
      transcript_r2_key?: string;
      session_id?: string;
      agent_active?: number;
    }>();
    const { taskUUID, status, pr_url, branch_name, slack_thread_ts, transcript_r2_key, session_id, agent_active } = body;

    // Log payloads so they appear in wrangler tail
    console.log(`[Conductor] status update: task=${taskUUID} status=${status || ""} branch=${branch_name || ""} agent_active=${agent_active ?? "unset"}`);

    // Reject heartbeats/status updates for tasks already in a terminal state.
    // This prevents agent containers from overwriting supervisor kill decisions.
    if (this.taskManager.isTerminal(taskUUID)) {
      // Allow explicit agent_active=0 (dashboard kill) but block heartbeats
      if (agent_active === undefined || agent_active !== 0) {
        const currentTask = this.taskManager.getTask(taskUUID);
        console.log(`[Conductor] Ignoring status update for terminal task ${taskUUID} (current: ${currentTask?.status})`);
        return Response.json({ ok: true, ignored: true, reason: "terminal task" });
      }
    }

    const updates: string[] = ["updated_at = datetime('now')"];
    const values: (string | number | null)[] = [];

    // Allow explicit control of agent_active flag (for dashboard kill operations)
    if (agent_active !== undefined) {
      updates.push("agent_active = ?");
      values.push(agent_active);
      console.log(`[Conductor] Explicitly setting agent_active=${agent_active} for task ${taskUUID}`);
    }

    if (status) {
      // Map agent tool status names to valid task states
      const statusAliases: Record<string, string> = {
        in_progress: "active",
        in_review: "pr_open",
        needs_revision: "active",
        asking: "needs_info",
      };
      const resolvedStatus = statusAliases[status] || status;

      // Only accept valid task states — reject agent lifecycle messages (e.g., "agent:*")
      // that old agent code may still send to this endpoint instead of /heartbeat.
      if (!(TASK_STATES as readonly string[]).includes(resolvedStatus)) {
        console.log(`[Conductor] Rejecting invalid status "${status}" for task ${taskUUID} — use /heartbeat for lifecycle messages`);
        // Still process other fields (pr_url, branch_name, etc.) below
      } else {
        updates.push("status = ?");
        values.push(resolvedStatus);
      }

      // Track first_response_at when agent starts working
      if (resolvedStatus === "active") {
        this.ctx.storage.sql.exec(
          `UPDATE task_metrics SET first_response_at = COALESCE(first_response_at, datetime('now')), updated_at = datetime('now') WHERE task_uuid = ?`,
          taskUUID,
        );
      }

      // Suspended state: mark agent inactive — container has exited
      if (resolvedStatus === "suspended") {
        updates.push("agent_active = 0");
        console.log(`[Conductor] Marking agent inactive for suspended state: ${taskUUID}`);
      }

      // Terminal states: mark agent as inactive so we don't spawn new agents
      // on deployment-triggered events
      if ((TERMINAL_STATUSES as readonly string[]).includes(status)) {
        updates.push("agent_active = 0");
        console.log(`[Conductor] Marking agent inactive for terminal state: ${status}`);

        // Update task_metrics with outcome and completion time
        const outcome = status === "merged" ? "automerge_success" : status;
        this.ctx.storage.sql.exec(
          `UPDATE task_metrics SET outcome = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE task_uuid = ?`,
          outcome,
          taskUUID,
        );

        // Stop the agent container
        await this.taskManager.stopAgent(taskUUID, `terminal status: ${status}`).catch(err =>
          console.error(`[Conductor] Failed to stop agent for ${taskUUID}:`, err)
        );
      }
    }
    if (pr_url) {
      updates.push("pr_url = ?");
      values.push(pr_url);

      // Increment pr_count only when the PR URL actually changes
      const currentTask = this.taskManager.getTask(taskUUID);
      if (!currentTask || currentTask.pr_url !== pr_url) {
        this.ctx.storage.sql.exec(
          `UPDATE task_metrics SET pr_count = pr_count + 1, updated_at = datetime('now') WHERE task_uuid = ?`,
          taskUUID,
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

    values.push(taskUUID);
    this.ctx.storage.sql.exec(
      `UPDATE tasks SET ${updates.join(", ")} WHERE task_uuid = ?`,
      ...values,
    );

    // Handle explicit agent_active=0 (dashboard kill) — stop the container
    if (agent_active !== undefined && agent_active === 0) {
      await this.taskManager.stopAgent(taskUUID, "explicit agent_active=0").catch(err =>
        console.error(`[Conductor] Failed to stop agent for ${taskUUID}:`, err)
      );
    }

    return Response.json({ ok: true });
  }

  private async handleTokenUsage(request: Request): Promise<Response> {
    const body = await request.json<{
      taskUUID: string;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheReadTokens: number;
      totalCacheCreationTokens: number;
      totalCostUsd: number;
      turns: number;
      sessionMessageCount: number;
      model?: string;
    }>();
    const { taskUUID, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens, totalCostUsd, turns, sessionMessageCount, model } = body;

    console.log(
      `[Conductor] Token usage: task=${taskUUID} input=${totalInputTokens} output=${totalOutputTokens} cost=$${totalCostUsd.toFixed(2)}`
    );

    // Upsert token usage data
    this.ctx.storage.sql.exec(
      `INSERT INTO token_usage (
        task_uuid, total_input_tokens, total_output_tokens,
        total_cache_read_tokens, total_cache_creation_tokens,
        total_cost_usd, turns, session_message_count, model
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_uuid) DO UPDATE SET
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cache_read_tokens = excluded.total_cache_read_tokens,
        total_cache_creation_tokens = excluded.total_cache_creation_tokens,
        total_cost_usd = excluded.total_cost_usd,
        turns = excluded.turns,
        session_message_count = excluded.session_message_count,
        model = excluded.model,
        updated_at = datetime('now')`,
      taskUUID,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      totalCostUsd,
      turns,
      sessionMessageCount,
      model,
    );

    // Sync cost to task_metrics for unified reporting
    this.ctx.storage.sql.exec(
      `UPDATE task_metrics SET total_cost_usd = ?, updated_at = datetime('now') WHERE task_uuid = ?`,
      totalCostUsd,
      taskUUID,
    );

    return Response.json({ ok: true });
  }

  private async handleHeartbeat(request: Request): Promise<Response> {
    const payload = await request.json<HeartbeatPayload>();
    const { taskUUID, message, ci_status, needs_attention, needs_attention_reason } = payload;

    console.log(`[Conductor] heartbeat: task=${taskUUID} ${message || ""}`);
    this.taskManager.recordPhoneHome(taskUUID, message);

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
        `UPDATE tasks SET ${extraUpdates.join(", ")}, updated_at = datetime('now') WHERE task_uuid = ?`,
        ...extraValues, taskUUID,
      );
    }

    // Auto-transition spawning → active on first heartbeat.
    // The agent sends heartbeats once it's running — this replaces the old
    // pattern where phoneHome side-effects would overwrite the status field.
    const task = this.taskManager.getTask(taskUUID);
    if (task?.status === "spawning") {
      this.ctx.storage.sql.exec(
        "UPDATE tasks SET status = 'active', updated_at = datetime('now') WHERE task_uuid = ?",
        taskUUID,
      );
      console.log(`[Conductor] Auto-transitioned task ${taskUUID} from spawning → active`);
    }

    return Response.json({ ok: true });
  }



  private async cleanupInactiveAgents(): Promise<Response> {
    // Force shutdown of containers for tasks marked inactive (agent_active = 0)
    // or terminal but still marked active.
    await this.taskManager.cleanupInactive();

    // Also stop containers for all inactive tasks (agent_active = 0)
    const inactiveTasks = this.ctx.storage.sql.exec(
      `SELECT task_uuid FROM tasks WHERE agent_active = 0`
    ).toArray() as Array<{ task_uuid: string }>;

    console.log(`[Conductor] Cleanup: found ${inactiveTasks.length} inactive tasks`);

    const results: Array<{ taskUUID: string; success: boolean; error?: string }> = [];

    for (const task of inactiveTasks) {
      try {
        await this.taskManager.stopAgent(task.task_uuid, "cleanup inactive");
        results.push({ taskUUID: task.task_uuid, success: true });
      } catch (err) {
        results.push({ taskUUID: task.task_uuid, success: false, error: String(err) });
      }
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`[Conductor] Cleanup complete: ${successCount}/${results.length} successful`);

    return Response.json({
      ok: true,
      total: inactiveTasks.length,
      successful: successCount,
      results,
    });
  }

  private async shutdownAllAgents(): Promise<Response> {
    // Force shutdown of ALL agent containers, regardless of state.
    // Use case: operator wants to stop all work immediately.

    // Get ALL tasks for response details before stopping
    const allTasks = this.ctx.storage.sql.exec(
      `SELECT task_uuid, status, agent_active FROM tasks`
    ).toArray() as Array<{ task_uuid: string; status: string; agent_active: number }>;

    console.log(`[Conductor] Shutdown all: found ${allTasks.length} total tasks`);

    // Stop each task individually to track per-task success/failure
    const results: Array<{ taskUUID: string; previousStatus: string; success: boolean; error?: string }> = [];

    for (const task of allTasks) {
      try {
        await this.taskManager.stopAgent(task.task_uuid, "shutdown all requested");
        results.push({ taskUUID: task.task_uuid, previousStatus: task.status, success: true });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[Conductor] Failed to stop ${task.task_uuid}:`, errorMsg);
        results.push({ taskUUID: task.task_uuid, previousStatus: task.status, success: false, error: errorMsg });
      }
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`[Conductor] Shutdown all complete: ${successCount}/${results.length} successful`);

    return Response.json({
      ok: true,
      total: allTasks.length,
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
      taskManager: this.taskManager,
      routeToProjectLead: (product, event) => this.routeToProjectLead(product, event),
      ensureConductor: () => this.ensureConductor(),
      handleTaskReview: (event) => this.handleTaskReview(event),
      respawnSuspendedTask: (taskUUID, product, event) => this.respawnSuspendedTask(taskUUID, product, event),
    });
  }

}
