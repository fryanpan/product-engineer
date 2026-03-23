/**
 * ProjectAgent — persistent Container DO, one per registered product.
 *
 * Runs a long-lived Agent SDK session that accumulates product context over time.
 * The project agent decides what to do with incoming events (answer directly,
 * spawn a ticket agent, ask a question) using the coding-project-lead SKILL.md.
 *
 * Key differences from TicketAgent:
 * - Keyed by product slug (not ticket UUID)
 * - No sleepAfter — persistent (like Orchestrator)
 * - alarm() restarts container if it dies
 * - Skills loaded from product-engineer repo via settingSources + cwd
 */

import { Container } from "@cloudflare/containers";
import type { TicketEvent, Bindings } from "./types";
import type { CloudflareAIGateway } from "./registry";

export interface ProjectAgentConfig {
  product: string;
  repos: string[];
  slackChannel: string;
  slackPersona?: { username: string; icon_emoji?: string; icon_url?: string };
  secrets: Record<string, string>;
  mode?: "coding" | "research" | "flexible";
  gatewayConfig?: CloudflareAIGateway | null;
  model?: string;
}

// Pure helper — exported for testing
export function resolveProjectAgentEnvVars(
  config: ProjectAgentConfig,
  env: Record<string, string>,
  gatewayConfig?: CloudflareAIGateway | null,
): Record<string, string> {
  const vars: Record<string, string> = {
    PRODUCT: config.product,
    REPOS: JSON.stringify(config.repos),
    SLACK_CHANNEL: config.slackChannel,
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN || "",
    LINEAR_APP_TOKEN: env.LINEAR_APP_TOKEN || "",
    SENTRY_DSN: env.SENTRY_DSN || "",
    WORKER_URL: env.WORKER_URL || "",
    API_KEY: env.API_KEY || "",
    // Agent role — tells the agent server to use project-lead behavior
    AGENT_ROLE: config.product === "__conductor__" ? "conductor" : "project-lead",
    // Model selection
    MODEL: config.model || "sonnet",
    // Agent mode
    MODE: config.mode || "coding",
    // Slack persona for outbound messages
    SLACK_PERSONA: config.slackPersona ? JSON.stringify(config.slackPersona) : "",
    // Secret prompt delimiter
    PROMPT_DELIMITER: env.PROMPT_DELIMITER || "",
    // R2 credentials for transcript backup
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID || "",
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY || "",
    CF_ACCOUNT_ID: env.CF_ACCOUNT_ID || "",
    // Ticket UUID is the product slug for project agents
    TICKET_UUID: `project-agent-${config.product}`,
    TICKET_IDENTIFIER: "",
    TICKET_TITLE: `Project agent for ${config.product}`,
  };

  // Resolve per-product secrets
  for (const [logicalName, bindingName] of Object.entries(config.secrets)) {
    const value = env[bindingName];
    if (value) {
      vars[logicalName] = value;
    } else {
      vars[logicalName] = "";
    }
  }

  // gh CLI reads GH_TOKEN
  if (vars.GITHUB_TOKEN) {
    vars.GH_TOKEN = vars.GITHUB_TOKEN;
  }

  // Cloudflare AI Gateway
  if (gatewayConfig) {
    vars.ANTHROPIC_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(gatewayConfig.account_id)}/${encodeURIComponent(gatewayConfig.gateway_id)}/anthropic`;
  }

  return vars;
}

export class ProjectAgent extends Container<Bindings> {
  defaultPort = 3000;
  // No sleepAfter — persistent session

  private configLoaded = false;

  constructor(ctx: DurableObjectState, env: Bindings) {
    // @ts-expect-error — DurableObjectState generic mismatch
    super(ctx, env);
    // Restore envVars from persisted config (for auto-restart after deploy)
    const config = this.getConfig();
    if (config) {
      this.envVars = resolveProjectAgentEnvVars(
        config,
        env as unknown as Record<string, string>,
        config.gatewayConfig,
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
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS event_buffer (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_json TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.configLoaded = true;
  }

  private getConfig(): ProjectAgentConfig | null {
    this.initDb();
    const row = this.ctx.storage.sql.exec(
      "SELECT value FROM config WHERE key = 'agent_config'",
    ).toArray()[0] as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  private setConfig(config: ProjectAgentConfig) {
    this.initDb();
    this.ctx.storage.sql.exec(
      `INSERT INTO config (key, value) VALUES ('agent_config', ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`,
      JSON.stringify(config),
      JSON.stringify(config),
    );
    this.envVars = resolveProjectAgentEnvVars(
      config,
      this.env as unknown as Record<string, string>,
      config.gatewayConfig,
    );
  }

  override onStop(params: { exitCode: number; reason: string }) {
    console.error(`[ProjectAgent] Container stopped: exitCode=${params.exitCode} reason=${params.reason}`);
  }

  override onError(error: unknown) {
    console.error("[ProjectAgent] Container error:", error);
    throw error;
  }

  // --- Event buffer ---

  private bufferEvent(event: TicketEvent) {
    this.initDb();
    const countRow = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) as cnt FROM event_buffer",
    ).toArray()[0] as { cnt: number };
    if (countRow.cnt >= 50) {
      this.ctx.storage.sql.exec(
        "DELETE FROM event_buffer WHERE id IN (SELECT id FROM event_buffer ORDER BY id ASC LIMIT ?)",
        countRow.cnt - 49,
      );
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO event_buffer (event_json) VALUES (?)",
      JSON.stringify(event),
    );
    console.log(`[ProjectAgent] Buffered event: ${event.type}`);
  }

  private drainEventBuffer(): TicketEvent[] {
    this.initDb();
    const rows = this.ctx.storage.sql.exec(
      "SELECT id, event_json FROM event_buffer ORDER BY id ASC LIMIT 20",
    ).toArray() as { id: number; event_json: string }[];

    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      const placeholders = ids.map(() => "?").join(",");
      this.ctx.storage.sql.exec(
        `DELETE FROM event_buffer WHERE id IN (${placeholders})`,
        ...ids,
      );
      console.log(`[ProjectAgent] Drained ${rows.length} buffered events`);
    }

    return rows.map(r => JSON.parse(r.event_json));
  }

  // Replay buffered events by sending them directly to the container.
  // This handles the case where events were buffered during container startup
  // and the container is now healthy but never received them.
  private async replayBufferedEvents() {
    this.initDb();
    const rows = this.ctx.storage.sql.exec(
      "SELECT id, event_json FROM event_buffer ORDER BY id ASC LIMIT 20",
    ).toArray() as { id: number; event_json: string }[];

    if (rows.length === 0) return;

    console.log(`[ProjectAgent] Replaying ${rows.length} buffered events...`);
    const delivered: number[] = [];

    for (const row of rows) {
      try {
        const res = await this.containerFetch("http://localhost/event", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": (this.env.API_KEY as string) || "",
          },
          body: row.event_json,
        }, this.defaultPort);

        if (res.ok) {
          delivered.push(row.id);
        } else if (res.status === 503) {
          // Container not ready for events yet — stop replaying
          break;
        }
      } catch {
        // Container error — stop replaying
        break;
      }
    }

    if (delivered.length > 0) {
      const placeholders = delivered.map(() => "?").join(",");
      this.ctx.storage.sql.exec(
        `DELETE FROM event_buffer WHERE id IN (${placeholders})`,
        ...delivered,
      );
      console.log(`[ProjectAgent] Successfully replayed ${delivered.length} events`);
    }
  }

  // Persistent: alarm keeps the container alive and restarts on crash/deploy
  override async alarm(alarmProps: { isRetry: boolean; retryCount: number }) {
    const config = this.getConfig();
    if (!config) {
      return super.alarm(alarmProps);
    }

    // Health check the container
    try {
      const port = (this.ctx as any).container.getTcpPort(this.defaultPort);
      const res = await port.fetch("http://localhost/health", {
        signal: AbortSignal.timeout(2000),
      }) as Response;
      if (res.ok) {
        // Container is healthy — replay any buffered events
        await this.replayBufferedEvents();
        // Schedule next alarm
        this.ctx.storage.setAlarm(Date.now() + 300_000); // 5 min
        return super.alarm(alarmProps);
      }
    } catch {
      console.log(`[ProjectAgent] Container not healthy for ${config.product}, restarting...`);
    }

    // Container is dead — restart
    try {
      await this.startAndWaitForPorts({
        ports: this.defaultPort,
        startOptions: { envVars: this.envVars as Record<string, string> },
      });
      console.log(`[ProjectAgent] Container restarted for ${config.product}`);
    } catch (err) {
      console.error(`[ProjectAgent] Container restart failed for ${config.product}:`, err);
    }

    this.ctx.storage.setAlarm(Date.now() + 300_000); // retry in 5 min
    return super.alarm(alarmProps);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/initialize":
      case "/ensure-running": {
        const config = await request.json<ProjectAgentConfig>();
        const existing = this.getConfig();

        // If config hasn't changed, just ensure container is running
        if (existing && JSON.stringify(existing) === JSON.stringify(config)) {
          try {
            const port = (this.ctx as any).container.getTcpPort(this.defaultPort);
            const res = await port.fetch("http://localhost/health", {
              signal: AbortSignal.timeout(2000),
            }) as Response;
            if (res.ok) {
              return Response.json({ ok: true, status: "already_running" });
            }
          } catch {
            // Container not healthy, restart below
          }
        }

        this.setConfig(config);
        await this.startAndWaitForPorts({
          ports: this.defaultPort,
          startOptions: { envVars: this.envVars as Record<string, string> },
        });

        // Replay any events buffered during container startup
        await this.replayBufferedEvents();

        // Schedule alarm to keep container alive
        this.ctx.storage.setAlarm(Date.now() + 300_000);

        return Response.json({ ok: true, status: "started" });
      }

      case "/event": {
        const event = await request.json<TicketEvent>();
        try {
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
            this.bufferEvent(event);
            return Response.json({ buffered: true }, { status: 202 });
          }
          return res;
        } catch (err) {
          console.warn("[ProjectAgent] Container not ready, buffering event:", err);
          this.bufferEvent(event);
          return Response.json({ buffered: true }, { status: 202 });
        }
      }

      case "/drain-events": {
        const events = this.drainEventBuffer();
        return Response.json({ events });
      }

      case "/health": {
        return Response.json({ ok: true, service: "project-agent-do" });
      }

      case "/status": {
        try {
          return await this.containerFetch("http://localhost/status", {
            method: "GET",
          }, this.defaultPort);
        } catch {
          return Response.json({ error: "Container not reachable" }, { status: 503 });
        }
      }

      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }
}
