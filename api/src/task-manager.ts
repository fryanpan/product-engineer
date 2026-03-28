import { TERMINAL_STATUSES, type TaskState, type TaskRecord } from "./types";
import { applyTransition, isTerminal as isTerminalStatus } from "./state-machine";

export interface CreateTaskParams {
  taskUUID: string;
  product: string;
  slackThreadTs?: string;
  slackChannel?: string;
  taskId?: string;
  title?: string;
  scheduledFor?: string; // ISO8601 timestamp
}

export interface StatusUpdate {
  status?: TaskState;
  pr_url?: string;
  branch_name?: string;
  slack_thread_ts?: string;
  transcript_r2_key?: string;
  scheduled_for?: string; // ISO8601 timestamp
}

export interface SpawnConfig {
  product: string;
  repos: string[];
  slackChannel: string;
  slackThreadTs?: string;
  secrets: Record<string, string>;
  gatewayConfig?: { account_id: string; gateway_id: string } | null;
  model?: string;
  mode?: "coding" | "research" | "flexible";
  slackPersona?: { username: string; icon_emoji?: string; icon_url?: string };
}

interface SqlResult {
  toArray(): Record<string, unknown>[];
}

interface SqlExec {
  exec(sql: string, ...params: unknown[]): SqlResult;
}

export interface TaskManagerOptions {
  /** Base retry delay in ms for sendEvent backoff. Default 2000. */
  retryDelayMs?: number;
}

export class TaskManager {
  private retryDelayMs: number;

  constructor(
    private sql: SqlExec,
    private env: Record<string, unknown>,
    options?: TaskManagerOptions,
  ) {
    this.retryDelayMs = options?.retryDelayMs ?? 2000;
  }

  createTask(params: CreateTaskParams): TaskRecord {
    const existing = this.getTask(params.taskUUID);
    if (existing && !this.isTerminal(params.taskUUID)) {
      throw new Error(`Task ${params.taskUUID} already exists (status: ${existing.status})`);
    }

    // If re-creating after terminal, reset everything
    if (existing) {
      this.sql.exec("DELETE FROM tasks WHERE task_uuid = ?", params.taskUUID);
    }

    this.sql.exec(
      `INSERT INTO tasks (task_uuid, product, status, slack_thread_ts, slack_channel, task_id, title, agent_active, scheduled_for)
       VALUES (?, ?, 'created', ?, ?, ?, ?, 0, ?)`,
      params.taskUUID, params.product,
      params.slackThreadTs || null, params.slackChannel || null,
      params.taskId || null, params.title || null,
      params.scheduledFor || null,
    );

    return this.getTask(params.taskUUID)!;
  }

  getTask(taskUUID: string): TaskRecord | null {
    const row = this.sql.exec(
      "SELECT * FROM tasks WHERE task_uuid = ?", taskUUID,
    ).toArray()[0] as unknown as TaskRecord | undefined;
    return row || null;
  }

  /** Look up a task by its human-readable identifier (e.g., "PES-23"). */
  getTaskByIdentifier(identifier: string): TaskRecord | null {
    const row = this.sql.exec(
      "SELECT * FROM tasks WHERE task_id = ?", identifier,
    ).toArray()[0] as unknown as TaskRecord | undefined;
    return row || null;
  }

  isTerminal(taskUUID: string): boolean {
    const task = this.getTask(taskUUID);
    if (!task) return false;
    return (TERMINAL_STATUSES as readonly string[]).includes(task.status);
  }

  /** Check if a status string is terminal (no task lookup needed). */
  isTerminalStatus(status: string): boolean {
    return (TERMINAL_STATUSES as readonly string[]).includes(status);
  }

