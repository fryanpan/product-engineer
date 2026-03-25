import { describe, it, expect, beforeEach } from "bun:test";
import { TASK_STATES, TERMINAL_STATUSES, type TaskState } from "./types";

/**
 * Tests for supervisor tick, heartbeat auto-transition, status validation,
 * and terminal state protection in the conductor.
 *
 * These tests exercise the logic from conductor.ts methods:
 * - handleHeartbeat(): auto-transition spawning → active, ci_status/needs_attention updates
 * - runSupervisorTick(): stale agent detection
 * - handleStatusUpdate(): status validation, terminal state protection
 * - handleEvent(): terminal task rejection
 *
 * Since we can't instantiate the full Durable Object, we extract the logic
 * into lightweight helpers that mirror what the conductor does, backed
 * by the same mock SQL layer used in task-manager.test.ts.
 */

// ─── Mock SQL layer (same pattern as task-manager.test.ts) ──────────────────

function createMockSql() {
  const tasks = new Map<string, Record<string, unknown>>();

  return {
    exec(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim();

      // INSERT INTO tasks
      if (trimmed.startsWith("INSERT INTO tasks")) {
        const [taskUUID, product, slackTs, slackCh, taskId, title] = params;
        tasks.set(taskUUID as string, {
          task_uuid: taskUUID,
          product,
          status: "created",
          slack_thread_ts: slackTs || null,
          slack_channel: slackCh || null,
          pr_url: null,
          branch_name: null,
          task_id: taskId || null,
          title: title || null,
          agent_active: 0,
          agent_message: null,
          ci_status: null,
          needs_attention: null,
          needs_attention_reason: null,
          transcript_r2_key: null,
          session_id: null,
          last_heartbeat: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return { toArray: () => [] };
      }

      // SELECT ... FROM tasks WHERE task_uuid = ?
      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tasks") && trimmed.includes("WHERE task_uuid =")) {
        const taskUUID = params[0] as string;
        const row = tasks.get(taskUUID);
        return { toArray: () => (row ? [{ ...row }] : []) };
      }

      // SELECT ... FROM tasks WHERE slack_thread_ts = ?
      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tasks") && trimmed.includes("WHERE slack_thread_ts =")) {
        const threadTs = params[0] as string;
        const row = [...tasks.values()].find((t) => t.slack_thread_ts === threadTs);
        return { toArray: () => (row ? [{ ...row }] : []) };
      }

      // SELECT stale agents (supervisor tick query)
      if (trimmed.includes("agent_active = 1") && trimmed.includes("last_heartbeat IS NOT NULL") && trimmed.includes("-5 minutes")) {
        // For testing, we compare last_heartbeat against 5 minutes ago
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
        const stale = [...tasks.values()].filter(
          (t) =>
            t.agent_active === 1 &&
            t.last_heartbeat !== null &&
            new Date(t.last_heartbeat as string) < fiveMinAgo,
        );
        return {
          toArray: () =>
            stale.map((t) => ({
              task_uuid: t.task_uuid,
              product: t.product,
              last_heartbeat: t.last_heartbeat,
            })),
        };
      }

      // UPDATE tasks SET ... WHERE task_uuid = ?
      if (trimmed.startsWith("UPDATE tasks SET")) {
        const id = params[params.length - 1] as string;
        const row = tasks.get(id);
        if (!row) return { toArray: () => [] };

        // Check for agent_active = 1 condition in WHERE clause
        if (trimmed.includes("AND agent_active = 1") && row.agent_active !== 1) {
          return { toArray: () => [] };
        }

        // Parse SET clauses
        const setClause = trimmed.match(/SET (.+) WHERE/)?.[1] || "";
        const setParts = setClause.split(",").map((s) => s.trim());
        let paramIdx = 0;
        for (const part of setParts) {
          const eqMatch = part.match(/(\w+)\s*=\s*\?/);
          if (eqMatch) {
            row[eqMatch[1]] = params[paramIdx++];
          } else if (part.includes("datetime('now')")) {
            const field = part.split("=")[0].trim();
            row[field] = new Date().toISOString();
          } else if (part.match(/agent_active\s*=\s*0/)) {
            row.agent_active = 0;
          } else if (part.match(/agent_active\s*=\s*1/)) {
            row.agent_active = 1;
          } else if (part.match(/status\s*=\s*'(\w+)'/)) {
            const statusMatch = part.match(/status\s*=\s*'(\w+)'/);
            if (statusMatch) row.status = statusMatch[1];
          } else if (part.match(/(\w+)\s*=\s*'([^']*)'/)) {
            // Literal string value in SET clause (e.g., agent_message = 'some text')
            const literalMatch = part.match(/(\w+)\s*=\s*'([^']*)'/);
            if (literalMatch) row[literalMatch[1]] = literalMatch[2];
          }
        }
        row.updated_at = new Date().toISOString();
        return { toArray: () => [] };
      }

      // SELECT agent_active = 1 (for getActiveAgents)
      if (trimmed.startsWith("SELECT") && trimmed.includes("agent_active = 1")) {
        const active = [...tasks.values()].filter((t) => t.agent_active === 1);
        return { toArray: () => active };
      }

      return { toArray: () => [] };
    },
    _tasks: tasks,
  };
}

