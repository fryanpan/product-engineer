import { Container } from "@cloudflare/containers";
import type { TaskEvent, TaskAgentConfig, Bindings } from "./types";
import type { CloudflareAIGateway } from "./registry";
import { resolveContainerEnvVars } from "./container-env";
import { EventBuffer } from "./event-buffer";
import { PersistentConfig } from "./persistent-config";

// Pure helper — exported for testing (delegates to shared resolveContainerEnvVars)
export function resolveAgentEnvVars(
  config: TaskAgentConfig,
  env: Record<string, string>,
  gatewayConfig?: CloudflareAIGateway | null,
): Record<string, string> {
  return resolveContainerEnvVars(config, env, gatewayConfig, {
    TASK_UUID: config.taskUUID,
    TASK_IDENTIFIER: config.taskId ?? "",
    TASK_TITLE: config.taskTitle ?? "",
    SLACK_THREAD_TS: config.slackThreadTs || "",
  });
}

export class TaskAgent extends Container<Bindings> {
  defaultPort = 3000;
  sleepAfter = "1h"; // Safety net — agent should exit within 5min of completion

  private persistentConfig: PersistentConfig<TaskAgentConfig>;
  private eventBuffer: EventBuffer;

  constructor(ctx: DurableObjectState, env: Bindings) {
    // @ts-expect-error — DurableObjectState generic mismatch between Container SDK and Workers types
    super(ctx, env);
    this.persistentConfig = new PersistentConfig<TaskAgentConfig>(ctx.storage.sql);
    this.eventBuffer = new EventBuffer(ctx.storage.sql, "TaskAgent");
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

  private getConfig(): TaskAgentConfig | null {
    return this.persistentConfig.get();
  }

  private setConfig(config: TaskAgentConfig) {
    this.persistentConfig.set(config);
    // Update instance envVars so containerFetch auto-restarts use correct values
    this.envVars = resolveAgentEnvVars(
      config,
      this.env as unknown as Record<string, string>,
      config.gatewayConfig
    );
  }

  override onStop(params: { exitCode: number; reason: string }) {
    console.error(`[TaskAgent] Container stopped: exitCode=${params.exitCode} reason=${params.reason}`);
  }

  override onError(error: unknown) {
    console.error("[TaskAgent] Container error:", error);
    throw error;
  }

  private bufferEvent(event: TaskEvent) {
    this.eventBuffer.buffer(event);
  }

  private drainEventBuffer(): TaskEvent[] {
    return this.eventBuffer.drain<TaskEvent>();
  }

  private isTerminal(): boolean {
    return this.persistentConfig.isTerminal();
  }

  markTerminal() {
    this.persistentConfig.markTerminal();
  }

  clearTerminal() {
    this.persistentConfig.clearTerminal();
    console.log("[TaskAgent] Terminal flag cleared — task reopened");
  }

  override async alarm(alarmProps: { isRetry: boolean; retryCount: number }) {
    // Don't restart containers for completed tasks
    if (this.isTerminal()) {
      return super.alarm(alarmProps);
    }

    const config = this.getConfig();
    if (config) {
      // Check conductor state — don't restart containers for tasks that are no longer active
      try {
        const conductorId = this.env.CONDUCTOR.idFromName("main");
        const conductorStub = this.env.CONDUCTOR.get(conductorId);
        const statusRes = await conductorStub.fetch(
          new Request(`http://internal/ticket-status/${encodeURIComponent(config.taskUUID)}`)
        );
        if (statusRes.ok) {
          const status = await statusRes.json<{ agent_active: number; status: string }>();
          if (status.agent_active === 0) {
            console.log(`[TaskAgent] Conductor says ${config.taskUUID} is inactive (status=${status.status}) — marking terminal, skipping restart`);
            this.markTerminal();
            return super.alarm(alarmProps);
          }
        }
      } catch (err) {
        console.warn(`[TaskAgent] Could not check conductor status for ${config.taskUUID}:`, err);
        // Fall through to existing container health check
      }

      // Check container health — mark terminal if session completed/errored
      try {
        const res = await this.containerFetch("http://localhost/status", { method: "GET" }, this.defaultPort);
        const status = await res.json<{ sessionStatus: string }>();
        if (status.sessionStatus === "completed" || status.sessionStatus === "error") {
          console.log(`[TaskAgent] Session ${status.sessionStatus} for ${config.taskUUID}, marking terminal`);
          this.markTerminal();
        }
      } catch {
        console.log(`[TaskAgent] Container not healthy for ${config.taskUUID}, will auto-resume on restart`);
      }
    }
    return super.alarm(alarmProps);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/initialize": {
        const config = await request.json<TaskAgentConfig>();
        this.setConfig(config);
        await this.startAndWaitForPorts({
          ports: this.defaultPort,
          startOptions: { envVars: this.envVars as Record<string, string> },
        });
        return Response.json({ ok: true });
      }
      case "/event": {
        const event = await request.json<TaskEvent>();
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
          console.warn("[TaskAgent] Container not ready, buffering event:", err);
          this.bufferEvent(event);
          return Response.json({ buffered: true }, { status: 202 });
        }
      }
      case "/mark-terminal": {
        this.markTerminal();

        // Tell the container to shut down immediately instead of waiting for session timeout.
        // Use a bounded-time request so a hung container cannot block the conductor status path.
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
            console.log("[TaskAgent] Container shutdown requested");
          } else {
            let bodyText = "";
            try {
              bodyText = await res.text();
            } catch {
              bodyText = "<unreadable body>";
            }
            console.warn(
              "[TaskAgent] Container shutdown request returned non-2xx response:",
              res.status,
              bodyText,
            );
          }
        } catch (err) {
          // Container might already be stopped or the request may have timed out - that's fine
          console.log(
            "[TaskAgent] Container shutdown request failed (container may already be stopped or request timed out):",
            err,
          );
        } finally {
          clearTimeout(shutdownTimeoutId);
        }

        return Response.json({ ok: true });
      }
      case "/health": {
        return Response.json({ ok: true, service: "task-agent-do" });
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
      case "/clear-terminal": {
        this.clearTerminal();
        return Response.json({ ok: true });
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }
}
