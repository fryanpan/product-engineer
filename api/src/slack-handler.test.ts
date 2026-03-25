import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { handleSlackEvent, resolveProductFromChannel, type SlackHandlerDeps } from "./slack-handler";
import type { TaskRecord } from "./types";

// ---------------------------------------------------------------------------
// Module-level mocks — intercept imports the handler uses
// ---------------------------------------------------------------------------

// Mock normalizeSlackEvent to always pass (no injection)
mock.module("./security/normalized-event", () => ({
  normalizeSlackEvent: async () => ({ ok: true, event: {} }),
}));

// Mock addReaction to no-op (fire-and-forget)
mock.module("./slack-utils", () => ({
  addReaction: () => {},
}));

// Mock observability (status command)
mock.module("./observability", () => ({
  getSystemStatus: () => ({ activeTasks: 0, totalTasks: 0 }),
  formatStatusMessage: () => "Status: OK",
}));

// We need to intercept the db module functions that the handler imports.
// getSetting, getAllProductConfigs, ensureTaskMetrics, getGatewayConfig all use sql.exec internally,
// but are imported as standalone functions. We mock them so they use our test data.
let mockSettings: Map<string, string>;
let mockProducts: Record<string, { slack_channel_id?: string; slack_channel?: string; triggers?: Record<string, unknown> }>;

mock.module("./db", () => ({
  getSetting: (_sql: unknown, key: string) => mockSettings.get(key) || null,
  setSetting: (_sql: unknown, key: string, value: string) => { mockSettings.set(key, value); },
  getGatewayConfig: () => null,
  getAllProductConfigs: () => mockProducts,
  ensureTaskMetrics: () => {},
}));

// Mock global fetch for postSlackMessage calls (Slack API, LLM, Linear)
const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

// ---------------------------------------------------------------------------
// Mock SQL — handles SELECT queries the handler runs directly on sql.exec
// ---------------------------------------------------------------------------

interface MockTask {
  task_uuid: string;
  product: string;
  status: string;
  agent_active: number;
  slack_thread_ts: string | null;
  slack_channel: string | null;
  session_id: string | null;
  transcript_r2_key: string | null;
}

function createMockSql(tasks: MockTask[] = []) {
  const taskMap = new Map<string, MockTask>();
  for (const t of tasks) taskMap.set(t.task_uuid, t);

  return {
    exec(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim();

      // SELECT ... FROM tasks WHERE slack_thread_ts = ?
      if (trimmed.includes("FROM tasks") && trimmed.includes("slack_thread_ts =")) {
        const threadTs = params[0] as string;
        const matches = [...taskMap.values()].filter(t => t.slack_thread_ts === threadTs);
        return { toArray: () => matches.map(t => ({ ...t })) };
      }

      // SELECT session_id, transcript_r2_key FROM tasks WHERE task_uuid = ?
      if (trimmed.includes("session_id") && trimmed.includes("transcript_r2_key") && trimmed.includes("task_uuid =")) {
        const uuid = params[0] as string;
        const t = taskMap.get(uuid);
        if (t) return { toArray: () => [{ session_id: t.session_id, transcript_r2_key: t.transcript_r2_key }] };
        return { toArray: () => [] };
      }

      // SELECT key, value FROM settings
      if (trimmed.includes("FROM settings")) {
        return { toArray: () => [...mockSettings.entries()].map(([key, value]) => ({ key, value })) };
      }

      // INSERT INTO slack_thread_map ...
      if (trimmed.includes("INSERT INTO slack_thread_map")) {
        return { toArray: () => [] };
      }

      // INSERT INTO task_metrics ...
      if (trimmed.includes("INSERT INTO task_metrics")) {
        return { toArray: () => [] };
      }

      // Fallback
      return { toArray: () => [] };
    },
    _tasks: taskMap,
  };
}

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function createMockDeps(sqlOverride?: ReturnType<typeof createMockSql>): SlackHandlerDeps {
  const sql = sqlOverride || createMockSql();

  return {
    sql,
    env: { SLACK_BOT_TOKEN: "xoxb-test", ANTHROPIC_API_KEY: "test-key" },
    taskManager: {
      isTerminalStatus: (s: string) => ["merged", "closed", "deferred", "failed"].includes(s),
      reopenTask: mock(() => Promise.resolve()),
      reactivate: mock(() => {}),
      updateStatus: mock(() => ({ status: "active" }) as unknown as TaskRecord),
      sendEvent: mock(() => Promise.resolve()),
      createTask: mock(() => ({
        task_uuid: "new-task-uuid",
        product: "test-product",
        status: "created",
        agent_active: 0,
        slack_thread_ts: null,
        slack_channel: null,
      }) as unknown as TaskRecord),
    } as unknown as SlackHandlerDeps["taskManager"],
    routeToProjectLead: mock(() => Promise.resolve()),
    ensureConductor: mock(() => Promise.resolve({
      fetch: mock(() => Promise.resolve(new Response("ok"))),
    })) as unknown as SlackHandlerDeps["ensureConductor"],
    handleTaskReview: mock(() => Promise.resolve()),
    respawnSuspendedTask: mock(() => Promise.resolve()),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSettings = new Map();
  mockProducts = {};
  // Mock fetch to handle Slack API / LLM calls
  fetchMock = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ ok: true, ts: "1111.2222" }), { status: 200 })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