// ─── Helpers that replicate conductor logic for testability ────────────────

/** Mimics handleHeartbeat logic from conductor.ts */
function handleHeartbeat(
  sql: ReturnType<typeof createMockSql>,
  payload: {
    taskUUID: string;
    message?: string;
    ci_status?: string;
    needs_attention?: boolean;
    needs_attention_reason?: string;
  },
) {
  const { taskUUID, message, ci_status, needs_attention, needs_attention_reason } = payload;

  // Record phone-home (update last_heartbeat + agent_message)
  const task = sql._tasks.get(taskUUID);
  if (!task) return;
  if ((TERMINAL_STATUSES as readonly string[]).includes(task.status as string)) return;

  if (task.agent_active === 1) {
    task.last_heartbeat = new Date().toISOString();
    if (message) task.agent_message = message;
    task.updated_at = new Date().toISOString();
  }

  // Store expanded heartbeat fields
  if (ci_status !== undefined) {
    sql.exec(
      "UPDATE tasks SET ci_status = ?, updated_at = datetime('now') WHERE task_uuid = ?",
      ci_status,
      taskUUID,
    );
  }
  if (needs_attention !== undefined) {
    sql.exec(
      "UPDATE tasks SET needs_attention = ?, updated_at = datetime('now') WHERE task_uuid = ?",
      needs_attention ? 1 : 0,
      taskUUID,
    );
  }
  if (needs_attention_reason !== undefined) {
    sql.exec(
      "UPDATE tasks SET needs_attention_reason = ?, updated_at = datetime('now') WHERE task_uuid = ?",
      needs_attention_reason,
      taskUUID,
    );
  }

  // Auto-transition spawning → active on first heartbeat
  const current = sql._tasks.get(taskUUID);
  if (current?.status === "spawning") {
    sql.exec(
      "UPDATE tasks SET status = 'active', updated_at = datetime('now') WHERE task_uuid = ?",
      taskUUID,
    );
  }
}

/** Mimics runSupervisorTick logic from conductor.ts */
function runSupervisorTick(sql: ReturnType<typeof createMockSql>): Array<{ task_uuid: string; product: string; last_heartbeat: string }> {
  const result = sql.exec(`
    SELECT task_uuid, product, last_heartbeat
    FROM tasks
    WHERE agent_active = 1
      AND last_heartbeat IS NOT NULL
      AND last_heartbeat < datetime('now', '-5 minutes')
  `).toArray() as Array<{ task_uuid: string; product: string; last_heartbeat: string }>;

  for (const agent of result) {
    sql.exec(
      "UPDATE tasks SET agent_message = 'heartbeat timeout — agent may be stuck', updated_at = datetime('now') WHERE task_uuid = ?",
      agent.task_uuid,
    );
  }

  return result;
}

