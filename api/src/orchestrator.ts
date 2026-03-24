import { Container } from "@cloudflare/containers";
import { TERMINAL_STATUSES, TICKET_STATES, type TicketEvent, type HeartbeatPayload, type Bindings } from "./types";
import type { ProductConfig, CloudflareAIGateway } from "./registry";
import { AgentManager, type SpawnConfig } from "./agent-manager";
import { addReaction } from "./slack-utils";
import { configure as configureInjectionDetector } from "./security/injection-detector";
import { normalizeSlackEvent } from "./security/normalized-event";
import type { ProjectAgentConfig } from "./project-agent";
import { initSchema, getSetting, setSetting, getGatewayConfig, getProductConfig, getAllProductConfigs, ensureTicketMetrics } from "./db";
import {
  getSystemStatus as getSystemStatusData,
  getMetrics as getMetricsData,
  getMetricsSummary as getMetricsSummaryData,
  checkAgentHealth as checkAgentHealthData,
  listTickets as listTicketsData,
  listTranscripts as listTranscriptsData,
  formatStatusMessage,
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
        const refreshed = await this.refreshLinearToken();
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
    // Build product→token map from per-product token bindings in env
    const tokens: Record<string, string> = {};
    // Load product configs to map slug → secret binding name
    const allProducts = getAllProductConfigs(this.sqlExec);

    for (const [slug, config] of Object.entries(allProducts)) {
      const tokenBinding = config.secrets?.GITHUB_TOKEN;
      if (tokenBinding && (this.env as Record<string, unknown>)[tokenBinding]) {
        tokens[slug] = (this.env as Record<string, unknown>)[tokenBinding] as string;
      }
    }
    return tokens;
  }

  /** Get the Linear OAuth app token — checks SQLite settings for a stored token, falls back to env binding. */
  private getLinearAppToken(): string {
    try {
      const value = getSetting(this.sqlExec, "linear_app_token");
      if (value) return value;
    } catch {
      // Settings table may not exist yet during early init
    }
    return (this.env.LINEAR_APP_TOKEN as string) || "";
  }

  /** Use LLM to generate a structured ticket title and description from a Slack message. */
  private async generateTicketSummary(
    rawText: string,
    product: string,
    slackUser: string,
  ): Promise<{ title: string; description: string }> {
    if (!rawText) {
      return { title: "Slack request (no description)", description: `**Slack request from <@${slackUser}>**` };
    }

    const apiKey = (this.env.ANTHROPIC_API_KEY as string) || "";
    if (!apiKey) {
      throw new Error("No ANTHROPIC_API_KEY configured");
    }

    // Check for AI Gateway config
    const gatewayConfig = getGatewayConfig(this.sqlExec);
    const baseUrl = gatewayConfig
      ? `https://gateway.ai.cloudflare.com/v1/${gatewayConfig.account_id}/${gatewayConfig.gateway_id}/anthropic`
      : "https://api.anthropic.com";

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{
          role: "user",
          content: `You are generating a Linear ticket from a Slack message for the "${product}" product.

Given this Slack message:
<message>
${rawText}
</message>

Generate a JSON object with:
- "title": A concise ticket title (imperative form, max 120 chars). Capture WHAT the request is.
- "description": A well-structured ticket description that captures WHY the user is asking (their goal) and any relevant context from the message. Include the original Slack message as a quote block for reference. Format with markdown.

Respond with ONLY the JSON object, no other text.`,
        }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error ${response.status}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const textBlock = data.content.find((b) => b.type === "text");
    if (!textBlock) throw new Error("No text in Anthropic response");

    // Parse JSON from response, handling potential markdown code fences
    let jsonText = textBlock.text.trim();
    const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();

    const parsed = JSON.parse(jsonText) as { title: string; description: string };

    // Ensure title isn't too long
    const title = parsed.title.length > 200 ? parsed.title.slice(0, 197) + "..." : parsed.title;

    return {
      title,
      description: parsed.description || `**Slack request from <@${slackUser}>:**\n\n${rawText}`,
    };
  }

  /** Get the Slack bot token from env. */
  private getSlackBotToken(): string {
    return (this.env.SLACK_BOT_TOKEN as string) || "";
  }

  /** Refresh the Linear OAuth token using the stored refresh token. */
  private async refreshLinearToken(): Promise<boolean> {
    try {
      const refreshToken = getSetting(this.sqlExec, "linear_refresh_token");

      if (!refreshToken) {
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
          refresh_token: refreshToken,
        }),
      });

      if (!res.ok) {
        console.error(`[Orchestrator] Linear token refresh failed: ${res.status}`);
        return false;
      }

      const data = await res.json() as { access_token: string; refresh_token?: string };
      setSetting(this.sqlExec, "linear_app_token", data.access_token);

      if (data.refresh_token) {
        setSetting(this.sqlExec, "linear_refresh_token", data.refresh_token);
      }

      console.log("[Orchestrator] Linear token refreshed successfully");
      return true;
    } catch (err) {
      console.error("[Orchestrator] Linear token refresh error:", err);
      return false;
    }
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

  // --- Product registry CRUD methods ---

  private listProducts(): Response {
    return listProductsHandler(this.sqlExec);
  }

  private getProduct(request: Request): Response {
    const url = new URL(request.url);
    const slug = url.pathname.split("/").pop()!;
    return getProductHandler(this.sqlExec, slug);
  }

  private async createProduct(request: Request): Promise<Response> {
    const { slug, config } = await request.json<{ slug: string; config: unknown }>();
    return createProductHandler(this.sqlExec, slug, config);
  }

  private async updateProduct(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const slug = url.pathname.split("/").pop()!;
    const { config } = await request.json<{ config: unknown }>();
    return updateProductHandler(this.sqlExec, slug, config);
  }

  private deleteProduct(request: Request): Response {
    const url = new URL(request.url);
    const slug = url.pathname.split("/").pop()!;
    return deleteProductHandler(this.sqlExec, slug);
  }

  private listSettings(): Response {
    return listSettingsHandler(this.sqlExec);
  }

  private async updateSetting(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname.split("/").pop()!;
    const { value } = await request.json<{ value: string }>();
    return updateSettingHandler(this.sqlExec, key, value);
  }

  private async seedProducts(request: Request): Promise<Response> {
    const registry = await request.json<{
      linear_team_id?: string;
      linear_app_user_id?: string;
      conductor_channel?: string;
      cloudflare_ai_gateway?: { account_id: string; gateway_id: string };
      products: Record<string, unknown>;
    }>();
    return seedProductsHandler(this.sqlExec, registry);
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
      case "/restart-project-agents":
        return this.restartProjectAgents();
      case "/products":
        return request.method === "GET" ? this.listProducts() : this.createProduct(request);
      case "/settings":
        return this.listSettings();
      case "/metrics":
        return this.getMetrics(request);
      case "/metrics/summary":
        return this.getMetricsSummary();
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
        // Project agent internal endpoints
        if (url.pathname.startsWith("/project-agent/")) {
          return this.handleProjectAgentRoute(url.pathname, request);
        }
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  // --- Project Agent routing ---

  /**
   * Ensure a ProjectAgent DO is initialized and running for a product.
   * Returns the DO stub for further interaction.
   */
  private async ensureProjectAgent(
    product: string,
    productConfig: ProductConfig,
  ): Promise<DurableObjectStub> {
    const id = this.env.PROJECT_AGENT.idFromName(product);
    const stub = this.env.PROJECT_AGENT.get(id);

    // Build ProjectAgentConfig
    const gatewayConfig = getGatewayConfig(this.sqlExec);

    const config: ProjectAgentConfig = {
      product,
      repos: productConfig.repos,
      slackChannel: productConfig.slack_channel_id || productConfig.slack_channel,
      slackPersona: productConfig.slack_persona,
      secrets: productConfig.secrets,
      mode: productConfig.mode,
      gatewayConfig,
      model: "sonnet",
    };

    // Initialize (idempotent — if config unchanged and container healthy, returns immediately)
    const res = await stub.fetch(new Request("http://project-agent/ensure-running", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    }));

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown error");
      console.error(`[Orchestrator] Failed to ensure ProjectAgent for ${product}: ${errText}`);
    }

    return stub;
  }

  /**
   * Ensure the Conductor (cross-product coordinator) is running.
   * The Conductor is a special ProjectAgent keyed as "__conductor__".
   */
  private async ensureConductor(): Promise<DurableObjectStub> {
    const id = this.env.PROJECT_AGENT.idFromName("__conductor__");
    const stub = this.env.PROJECT_AGENT.get(id);

    // Read conductor channel from settings
    const conductorChannel = getSetting(this.sqlExec, "conductor_channel") || "";

    const conductorConfig: ProjectAgentConfig = {
      product: "__conductor__",
      repos: [],
      slackChannel: conductorChannel,
      secrets: {
        ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      },
      mode: "flexible",
      model: "sonnet",
    };

    const res = await stub.fetch(new Request("http://project-agent/ensure-running", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(conductorConfig),
    }));

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown error");
      console.error(`[Orchestrator] Failed to ensure Conductor: ${errText}`);
    }

    return stub;
  }

  /**
   * Route an event to the ProjectAgent for a product.
   * Ensures the agent is running first, then forwards the event.
   */
  private async routeToProjectAgent(
    product: string,
    event: TicketEvent,
  ): Promise<void> {
    // Load product config
    const productConfig = getProductConfig(this.sqlExec, product);

    if (!productConfig) {
      throw new Error(`No product config for ${product} — cannot route to ProjectAgent`);
    }

    const stub = await this.ensureProjectAgent(product, productConfig);

    const res = await stub.fetch(new Request("http://project-agent/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }));

    if (res.ok) {
      console.log(`[Orchestrator] Routed ${event.type} to ProjectAgent for ${product}`);
    } else if (res.status === 202) {
      console.log(`[Orchestrator] Event buffered in ProjectAgent for ${product} (container starting)`);
    } else {
      throw new Error(`ProjectAgent event routing failed: ${res.status}`);
    }
  }

  /**
   * Handle internal project agent API requests.
   * These endpoints are called by the project agent container via the worker.
   */
  private async handleProjectAgentRoute(pathname: string, request: Request): Promise<Response> {
    const subpath = pathname.replace("/project-agent/", "");

    switch (subpath) {
      case "spawn-task": {
        // Project agent requests spawning a ticket agent for a task
        const body = await request.json<{
          product: string;
          ticketUUID: string;
          ticketId?: string;
          ticketTitle?: string;
          ticketDescription?: string;
          slackThreadTs?: string;
          slackChannel?: string;
          mode?: "coding" | "research" | "flexible";
          model?: string;
        }>();

        // Load product config
        const productConfig = getProductConfig(this.sqlExec, body.product);
        if (!productConfig) {
          return Response.json({ error: "product not found" }, { status: 404 });
        }

        // Create ticket in DB and transition to reviewing so spawnAgent accepts it
        try {
          this.agentManager.createTicket({
            ticketUUID: body.ticketUUID,
            product: body.product,
            slackThreadTs: body.slackThreadTs,
            slackChannel: body.slackChannel,
            ticketId: body.ticketId,
            title: body.ticketTitle,
          });
          // Transition from created → reviewing (spawnAgent requires reviewing or queued)
          this.agentManager.updateStatus(body.ticketUUID, { status: "reviewing" });
        } catch {
          // Already exists or already in reviewing — fine
        }

        // Build spawn config
        const gatewayConfig = getGatewayConfig(this.sqlExec);

        const spawnConfig: SpawnConfig = {
          product: body.product,
          repos: productConfig.repos,
          slackChannel: body.slackChannel || productConfig.slack_channel_id || productConfig.slack_channel,
          slackThreadTs: body.slackThreadTs,
          secrets: productConfig.secrets,
          gatewayConfig,
          model: body.model || "sonnet",
          mode: body.mode || productConfig.mode,
          slackPersona: productConfig.slack_persona,
        };

        try {
          await this.agentManager.spawnAgent(body.ticketUUID, spawnConfig);

          // Send the task description as an event so the ticket agent starts work
          if (body.ticketDescription || body.ticketTitle) {
            const taskEvent: TicketEvent = {
              type: "slack_mention",
              source: "internal",
              ticketUUID: body.ticketUUID,
              product: body.product,
              payload: {
                text: body.ticketDescription || body.ticketTitle || "",
                title: body.ticketTitle || "",
              },
            };
            try {
              await this.agentManager.sendEvent(body.ticketUUID, taskEvent);
            } catch (err) {
              console.warn(`[Orchestrator] spawn-task: event delivery deferred for ${body.ticketUUID}:`, err);
              // Agent may not be ready yet — it will receive the event via buffer drain
            }
          }

          return Response.json({ ok: true, ticketUUID: body.ticketUUID, status: "spawned" });
        } catch (err) {
          console.error(`[Orchestrator] spawn-task failed for ${body.ticketUUID}:`, err);
          return Response.json({ error: "spawn failed" }, { status: 500 });
        }
      }

      case "list-tasks": {
        // List all tickets for a product
        const url = new URL(request.url);
        const product = url.searchParams.get("product");
        if (!product) return Response.json({ error: "product required" }, { status: 400 });

        const rows = this.ctx.storage.sql.exec(
          `SELECT ticket_uuid, ticket_id, title, status, agent_active, pr_url,
                  branch_name, agent_message, created_at, updated_at
           FROM tickets WHERE product = ? ORDER BY created_at DESC LIMIT 50`,
          product,
        ).toArray();
        return Response.json({ tasks: rows });
      }

      case "send-event": {
        // Forward an event to a specific ticket agent
        const body = await request.json<{ ticketUUID: string; event: TicketEvent }>();
        try {
          await this.agentManager.sendEvent(body.ticketUUID, body.event);
          return Response.json({ ok: true });
        } catch (err) {
          return Response.json({ error: "send failed" }, { status: 500 });
        }
      }

      case "relay-to-project": {
        // Relay a message/event to a specific product's ProjectAgent DO
        const body = await request.json<{ product: string; event: TicketEvent }>();

        // Load product config
        const productConfig = getProductConfig(this.sqlExec, body.product);

        if (!productConfig) {
          return Response.json({ error: "product not found" }, { status: 404 });
        }

        try {
          const stub = await this.ensureProjectAgent(body.product, productConfig);
          const res = await stub.fetch(new Request("http://project-agent/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body.event),
          }));

          if (res.ok) {
            return Response.json({ ok: true, routed: body.product });
          }
          return Response.json({ error: "relay failed" }, { status: res.status });
        } catch (err) {
          console.error(`[Orchestrator] relay-to-project failed for ${body.product}:`, err);
          return Response.json({ error: "relay failed" }, { status: 500 });
        }
      }

      case "stop-task": {
        // Stop a ticket agent
        const body = await request.json<{ ticketUUID: string; reason?: string }>();
        try {
          await this.agentManager.stopAgent(body.ticketUUID, body.reason || "project_agent_request");
          return Response.json({ ok: true });
        } catch (err) {
          return Response.json({ error: "stop failed" }, { status: 500 });
        }
      }

      case "drain-events": {
        // Drain buffered events from a specific ProjectAgent DO.
        // Called by the container after starting a session to pick up events
        // that were buffered while the container was starting/restarting.
        const url = new URL(request.url);
        const product = url.searchParams.get("product");
        if (!product) return Response.json({ error: "product required" }, { status: 400 });

        const id = this.env.PROJECT_AGENT.idFromName(product);
        const stub = this.env.PROJECT_AGENT.get(id);
        return stub.fetch(new Request("http://project-agent/drain-events"));
      }

      case "status": {
        // Get status of all project agents
        const productRows = this.ctx.storage.sql.exec(
          "SELECT slug FROM products",
        ).toArray() as Array<{ slug: string }>;

        const statuses: Record<string, unknown> = {};
        for (const row of productRows) {
          try {
            const id = this.env.PROJECT_AGENT.idFromName(row.slug);
            const stub = this.env.PROJECT_AGENT.get(id);
            const res = await stub.fetch(new Request("http://project-agent/status"));
            statuses[row.slug] = res.ok ? await res.json() : { error: `${res.status}` };
          } catch {
            statuses[row.slug] = { error: "unreachable" };
          }
        }
        return Response.json({ project_agents: statuses });
      }

      default:
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

  private async checkAgentHealth(): Promise<Response> {
    const result = checkAgentHealthData(this.sqlExec);
    return Response.json({ ok: true, stale_agents: result.staleAgents });
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

  /**
   * Force restart all ProjectAgent containers to pick up new code after deploy.
   */
  private async restartProjectAgents(): Promise<Response> {
    const productRows = this.ctx.storage.sql.exec(
      "SELECT slug FROM products",
    ).toArray() as Array<{ slug: string }>;

    const products = [...productRows.map(r => r.slug), "__conductor__"];
    const results: Array<{ product: string; success: boolean; error?: string }> = [];

    for (const product of products) {
      try {
        const id = this.env.PROJECT_AGENT.idFromName(product);
        const stub = this.env.PROJECT_AGENT.get(id);
        const res = await stub.fetch(new Request("http://project-agent/restart", {
          method: "POST",
        }));
        if (res.ok) {
          results.push({ product, success: true });
        } else {
          const errText = await res.text().catch(() => "unknown");
          results.push({ product, success: false, error: errText });
        }
      } catch (err) {
        results.push({ product, success: false, error: String(err) });
      }
    }

    console.log(`[Orchestrator] Restarted ${results.filter(r => r.success).length}/${results.length} ProjectAgents`);
    return Response.json({ ok: true, results });
  }

  private listTickets(): Response {
    return Response.json(listTicketsData(this.sqlExec));
  }

  private listTranscripts(request: Request): Response {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    const sinceHours = url.searchParams.get("sinceHours") ? parseInt(url.searchParams.get("sinceHours")!, 10) : undefined;
    return Response.json(listTranscriptsData(this.sqlExec, { limit, sinceHours }));
  }

  private getSystemStatus(): Response {
    return Response.json(getSystemStatusData(this.sqlExec));
  }

  private async handleStatusCommand(channel: string, threadTs: string): Promise<void> {
    try {
      const statusData = getSystemStatusData(this.sqlExec);
      const message = formatStatusMessage(statusData, channel);
      await this.postSlackMessage(channel, message, threadTs);
      console.log(`[Orchestrator] Posted status to channel=${channel}`);
    } catch (err) {
      console.error("[Orchestrator] Failed to handle status command:", err);
    }
  }


  /** Post a message to Slack. Returns the message ts on success, null on failure. */
  private async postSlackMessage(
    channel: string,
    text: string,
    threadTs?: string | null,
  ): Promise<string | null> {
    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${(this.env as any).SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel,
          text,
          ...(threadTs && { thread_ts: threadTs }),
        }),
      });

      if (!res.ok) {
        console.error(`[Orchestrator] Slack API error: ${res.status}`);
        return null;
      }

      const data = await res.json() as { ok: boolean; ts?: string; error?: string };
      if (!data.ok) {
        console.error(`[Orchestrator] Slack API error: ${data.error}`);
        return null;
      }
      return data.ts || null;
    } catch (err) {
      console.error("[Orchestrator] Failed to post Slack message:", err);
      return null;
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

    // Fast-ack: immediately add 👀 reaction so user knows we received the event
    if (slackEvent.ts && slackEvent.channel && slackEvent.type === "app_mention") {
      addReaction({
        token: this.getSlackBotToken(),
        channel: slackEvent.channel,
        timestamp: slackEvent.ts,
        name: "eyes",
      }); // Fire-and-forget — don't await
    }

    // Scan for injection attacks before processing
    if (slackEvent.text) {
      const scanResult = await normalizeSlackEvent(slackEvent as Record<string, unknown>);
      if (!scanResult.ok) {
        console.warn(`[Orchestrator] Slack event rejected: ${scanResult.error}`);
        return Response.json({ ok: true, rejected: true, reason: "injection detected" });
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

    // Check if this message is in the conductor's dedicated channel.
    // Conductor channel accepts ALL messages (no @-mention required).
    const conductorChannelId = getSetting(this.sqlExec, "conductor_channel");

    if (!conductorChannelId) {
      console.log(`[Orchestrator] No conductor_channel configured in settings — conductor routing skipped for channel ${slackEvent.channel}`);
    } else if (slackEvent.channel !== conductorChannelId) {
      console.log(`[Orchestrator] Message in channel ${slackEvent.channel} does not match conductor channel ${conductorChannelId}`);
    }

    if (conductorChannelId && slackEvent.channel === conductorChannelId) {
      console.log(`[Orchestrator] Mention in conductor channel ${conductorChannelId} — routing to Conductor`);

      try {
        const conductorStub = await this.ensureConductor();
        const rawText = (slackEvent.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
        const event: TicketEvent = {
          type: "slack_mention",
          source: "slack",
          ticketUUID: `conductor-${slackEvent.ts || Date.now()}`,
          product: "__conductor__",
          payload: {
            text: rawText,
            user: slackEvent.user,
            channel: slackEvent.channel,
            ts: slackEvent.ts,
          },
          slackThreadTs: slackEvent.thread_ts || slackEvent.ts,
          slackChannel: slackEvent.channel,
        };
        await conductorStub.fetch(new Request("http://project-agent/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        }));
        return Response.json({ ok: true, routed: "conductor" });
      } catch (err) {
        console.error("[Orchestrator] Failed to route to Conductor:", err);
        return Response.json({ error: "conductor_routing_failed" }, { status: 500 });
      }
    }

    // Resolve product from channel (needed for both @-mentions and plain messages)
    const products = getAllProductConfigs(this.sqlExec);

    const product = resolveProductFromChannel(products, slackEvent.channel || "");

    if (!product) {
      // Unmapped channel — only respond on @-mention, silently ignore plain messages
      if (slackEvent.type === "app_mention") {
        console.log(`[Orchestrator] No product mapped to channel ${slackEvent.channel} — replying to mention`);
        await this.postSlackMessage(
          slackEvent.channel || "",
          `ℹ️ This channel is not configured for any product. Ask an admin to register it.`,
          slackEvent.ts || ""
        );
      }
      return Response.json({ ok: true, ignored: true, reason: "unmapped_channel" });
    }

    // Product channel: route ALL messages to ProjectAgent.
    // For plain messages (no @-mention), route directly — no Linear ticket.
    // For @-mentions, create a Linear ticket first (existing flow below).
    if (slackEvent.type !== "app_mention") {
      console.log(`[Orchestrator] Plain message in ${product} channel — routing to ProjectAgent`);
      const rawText = (slackEvent.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      const event: TicketEvent = {
        type: "slack_mention",
        source: "slack",
        ticketUUID: `chat-${slackEvent.ts || Date.now()}`,
        product,
        payload: {
          text: rawText,
          user: slackEvent.user,
          channel: slackEvent.channel,
          ts: slackEvent.ts,
        },
        slackThreadTs: slackEvent.thread_ts || slackEvent.ts,
        slackChannel: slackEvent.channel,
      };
      this.routeToProjectAgent(product, event).catch(err =>
        console.error(`[Orchestrator] ProjectAgent routing failed for ${product}:`, err)
      );
      return Response.json({ ok: true, routed: "project_agent", product });
    }

    const slackThreadTs = slackEvent.thread_ts || slackEvent.ts;

    const productConfig = products[product];
    const projectName = productConfig.triggers?.linear?.project_name;

    // Products without Linear (e.g., research mode) route directly to ProjectAgent
    // without creating a Linear ticket. A ticket record is still created in the DB
    // so that thread replies can be routed back to the agent.
    if (!projectName) {
      console.log(`[Orchestrator] No Linear project for ${product} — routing directly to ProjectAgent`);

      const rawText = (slackEvent.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      const ticketUUID = `slack-${slackEvent.ts || Date.now()}`;

      // Create ticket record so thread replies can be routed
      try {
        this.agentManager.createTicket({
          ticketUUID,
          product,
          slackThreadTs: slackThreadTs || undefined,
          slackChannel: slackEvent.channel || undefined,
          title: rawText.slice(0, 100),
        });
      } catch {
        // Already exists — fine (e.g. re-delivery)
      }

      const directEvent: TicketEvent = {
        type: "slack_mention",
        source: "slack",
        ticketUUID,
        product,
        payload: {
          text: rawText,
          user: slackEvent.user,
          channel: slackEvent.channel,
          ts: slackEvent.ts,
        },
        slackThreadTs: slackThreadTs || undefined,
        slackChannel: slackEvent.channel || undefined,
      };

      // Route to ProjectAgent (fire-and-forget — don't block Slack response)
      this.routeToProjectAgent(product, directEvent).catch(err =>
        console.error(`[Orchestrator] Direct ProjectAgent routing failed for ${product}:`, err)
      );

      return Response.json({ ok: true, routed: "project_agent", product });
    }

    // Load settings for Linear API
    const settings = this.ctx.storage.sql.exec("SELECT key, value FROM settings").toArray() as Array<{ key: string; value: string }>;
    const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const teamId: string | undefined = settingsMap.linear_team_id;
    const appUserId: string | undefined = settingsMap.linear_app_user_id;
    const linearToken = this.getLinearAppToken();

    if (!teamId || !linearToken) {
      await this.postSlackMessage(
        slackEvent.channel || "",
        `❌ Linear integration not configured (missing team ID or token).`,
        slackThreadTs || "",
      );
      return Response.json({ error: "linear not configured" }, { status: 500 });
    }

    // Strip the @mention from the text to get the raw request
    const rawText = (slackEvent.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();

    // Use LLM to generate a structured title and description from the Slack message
    let title: string;
    let description: string;
    try {
      const generated = await this.generateTicketSummary(rawText, product, slackEvent.user || "unknown");
      title = generated.title;
      description = generated.description;
    } catch (err) {
      console.error("[Orchestrator] LLM title generation failed, using fallback:", err);
      // Fallback: normalize whitespace and truncate
      const normalized = rawText.replace(/\s+/g, " ").trim();
      title = normalized
        ? (normalized.length <= 200 ? normalized : normalized.slice(0, 197) + "...")
        : "Slack request (no description)";
      description = `**Slack request from <@${slackEvent.user}>:**\n\n${rawText}`;
    }

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
            description,
            ...(projectId && { projectId }),
            ...(appUserId && { assigneeId: appUserId }),
          },
        },
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error(`[Orchestrator] Failed to create Linear issue: ${createRes.status} ${errText}`);
      await this.postSlackMessage(
        slackEvent.channel || "",
        `❌ Failed to create Linear ticket. Please try again or create one manually.`,
        slackThreadTs || "",
      );
      return Response.json({ error: "linear issue creation failed" }, { status: 500 });
    }

    const createData = await createRes.json() as {
      data?: { issueCreate?: { success: boolean; issue?: { id: string; identifier: string; url: string } } }
    };
    const issue = createData.data?.issueCreate?.issue;

    if (!issue) {
      console.error("[Orchestrator] Linear issueCreate returned no issue:", JSON.stringify(createData));
      await this.postSlackMessage(
        slackEvent.channel || "",
        `❌ Failed to create Linear ticket. Please try again or create one manually.`,
        slackThreadTs || "",
      );
      return Response.json({ error: "linear issue creation failed" }, { status: 500 });
    }

    console.log(`[Orchestrator] Created Linear issue ${issue.identifier} (${issue.id}) from Slack mention`);

    // Post acknowledgment as a NEW top-level message (not a reply).
    // This message becomes the ticket thread — all future updates reply here.
    const ticketThreadTs = await this.postSlackMessage(
      slackEvent.channel!,
      `📋 Created <${issue.url}|${issue.identifier}>: ${title}\n⏳ Working on it...`,
    );

    // Reply briefly in the user's original thread pointing to the ticket thread
    if (ticketThreadTs) {
      this.postSlackMessage(
        slackEvent.channel!,
        `👋 On it! Follow progress in the thread above.`,
        slackThreadTs,
      ).catch(err => console.warn("[Orchestrator] Failed to post thread pointer:", err));
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
    ensureTicketMetrics(this.sqlExec, issue.id);

    this.handleTicketReview(ticketEvent)
      .catch(err => console.error("[Orchestrator] Direct ticket review failed:", err));

    return Response.json({ ok: true, linearIssue: issue.identifier });
  }

  private async handleSlackInteractive(_request: Request): Promise<Response> {
    return Response.json({ ok: true });
  }

  // --- Metrics endpoints ---

  private getMetrics(request: Request): Response {
    const url = new URL(request.url);
    const rawLimit = parseInt(url.searchParams.get("limit") || "50", 10);
    const limit = Number.isNaN(rawLimit) ? 50 : Math.max(1, Math.min(500, rawLimit));
    const rawDays = parseInt(url.searchParams.get("days") || "30", 10);
    const days = Number.isNaN(rawDays) ? 30 : Math.max(1, Math.min(365, rawDays));
    return Response.json(getMetricsData(this.sqlExec, { limit, days }));
  }

  private getMetricsSummary(): Response {
    return Response.json(getMetricsSummaryData(this.sqlExec));
  }

}
