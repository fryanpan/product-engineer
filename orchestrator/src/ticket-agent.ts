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
    // R2 FUSE mount credentials for session persistence
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID || "",
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY || "",
    CF_ACCOUNT_ID: env.CF_ACCOUNT_ID || "",
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
  sleepAfter = "96h"; // 4 days

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
          return await this.containerFetch("http://localhost/event", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Key": (this.env.API_KEY as string) || "",
            },
            body: JSON.stringify(event),
          }, this.defaultPort);
        } catch (err) {
          console.error("[TicketAgent] Container not ready, event may be lost:", err);
          return Response.json(
            { error: "Container not ready" },
            { status: 503 },
          );
        }
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
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }
}