// Restore fetch after all tests
// (bun:test doesn't have afterAll in describe-less context but this is fine for test isolation)

describe("resolveProductFromChannel", () => {
  it("matches by slack_channel_id", () => {
    const products = { myapp: { slack_channel_id: "C100", repos: [] } };
    expect(resolveProductFromChannel(products as any, "C100")).toBe("myapp");
  });

  it("matches by slack_channel name", () => {
    const products = { myapp: { slack_channel: "general", repos: [] } };
    expect(resolveProductFromChannel(products as any, "general")).toBe("myapp");
  });

  it("returns null for unmapped channel", () => {
    const products = { myapp: { slack_channel_id: "C100", repos: [] } };
    expect(resolveProductFromChannel(products as any, "C999")).toBeNull();
  });
});

describe("handleSlackEvent — thread reply routing", () => {
  it("routes thread reply to active task via sendEvent", async () => {
    const sql = createMockSql([{
      task_uuid: "task-1",
      product: "myapp",
      status: "active",
      agent_active: 1,
      slack_thread_ts: "1000.0001",
      slack_channel: "C100",
      session_id: null,
      transcript_r2_key: null,
    }]);
    const deps = createMockDeps(sql);

    const res = await handleSlackEvent({
      type: "message",
      text: "please also fix the footer",
      user: "U123",
      channel: "C100",
      thread_ts: "1000.0001",
      ts: "1000.0099",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.taskUUID).toBe("task-1");

    // Should have called sendEvent (not respawn) since task is active with agent_active=1
    expect(deps.taskManager.sendEvent).toHaveBeenCalledTimes(1);
    expect(deps.respawnSuspendedTask).not.toHaveBeenCalled();

    // Should have called reactivate (non-terminal path)
    expect(deps.taskManager.reactivate).toHaveBeenCalledTimes(1);
  });

  it("reopens terminal task and respawns on thread reply", async () => {
    const sql = createMockSql([{
      task_uuid: "task-2",
      product: "myapp",
      status: "merged",
      agent_active: 0,
      slack_thread_ts: "2000.0001",
      slack_channel: "C100",
      session_id: "sess-abc",
      transcript_r2_key: "transcripts/task-2.json",
    }]);
    const deps = createMockDeps(sql);

    const res = await handleSlackEvent({
      type: "message",
      text: "actually one more thing",
      user: "U123",
      channel: "C100",
      thread_ts: "2000.0001",
      ts: "2000.0099",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.taskUUID).toBe("task-2");

    // Terminal task should be reopened
    expect(deps.taskManager.reopenTask).toHaveBeenCalledTimes(1);
    const reopenCall = (deps.taskManager.reopenTask as ReturnType<typeof mock>).mock.calls[0];
    expect(reopenCall[0]).toBe("task-2");

    // Should respawn (not sendEvent) since terminal → needs new container
    expect(deps.respawnSuspendedTask).toHaveBeenCalledTimes(1);
    expect(deps.taskManager.sendEvent).not.toHaveBeenCalled();

    // The event should include resume context
    const respawnCall = (deps.respawnSuspendedTask as ReturnType<typeof mock>).mock.calls[0];
    const event = respawnCall[2];
    expect(event.resumeSessionId).toBe("sess-abc");
    expect(event.resumeTranscriptR2Key).toBe("transcripts/task-2.json");
  });

  it("reactivates and respawns inactive task (agent_active=0, non-terminal)", async () => {
    const sql = createMockSql([{
      task_uuid: "task-3",
      product: "myapp",
      status: "active",
      agent_active: 0,
      slack_thread_ts: "3000.0001",
      slack_channel: "C100",
      session_id: null,
      transcript_r2_key: null,
    }]);
    const deps = createMockDeps(sql);

    const res = await handleSlackEvent({
      type: "message",
      text: "hey, any update?",
      user: "U123",
      channel: "C100",
      thread_ts: "3000.0001",
      ts: "3000.0099",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.taskUUID).toBe("task-3");

    // Not terminal, so reopenTask should NOT be called
    expect(deps.taskManager.reopenTask).not.toHaveBeenCalled();

    // Should call reactivate (non-terminal path)
    expect(deps.taskManager.reactivate).toHaveBeenCalledTimes(1);

    // agent_active=0 means needsRespawn, so respawnSuspendedTask should be called
    expect(deps.respawnSuspendedTask).toHaveBeenCalledTimes(1);
    expect(deps.taskManager.sendEvent).not.toHaveBeenCalled();
  });

  it("reactivates and respawns suspended task, transitioning to active", async () => {
    const sql = createMockSql([{
      task_uuid: "task-susp",
      product: "myapp",
      status: "suspended",
      agent_active: 0,
      slack_thread_ts: "4000.0001",
      slack_channel: "C100",
      session_id: "sess-xyz",
      transcript_r2_key: null,
    }]);
    const deps = createMockDeps(sql);

    const res = await handleSlackEvent({
      type: "message",
      text: "resume please",
      user: "U123",
      channel: "C100",
      thread_ts: "4000.0001",
      ts: "4000.0099",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);

    // Suspended → active transition should happen
    expect(deps.taskManager.updateStatus).toHaveBeenCalledTimes(1);
    const updateCall = (deps.taskManager.updateStatus as ReturnType<typeof mock>).mock.calls[0];
    expect(updateCall[0]).toBe("task-susp");
    expect(updateCall[1]).toEqual({ status: "active" });

    // Should reactivate and respawn
    expect(deps.taskManager.reactivate).toHaveBeenCalledTimes(1);
    expect(deps.respawnSuspendedTask).toHaveBeenCalledTimes(1);
  });

  it("ignores thread reply with no matching task (plain message)", async () => {
    const sql = createMockSql([]); // No tasks
    const deps = createMockDeps(sql);

    const res = await handleSlackEvent({
      type: "message",
      text: "replying to some random thread",
      user: "U123",
      channel: "C100",
      thread_ts: "9999.0001",
      ts: "9999.0099",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe("thread not tracked");

    // No task manager calls
    expect(deps.taskManager.sendEvent).not.toHaveBeenCalled();
    expect(deps.taskManager.reopenTask).not.toHaveBeenCalled();
  });
});

describe("handleSlackEvent — product channel routing (no Linear)", () => {
  beforeEach(() => {
    // Set up a product without Linear triggers
    mockProducts = {
      myapp: {
        slack_channel_id: "C100",
        triggers: {},
      },
    };
  });

  it("creates task and routes to handleTaskReview for new top-level message", async () => {
    const sql = createMockSql();
    const deps = createMockDeps(sql);

    // Mock generateTaskSummary via fetch (LLM call)
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ title: "Fix nav bug", description: "Fix it", taskId: "fix-nav-bug" }) }],
      }), { status: 200 })),
    ) as unknown as typeof fetch;

    const res = await handleSlackEvent({
      type: "message",
      text: "fix the navigation bug",
      user: "U123",
      channel: "C100",
      ts: "5000.0001",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.product).toBe("myapp");
    expect(body.taskUUID).toBeDefined();

    // Should create a task
    expect(deps.taskManager.createTask).toHaveBeenCalledTimes(1);

    // Should route to handleTaskReview
    expect(deps.handleTaskReview).toHaveBeenCalledTimes(1);
  });

  it("@mention in product channel treated same as plain message", async () => {
    const sql = createMockSql();
    const deps = createMockDeps(sql);

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ title: "Add dark mode", description: "Add it", taskId: "add-dark-mode" }) }],
      }), { status: 200 })),
    ) as unknown as typeof fetch;

    const res = await handleSlackEvent({
      type: "app_mention",
      text: "<@U999BOT> add dark mode",
      user: "U123",
      channel: "C100",
      ts: "5000.0002",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.product).toBe("myapp");

    // Same path: createTask + handleTaskReview
    expect(deps.taskManager.createTask).toHaveBeenCalledTimes(1);
    expect(deps.handleTaskReview).toHaveBeenCalledTimes(1);
  });

  it("stores user's original ts as slack_thread_ts (top-level message)", async () => {
    const sql = createMockSql();
    const deps = createMockDeps(sql);

    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify({ title: "Test", description: "Test", taskId: "test" }) }],
      }), { status: 200 })),
    ) as unknown as typeof fetch;

    await handleSlackEvent({
      type: "message",
      text: "do the thing",
      user: "U123",
      channel: "C100",
      ts: "6000.0001",
      // No thread_ts — this is a top-level message
    }, deps);

    // Check createTask was called with user's ts as slackThreadTs
    const createCall = (deps.taskManager.createTask as ReturnType<typeof mock>).mock.calls[0];
    expect(createCall[0].slackThreadTs).toBe("6000.0001");
    expect(createCall[0].slackChannel).toBe("C100");
  });
});

