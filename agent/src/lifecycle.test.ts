import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { AgentLifecycle, type LifecycleCallbacks, type SessionState } from "./lifecycle";
import type { AgentConfig } from "./config";
import type { RoleConfig } from "./role-config";
import type { TranscriptManager } from "./transcripts";
import type { TokenTracker, ReportOptions } from "./token-tracker";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    taskUUID: "test-uuid",
    product: "test-product",
    repos: ["org/repo"],
    anthropicApiKey: "sk-test",
    githubToken: "ghp-test",
    slackBotToken: "xoxb-test",
    slackChannel: "#test",
    slackThreadTs: "1234.5678",
    linearAppToken: "",
    workerUrl: "https://worker.test",
    apiKey: "test-api-key",
    ...overrides,
  };
}

function makeTicketAgentRole(): RoleConfig {
  return {
    role: "ticket-agent",
    isProjectLead: false,
    isConductor: false,
    maxTurns: 200,
    sessionTimeoutMs: 2 * 60 * 60 * 1000,
    idleTimeoutMs: 5 * 60 * 1000,
    persistAfterSession: false,
    exitOnError: true,
    peRepoRequired: false,
    peRepo: "fryanpan/product-engineer",
  };
}

function makeProjectLeadRole(): RoleConfig {
  return {
    role: "project-lead",
    isProjectLead: true,
    isConductor: false,
    maxTurns: 1000,
    sessionTimeoutMs: Infinity,
    idleTimeoutMs: Infinity,
    persistAfterSession: true,
    exitOnError: false,
    peRepoRequired: true,
    peRepo: "fryanpan/product-engineer",
  };
}

function makeTranscriptMgr(associatedTaskUUID?: string): TranscriptManager {
  return {
    upload: mock(() => Promise.resolve()),
    getTranscriptDir: () => "/tmp/transcripts",
    findAllTranscripts: mock(() => Promise.resolve([])),
    getUploadedSizes: () => new Map(),
    getAssociatedTaskUUID: () => associatedTaskUUID,
  } as unknown as TranscriptManager;
}

function makeTokenTracker(): TokenTracker & { reportCalls: ReportOptions[] } {
  const reportCalls: ReportOptions[] = [];
  return {
    reportCalls,
    reset: mock(() => {}),
    report: mock((opts: ReportOptions) => {
      reportCalls.push(opts);
      return Promise.resolve();
    }),
    getSummary: () => ({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCostUsd: 0,
      turns: 0,
      turnLog: [],
    }),
  } as unknown as TokenTracker & { reportCalls: ReportOptions[] };
}

