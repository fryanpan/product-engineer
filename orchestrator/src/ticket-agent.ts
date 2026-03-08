import { Container } from "@cloudflare/containers";
import type { TicketEvent, TicketAgentConfig, Bindings } from "./types";
import type { CloudflareAIGateway } from "./registry";

// Pure helper — exported for testing
// gatewayConfig is optional — pass null to disable, pass config to enable
export function resolveAgentEnvVars(
  config: TicketAgentConfig,
  env: Record<string, string>,
  gatewayConfig?: CloudflareAIGateway | null,
): Record<string, string> {
  const vars: Record<string, string> = {
    PRODUCT: config.product,
    TICKET_ID: config.ticketId,
    REPOS: JSON.stringify(config.repos),
    SLACK_CHANNEL: config.slackChannel,
    SLACK_THREAD_TS: "", // Populated at runtime via event.slackThreadTs
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN || "",
    LINEAR_API_KEY: env.LINEAR_API_KEY || "",
    SENTRY_DSN: env.SENTRY_DSN || "",
    WORKER_URL: env.WORKER_URL || (() => { console.error("[TicketAgent] WORKER_URL not configured — run: wrangler secret put WORKER_URL"); return ""; })(),
    API_KEY: env.API_KEY || "",
    // R2 credentials for transcript backup (not session persistence)
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID || "",
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY || "",
    CF_ACCOUNT_ID: env.CF_ACCOUNT_ID || "",
    // Model selection (sonnet, opus, haiku)
    MODEL: config.model || "",
  };

  for (const [logicalName, bindingName] of Object.entries(config.secrets)) {
    const value = env[bindingName];
    if (value) {
      vars[logicalName] = value;
    } else {
      console.warn(`[TicketAgent] Secret not found: ${logicalName}`);
      vars[logicalName] = "";
    }
  }

  // gh CLI reads GH_TOKEN for headless auth
  if (vars.GITHUB_TOKEN) {
    vars.GH_TOKEN = vars.GITHUB_TOKEN;
  }

  // Cloudflare AI Gateway — route all Anthropic API traffic through gateway
  // The Agent SDK reads ANTHROPIC_BASE_URL automatically to proxy all requests
  // See docs/cloudflare-ai-gateway.md for setup and analytics features
  // gatewayConfig is loaded from registry by caller and passed in
  if (gatewayConfig) {
    vars.ANTHROPIC_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(gatewayConfig.account_id)}/${encodeURIComponent(gatewayConfig.gateway_id)}/anthropic`;
  }

  return vars;
}

export class TicketAgent extends Container<Bindings> {
  defaultPort = 3000;
  sleepAfter = "15m";

  private configLoaded = false;

  constructor(ctx: DurableObjectState, env: Bindings) {
    // @ts-expect-error — DurableObjectState generic mismatch between Container SDK and Workers types
    super(ctx, env);
    // Container base class initializes envVars={} as a class field, which shadows
    // any getter. Set the real values here so containerFetch auto-restarts work.
    // On first construction (no config yet), envVars stays {} — /initialize sets it.
    const config = this.getConfig();
    if (config) {
      this.envVars = resolveAgentEnvVars(
        config,
        env as unknown as Record<string, string>,
        config.gatewayConfig
      );
    }
  }

  private initDb() {
    if (this.configLoaded) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.configLoaded = true;
  }

  private getConfig(): TicketAgentConfig | null {
    this.initDb();
    const row = this.ctx.storage.sql.exec(
      "SELECT value FROM config WHERE key = 'agent_config'"
    ).toArray()[0] as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  private setConfig(config: TicketAgentConfig) {
    this.initDb();
    this.ctx.storage.sql.exec(
      `INSERT INTO config (key, value) VALUES ('agent_config', ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`,
      JSON.stringify(config),
      JSON.stringify(config),
    );
    // Update instance envVars so containerFetch auto-restarts use correct values
    this.envVars = resolveAgentEnvVars(
      config,
      this.env as unknown as Record<string, string>,
      config.gatewayConfig
    );
  }

  override onStop(params: { exitCode: number; reason: string }) {
    console.error(`[TicketAgent] Container stopped: exitCode=${params.exitCode} reason=${params.reason}`);
  }

  override onError(error: unknown) {
    console.error("[TicketAgent] Container error:", error);
    throw error;
  }

  // --- Event buffer: stores events that arrive while the container is unreachable ---

  private eventBufferInitialized = false;

  private initEventBuffer() {
    if (this.eventBufferInitialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS event_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.eventBufferInitialized = true;
  }

  private bufferEvent(event: TicketEvent) {
    this.initEventBuffer();
    this.ctx.storage.sql.exec(
      "INSERT INTO event_buffer (event_json) VALUES (?)",
      JSON.stringify(event),
    );
    console.log(`[TicketAgent] Buffered event: ${event.type} for ${event.ticketId}`);
  }

  private drainEventBuffer(): TicketEvent[] {
    this.initEventBuffer();
    const rows = this.ctx.storage.sql.exec(
      "SELECT id, event_json FROM event_buffer ORDER BY id ASC LIMIT 20"
    ).toArray() as { id: number; event_json: string }[];

    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      this.ctx.storage.sql.exec(
        `DELETE FROM event_buffer WHERE id IN (${ids.join(",")})`,
      );
      console.log(`[TicketAgent] Drained ${rows.length} buffered events`);
    }

    return rows.map(r => JSON.parse(r.event_json));
  }

  private isTerminal(): boolean {
    this.initDb();
    const row = this.ctx.storage.sql.exec(
      "SELECT value FROM config WHERE key = 'terminal'"
    ).toArray()[0] as { value: string } | undefined;
    return row?.value === "true";
  }

  markTerminal() {
    this.initDb();
    this.ctx.storage.sql.exec(
      `INSERT INTO config (key, value) VALUES ('terminal', 'true')
       ON CONFLICT(key) DO UPDATE SET value = 'true'`
    );
  }

  override async alarm(alarmProps: { isRetry: boolean; retryCount: number }) {
    // Don't restart containers for completed tickets
    if (this.isTerminal()) {
      return super.alarm(alarmProps);
    }

    const config = this.getConfig();
    if (config) {
      // Check orchestrator state — don't restart containers for tickets that are no longer active
      try {
        const orchestratorId = this.env.ORCHESTRATOR.idFromName("main");
        const orchestratorStub = this.env.ORCHESTRATOR.get(orchestratorId);
        const statusRes = await orchestratorStub.fetch(
          new Request(`http://internal/ticket-status/${encodeURIComponent(config.ticketId)}`)
        );
        if (statusRes.ok) {
          const status = await statusRes.json<{ agent_active: number; status: string }>();
          if (status.agent_active === 0) {
            console.log(`[TicketAgent] Orchestrator says ${config.ticketId} is inactive (status=${status.status}) — marking terminal, skipping restart`);
            this.markTerminal();
            return super.alarm(alarmProps);
          }
        }
      } catch (err) {
        console.warn(`[TicketAgent] Could not check orchestrator status for ${config.ticketId}:`, err);
        // Fall through to existing container health check
      }

      // Check container health — mark terminal if session completed/errored
      try {
        const res = await this.containerFetch("http://localhost/status", { method: "GET" }, this.defaultPort);
        const status = await res.json<{ sessionStatus: string }>();
        if (status.sessionStatus === "completed" || status.sessionStatus === "error") {
          console.log(`[TicketAgent] Session ${status.sessionStatus} for ${config.ticketId}, marking terminal`);
          this.markTerminal();
        }
      } catch {
        console.log(`[TicketAgent] Container not healthy for ${config.ticketId}, will auto-resume on restart`);
      }
    }
    return super.alarm(alarmProps);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/initialize": {
        const config = await request.json<TicketAgentConfig>();
        this.setConfig(config);
        await this.startAndWaitForPorts({
          ports: this.defaultPort,
          startOptions: { envVars: this.envVars as Record<string, string> },
        });
        return Response.json({ ok: true });
      }
      case "/event": {
        const event = await request.json<TicketEvent>();
        try {
          // containerFetch auto-starts the container if needed, using this.envVars
          // (set in constructor from SQLite or in setConfig from /initialize)
          const res = await this.containerFetch("http://localhost/event", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Key": (this.env.API_KEY as string) || "",
            },
            body: JSON.stringify(event),
          }, this.defaultPort);

          if (res.ok) return res;
          if (res.status === 503) {
            // Container not ready — buffer the event for later drain
            this.bufferEvent(event);
            return Response.json({ buffered: true }, { status: 202 });
          }
          return res;
        } catch (err) {
          // Container unreachable — buffer the event for later drain
          console.warn("[TicketAgent] Container not ready, buffering event:", err);
          this.bufferEvent(event);
          return Response.json({ buffered: true }, { status: 202 });
        }
      }
      case "/mark-terminal": {
        this.markTerminal();

        // Tell the container to shut down immediately instead of waiting for session timeout.
        // Use a bounded-time request so a hung container cannot block the orchestrator status path.
        const shutdownController = new AbortController();
        const shutdownTimeoutMs = 5000;
        const shutdownTimeoutId = setTimeout(() => {
          shutdownController.abort("shutdown request timed out");
        }, shutdownTimeoutMs);

        try {
          const res = await this.containerFetch(
            "http://localhost/shutdown",
            {
              method: "POST",
              headers: {
                "X-Internal-Key": (this.env.API_KEY as string) || "",
              },
              // Best-effort: abort if the shutdown endpoint hangs.
              signal: shutdownController.signal,
            },
            this.defaultPort,
          );

          if (res.ok) {
            console.log("[TicketAgent] Container shutdown requested");
          } else {
            let bodyText = "";
            try {
              bodyText = await res.text();
            } catch {
              bodyText = "<unreadable body>";
            }
            console.warn(
              "[TicketAgent] Container shutdown request returned non-2xx response:",
              res.status,
              bodyText,
            );
          }
        } catch (err) {
          // Container might already be stopped or the request may have timed out - that's fine
          console.log(
            "[TicketAgent] Container shutdown request failed (container may already be stopped or request timed out):",
            err,
          );
        } finally {
          clearTimeout(shutdownTimeoutId);
        }

        return Response.json({ ok: true });
      }
      case "/health": {
        return Response.json({ ok: true, service: "ticket-agent-do" });
      }
      case "/status": {
        try {
          return await this.containerFetch("http://localhost/status", {
            method: "GET",
          }, this.defaultPort);
        } catch (err) {
          return Response.json({ error: "Container not reachable" }, { status: 503 });
        }
      }
      case "/drain-events": {
        const events = this.drainEventBuffer();
        return Response.json({ events });
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }
}