/** Mimics handleStatusUpdate status validation logic from conductor.ts */
function validateAndApplyStatus(
  sql: ReturnType<typeof createMockSql>,
  taskUUID: string,
  body: {
    status?: string;
    pr_url?: string;
    branch_name?: string;
    agent_active?: number;
  },
): { ok: boolean; ignored?: boolean; reason?: string } {
  const task = sql._tasks.get(taskUUID);
  if (!task) return { ok: false, reason: "task not found" };

  // Terminal state protection
  if ((TERMINAL_STATUSES as readonly string[]).includes(task.status as string)) {
    if (body.agent_active === undefined || body.agent_active !== 0) {
      return { ok: true, ignored: true, reason: "terminal task" };
    }
  }

  const updates: string[] = ["updated_at = datetime('now')", "last_heartbeat = datetime('now')"];
  const values: (string | number | null)[] = [];

  if (body.agent_active !== undefined) {
    updates.push("agent_active = ?");
    values.push(body.agent_active);
  }

  if (body.status) {
    // Validate against TASK_STATES — reject invalid strings
    if (!(TASK_STATES as readonly string[]).includes(body.status)) {
      // Invalid status: skip status update but continue processing other fields
    } else {
      updates.push("status = ?");
      values.push(body.status);

      // Terminal states: mark agent as inactive
      if ((TERMINAL_STATUSES as readonly string[]).includes(body.status)) {
        updates.push("agent_active = 0");
      }
    }
  }

  if (body.pr_url) {
    updates.push("pr_url = ?");
    values.push(body.pr_url);
  }
  if (body.branch_name) {
    updates.push("branch_name = ?");
    values.push(body.branch_name);
  }

  values.push(taskUUID);
  sql.exec(`UPDATE tasks SET ${updates.join(", ")} WHERE task_uuid = ?`, ...values);

  return { ok: true };
}

/** Mimics handleEvent terminal state check from conductor.ts */
function checkEventTerminalGuard(
  sql: ReturnType<typeof createMockSql>,
  taskUUID: string,
): { ignored: boolean; reason?: string } {
  const task = sql._tasks.get(taskUUID);
  if (!task) return { ignored: false };

  if ((TERMINAL_STATUSES as readonly string[]).includes(task.status as string)) {
    return { ignored: true, reason: "terminal task" };
  }

  return { ignored: false };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function insertTask(
  sql: ReturnType<typeof createMockSql>,
  taskUUID: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  sql.exec(
    "INSERT INTO tasks (task_uuid, product, slack_thread_ts, slack_channel, task_id, title) VALUES (?, ?, ?, ?, ?, ?)",
    taskUUID,
    overrides.product || "test-product",
    null,
    null,
    null,
    null,
  );
  // Apply overrides
  const task = sql._tasks.get(taskUUID)!;
  for (const [key, value] of Object.entries(overrides)) {
    task[key] = value;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Heartbeat auto-transition", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("transitions task from spawning → active on first heartbeat", () => {
    insertTask(sql, "PE-1", { status: "spawning", agent_active: 1 });

    handleHeartbeat(sql, { taskUUID: "PE-1", message: "agent starting" });

    const task = sql._tasks.get("PE-1")!;
    expect(task.status).toBe("active");
    expect(task.last_heartbeat).not.toBeNull();
    expect(task.agent_message).toBe("agent starting");
  });

  it("does not transition non-spawning tasks", () => {
    insertTask(sql, "PE-2", { status: "active", agent_active: 1 });

    handleHeartbeat(sql, { taskUUID: "PE-2", message: "still working" });

    const task = sql._tasks.get("PE-2")!;
    expect(task.status).toBe("active"); // stays active, not re-transitioned
    expect(task.last_heartbeat).not.toBeNull();
  });

  it("does not transition tasks in created state", () => {
    insertTask(sql, "PE-3", { status: "created", agent_active: 1 });

    handleHeartbeat(sql, { taskUUID: "PE-3" });

    expect(sql._tasks.get("PE-3")!.status).toBe("created");
  });

  it("skips heartbeat for terminal tasks", () => {
    insertTask(sql, "PE-4", { status: "merged", agent_active: 0 });

    handleHeartbeat(sql, { taskUUID: "PE-4", message: "late heartbeat" });

    const task = sql._tasks.get("PE-4")!;
    expect(task.status).toBe("merged");
    expect(task.last_heartbeat).toBeNull(); // not updated
    expect(task.agent_message).toBeNull(); // not updated
  });

  it("only updates heartbeat for active agents (agent_active=1)", () => {
    insertTask(sql, "PE-5", { status: "active", agent_active: 0 });

    handleHeartbeat(sql, { taskUUID: "PE-5", message: "orphaned heartbeat" });

    const task = sql._tasks.get("PE-5")!;
    expect(task.last_heartbeat).toBeNull(); // agent_active=0, no update
  });
});

