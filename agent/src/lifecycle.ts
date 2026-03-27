/**
 * AgentLifecycle — consolidates heartbeat, timeout watchdog, signal handlers,
 * session state tracking, and the phone-home protocol.
 *
 * Extracted from server.ts to keep the main server focused on HTTP/session logic.
 */

import type { RoleConfig } from "./role-config";
import type { TranscriptManager } from "./transcripts";
import type { TokenTracker } from "./token-tracker";
import type { AgentConfig } from "./config";

// ── Types ──────────────────────────────────────────────────────────────────

export type SessionStatus = "idle" | "cloning" | "starting_session" | "running" | "completed" | "error";

export interface SessionState {
  sessionActive: boolean;
  sessionStatus: SessionStatus;
  sessionMessageCount: number;
  sessionStartTime: number;
  lastMessageTime: number;
  sessionError: string;
  lastStderr: string;
  lastToolCall: string;
  lastAssistantText: string;
  lastUserPrompt: string;
  currentSessionId: string;
}

export interface LifecycleCallbacks {
  /** Called when the lifecycle decides the process should exit. */
  onExit: (code: number) => void;
}

// ── Implementation ─────────────────────────────────────────────────────────

export class AgentLifecycle {
  readonly state: SessionState;

  private config: AgentConfig;
  private roleConfig: RoleConfig;
  private transcriptMgr: TranscriptManager;
  private tokenTracker: TokenTracker;
  private callbacks: LifecycleCallbacks;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private transcriptBackupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: {
    config: AgentConfig;
    roleConfig: RoleConfig;
    transcriptMgr: TranscriptManager;
    tokenTracker: TokenTracker;
    callbacks?: LifecycleCallbacks;
  }) {
    this.config = deps.config;
    this.roleConfig = deps.roleConfig;
    this.transcriptMgr = deps.transcriptMgr;
    this.tokenTracker = deps.tokenTracker;
    this.callbacks = deps.callbacks ?? { onExit: (code) => process.exit(code) };

    this.state = {
      sessionActive: false,
      sessionStatus: "idle",
      sessionMessageCount: 0,
      sessionStartTime: 0,
      lastMessageTime: 0,
      sessionError: "",
      lastStderr: "",
      lastToolCall: "",
      lastAssistantText: "",
      lastUserPrompt: "",
      currentSessionId: "",
    };
  }

  // ── Phone-home ─────────────────────────────────────────────────────────

  /** Send a heartbeat/log message to the conductor (fire-and-forget). */
  phoneHome(message: string): void {
    console.log(`[Agent] phoneHome: ${message}`);
    fetch(`${this.config.workerUrl}/api/conductor/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": this.config.apiKey,
      },
      body: JSON.stringify({ taskUUID: this.config.taskUUID, message }),
    }).catch((err) => console.error("[Agent] phoneHome failed:", err));
  }

  // ── Auto-suspend ─────────────────────────────────────────────────────

  /**
   * Upload transcript, report tokens, notify orchestrator to set "suspended"
   * status, then exit the container.
   */
  async autoSuspend(reason: string): Promise<void> {
    console.log(`[Agent] Auto-suspending (reason=${reason})`);

    // 1. Upload transcript before exiting
    try {
      await this.transcriptMgr.upload(true);
    } catch (err) {
      console.error("[Agent] Failed to upload transcript during auto-suspend:", err);
    }

    // 2. Report token usage
    try {
      await this.tokenTracker.report({
        taskUUID: this.config.taskUUID,
        workerUrl: this.config.workerUrl,
        apiKey: this.config.apiKey,
        slackBotToken: this.config.slackBotToken,
        slackChannel: this.config.slackChannel,
        slackThreadTs: this.config.slackThreadTs,
        sessionMessageCount: this.state.sessionMessageCount,
        model: this.config.model,
      });
    } catch (err) {
      console.error("[Agent] Failed to report tokens during auto-suspend:", err);
    }

    // 3. Tell orchestrator to set status to "suspended" with session_id
    try {
      await fetch(`${this.config.workerUrl}/api/internal/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": this.config.apiKey,
        },
        body: JSON.stringify({
          taskUUID: this.config.taskUUID,
          status: "suspended",
          session_id: this.state.currentSessionId,
        }),
      });
    } catch (err) {
      console.error("[Agent] Failed to notify orchestrator during auto-suspend:", err);
    }

    // 4. Exit
    this.callbacks.onExit(0);
  }

  // ── Timers ─────────────────────────────────────────────────────────────

  /** Start all timers (heartbeat, watchdog, transcript backup). */
  startTimers(): void {
    this.startHeartbeat();
    this.startWatchdog();
    this.startTranscriptBackup();
    this.installSignalHandlers();
  }

  /** Stop all timers and perform cleanup. */
  stopTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (this.transcriptBackupTimer) {
      clearInterval(this.transcriptBackupTimer);
      this.transcriptBackupTimer = null;
    }
  }

  /** Record activity (resets idle timeout tracking). */
  recordActivity(): void {
    this.state.lastMessageTime = Date.now();
  }

  // ── Session lifecycle ──────────────────────────────────────────────────

  /** Reset session state for project-lead re-use after session completion. */
  resetSession(): void {
    this.state.sessionActive = false;
    this.state.sessionStatus = "idle";
    this.state.sessionMessageCount = 0;
    this.state.sessionStartTime = 0;
    this.state.sessionError = "";
    this.state.lastStderr = "";
    this.state.lastToolCall = "";
    this.state.lastAssistantText = "";
    this.state.lastUserPrompt = "";
    this.tokenTracker.reset();
  }

  /**
   * Handle session completion. For project leads: reset state, stay alive.
   * For ticket agents: report tokens, exit(0).
   */
  async handleSessionEnd(): Promise<void> {
    console.log("[Agent] Session ended normally");
    this.state.sessionStatus = "completed";
    this.state.sessionActive = false;
    this.phoneHome(`session_completed msgs=${this.state.sessionMessageCount}`);

    if (this.roleConfig.persistAfterSession) {
      // Project lead/research session completed — upload transcript, report
      // session_id, then report tokens. autoSuspend won't be called since
      // persistent agents stay alive.

      // 1. Upload transcript before anything else
      try {
        await this.transcriptMgr.upload(true);
      } catch (err) {
        console.error("[Agent] Failed to upload transcript during persistent session end:", err);
      }

      // 2. Save session_id to conductor so it can resume this session later.
      //    For project leads, also save to the associated child task (the one the
      //    user actually replies to in the thread).
      if (this.state.currentSessionId) {
        const taskUUIDs = [this.config.taskUUID];
        const associatedUUID = this.transcriptMgr.getAssociatedTaskUUID();
        if (associatedUUID && associatedUUID !== this.config.taskUUID) {
          taskUUIDs.push(associatedUUID);
        }
        for (const uuid of taskUUIDs) {
          try {
            await fetch(`${this.config.workerUrl}/api/internal/status`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Internal-Key": this.config.apiKey,
              },
              body: JSON.stringify({
                taskUUID: uuid,
                session_id: this.state.currentSessionId,
              }),
            });
          } catch (err) {
            console.error(`[Agent] Failed to report session_id for ${uuid}:`, err);
          }
        }
      }

      // 3. Report token usage
      await this.tokenTracker.report({
        taskUUID: this.config.taskUUID,
        workerUrl: this.config.workerUrl,
        apiKey: this.config.apiKey,
        slackBotToken: this.config.slackBotToken,
        slackChannel: this.config.slackChannel,
        slackThreadTs: this.config.slackThreadTs,
        sessionMessageCount: this.state.sessionMessageCount,
        model: this.config.model,
      });
      console.log("[Agent] Persistent session completed — staying alive for next event");
      this.resetSession();
    } else {
      // Auto-suspend handles token reporting, transcript upload, and orchestrator notification.
      console.log("[Agent] Session completed — auto-suspending for potential resume");
      this.stopTimers();
      this.autoSuspend("session_completed").catch((err) => {
        console.error("[Agent] autoSuspend failed after session end:", err);
        this.callbacks.onExit(0);
      });
    }
  }

  /**
   * Handle session error. For project leads: log + reset.
   * For ticket agents: report, exit(1).
   */
  async handleSessionError(err: Error): Promise<void> {
    console.error("[Agent] Session error:", err);
    this.state.sessionError = String(err);
    this.state.sessionStatus = "error";
    this.state.sessionActive = false;
    this.phoneHome(`session_error ${String(err).slice(0, 150)} | stderr=${this.state.lastStderr.slice(0, 100)}`);

    // Upload transcripts on error to capture work done before crash
    try {
      await this.transcriptMgr.upload(true);
    } catch (uploadErr) {
      console.error("[Agent] Failed to upload transcript after error:", uploadErr);
    }

    if (this.roleConfig.persistAfterSession) {
      // Project leads recover from errors — reset to idle so next event starts fresh
      console.log("[Agent] Project lead session error — resetting to idle for recovery");
      this.resetSession();
    } else {
      // Exit the container so it stops using resources
      console.log("[Agent] Exiting container after error");
      this.stopTimers();
      // Use exit code 1 for errors so monitoring can distinguish success vs failure
      this.callbacks.onExit(1);
    }
  }

  // ── Private timer setup ────────────────────────────────────────────────

  /** Heartbeat every 2 minutes while the session is active. */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.state.sessionStatus === "completed" || this.state.sessionStatus === "error") {
        this.stopTimers();
        return;
      }
      // Only send heartbeat when session is actually doing work (not idle waiting for first event)
      if (this.state.sessionStatus === "idle") return;

      // Send heartbeat to orchestrator for monitoring
      fetch(`${this.config.workerUrl}/api/conductor/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": this.config.apiKey,
        },
        body: JSON.stringify({ taskUUID: this.config.taskUUID }),
      }).catch((err) => console.error("[Agent] Heartbeat failed:", err));

      this.phoneHome(`heartbeat status=${this.state.sessionStatus} msgs=${this.state.sessionMessageCount}`);
    }, 120_000);
  }

  /** Timeout watchdog: exit if session runs too long or becomes idle. */
  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      if (!this.state.sessionActive && this.state.sessionStatus === "idle" && this.state.sessionStartTime === 0) return; // Not started yet
      if (this.roleConfig.idleTimeoutMs === Infinity) return; // Project leads never timeout

      const now = Date.now();
      const sessionDuration = this.state.sessionStartTime > 0 ? now - this.state.sessionStartTime : 0;
      const idleDuration = this.state.lastMessageTime > 0 ? now - this.state.lastMessageTime : 0;

      // Hard timeout: session exceeded max duration (ticket agents only)
      if (sessionDuration > this.roleConfig.sessionTimeoutMs) {
        console.log(`[Agent] Session timeout after ${Math.floor(sessionDuration / 60000)}m — auto-suspending`);
        this.phoneHome(`session_timeout duration=${Math.floor(sessionDuration / 60000)}m msgs=${this.state.sessionMessageCount}`);
        this.stopTimers();
        this.autoSuspend("session_timeout").catch((err) =>
          console.error("[Agent] autoSuspend failed:", err),
        );
        return;
      }

      // Idle timeout: no activity for too long
      // Keep sessionStatus guard — during long tool runs (tests, builds), the SDK status stays
      // "running" without producing messages. We only timeout truly idle sessions.
      if (idleDuration > this.roleConfig.idleTimeoutMs && this.state.sessionStatus !== "running") {
        console.log(`[Agent] Idle timeout after ${Math.floor(idleDuration / 60000)}m with status=${this.state.sessionStatus} — auto-suspending`);
        this.phoneHome(`idle_timeout idle=${Math.floor(idleDuration / 60000)}m status=${this.state.sessionStatus} msgs=${this.state.sessionMessageCount}`);
        this.stopTimers();
        this.autoSuspend("idle_timeout").catch((err) =>
          console.error("[Agent] autoSuspend failed:", err),
        );
        return;
      }
    }, 60_000); // Check every minute
  }

  /** Periodic transcript backup every 1 minute (only uploads if file changed). */
  private startTranscriptBackup(): void {
    this.transcriptBackupTimer = setInterval(() => {
      if (this.state.sessionStatus === "completed" || this.state.sessionStatus === "error") {
        this.stopTimers();
        return;
      }
      if (this.state.sessionStatus === "running" && this.state.sessionActive) {
        this.transcriptMgr.upload().catch((err) => console.error("[Agent] Periodic backup failed:", err));
      }
    }, 60_000); // 1 minute
  }

  /** Install signal handlers to upload transcript on container shutdown. */
  private installSignalHandlers(): void {
    const handleShutdown = async (signal: string) => {
      console.log(`[Agent] Received ${signal}, uploading transcript before shutdown...`);
      this.stopTimers();
      await this.transcriptMgr.upload(true);
      this.phoneHome(`container_shutdown signal=${signal}`);
      this.callbacks.onExit(0);
    };

    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
    process.on("SIGINT", () => handleShutdown("SIGINT"));
  }
}