function createLifecycle(overrides?: {
  config?: Partial<AgentConfig>;
  roleConfig?: RoleConfig;
  transcriptMgr?: TranscriptManager;
  tokenTracker?: ReturnType<typeof makeTokenTracker>;
  callbacks?: LifecycleCallbacks;
}) {
  const config = makeConfig(overrides?.config);
  const roleConfig = overrides?.roleConfig ?? makeTicketAgentRole();
  const transcriptMgr = overrides?.transcriptMgr ?? makeTranscriptMgr();
  const tokenTracker = overrides?.tokenTracker ?? makeTokenTracker();
  const callbacks = overrides?.callbacks ?? { onExit: mock(() => {}) };

  const lifecycle = new AgentLifecycle({
    config,
    roleConfig,
    transcriptMgr,
    tokenTracker,
    callbacks,
  });

  return { lifecycle, config, roleConfig, transcriptMgr, tokenTracker, callbacks };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("AgentLifecycle", () => {
  // Capture and restore global fetch
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init! });
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("initial state", () => {
    test("creates with default idle state", () => {
      const { lifecycle } = createLifecycle();
      const s = lifecycle.state;

      expect(s.sessionActive).toBe(false);
      expect(s.sessionStatus as string).toBe("idle");
      expect(s.sessionMessageCount).toBe(0);
      expect(s.sessionStartTime).toBe(0);
      expect(s.lastMessageTime).toBe(0);
      expect(s.sessionError).toBe("");
      expect(s.lastStderr).toBe("");
      expect(s.lastToolCall).toBe("");
      expect(s.lastAssistantText).toBe("");
      expect(s.lastUserPrompt).toBe("");
      expect(s.currentSessionId).toBe("");
    });
  });

  describe("resetSession", () => {
    test("resets all session fields to defaults", () => {
      const { lifecycle, tokenTracker } = createLifecycle();

      // Simulate an active session with state
      lifecycle.state.sessionActive = true;
      lifecycle.state.sessionStatus = "running";
      lifecycle.state.sessionMessageCount = 42;
      lifecycle.state.sessionStartTime = Date.now();
      lifecycle.state.lastMessageTime = Date.now();
      lifecycle.state.sessionError = "some error";
      lifecycle.state.lastStderr = "stderr output";
      lifecycle.state.lastToolCall = "Read";
      lifecycle.state.lastAssistantText = "Hello";
      lifecycle.state.lastUserPrompt = "Fix the bug";

      lifecycle.resetSession();

      expect(lifecycle.state.sessionActive).toBe(false);
      expect(lifecycle.state.sessionStatus as string).toBe("idle");
      expect(lifecycle.state.sessionMessageCount).toBe(0);
      expect(lifecycle.state.sessionStartTime).toBe(0);
      expect(lifecycle.state.sessionError).toBe("");
      expect(lifecycle.state.lastStderr).toBe("");
      expect(lifecycle.state.lastToolCall).toBe("");
      expect(lifecycle.state.lastAssistantText).toBe("");
      expect(lifecycle.state.lastUserPrompt).toBe("");
    });

    test("calls tokenTracker.reset()", () => {
      const { lifecycle, tokenTracker } = createLifecycle();
      lifecycle.resetSession();
      expect(tokenTracker.reset).toHaveBeenCalledTimes(1);
    });

    test("does not reset currentSessionId", () => {
      const { lifecycle } = createLifecycle();
      lifecycle.state.currentSessionId = "session-123";
      lifecycle.resetSession();
      // currentSessionId is not reset — it's set when a new session starts
      expect(lifecycle.state.currentSessionId).toBe("session-123");
    });
  });

  describe("phoneHome", () => {
    test("sends POST to orchestrator heartbeat endpoint", () => {
      const { lifecycle } = createLifecycle({
        config: { workerUrl: "https://test.worker", apiKey: "key123", taskUUID: "uuid-abc" },
      });

      lifecycle.phoneHome("test_message");

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toBe("https://test.worker/api/conductor/heartbeat");
      expect(fetchCalls[0].init.method).toBe("POST");

      const headers = fetchCalls[0].init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Internal-Key"]).toBe("key123");

      const body = JSON.parse(fetchCalls[0].init.body as string);
      expect(body.taskUUID).toBe("uuid-abc");
      expect(body.message).toBe("test_message");
    });

    test("does not throw when fetch fails", () => {
      globalThis.fetch = mock(() => Promise.reject(new Error("network error"))) as unknown as typeof fetch;
      const { lifecycle } = createLifecycle();

      // Should not throw
      expect(() => lifecycle.phoneHome("test")).not.toThrow();
    });
  });

  describe("recordActivity", () => {
    test("updates lastMessageTime to current time", () => {
      const { lifecycle } = createLifecycle();
      const before = Date.now();
      lifecycle.recordActivity();
      const after = Date.now();

      expect(lifecycle.state.lastMessageTime).toBeGreaterThanOrEqual(before);
      expect(lifecycle.state.lastMessageTime).toBeLessThanOrEqual(after);
    });
  });

  describe("startTimers / stopTimers", () => {
    test("stopTimers clears all intervals without error", () => {
      const { lifecycle } = createLifecycle();
      // Should work even if timers were never started
      expect(() => lifecycle.stopTimers()).not.toThrow();
    });

    test("stopTimers after startTimers clears intervals", () => {
      const { lifecycle } = createLifecycle();
      lifecycle.startTimers();
      // Timers are running — stop them
      lifecycle.stopTimers();
      // Calling stopTimers again is safe (idempotent)
      expect(() => lifecycle.stopTimers()).not.toThrow();
    });
  });

  describe("handleSessionEnd", () => {
    test("ticket agent: reports tokens and auto-suspends with code 0", async () => {
      const { lifecycle, tokenTracker, callbacks } = createLifecycle();

      lifecycle.state.sessionActive = true;
      lifecycle.state.sessionStatus = "running";
      lifecycle.state.sessionMessageCount = 15;

      await lifecycle.handleSessionEnd();
      // autoSuspend runs asynchronously — wait for it to complete
      await new Promise((r) => setTimeout(r, 10));

      // State updated
      expect(lifecycle.state.sessionStatus as string).toBe("completed");
      expect(lifecycle.state.sessionActive).toBe(false);

      // Token report called once (in autoSuspend only — handleSessionEnd delegates to it)
      expect(tokenTracker.report).toHaveBeenCalledTimes(1);
      expect(tokenTracker.reportCalls[0].taskUUID).toBe("test-uuid");
      expect(tokenTracker.reportCalls[0].sessionMessageCount).toBe(15);

      // Exit callback was called with 0 (from autoSuspend)
      expect(callbacks.onExit).toHaveBeenCalledTimes(1);
      expect(callbacks.onExit).toHaveBeenCalledWith(0);
    });

    test("project lead: uploads transcript and reports session_id before resetting", async () => {
      const transcriptMgr = makeTranscriptMgr();
      const { lifecycle, tokenTracker, callbacks, config } = createLifecycle({
        roleConfig: makeProjectLeadRole(),
        transcriptMgr,
      });

      lifecycle.state.sessionActive = true;
      lifecycle.state.sessionStatus = "running";
      lifecycle.state.sessionMessageCount = 5;
      lifecycle.state.currentSessionId = "sess-abc-123";

      await lifecycle.handleSessionEnd();

      // Transcript uploaded with force=true
      expect(transcriptMgr.upload).toHaveBeenCalledWith(true);

      // session_id POSTed to orchestrator
      const statusCalls = fetchCalls.filter((c) => c.url.includes("/api/internal/status"));
      expect(statusCalls.length).toBe(1);
      const statusBody = JSON.parse(statusCalls[0].init.body as string);
      expect(statusBody.taskUUID).toBe("test-uuid");
      expect(statusBody.session_id).toBe("sess-abc-123");
      expect(statusCalls[0].init.method).toBe("POST");
      const statusHeaders = statusCalls[0].init.headers as Record<string, string>;
      expect(statusHeaders["X-Internal-Key"]).toBe("test-api-key");

      // Token report still called
      expect(tokenTracker.report).toHaveBeenCalledTimes(1);

      // Session was reset, onExit NOT called
      expect(lifecycle.state.sessionStatus as string).toBe("idle");
      expect(lifecycle.state.sessionActive).toBe(false);
      expect(callbacks.onExit).not.toHaveBeenCalled();
    });

    test("project lead: reports session_id to both container and associated task", async () => {
      const transcriptMgr = makeTranscriptMgr("conductor-task-12345");
      const { lifecycle, callbacks } = createLifecycle({
        roleConfig: makeProjectLeadRole(),
        transcriptMgr,
      });

      lifecycle.state.sessionActive = true;
      lifecycle.state.sessionStatus = "running";
      lifecycle.state.currentSessionId = "sess-xyz-789";

      await lifecycle.handleSessionEnd();

      // session_id POSTed to BOTH container UUID and associated child task UUID
      const statusCalls = fetchCalls.filter((c) => c.url.includes("/api/internal/status"));
      expect(statusCalls.length).toBe(2);

      const uuids = statusCalls.map((c) => JSON.parse(c.init.body as string).taskUUID);
      expect(uuids).toContain("test-uuid"); // container UUID
      expect(uuids).toContain("conductor-task-12345"); // associated child task

      // Both have the same session_id
      for (const call of statusCalls) {
        expect(JSON.parse(call.init.body as string).session_id).toBe("sess-xyz-789");
      }

      expect(callbacks.onExit).not.toHaveBeenCalled();
    });

    test("project lead: skips session_id POST when currentSessionId is empty", async () => {
      const transcriptMgr = makeTranscriptMgr();
      const { lifecycle, callbacks } = createLifecycle({
        roleConfig: makeProjectLeadRole(),
        transcriptMgr,
      });

      lifecycle.state.sessionActive = true;
      lifecycle.state.sessionStatus = "running";
      lifecycle.state.currentSessionId = ""; // empty — no session_id to report

      await lifecycle.handleSessionEnd();

      // Transcript still uploaded
      expect(transcriptMgr.upload).toHaveBeenCalledWith(true);

      // No status call made (no session_id to report)
      const statusCalls = fetchCalls.filter((c) => c.url.includes("/api/internal/status"));
      expect(statusCalls.length).toBe(0);

      // onExit NOT called
      expect(callbacks.onExit).not.toHaveBeenCalled();
    });

    test("project lead: resets session state instead of exiting", async () => {
      const transcriptMgr = makeTranscriptMgr();
      const { lifecycle, tokenTracker, callbacks } = createLifecycle({
        roleConfig: makeProjectLeadRole(),
        transcriptMgr,
      });

      lifecycle.state.sessionActive = true;
      lifecycle.state.sessionStatus = "running";
      lifecycle.state.sessionMessageCount = 10;
      lifecycle.state.lastToolCall = "Bash";
      lifecycle.state.lastStderr = "warning";

      await lifecycle.handleSessionEnd();

      // Token report was called
      expect(tokenTracker.report).toHaveBeenCalledTimes(1);

      // Session was reset (not exited)
      expect(lifecycle.state.sessionStatus as string).toBe("idle");
      expect(lifecycle.state.sessionActive).toBe(false);
      expect(lifecycle.state.sessionMessageCount).toBe(0);
      expect(lifecycle.state.lastToolCall).toBe("");
      expect(lifecycle.state.lastStderr).toBe("");

      // tokenTracker.reset was called (via resetSession)
      expect(tokenTracker.reset).toHaveBeenCalled();

      // onExit was NOT called
      expect(callbacks.onExit).not.toHaveBeenCalled();
    });

    test("sends phone-home with session_completed", async () => {
      const { lifecycle } = createLifecycle();
      lifecycle.state.sessionMessageCount = 7;

      await lifecycle.handleSessionEnd();

      // phoneHome call is the second fetch (first may be the heartbeat endpoint)
      const phoneHomeCalls = fetchCalls.filter((c) =>
        c.url.includes("/heartbeat") && c.init.body?.toString().includes("session_completed"),
      );
      expect(phoneHomeCalls.length).toBe(1);
      const body = JSON.parse(phoneHomeCalls[0].init.body as string);
      expect(body.message).toContain("session_completed");
      expect(body.message).toContain("msgs=7");
    });
  });

  describe("handleSessionError", () => {
    test("ticket agent: uploads transcript, reports error, exits with code 1", async () => {
      const transcriptMgr = makeTranscriptMgr();
      const { lifecycle, callbacks } = createLifecycle({ transcriptMgr });

      lifecycle.state.sessionActive = true;
      lifecycle.state.sessionStatus = "running";
      lifecycle.state.lastStderr = "some stderr";

      const error = new Error("SDK crashed");
      await lifecycle.handleSessionError(error);

      // State updated
      expect(lifecycle.state.sessionStatus as string).toBe("error");
      expect(lifecycle.state.sessionActive).toBe(false);
      expect(lifecycle.state.sessionError).toBe("Error: SDK crashed");

      // Transcript uploaded with force=true
      expect(transcriptMgr.upload).toHaveBeenCalledWith(true);

      // Exit callback was called with 1
      expect(callbacks.onExit).toHaveBeenCalledTimes(1);
      expect(callbacks.onExit).toHaveBeenCalledWith(1);
    });

    test("project lead: resets session state instead of exiting", async () => {
      const { lifecycle, tokenTracker, callbacks } = createLifecycle({
        roleConfig: makeProjectLeadRole(),
      });

      lifecycle.state.sessionActive = true;
      lifecycle.state.sessionStatus = "running";
      lifecycle.state.lastToolCall = "Edit";

      const error = new Error("something broke");
      await lifecycle.handleSessionError(error);

      // Session was reset
      expect(lifecycle.state.sessionStatus as string).toBe("idle");
      expect(lifecycle.state.sessionActive).toBe(false);
      expect(lifecycle.state.sessionMessageCount).toBe(0);
      expect(lifecycle.state.lastToolCall).toBe("");

      // tokenTracker.reset was called
      expect(tokenTracker.reset).toHaveBeenCalled();

      // onExit was NOT called
      expect(callbacks.onExit).not.toHaveBeenCalled();
    });

    test("sends phone-home with truncated error and stderr", async () => {
      const { lifecycle } = createLifecycle();
      lifecycle.state.lastStderr = "x".repeat(200);

      const error = new Error("a".repeat(300));
      await lifecycle.handleSessionError(error);

      const phoneHomeCalls = fetchCalls.filter((c) =>
        c.url.includes("/heartbeat") && c.init.body?.toString().includes("session_error"),
      );
      expect(phoneHomeCalls.length).toBe(1);
      const body = JSON.parse(phoneHomeCalls[0].init.body as string);
      // Error is truncated to 150 chars, stderr to 100
      expect(body.message.length).toBeLessThan(400);
    });

    test("continues even if transcript upload fails", async () => {
      const transcriptMgr = makeTranscriptMgr();
      (transcriptMgr.upload as ReturnType<typeof mock>).mockImplementation(() =>
        Promise.reject(new Error("upload failed")),
      );

      const { lifecycle, callbacks } = createLifecycle({ transcriptMgr });
      lifecycle.state.sessionActive = true;

      const error = new Error("crash");
      await lifecycle.handleSessionError(error);

      // Should still exit despite upload failure
      expect(callbacks.onExit).toHaveBeenCalledWith(1);
    });
  });
});