describe("Heartbeat expanded fields", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("updates ci_status when provided", () => {
    insertTask(sql, "PE-1", { status: "active", agent_active: 1 });

    handleHeartbeat(sql, { taskUUID: "PE-1", ci_status: "passing" });

    expect(sql._tasks.get("PE-1")!.ci_status).toBe("passing");
  });

  it("updates needs_attention when provided", () => {
    insertTask(sql, "PE-1", { status: "active", agent_active: 1 });

    handleHeartbeat(sql, {
      taskUUID: "PE-1",
      needs_attention: true,
      needs_attention_reason: "CI failing after 3 retries",
    });

    const task = sql._tasks.get("PE-1")!;
    expect(task.needs_attention).toBe(1);
    expect(task.needs_attention_reason).toBe("CI failing after 3 retries");
  });

  it("sets needs_attention to 0 when false", () => {
    insertTask(sql, "PE-1", { status: "active", agent_active: 1, needs_attention: 1 });

    handleHeartbeat(sql, { taskUUID: "PE-1", needs_attention: false });

    expect(sql._tasks.get("PE-1")!.needs_attention).toBe(0);
  });

  it("does not overwrite ci_status when not provided", () => {
    insertTask(sql, "PE-1", { status: "active", agent_active: 1, ci_status: "pending" });

    handleHeartbeat(sql, { taskUUID: "PE-1", message: "still working" });

    expect(sql._tasks.get("PE-1")!.ci_status).toBe("pending");
  });
});

describe("Supervisor tick: stale agent detection", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("detects agents with heartbeat older than 5 minutes", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertTask(sql, "PE-1", {
      status: "active",
      agent_active: 1,
      last_heartbeat: tenMinAgo,
    });

    const stale = runSupervisorTick(sql);

    expect(stale.length).toBe(1);
    expect(stale[0].task_uuid).toBe("PE-1");
    // Check that agent_message was updated
    expect(sql._tasks.get("PE-1")!.agent_message).toBe(
      "heartbeat timeout — agent may be stuck",
    );
  });

  it("does not flag agents with recent heartbeats", () => {
    const oneMinAgo = new Date(Date.now() - 1 * 60 * 1000).toISOString();
    insertTask(sql, "PE-2", {
      status: "active",
      agent_active: 1,
      last_heartbeat: oneMinAgo,
    });

    const stale = runSupervisorTick(sql);

    expect(stale.length).toBe(0);
    expect(sql._tasks.get("PE-2")!.agent_message).toBeNull();
  });

  it("does not flag inactive agents (agent_active=0)", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertTask(sql, "PE-3", {
      status: "active",
      agent_active: 0,
      last_heartbeat: tenMinAgo,
    });

    const stale = runSupervisorTick(sql);
    expect(stale.length).toBe(0);
  });

  it("does not flag agents with no heartbeat (null)", () => {
    insertTask(sql, "PE-4", {
      status: "spawning",
      agent_active: 1,
      last_heartbeat: null,
    });

    const stale = runSupervisorTick(sql);
    expect(stale.length).toBe(0);
  });

  it("detects multiple stale agents", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertTask(sql, "PE-A", { status: "active", agent_active: 1, last_heartbeat: tenMinAgo });
    insertTask(sql, "PE-B", { status: "active", agent_active: 1, last_heartbeat: tenMinAgo });

    const stale = runSupervisorTick(sql);
    expect(stale.length).toBe(2);
  });
});

