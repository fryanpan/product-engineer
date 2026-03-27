import { describe, it, expect, beforeEach } from "bun:test";
import { TaskManager, type CreateTaskParams, type SpawnConfig } from "./task-manager";
import { VALID_TRANSITIONS, TERMINAL_STATUSES, TASK_STATES, type TaskState } from "./types";

// In-memory SQLite mock — stores tasks as a Map
function createMockSql() {
  const tasks = new Map<string, Record<string, unknown>>();

  return {
    exec(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim();

      // INSERT INTO tasks
      if (trimmed.startsWith("INSERT INTO tasks")) {
        const [taskUUID, product, slackTs, slackCh, taskId, title] = params;

        tasks.set(taskUUID as string, {
          task_uuid: taskUUID, product,
          status: "created",
          slack_thread_ts: slackTs || null,
          slack_channel: slackCh || null,
          pr_url: null,
          branch_name: null,
          task_id: taskId || null,
          title: title || null,
          agent_active: 0,
          transcript_r2_key: null,
          session_id: null,
          last_heartbeat: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return { toArray: () => [] };
      }

      // DELETE FROM tasks WHERE task_uuid = ?
      if (trimmed.startsWith("DELETE FROM tasks")) {
        tasks.delete(params[0] as string);
        return { toArray: () => [] };
      }

      // SELECT * FROM tasks WHERE task_uuid = ?
      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tasks") && trimmed.includes("WHERE task_uuid =")) {
        const taskUUID = params[0] as string;
        const row = tasks.get(taskUUID);
        return { toArray: () => row ? [{ ...row }] : [] };
      }

      // SELECT * FROM tasks WHERE task_id = ?
      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tasks") && trimmed.includes("WHERE task_id")) {
        const taskId = params[0] as string;
        const match = [...tasks.values()].find(t => t.task_id === taskId);
        return { toArray: () => match ? [{ ...match }] : [] };
      }

      // SELECT task_uuid FROM tasks WHERE agent_active = 1 AND status IN (...)
      if (trimmed.includes("agent_active = 1") && trimmed.includes("status IN")) {
        // Support both parameterized (?-based) and literal ('value'-based) IN clauses
        const inMatch = trimmed.match(/IN \(([^)]+)\)/);
        let statuses: string[];
        if (inMatch && inMatch[1].includes("?")) {
          // Parameterized: statuses come from params
          statuses = params.map(p => String(p));
        } else {
          statuses = inMatch ? inMatch[1].split(",").map(s => s.trim().replace(/'/g, "")) : [];
        }
        const matching = [...tasks.values()].filter(
          t => t.agent_active === 1 && statuses.includes(t.status as string),
        );
        return { toArray: () => matching.map(t => ({ task_uuid: t.task_uuid })) };
      }

      // UPDATE tasks SET ... WHERE task_uuid = ? AND agent_active = 1
      // UPDATE tasks SET ... WHERE task_uuid = ?
      if (trimmed.startsWith("UPDATE tasks SET")) {
        const id = params[params.length - 1] as string;
        const row = tasks.get(id);
        if (!row) return { toArray: () => [] };

        // Check for agent_active = 1 condition in WHERE clause
        if (trimmed.includes("AND agent_active = 1") && row.agent_active !== 1) {
          return { toArray: () => [] };
        }

        // Parse SET clauses to figure out which fields to update
        const setClause = trimmed.match(/SET (.+) WHERE/)?.[1] || "";
        const setParts = setClause.split(",").map(s => s.trim());
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
          }
        }
        row.updated_at = new Date().toISOString();
        return { toArray: () => [] };
      }

      // SELECT * FROM tasks WHERE agent_active = 1 ORDER BY ...
      if (trimmed.startsWith("SELECT") && trimmed.includes("agent_active = 1")) {
        const active = [...tasks.values()].filter(t => t.agent_active === 1);
        return { toArray: () => active };
      }

      return { toArray: () => [] };
    },
    // Expose for test assertions
    _tasks: tasks,
  };
}