  updateStatus(taskUUID: string, update: StatusUpdate): TaskRecord {
    const task = this.getTask(taskUUID);
    if (!task) throw new Error(`Task ${taskUUID} not found`);

    if (this.isTerminalStatus(task.status)) {
      console.log(`[TaskManager] Ignoring update for terminal task ${taskUUID}`);
      return task;
    }

    // Use the pure state machine for status transitions
    let transitioned = task;
    if (update.status && update.status !== task.status) {
      const result = applyTransition(task, update.status);
      if (!result) {
        console.warn(
          `[TaskManager] Invalid transition: ${task.status} → ${update.status} for ${taskUUID}`
        );
        return task;
      }
      transitioned = result;
      if (isTerminalStatus(update.status)) {
        console.log(`[TaskManager] Terminal state ${update.status} for ${taskUUID}`);
      }
    }

    const sets: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    if (update.status) {
      sets.push("status = ?");
      values.push(transitioned.status);

      // agent_active side effects come from the state machine
      if (transitioned.agent_active !== task.agent_active) {
        sets.push("agent_active = ?");
        values.push(transitioned.agent_active);
      }
    }
    if (update.pr_url !== undefined) { sets.push("pr_url = ?"); values.push(update.pr_url); }
    if (update.branch_name !== undefined) { sets.push("branch_name = ?"); values.push(update.branch_name); }
    if (update.slack_thread_ts !== undefined) { sets.push("slack_thread_ts = ?"); values.push(update.slack_thread_ts); }
    if (update.transcript_r2_key !== undefined) { sets.push("transcript_r2_key = ?"); values.push(update.transcript_r2_key); }
    if (update.scheduled_for !== undefined) { sets.push("scheduled_for = ?"); values.push(update.scheduled_for); }

    values.push(taskUUID);
    this.sql.exec(`UPDATE tasks SET ${sets.join(", ")} WHERE task_uuid = ?`, ...values);

    return this.getTask(taskUUID)!;
  }