describe("Status validation: handleStatusUpdate", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("accepts valid TASK_STATES status strings", () => {
    insertTask(sql, "PE-1", { status: "active", agent_active: 1 });

    const result = validateAndApplyStatus(sql, "PE-1", { status: "pr_open" });

    expect(result.ok).toBe(true);
    expect(result.ignored).toBeUndefined();
    expect(sql._tasks.get("PE-1")!.status).toBe("pr_open");
  });

  it("rejects invalid status strings (e.g., 'agent:starting')", () => {
    insertTask(sql, "PE-1", { status: "active", agent_active: 1 });

    const result = validateAndApplyStatus(sql, "PE-1", { status: "agent:starting" });

    expect(result.ok).toBe(true);
    // Status should NOT have changed
    expect(sql._tasks.get("PE-1")!.status).toBe("active");
  });

  it("rejects arbitrary strings not in TASK_STATES", () => {
    insertTask(sql, "PE-1", { status: "created", agent_active: 1 });

    for (const invalidStatus of ["in_progress", "running", "agent:cloning", "completed", "done", ""]) {
      // Reset
      sql._tasks.get("PE-1")!.status = "created";

      validateAndApplyStatus(sql, "PE-1", { status: invalidStatus });
      // Empty string may match but none of these are in TASK_STATES
      if (!(TASK_STATES as readonly string[]).includes(invalidStatus)) {
        expect(sql._tasks.get("PE-1")!.status).toBe("created");
      }
    }
  });

  it("still processes metadata fields when status is invalid", () => {
    insertTask(sql, "PE-1", { status: "active", agent_active: 1 });

    validateAndApplyStatus(sql, "PE-1", {
      status: "agent:pushing",
      pr_url: "https://github.com/org/repo/pull/42",
      branch_name: "ticket/PE-1",
    });

    const task = sql._tasks.get("PE-1")!;
    expect(task.status).toBe("active"); // status unchanged
    expect(task.pr_url).toBe("https://github.com/org/repo/pull/42"); // metadata applied
    expect(task.branch_name).toBe("ticket/PE-1"); // metadata applied
  });

  it("marks agent_active=0 on terminal status transitions", () => {
    insertTask(sql, "PE-1", { status: "active", agent_active: 1 });

    validateAndApplyStatus(sql, "PE-1", { status: "failed" });

    expect(sql._tasks.get("PE-1")!.agent_active).toBe(0);
  });

  it("all terminal statuses mark agent_active=0", () => {
    for (const terminal of TERMINAL_STATUSES) {
      const id = `term-${terminal}`;
      insertTask(sql, id, { status: "active", agent_active: 1 });

      validateAndApplyStatus(sql, id, { status: terminal });

      expect(sql._tasks.get(id)!.agent_active).toBe(0);
    }
  });
});

describe("Terminal state protection in handleStatusUpdate", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("rejects status updates for terminal tasks", () => {
    insertTask(sql, "PE-1", { status: "merged", agent_active: 0 });

    const result = validateAndApplyStatus(sql, "PE-1", { status: "active" });

    expect(result.ignored).toBe(true);
    expect(result.reason).toBe("terminal task");
    expect(sql._tasks.get("PE-1")!.status).toBe("merged");
  });

  it("allows explicit agent_active=0 for terminal tasks (dashboard kill)", () => {
    insertTask(sql, "PE-1", { status: "failed", agent_active: 1 });

    const result = validateAndApplyStatus(sql, "PE-1", { agent_active: 0 });

    expect(result.ok).toBe(true);
    expect(result.ignored).toBeUndefined();
    expect(sql._tasks.get("PE-1")!.agent_active).toBe(0);
  });

  it("rejects heartbeat-style updates for all terminal statuses", () => {
    for (const terminal of TERMINAL_STATUSES) {
      const id = `term-${terminal}`;
      insertTask(sql, id, { status: terminal, agent_active: 0 });

      const result = validateAndApplyStatus(sql, id, { status: "active" });

      expect(result.ignored).toBe(true);
      expect(result.reason).toBe("terminal task");
    }
  });
});