function createMockTaskAgentNs() {
  const agents = new Map<string, {
    fetchCalls: Array<{ url: string; method: string; body?: string }>;
    nextResponse: Response;
  }>();

  return {
    idFromName(name: string) { return { name }; },
    get(id: { name: string }) {
      if (!agents.has(id.name)) {
        agents.set(id.name, { fetchCalls: [], nextResponse: new Response("ok", { status: 200 }) });
      }
      const agent = agents.get(id.name)!;
      return {
        fetch: async (req: Request) => {
          const body = req.method === "POST" ? await req.text() : undefined;
          agent.fetchCalls.push({ url: req.url, method: req.method, body });
          return agent.nextResponse.clone();
        },
      };
    },
    _agents: agents,
    setResponse(taskId: string, status: number, body = "") {
      if (!agents.has(taskId)) {
        agents.set(taskId, { fetchCalls: [], nextResponse: new Response(body, { status }) });
      } else {
        agents.get(taskId)!.nextResponse = new Response(body, { status });
      }
    },
  };
}

const defaultSpawnConfig: SpawnConfig = {
  product: "test-product",
  repos: ["org/repo"],
  slackChannel: "C123",
  secrets: { GITHUB_TOKEN: "gh-token" },
};

describe("State machine", () => {
  it("terminal states can only transition to active (reopen)", () => {
    for (const state of TERMINAL_STATUSES) {
      expect(VALID_TRANSITIONS[state]).toEqual(["active"]);
    }
  });

  it("all transition targets are valid states", () => {
    const validStates = new Set<string>(TASK_STATES);
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const target of targets) {
        expect(validStates.has(target)).toBe(true);
      }
    }
  });

  it("every non-terminal state can reach a terminal state", () => {
    const terminalSet = new Set<string>(TERMINAL_STATUSES);

    function canReachTerminal(state: TaskState, visited = new Set<string>()): boolean {
      if (terminalSet.has(state)) return true;
      if (visited.has(state)) return false;
      visited.add(state);
      return VALID_TRANSITIONS[state].some(next => canReachTerminal(next, new Set(visited)));
    }

    for (const state of TASK_STATES) {
      if (!terminalSet.has(state)) {
        expect(canReachTerminal(state)).toBe(true);
      }
    }
  });
});

