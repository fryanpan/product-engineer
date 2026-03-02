import { Container } from "@cloudflare/containers";
import type { TicketEvent, TicketAgentConfig, Bindings } from "./types";

// Pure helper — exported for testing
export function resolveAgentEnvVars(
  config: TicketAgentConfig,
  env: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {
    PRODUCT: config.product,
    TICKET_ID: config.ticketId,
    REPOS: JSON.stringify(config.repos),
    SLACK_CHANNEL: config.slackChannel,
    SLACK_THREAD_TS: "", // Populated at runtime via event.slackThreadTs
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN || "",
    SENTRY_DSN: env.SENTRY_DSN || "",
    WORKER_URL: env.WORKER_URL || "https://product-engineer.fryanpan.workers.dev",
    API_KEY: env.API_KEY || "",
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

  return vars;
}

export class TicketAgent extends Container<Bindings> {
  defaultPort = 3000;
  sleepAfter = "4d";

  private configLoaded = false;

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
  }

  get envVars() {
    const config = this.getConfig();
    if (!config) {
      return {};
    }
    return resolveAgentEnvVars(config, this.env as unknown as Record<string, string>);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/initialize": {
        const config = await request.json<TicketAgentConfig>();
        this.setConfig(config);
        return Response.json({ ok: true });
      }
      case "/event": {
        const event = await request.json<TicketEvent>();
        try {
          const port = this.ctx.container.getTcpPort(this.defaultPort);
          const res = await port.fetch("http://localhost/event", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Key": (this.env.API_KEY as string) || "",
            },
            body: JSON.stringify(event),
          });
          return res;
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
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }
}
