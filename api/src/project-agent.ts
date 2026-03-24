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
import { resolveContainerEnvVars } from "./container-env";
import { EventBuffer } from "./event-buffer";
import { PersistentConfig } from "./persistent-config";

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

// Pure helper — exported for testing (delegates to shared resolveContainerEnvVars)
export function resolveProjectAgentEnvVars(
  config: ProjectAgentConfig,
  env: Record<string, string>,
  gatewayConfig?: CloudflareAIGateway | null,
): Record<string, string> {
  return resolveContainerEnvVars(
    { ...config, model: config.model || "sonnet" },
    env,
    gatewayConfig,
    {
      AGENT_ROLE: config.product === "__conductor__" ? "conductor" : "project-lead",
      TICKET_UUID: `project-agent-${config.product}`,
      TICKET_IDENTIFIER: "",
      TICKET_TITLE: `Project agent for ${config.product}`,
    },
  );
}

export class ProjectAgent extends Container<Bindings> {
  defaultPort = 3000;
  // No sleepAfter — persistent session

  private persistentConfig: PersistentConfig<ProjectAgentConfig>;
  private eventBuffer: EventBuffer;

  constructor(ctx: DurableObjectState, env: Bindings) {
    // @ts-expect-error — DurableObjectState generic mismatch
    super(ctx, env);
    this.persistentConfig = new PersistentConfig<ProjectAgentConfig>(ctx.storage.sql);
    this.eventBuffer = new EventBuffer(ctx.storage.sql, "ProjectAgent");
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

  private getConfig(): ProjectAgentConfig | null {
    return this.persistentConfig.get();
  }

  private setConfig(config: ProjectAgentConfig) {
    this.persistentConfig.set(config);
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

  private bufferEvent(event: TicketEvent) {
    this.eventBuffer.buffer(event);
  }

  private drainEventBuffer(): TicketEvent[] {
    return this.eventBuffer.drain<TicketEvent>();
  }

  private async replayBufferedEvents() {
    await this.eventBuffer.replay((eventJson: string) =>
      this.containerFetch("http://localhost/event", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": (this.env.API_KEY as string) || "",
        },
        body: eventJson,
      }, this.defaultPort),
    );
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

      case "/restart": {
        // Force restart the container with the latest image.
        // Used after deploys to pick up new code.
        const config = this.getConfig();
        if (!config) {
          return Response.json({ error: "No config — agent never initialized" }, { status: 400 });
        }
        console.log(`[ProjectAgent] Force restarting container for ${config.product}`);
        try {
          await this.startAndWaitForPorts({
            ports: this.defaultPort,
            startOptions: { envVars: this.envVars as Record<string, string> },
          });
          await this.replayBufferedEvents();
          this.ctx.storage.setAlarm(Date.now() + 300_000);
          return Response.json({ ok: true, status: "restarted" });
        } catch (err) {
          console.error(`[ProjectAgent] Restart failed:`, err);
          return Response.json({ error: String(err) }, { status: 500 });
        }
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