describe("Terminal state protection in handleEvent", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("rejects events for merged tasks", () => {
    insertTask(sql, "PE-1", { status: "merged", agent_active: 0 });

    const result = checkEventTerminalGuard(sql, "PE-1");

    expect(result.ignored).toBe(true);
    expect(result.reason).toBe("terminal task");
  });

  it("rejects events for closed tasks", () => {
    insertTask(sql, "PE-1", { status: "closed", agent_active: 0 });

    const result = checkEventTerminalGuard(sql, "PE-1");

    expect(result.ignored).toBe(true);
  });

  it("rejects events for failed tasks", () => {
    insertTask(sql, "PE-1", { status: "failed", agent_active: 0 });

    const result = checkEventTerminalGuard(sql, "PE-1");

    expect(result.ignored).toBe(true);
  });

  it("rejects events for deferred tasks", () => {
    insertTask(sql, "PE-1", { status: "deferred", agent_active: 0 });

    const result = checkEventTerminalGuard(sql, "PE-1");

    expect(result.ignored).toBe(true);
  });

  it("allows events for non-terminal tasks", () => {
    for (const status of TASK_STATES) {
      if ((TERMINAL_STATUSES as readonly string[]).includes(status)) continue;

      const id = `nonterm-${status}`;
      insertTask(sql, id, { status, agent_active: 1 });

      const result = checkEventTerminalGuard(sql, id);

      expect(result.ignored).toBe(false);
    }
  });

  it("allows events for non-existent tasks (will be created)", () => {
    const result = checkEventTerminalGuard(sql, "nonexistent");
    expect(result.ignored).toBe(false);
  });
});

// ─── Thread reply routing decision ──────────────────────────────────────────

/**
 * Mirrors the thread reply routing logic in conductor.ts handleSlackEvent.
 * Determines whether a thread reply should respawn the container or route to
 * an existing one.
 */
function threadReplyRoutingDecision(
  sql: ReturnType<typeof createMockSql>,
  threadTs: string,
): { found: boolean; wasTerminal: boolean; needsRespawn: boolean } {
  const rows = sql.exec(
    "SELECT task_uuid, product, status, agent_active FROM tasks WHERE slack_thread_ts = ?",
    threadTs,
  ).toArray() as { task_uuid: string; product: string; status: string; agent_active: number }[];

  if (rows.length === 0) {
    return { found: false, wasTerminal: false, needsRespawn: false };
  }

  const task = rows[0];
  const isTerminal = (TERMINAL_STATUSES as readonly string[]).includes(task.status);

  // Terminal tasks get reopened and respawned (not ignored)
  const needsRespawn = isTerminal || task.status === "suspended" || task.agent_active === 0;
  return { found: true, wasTerminal: isTerminal, needsRespawn };
}

describe("Thread reply routing", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("returns not-found for unknown thread_ts", () => {
    const result = threadReplyRoutingDecision(sql, "unknown-ts");
    expect(result.found).toBe(false);
  });

  it("reopens and respawns merged tasks", () => {
    insertTask(sql, "PE-1", { status: "merged", agent_active: 0, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(true);
    expect(result.needsRespawn).toBe(true);
  });

  it("reopens and respawns closed tasks", () => {
    insertTask(sql, "PE-1", { status: "closed", agent_active: 0, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(true);
    expect(result.needsRespawn).toBe(true);
  });

  it("needs respawn for suspended tasks", () => {
    insertTask(sql, "PE-1", { status: "suspended", agent_active: 0, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(false);
    expect(result.needsRespawn).toBe(true);
  });

  it("needs respawn for active tasks with agent_active=0 (dead container)", () => {
    insertTask(sql, "PE-1", { status: "active", agent_active: 0, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(false);
    expect(result.needsRespawn).toBe(true);
  });

  it("needs respawn for pr_open tasks with agent_active=0 (post-deploy)", () => {
    insertTask(sql, "PE-1", { status: "pr_open", agent_active: 0, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(false);
    expect(result.needsRespawn).toBe(true);
  });

  it("routes to existing container for active tasks with agent_active=1", () => {
    insertTask(sql, "PE-1", { status: "active", agent_active: 1, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(false);
    expect(result.needsRespawn).toBe(false);
  });
});