describe("TaskManager", () => {
  let sql: ReturnType<typeof createMockSql>;
  let manager: TaskManager;

  const defaultParams: CreateTaskParams = {
    taskUUID: "PE-1",
    product: "test-product",
  };

  beforeEach(() => {
    sql = createMockSql();
    manager = new TaskManager(sql, {});
  });

  describe("createTask", () => {
    it("creates task in 'created' state with agent_active=0", () => {
      const task = manager.createTask(defaultParams);
      expect(task.task_uuid).toBe("PE-1");
      expect(task.product).toBe("test-product");
      expect(task.status).toBe("created");
      expect(task.agent_active).toBe(0);
    });

    it("throws if task already exists in non-terminal state", () => {
      manager.createTask(defaultParams);
      expect(() => manager.createTask(defaultParams)).toThrow(
        "Task PE-1 already exists (status: created)"
      );
    });

    it("allows re-creating after terminal state", () => {
      manager.createTask(defaultParams);
      // Transition to terminal: created → reviewing → spawning → active → pr_open → merged
      manager.updateStatus("PE-1", { status: "reviewing" });
      manager.updateStatus("PE-1", { status: "spawning" });
      manager.updateStatus("PE-1", { status: "active" });
      manager.updateStatus("PE-1", { status: "pr_open" });
      manager.updateStatus("PE-1", { status: "merged" });

      // Should be able to re-create
      const task = manager.createTask(defaultParams);
      expect(task.status).toBe("created");
    });

    it("stores all provided fields", () => {
      const task = manager.createTask({
        taskUUID: "PE-2",
        product: "my-product",
        slackThreadTs: "1234.5678",
        slackChannel: "C123",
        taskId: "PE-2",
        title: "Fix the bug",
      });

      expect(task.slack_thread_ts).toBe("1234.5678");
      expect(task.slack_channel).toBe("C123");
      expect(task.task_id).toBe("PE-2");
      expect(task.title).toBe("Fix the bug");
    });
  });

  describe("getTask", () => {
    it("returns null for non-existent task", () => {
      expect(manager.getTask("nonexistent")).toBeNull();
    });

    it("returns the task record after creation", () => {
      manager.createTask(defaultParams);
      const task = manager.getTask("PE-1");
      expect(task).not.toBeNull();
      expect(task!.task_uuid).toBe("PE-1");
      expect(task!.status).toBe("created");
    });
  });

  describe("getTaskByIdentifier", () => {
    it("returns null when no task has that identifier", () => {
      expect(manager.getTaskByIdentifier("PES-99")).toBeNull();
    });

    it("finds a task by its identifier", () => {
      manager.createTask({ taskUUID: "uuid-123", product: "test", taskId: "PES-5" });
      const task = manager.getTaskByIdentifier("PES-5");
      expect(task).not.toBeNull();
      expect(task!.task_uuid).toBe("uuid-123");
      expect(task!.task_id).toBe("PES-5");
    });

    it("does not match by id when looking up by identifier", () => {
      manager.createTask({ taskUUID: "PES-5", product: "test" });
      // id is "PES-5" but identifier is null
      expect(manager.getTaskByIdentifier("PES-5")).toBeNull();
    });
  });

  describe("isTerminal", () => {
    it("returns false for non-existent task", () => {
      expect(manager.isTerminal("nonexistent")).toBe(false);
    });

    it("returns false for 'created' task", () => {
      manager.createTask(defaultParams);
      expect(manager.isTerminal("PE-1")).toBe(false);
    });

    it("returns true for each terminal status", () => {
      for (const terminalStatus of TERMINAL_STATUSES) {
        const id = `terminal-${terminalStatus}`;
        manager.createTask({ taskUUID: id, product: "test" });

        // Get to terminal via valid path
        if (terminalStatus === "merged") {
          manager.updateStatus(id, { status: "reviewing" });
          manager.updateStatus(id, { status: "spawning" });
          manager.updateStatus(id, { status: "active" });
          manager.updateStatus(id, { status: "pr_open" });
          manager.updateStatus(id, { status: "merged" });
        } else if (terminalStatus === "closed") {
          manager.updateStatus(id, { status: "reviewing" });
          manager.updateStatus(id, { status: "closed" });
        } else if (terminalStatus === "failed") {
          manager.updateStatus(id, { status: "failed" });
        } else if (terminalStatus === "deferred") {
          manager.updateStatus(id, { status: "reviewing" });
          manager.updateStatus(id, { status: "deferred" });
        }

        expect(manager.isTerminal(id)).toBe(true);
      }
    });
  });

  describe("updateStatus", () => {
    it("allows valid transitions (created -> reviewing)", () => {
      manager.createTask(defaultParams);
      const task = manager.updateStatus("PE-1", { status: "reviewing" });
      expect(task.status).toBe("reviewing");
    });

    it("rejects invalid transitions (created -> merged) by returning unchanged task", () => {
      manager.createTask(defaultParams);
      const task = manager.updateStatus("PE-1", { status: "merged" });
      // Invalid transitions return the task unchanged (no throw)
      expect(task.status).toBe("created");
    });

    it("sets agent_active=0 on terminal transitions", () => {
      manager.createTask(defaultParams);
      // Set agent_active=1 manually to verify it gets reset
      sql._tasks.get("PE-1")!.agent_active = 1;

      manager.updateStatus("PE-1", { status: "failed" });
      const task = manager.getTask("PE-1");
      expect(task!.agent_active).toBe(0);
    });

    it("updates metadata fields without changing status", () => {
      manager.createTask(defaultParams);
      const task = manager.updateStatus("PE-1", {
        pr_url: "https://github.com/org/repo/pull/1",
        branch_name: "fix/pe-1",
      });
      expect(task.pr_url).toBe("https://github.com/org/repo/pull/1");
      expect(task.branch_name).toBe("fix/pe-1");
      expect(task.status).toBe("created");
    });

    it("throws for non-existent task", () => {
      expect(() => manager.updateStatus("nonexistent", { status: "reviewing" })).toThrow(
        "Task nonexistent not found"
      );
    });

    it("ignores updates for terminal tasks (returns task without throwing)", () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "failed" });

      // Should not throw, just return the existing task
      const task = manager.updateStatus("PE-1", { status: "reviewing" as any });
      expect(task.status).toBe("failed");
    });

    it("handles multiple metadata fields in one update", () => {
      manager.createTask(defaultParams);
      const task = manager.updateStatus("PE-1", {
        status: "reviewing",
        slack_thread_ts: "9999.0000",
        transcript_r2_key: "transcripts/pe-1.json",
      });
      expect(task.status).toBe("reviewing");
      expect(task.slack_thread_ts).toBe("9999.0000");
      expect(task.transcript_r2_key).toBe("transcripts/pe-1.json");
    });
  });

  describe("spawnAgent", () => {
    let mockNs: ReturnType<typeof createMockTaskAgentNs>;

    beforeEach(() => {
      mockNs = createMockTaskAgentNs();
      manager = new TaskManager(sql, { TASK_AGENT: mockNs });
    });

    it("transitions from reviewing to spawning and sets agent_active=1", async () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });

      await manager.spawnAgent("PE-1", defaultSpawnConfig);

      const task = manager.getTask("PE-1")!;
      expect(task.status).toBe("spawning");
      expect(task.agent_active).toBe(1);
    });

    it("sends /initialize to TaskAgent DO with correct config", async () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });

      await manager.spawnAgent("PE-1", {
        ...defaultSpawnConfig,
        slackThreadTs: "ts-123",
        model: "opus",
      });

      const calls = mockNs._agents.get("PE-1")!.fetchCalls;
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("http://internal/initialize");
      expect(calls[0].method).toBe("POST");
      const body = JSON.parse(calls[0].body!);
      expect(body.taskUUID).toBe("PE-1");
      expect(body.product).toBe("test-product");
      expect(body.repos).toEqual(["org/repo"]);
      expect(body.slackThreadTs).toBe("ts-123");
      expect(body.model).toBe("opus");
    });

    it("allows re-spawn from spawning state (deploy recovery)", async () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });
      manager.updateStatus("PE-1", { status: "spawning" });

      await manager.spawnAgent("PE-1", defaultSpawnConfig);

      const task = manager.getTask("PE-1")!;
      expect(task.status).toBe("spawning");
      expect(task.agent_active).toBe(1);
    });

    it("allows re-spawn from active state (deploy recovery)", async () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });
      manager.updateStatus("PE-1", { status: "spawning" });
      manager.updateStatus("PE-1", { status: "active" });

      await manager.spawnAgent("PE-1", defaultSpawnConfig);

      const task = manager.getTask("PE-1")!;
      expect(task.status).toBe("active");
      expect(task.agent_active).toBe(1);
    });

    it("throws for task not in valid spawn state (e.g., created)", async () => {
      manager.createTask(defaultParams);

      await expect(manager.spawnAgent("PE-1", defaultSpawnConfig)).rejects.toThrow(
        "Cannot spawn agent for task in created state"
      );
    });

    it("marks failed on init failure for new spawns", async () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });
      mockNs.setResponse("PE-1", 500, "error");

      await expect(manager.spawnAgent("PE-1", defaultSpawnConfig)).rejects.toThrow(
        "Agent init failed: 500"
      );

      const task = manager.getTask("PE-1")!;
      expect(task.status).toBe("failed");
      expect(task.agent_active).toBe(0);
    });

    it("does NOT mark failed on init failure for respawns", async () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });
      manager.updateStatus("PE-1", { status: "spawning" });
      manager.updateStatus("PE-1", { status: "active" });
      mockNs.setResponse("PE-1", 500, "error");

      await expect(manager.spawnAgent("PE-1", defaultSpawnConfig)).rejects.toThrow(
        "Agent init failed: 500"
      );

      const task = manager.getTask("PE-1")!;
      expect(task.status).toBe("active"); // Keeps current state
      expect(task.agent_active).toBe(0);
    });

    it("throws for terminal task", async () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "failed" });

      await expect(manager.spawnAgent("PE-1", defaultSpawnConfig)).rejects.toThrow(
        "Task PE-1 is terminal"
      );
    });

    it("throws for non-existent task", async () => {
      await expect(manager.spawnAgent("nonexistent", defaultSpawnConfig)).rejects.toThrow(
        "Task nonexistent not found"
      );
    });
  });

  describe("stopAgent", () => {
    let mockNs: ReturnType<typeof createMockTaskAgentNs>;

    beforeEach(() => {
      mockNs = createMockTaskAgentNs();
      manager = new TaskManager(sql, { TASK_AGENT: mockNs });
    });

    it("sets agent_active=0", async () => {
      manager.createTask(defaultParams);
      sql._tasks.get("PE-1")!.agent_active = 1;

      await manager.stopAgent("PE-1", "test stop");

      const task = manager.getTask("PE-1")!;
      expect(task.agent_active).toBe(0);
    });

    it("sends /mark-terminal to TaskAgent DO", async () => {
      manager.createTask(defaultParams);
      sql._tasks.get("PE-1")!.agent_active = 1;

      await manager.stopAgent("PE-1", "test stop");

      const calls = mockNs._agents.get("PE-1")!.fetchCalls;
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("http://internal/mark-terminal");
      expect(calls[0].method).toBe("POST");
    });

    it("is idempotent (calling twice doesn't throw)", async () => {
      manager.createTask(defaultParams);
      sql._tasks.get("PE-1")!.agent_active = 1;

      await manager.stopAgent("PE-1", "first");
      await manager.stopAgent("PE-1", "second"); // should not throw

      expect(manager.getTask("PE-1")!.agent_active).toBe(0);
    });
  });

  describe("sendEvent", () => {
    let mockNs: ReturnType<typeof createMockTaskAgentNs>;

    beforeEach(() => {
      mockNs = createMockTaskAgentNs();
      manager = new TaskManager(sql, { TASK_AGENT: mockNs }, { retryDelayMs: 0 });
    });

    it("sends event to running agent", async () => {
      manager.createTask(defaultParams);
      sql._tasks.get("PE-1")!.agent_active = 1;

      const event = { type: "test", payload: "data" };
      await manager.sendEvent("PE-1", event);

      const calls = mockNs._agents.get("PE-1")!.fetchCalls;
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("http://internal/event");
      expect(JSON.parse(calls[0].body!)).toEqual(event);
    });

    it("ignores terminal tasks", async () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "failed" });

      await manager.sendEvent("PE-1", { type: "test" });

      // No fetch calls should be made
      expect(mockNs._agents.has("PE-1")).toBe(false);
    });

    it("skips when no active agent (agent_active=0)", async () => {
      manager.createTask(defaultParams);

      await manager.sendEvent("PE-1", { type: "test" });

      expect(mockNs._agents.has("PE-1")).toBe(false);
    });

    it("throws for non-existent task", async () => {
      await expect(manager.sendEvent("nonexistent", {})).rejects.toThrow(
        "Task nonexistent not found"
      );
    });

    it("marks agent inactive (not terminal) after 3 consecutive 503s", async () => {
      manager.createTask(defaultParams);
      sql._tasks.get("PE-1")!.agent_active = 1;
      sql._tasks.get("PE-1")!.status = "active";
      mockNs.setResponse("PE-1", 503, "not ready");

      await manager.sendEvent("PE-1", { type: "test" });

      const task = manager.getTask("PE-1")!;
      // Should NOT be terminal — transient 503s leave task retryable
      expect(task.status).toBe("active");
      expect(task.agent_active).toBe(0);
    });

    it("throws immediately on 400 (4xx) without retry", async () => {
      manager.createTask(defaultParams);
      sql._tasks.get("PE-1")!.agent_active = 1;
      mockNs.setResponse("PE-1", 400, "bad request");

      await expect(manager.sendEvent("PE-1", {})).rejects.toThrow(
        "Event delivery failed: 400"
      );
    });

    it("retries 500 errors (not just 503) and marks inactive after exhaustion", async () => {
      manager.createTask(defaultParams);
      sql._tasks.get("PE-1")!.agent_active = 1;
      sql._tasks.get("PE-1")!.status = "active";
      mockNs.setResponse("PE-1", 500, "internal server error");

      await manager.sendEvent("PE-1", { type: "test" });

      const task = manager.getTask("PE-1")!;
      // Should retry and eventually mark inactive (same as 503 behavior)
      expect(task.status).toBe("active");
      expect(task.agent_active).toBe(0);

      // Should have made 3 attempts (retried, not thrown immediately)
      const calls = mockNs._agents.get("PE-1")!.fetchCalls;
      expect(calls.length).toBe(3);
    });

    it("retries 502 errors and marks inactive after exhaustion", async () => {
      manager.createTask(defaultParams);
      sql._tasks.get("PE-1")!.agent_active = 1;
      sql._tasks.get("PE-1")!.status = "active";
      mockNs.setResponse("PE-1", 502, "bad gateway");

      await manager.sendEvent("PE-1", { type: "test" });

      const task = manager.getTask("PE-1")!;
      expect(task.status).toBe("active");
      expect(task.agent_active).toBe(0);

      const calls = mockNs._agents.get("PE-1")!.fetchCalls;
      expect(calls.length).toBe(3);
    });

    it("throws immediately on 4xx errors without retry", async () => {
      manager.createTask(defaultParams);
      sql._tasks.get("PE-1")!.agent_active = 1;
      mockNs.setResponse("PE-1", 422, "unprocessable");

      await expect(manager.sendEvent("PE-1", {})).rejects.toThrow(
        "Event delivery failed: 422"
      );

      // Should NOT have retried — only 1 attempt
      const calls = mockNs._agents.get("PE-1")!.fetchCalls;
      expect(calls.length).toBe(1);
    });
  });

  describe("recordHeartbeat", () => {
    it("updates last_heartbeat for active tasks", () => {
      manager.createTask(defaultParams);
      sql._tasks.get("PE-1")!.agent_active = 1;

      manager.recordHeartbeat("PE-1");

      const task = manager.getTask("PE-1")!;
      expect(task.last_heartbeat).not.toBeNull();
    });

    it("does not update last_heartbeat for inactive tasks", () => {
      manager.createTask(defaultParams);
      // agent_active is 0 by default

      manager.recordHeartbeat("PE-1");

      const task = manager.getTask("PE-1")!;
      expect(task.last_heartbeat).toBeNull();
    });
  });

  describe("getActiveAgents", () => {
    it("returns only active tasks", () => {
      manager.createTask({ taskUUID: "PE-1", product: "test" });
      manager.createTask({ taskUUID: "PE-2", product: "test" });
      sql._tasks.get("PE-1")!.agent_active = 1;

      const active = manager.getActiveAgents();
      expect(active.length).toBe(1);
      expect(active[0].task_uuid).toBe("PE-1");
    });

    it("returns empty array when none active", () => {
      manager.createTask(defaultParams);

      const active = manager.getActiveAgents();
      expect(active).toEqual([]);
    });
  });

  describe("stopAllAgents", () => {
    let mockNs: ReturnType<typeof createMockTaskAgentNs>;

    beforeEach(() => {
      mockNs = createMockTaskAgentNs();
      manager = new TaskManager(sql, { TASK_AGENT: mockNs });
    });

    it("stops all active agents", async () => {
      manager.createTask({ taskUUID: "PE-1", product: "test" });
      manager.createTask({ taskUUID: "PE-2", product: "test" });
      sql._tasks.get("PE-1")!.agent_active = 1;
      sql._tasks.get("PE-2")!.agent_active = 1;

      await manager.stopAllAgents("shutdown");

      expect(manager.getTask("PE-1")!.agent_active).toBe(0);
      expect(manager.getTask("PE-2")!.agent_active).toBe(0);
    });
  });

  describe("cleanupInactive", () => {
    let mockNs: ReturnType<typeof createMockTaskAgentNs>;

    beforeEach(() => {
      mockNs = createMockTaskAgentNs();
      manager = new TaskManager(sql, { TASK_AGENT: mockNs });
    });

    it("stops agents that are terminal but still agent_active=1", async () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "failed" });
      // Simulate inconsistency: status is terminal but agent_active=1
      sql._tasks.get("PE-1")!.agent_active = 1;

      await manager.cleanupInactive();

      expect(manager.getTask("PE-1")!.agent_active).toBe(0);
    });

    it("does not stop non-terminal active agents", async () => {
      manager.createTask(defaultParams);
      sql._tasks.get("PE-1")!.agent_active = 1;
      // status is "created" — not terminal

      await manager.cleanupInactive();

      expect(manager.getTask("PE-1")!.agent_active).toBe(1);
    });
  });

  describe("deploy resilience", () => {
    let mockNs: ReturnType<typeof createMockTaskAgentNs>;

    it("fresh TaskManager instance sees pre-deploy tasks", () => {
      // Create task with first instance
      const sql1 = createMockSql();
      const mgr1 = new TaskManager(sql1, {});
      mgr1.createTask(defaultParams);
      mgr1.updateStatus("PE-1", { status: "reviewing" });

      // Simulate deploy: new instance, same SQL store
      const mgr2 = new TaskManager(sql1, {});
      const task = mgr2.getTask("PE-1");
      expect(task).not.toBeNull();
      expect(task!.status).toBe("reviewing");
    });

    it("spawnAgent is safe to re-call after deploy (new instance, same SQL)", async () => {
      mockNs = createMockTaskAgentNs();
      const sharedSql = createMockSql();

      // First instance spawns
      const mgr1 = new TaskManager(sharedSql, { TASK_AGENT: mockNs });
      mgr1.createTask(defaultParams);
      mgr1.updateStatus("PE-1", { status: "reviewing" });
      await mgr1.spawnAgent("PE-1", defaultSpawnConfig);

      // Simulate deploy: new TaskManager, task is in "spawning" with agent_active=1
      const mgr2 = new TaskManager(sharedSql, { TASK_AGENT: mockNs });
      await mgr2.spawnAgent("PE-1", defaultSpawnConfig); // re-spawn, should not throw

      expect(mgr2.getTask("PE-1")!.agent_active).toBe(1);
    });

    it("stopAgent is idempotent across instances", async () => {
      mockNs = createMockTaskAgentNs();
      const sharedSql = createMockSql();
      const mgr1 = new TaskManager(sharedSql, { TASK_AGENT: mockNs });
      mgr1.createTask(defaultParams);
      sharedSql._tasks.get("PE-1")!.agent_active = 1;

      await mgr1.stopAgent("PE-1", "first");

      const mgr2 = new TaskManager(sharedSql, { TASK_AGENT: mockNs });
      await mgr2.stopAgent("PE-1", "second"); // idempotent

      expect(mgr2.getTask("PE-1")!.agent_active).toBe(0);
    });
  });

  describe("reactivate", () => {
    it("sets agent_active=1 for non-terminal task", () => {
      manager.createTask(defaultParams);
      expect(manager.getTask("PE-1")!.agent_active).toBe(0);

      manager.reactivate("PE-1");
      expect(manager.getTask("PE-1")!.agent_active).toBe(1);
    });

    it("no-ops for terminal task", () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "failed" });

      manager.reactivate("PE-1");
      expect(manager.getTask("PE-1")!.agent_active).toBe(0);
    });
  });

  describe("reopenTask", () => {
    it("transitions terminal task to active with agent_active=1", async () => {
      manager.createTask(defaultParams);
      manager.updateStatus("PE-1", { status: "failed" });
      expect(manager.getTask("PE-1")!.status).toBe("failed");
      expect(manager.getTask("PE-1")!.agent_active).toBe(0);

      await manager.reopenTask("PE-1");
      const task = manager.getTask("PE-1")!;
      expect(task.status).toBe("active");
      expect(task.agent_active).toBe(1);
    });

    it("no-ops for non-terminal task", async () => {
      manager.createTask(defaultParams);
      await manager.reopenTask("PE-1");
      expect(manager.getTask("PE-1")!.status).toBe("created");
    });
  });

  describe("isTerminalStatus", () => {
    it("returns true for terminal statuses", () => {
      expect(manager.isTerminalStatus("merged")).toBe(true);
      expect(manager.isTerminalStatus("closed")).toBe(true);
      expect(manager.isTerminalStatus("deferred")).toBe(true);
      expect(manager.isTerminalStatus("failed")).toBe(true);
    });

    it("returns false for non-terminal statuses", () => {
      expect(manager.isTerminalStatus("created")).toBe(false);
      expect(manager.isTerminalStatus("active")).toBe(false);
      expect(manager.isTerminalStatus("pr_open")).toBe(false);
    });
  });
});