describe("handleSlackEvent — unmapped channel", () => {
  beforeEach(() => {
    mockProducts = {}; // No products configured
  });

  it("returns ignored response for unmapped channel", async () => {
    const sql = createMockSql();
    const deps = createMockDeps(sql);

    const res = await handleSlackEvent({
      type: "message",
      text: "hello",
      user: "U123",
      channel: "C999",
      ts: "7000.0001",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe("unmapped_channel");
  });

  it("replies with info message for @mention in unmapped channel", async () => {
    const sql = createMockSql();
    const deps = createMockDeps(sql);

    // Track fetch calls to verify Slack postMessage
    const fetchCalls: string[] = [];
    globalThis.fetch = mock((url: string) => {
      fetchCalls.push(url);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, ts: "reply-ts" }), { status: 200 }));
    }) as unknown as typeof fetch;

    const res = await handleSlackEvent({
      type: "app_mention",
      text: "<@U999BOT> help me",
      user: "U123",
      channel: "C999",
      ts: "7000.0002",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ignored).toBe(true);
    expect(body.reason).toBe("unmapped_channel");

    // Should have posted a Slack message
    expect(fetchCalls.some(url => url.includes("chat.postMessage"))).toBe(true);
  });
});

describe("handleSlackEvent — conductor channel routing", () => {
  it("routes message in conductor channel to conductor stub", async () => {
    mockSettings.set("conductor_channel", "C-CONDUCTOR");
    mockProducts = {}; // No product mapping needed

    const mockStubFetch = mock(() => Promise.resolve(new Response("ok")));
    const sql = createMockSql();
    const deps = createMockDeps(sql);
    deps.ensureConductor = mock(() =>
      Promise.resolve({ fetch: mockStubFetch } as unknown as DurableObjectStub),
    ) as unknown as SlackHandlerDeps["ensureConductor"];

    const res = await handleSlackEvent({
      type: "app_mention",
      text: "<@U999BOT> status report",
      user: "U123",
      channel: "C-CONDUCTOR",
      ts: "8000.0001",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.routed).toBe("conductor");

    // Should have called the conductor stub
    expect(mockStubFetch).toHaveBeenCalledTimes(1);

    // Should NOT create a task or route to project lead
    expect(deps.taskManager.createTask).not.toHaveBeenCalled();
    expect(deps.handleTaskReview).not.toHaveBeenCalled();
  });
});

describe("handleSlackEvent — status command", () => {
  it("handles /agent-status slash command", async () => {
    const sql = createMockSql();
    const deps = createMockDeps(sql);

    const res = await handleSlackEvent({
      type: "app_mention",
      text: "/agent-status",
      user: "U123",
      channel: "C100",
      ts: "9000.0001",
      slash_command: "agent-status",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.handled).toBe("status_command");

    // Should NOT create tasks or route events
    expect(deps.taskManager.createTask).not.toHaveBeenCalled();
  });

  it("handles /agent-status as text in @mention", async () => {
    const sql = createMockSql();
    const deps = createMockDeps(sql);

    const res = await handleSlackEvent({
      type: "app_mention",
      text: "<@U999BOT> /agent-status",
      user: "U123",
      channel: "C100",
      ts: "9000.0002",
    }, deps);

    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.handled).toBe("status_command");
  });
});

describe("handleSlackEvent — terminal states enumeration", () => {
  for (const terminalStatus of ["merged", "closed", "deferred", "failed"]) {
    it(`reopens ${terminalStatus} task on thread reply`, async () => {
      const sql = createMockSql([{
        task_uuid: `task-${terminalStatus}`,
        product: "myapp",
        status: terminalStatus,
        agent_active: 0,
        slack_thread_ts: "term.0001",
        slack_channel: "C100",
        session_id: null,
        transcript_r2_key: null,
      }]);
      const deps = createMockDeps(sql);

      const res = await handleSlackEvent({
        type: "message",
        text: "need more work",
        user: "U123",
        channel: "C100",
        thread_ts: "term.0001",
        ts: "term.0099",
      }, deps);

      const body = await res.json() as Record<string, unknown>;
      expect(body.ok).toBe(true);

      expect(deps.taskManager.reopenTask).toHaveBeenCalledTimes(1);
      expect(deps.respawnSuspendedTask).toHaveBeenCalledTimes(1);
      // Should NOT call reactivate (terminal path uses reopenTask instead)
      expect(deps.taskManager.reactivate).not.toHaveBeenCalled();
    });
  }
});