  /**
   * Spawn an agent container for a task.
   * Deploy re-spawn safe: accepts tasks in spawning/active state (re-initializes container).
   * For new spawns, transitions from reviewing/queued → spawning.
   */
  async spawnAgent(taskUUID: string, config: SpawnConfig): Promise<void> {
    const task = this.getTask(taskUUID);
    if (!task) throw new Error(`Task ${taskUUID} not found`);
    if (this.isTerminalStatus(task.status)) throw new Error(`Task ${taskUUID} is terminal`);

    const isRespawn = task.status === "spawning" || task.status === "active";

    if (!isRespawn) {
      // New spawn — must be in reviewing or queued
      if (task.status !== "reviewing" && task.status !== "queued") {
        throw new Error(`Cannot spawn agent for task in ${task.status} state`);
      }
      // Transition to spawning
      this.updateStatus(taskUUID, { status: "spawning" });
    }

    // Set agent_active=1
    this.sql.exec(
      "UPDATE tasks SET agent_active = 1, updated_at = datetime('now') WHERE task_uuid = ?",
      taskUUID,
    );

    try {
      const agentNs = this.env.TASK_AGENT as any;
      const id = agentNs.idFromName(taskUUID);
      const agent = agentNs.get(id);

      // Initialize the agent container with config
      const initRes = await agent.fetch(new Request("http://internal/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskUUID,
          taskId: task.task_id ?? undefined,
          taskTitle: task.title ?? undefined,
          product: config.product,
          repos: config.repos,
          slackChannel: config.slackChannel,
          slackThreadTs: config.slackThreadTs || task.slack_thread_ts || undefined,
          secrets: config.secrets,
          gatewayConfig: config.gatewayConfig,
          model: config.model,
          mode: config.mode,
          slackPersona: config.slackPersona,
        }),
      }));

      if (!initRes.ok) {
        throw new Error(`Agent init failed: ${initRes.status}`);
      }
      console.log(`[TaskManager] Agent spawned for ${taskUUID} (respawn=${isRespawn})`);
    } catch (err) {
      // On failure: mark agent inactive, transition to failed for new spawns
      if (!isRespawn) {
        try {
          this.updateStatus(taskUUID, { status: "failed" });
        } catch {
          this.sql.exec(
            "UPDATE tasks SET status = 'failed', agent_active = 0, updated_at = datetime('now') WHERE task_uuid = ?",
            taskUUID,
          );
        }
      } else {
        // Respawns keep current state so alarm can retry later
        this.sql.exec(
          "UPDATE tasks SET agent_active = 0, updated_at = datetime('now') WHERE task_uuid = ?",
          taskUUID,
        );
      }
      console.error(`[TaskManager] Failed to spawn agent for ${taskUUID}:`, err);
      throw err;
    }
  }

  /**
   * Stop an agent. Idempotent — safe to call on already-stopped agents.
   */
  async stopAgent(taskUUID: string, reason: string): Promise<void> {
    console.log(`[TaskManager] Stopping agent for ${taskUUID}: ${reason}`);

    // Set agent_active=0 in DB first
    this.sql.exec(
      "UPDATE tasks SET agent_active = 0, updated_at = datetime('now') WHERE task_uuid = ?",
      taskUUID,
    );

    // Notify TaskAgent DO — best-effort, don't throw on failure
    try {
      const agentNs = this.env.TASK_AGENT as any;
      const id = agentNs.idFromName(taskUUID);
      const agent = agentNs.get(id);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      await agent.fetch(
        new Request("http://internal/mark-terminal", { method: "POST", signal: controller.signal })
      ).finally(() => clearTimeout(timeout));
    } catch (err) {
      // Timeout or network error — agent may already be dead
      console.warn(`[TaskManager] Could not notify agent for ${taskUUID}:`, err);
    }
  }

  /**
   * Send an event to a running agent. Retries with backoff.
   */
  async sendEvent(taskUUID: string, event: unknown): Promise<void> {
    const task = this.getTask(taskUUID);
    if (!task) throw new Error(`Task ${taskUUID} not found`);
    if (this.isTerminal(taskUUID)) {
      console.log(`[TaskManager] Ignoring event for terminal task ${taskUUID}`);
      return;
    }
    if (task.agent_active !== 1) {
      console.log(`[TaskManager] No active agent for ${taskUUID}, skipping event`);
      return;
    }

    const agentNs = this.env.TASK_AGENT as any;
    const id = agentNs.idFromName(taskUUID);
    const agent = agentNs.get(id);

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await agent.fetch(new Request("http://internal/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }));

      if (res.ok) return;

      // 4xx = client error, won't self-resolve — fail immediately
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`Event delivery failed: ${res.status}`);
      }

      // 5xx = server error (503 cold start, 500 workspace setup, 502 gateway) — retry
      console.warn(`[TaskManager] Agent error ${res.status} for ${taskUUID}, retry ${attempt + 1}/3`);
      await new Promise(r => setTimeout(r, this.retryDelayMs * (attempt + 1)));
    }

    // Exhausted retries — mark agent inactive but don't terminal-fail the task.
    // Transient 503s (cold start, deploy recovery) should leave the task retryable
    // so supervisor or thread replies can re-activate it later.
    console.error(`[TaskManager] Event delivery failed after retries for ${taskUUID}`);
    this.sql.exec(
      "UPDATE tasks SET agent_active = 0, updated_at = datetime('now') WHERE task_uuid = ?",
      taskUUID,
    );
  }

  /**
   * Re-activate an agent for a task (e.g., user replied in thread).
   * Only works for non-terminal tasks.
   */
  reactivate(taskUUID: string): void {
    if (this.isTerminal(taskUUID)) {
      console.log(`[TaskManager] Cannot reactivate terminal task ${taskUUID}`);
      return;
    }
    this.sql.exec(
      "UPDATE tasks SET agent_active = 1, updated_at = datetime('now') WHERE task_uuid = ?",
      taskUUID,
    );
    console.log(`[TaskManager] Reactivated agent for ${taskUUID}`);
  }

  /**
   * Reopen a terminal task (e.g., user replied in a completed thread).
   * Transitions terminal → active, sets agent_active=1, and clears the
   * TaskAgent DO's terminal flag so the container can restart.
   */
  async reopenTask(taskUUID: string): Promise<void> {
    const task = this.getTask(taskUUID);
    if (!task) throw new Error(`Task ${taskUUID} not found`);
    if (!this.isTerminalStatus(task.status)) {
      console.log(`[TaskManager] Task ${taskUUID} is not terminal (${task.status}) — skipping reopen`);
      return;
    }

    // Bypass updateStatus() which has a terminal guard — direct SQL update.
    // The state machine allows terminal → active (types.ts VALID_TRANSITIONS).
    this.sql.exec(
      "UPDATE tasks SET status = ?, agent_active = 1, updated_at = datetime('now') WHERE task_uuid = ?",
      "active",
      taskUUID,
    );

    // Clear the TaskAgent DO's terminal flag so it accepts events again
    try {
      const agentNs = this.env.TASK_AGENT as any;
      const id = agentNs.idFromName(taskUUID);
      const agent = agentNs.get(id);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      await agent.fetch(
        new Request("http://internal/clear-terminal", { method: "POST", signal: controller.signal })
      ).finally(() => clearTimeout(timeout));
    } catch (err) {
      console.warn(`[TaskManager] Could not clear terminal flag on DO for ${taskUUID}:`, err);
    }

    console.log(`[TaskManager] Reopened terminal task ${taskUUID}`);
  }

  recordHeartbeat(taskUUID: string): void {
    this.sql.exec(
      "UPDATE tasks SET last_heartbeat = datetime('now'), updated_at = datetime('now') WHERE task_uuid = ? AND agent_active = 1",
      taskUUID,
    );
  }

  /** Record a phone-home from the agent: updates heartbeat timestamp and optional log message. */
  recordPhoneHome(taskUUID: string, message?: string): void {
    if (this.isTerminal(taskUUID)) return;
    if (message) {
      this.sql.exec(
        "UPDATE tasks SET last_heartbeat = datetime('now'), agent_message = ?, updated_at = datetime('now') WHERE task_uuid = ? AND agent_active = 1",
        message, taskUUID,
      );
    } else {
      this.recordHeartbeat(taskUUID);
    }
  }

  getActiveAgents(): TaskRecord[] {
    return this.sql.exec(
      "SELECT * FROM tasks WHERE agent_active = 1 ORDER BY updated_at DESC",
    ).toArray() as unknown as TaskRecord[];
  }

  async stopAllAgents(reason: string): Promise<void> {
    const agents = this.getActiveAgents();
    for (const agent of agents) {
      await this.stopAgent(agent.task_uuid, reason).catch(err =>
        console.error(`[TaskManager] Failed to stop ${agent.task_uuid}:`, err)
      );
    }
  }

  async cleanupInactive(): Promise<void> {
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(", ");
    const inactive = this.sql.exec(
      `SELECT task_uuid FROM tasks WHERE agent_active = 1 AND status IN (${placeholders})`,
      ...TERMINAL_STATUSES,
    ).toArray() as { task_uuid: string }[];

    for (const { task_uuid } of inactive) {
      await this.stopAgent(task_uuid, "cleanup: terminal but still active").catch(() => {});
    }
  }

  /**
   * Get all tasks that are scheduled and ready to be spawned.
   * Returns tasks in 'queued' status with scheduled_for <= now.
   */
  getScheduledTasksReadyToSpawn(): TaskRecord[] {
    return this.sql.exec(
      `SELECT * FROM tasks
       WHERE status = 'queued'
         AND scheduled_for IS NOT NULL
         AND scheduled_for <= datetime('now')
       ORDER BY scheduled_for ASC`,
    ).toArray() as unknown as TaskRecord[];
  }

  /**
   * Check if a task is scheduled for a future time.
   */
  isScheduledForFuture(taskUUID: string): boolean {
    const task = this.getTask(taskUUID);
    if (!task || !task.scheduled_for) return false;

    const scheduled = new Date(task.scheduled_for).getTime();
    const now = Date.now();
    return scheduled > now;
  }
}
