import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { TokenTracker, type TurnUsage } from "./token-tracker";

describe("TokenTracker", () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = new TokenTracker();
  });

  describe("recordTurn", () => {
    test("tracks a single turn with correct cost calculation", () => {
      tracker.recordTurn({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheCreationTokens: 100,
        promptSnippet: "Hello",
        outputSnippet: "Hi there",
      });

      const summary = tracker.getSummary();
      expect(summary.totalInputTokens).toBe(1000);
      expect(summary.totalOutputTokens).toBe(500);
      expect(summary.totalCacheReadTokens).toBe(2000);
      expect(summary.totalCacheCreationTokens).toBe(100);
      expect(summary.turns).toBe(1);

      // Cost: (1000*3 + 500*15 + 2000*0.3 + 100*3) / 1_000_000
      // = (3000 + 7500 + 600 + 300) / 1_000_000
      // = 11400 / 1_000_000 = 0.0114
      expect(summary.totalCostUsd).toBeCloseTo(0.0114, 6);
    });

    test("accumulates totals across multiple turns", () => {
      tracker.recordTurn({
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });
      tracker.recordTurn({
        inputTokens: 500,
        outputTokens: 300,
        cacheReadTokens: 1000,
        cacheCreationTokens: 0,
      });

      const summary = tracker.getSummary();
      expect(summary.totalInputTokens).toBe(1500);
      expect(summary.totalOutputTokens).toBe(500);
      expect(summary.totalCacheReadTokens).toBe(1000);
      expect(summary.totalCacheCreationTokens).toBe(0);
      expect(summary.turns).toBe(2);
    });

    test("assigns incrementing turn numbers", () => {
      tracker.recordTurn({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });
      tracker.recordTurn({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 });
      tracker.recordTurn({ inputTokens: 300, outputTokens: 150, cacheReadTokens: 0, cacheCreationTokens: 0 });

      const summary = tracker.getSummary();
      expect(summary.turnLog[0].turn).toBe(1);
      expect(summary.turnLog[1].turn).toBe(2);
      expect(summary.turnLog[2].turn).toBe(3);
    });

    test("stores prompt and output snippets", () => {
      tracker.recordTurn({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptSnippet: "What is 2+2?",
        outputSnippet: "The answer is 4.",
      });

      const summary = tracker.getSummary();
      expect(summary.turnLog[0].promptSnippet).toBe("What is 2+2?");
      expect(summary.turnLog[0].outputSnippet).toBe("The answer is 4.");
    });

    test("stores model from first turn", () => {
      tracker.recordTurn({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        model: "sonnet",
      });
      tracker.recordTurn({
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        model: "opus",
      });

      const summary = tracker.getSummary();
      expect(summary.model).toBe("sonnet");
      expect(summary.turnLog[0].model).toBe("sonnet");
      expect(summary.turnLog[1].model).toBe("opus");
    });
  });

  describe("overrideCost", () => {
    test("replaces calculated cost with SDK-provided cost", () => {
      tracker.recordTurn({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });
      const beforeCost = tracker.getSummary().totalCostUsd;
      expect(beforeCost).toBeGreaterThan(0);

      tracker.overrideCost(1.23);
      expect(tracker.getSummary().totalCostUsd).toBe(1.23);
    });

    test("Slack summary shows override warning and explanatory note when cost is overridden", () => {
      tracker.recordTurn({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });
      tracker.overrideCost(1.23);

      const msg = tracker.formatSlackSummary();
      expect(msg).toContain("Total Cost:** $1.23");
      expect(msg).toContain("(SDK-reported)");
      expect(msg).toContain("est.");
      expect(msg).toContain("Note: Total cost from Agent SDK may differ");
    });

    test("Slack summary omits override labels when cost is not overridden", () => {
      tracker.recordTurn({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });

      const msg = tracker.formatSlackSummary();
      expect(msg).not.toContain("(SDK-reported)");
      expect(msg).not.toContain("est.");
      expect(msg).not.toContain("Note: Total cost from Agent SDK may differ");
    });
  });

  describe("reset", () => {
    test("clears all state", () => {
      tracker.recordTurn({ inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 1000, cacheCreationTokens: 500 });
      expect(tracker.getSummary().turns).toBe(1);

      tracker.reset();
      const summary = tracker.getSummary();
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.totalCacheReadTokens).toBe(0);
      expect(summary.totalCacheCreationTokens).toBe(0);
      expect(summary.totalCostUsd).toBe(0);
      expect(summary.turns).toBe(0);
      expect(summary.turnLog).toHaveLength(0);
    });

    test("turn numbers restart after reset", () => {
      tracker.recordTurn({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });
      tracker.recordTurn({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });
      tracker.reset();
      tracker.recordTurn({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });

      expect(tracker.getSummary().turnLog[0].turn).toBe(1);
    });
  });

  describe("formatSlackSummary", () => {
    test("includes cost, token counts, and turn count", () => {
      tracker.recordTurn({ inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 0, cacheCreationTokens: 0 });

      const msg = tracker.formatSlackSummary();
      expect(msg).toContain("Token Usage Summary");
      expect(msg).toContain("Total Cost:");
      expect(msg).toContain("Input:");
      expect(msg).toContain("Output:");
      expect(msg).toContain("Conversation Turns:** 1");
    });

    test("includes model when provided", () => {
      tracker.recordTurn({ inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 0, cacheCreationTokens: 0, model: "sonnet" });

      const msg = tracker.formatSlackSummary();
      expect(msg).toContain("Model:** sonnet");
    });

    test("omits model when not provided", () => {
      tracker.recordTurn({ inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 0, cacheCreationTokens: 0 });

      const msg = tracker.formatSlackSummary();
      expect(msg).not.toContain("Model:");
    });

    test("omits cache sections when zero", () => {
      tracker.recordTurn({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });

      const msg = tracker.formatSlackSummary();
      expect(msg).not.toContain("Cache Read:");
      expect(msg).not.toContain("Cache Creation:");
    });

    test("includes cache sections when nonzero", () => {
      tracker.recordTurn({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 5000, cacheCreationTokens: 1000 });

      const msg = tracker.formatSlackSummary();
      expect(msg).toContain("Cache Read:");
      expect(msg).toContain("Cache Creation:");
    });

    test("shows top 3 most expensive turns", () => {
      // Create 5 turns with different costs
      tracker.recordTurn({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });
      tracker.recordTurn({ inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 0, cacheCreationTokens: 0 }); // expensive
      tracker.recordTurn({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 });
      tracker.recordTurn({ inputTokens: 50000, outputTokens: 20000, cacheReadTokens: 0, cacheCreationTokens: 0 }); // most expensive
      tracker.recordTurn({ inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 0, cacheCreationTokens: 0 }); // 3rd

      const msg = tracker.formatSlackSummary();
      expect(msg).toContain("Most Expensive Turns:");
      // Turn 4 (most expensive) should appear before turn 2
      const turn4Idx = msg.indexOf("Turn 4:");
      const turn2Idx = msg.indexOf("Turn 2:");
      const turn5Idx = msg.indexOf("Turn 5:");
      expect(turn4Idx).toBeLessThan(turn2Idx);
      expect(turn2Idx).toBeLessThan(turn5Idx);
      // Turns 1 and 3 should not appear
      expect(msg).not.toContain("Turn 1:");
      expect(msg).not.toContain("Turn 3:");
    });

    test("includes prompt/output snippets with ellipsis for long text", () => {
      const longPrompt = "A".repeat(100);
      const shortOutput = "short";
      tracker.recordTurn({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        promptSnippet: longPrompt,
        outputSnippet: shortOutput,
      });

      const msg = tracker.formatSlackSummary();
      expect(msg).toContain(`Prompt: "${longPrompt}..."`);
      expect(msg).toContain(`Output: "${shortOutput}"`);
      expect(msg).not.toContain(`Output: "${shortOutput}..."`);
    });
  });

  describe("report", () => {
    let fetchCalls: Array<{ url: string; options: any }>;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      fetchCalls = [];
      globalThis.fetch = mock(async (url: string | URL | Request, options?: any) => {
        fetchCalls.push({ url: url.toString(), options });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as any;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test("posts usage to orchestrator API and Slack", async () => {
      tracker.recordTurn({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });

      await tracker.report({
        taskUUID: "ticket-123",
        workerUrl: "https://worker.example.com",
        apiKey: "api-key",
        slackBotToken: "xoxb-test",
        slackChannel: "#test",
      });

      // Should make 2 fetch calls: API + Slack
      expect(fetchCalls).toHaveLength(2);

      // API call
      expect(fetchCalls[0].url).toBe("https://worker.example.com/api/internal/token-usage");
      const apiBody = JSON.parse(fetchCalls[0].options.body);
      expect(apiBody.taskUUID).toBe("ticket-123");
      expect(apiBody.totalInputTokens).toBe(1000);
      expect(apiBody.totalOutputTokens).toBe(500);

      // Slack call
      expect(fetchCalls[1].url).toBe("https://slack.com/api/chat.postMessage");
      const slackBody = JSON.parse(fetchCalls[1].options.body);
      expect(slackBody.channel).toBe("#test");
      expect(slackBody.text).toContain("Token Usage Summary");
    });

    test("includes thread_ts when provided", async () => {
      tracker.recordTurn({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });

      await tracker.report({
        taskUUID: "ticket-123",
        workerUrl: "https://worker.example.com",
        apiKey: "api-key",
        slackBotToken: "xoxb-test",
        slackChannel: "#test",
        slackThreadTs: "1234567890.123456",
      });

      const slackBody = JSON.parse(fetchCalls[1].options.body);
      expect(slackBody.thread_ts).toBe("1234567890.123456");
    });

    test("omits thread_ts when not provided", async () => {
      tracker.recordTurn({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });

      await tracker.report({
        taskUUID: "ticket-123",
        workerUrl: "https://worker.example.com",
        apiKey: "api-key",
        slackBotToken: "xoxb-test",
        slackChannel: "#test",
      });

      const slackBody = JSON.parse(fetchCalls[1].options.body);
      expect(slackBody.thread_ts).toBeUndefined();
    });

    test("includes sessionMessageCount in API payload", async () => {
      tracker.recordTurn({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });
      tracker.recordTurn({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 });

      await tracker.report({
        taskUUID: "ticket-123",
        workerUrl: "https://worker.example.com",
        apiKey: "api-key",
        slackBotToken: "xoxb-test",
        slackChannel: "#test",
        sessionMessageCount: 42,
      });

      const apiBody = JSON.parse(fetchCalls[0].options.body);
      expect(apiBody.sessionMessageCount).toBe(42);
      expect(apiBody.turns).toBe(2);
    });

    test("does not throw on fetch failure", async () => {
      globalThis.fetch = mock(async () => {
        return new Response("error", { status: 500 });
      }) as any;

      tracker.recordTurn({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });

      // Should not throw
      await tracker.report({
        taskUUID: "ticket-123",
        workerUrl: "https://worker.example.com",
        apiKey: "api-key",
        slackBotToken: "xoxb-test",
        slackChannel: "#test",
      });
    });

    test("does not throw on network error", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("Network error");
      }) as any;

      tracker.recordTurn({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 });

      await tracker.report({
        taskUUID: "ticket-123",
        workerUrl: "https://worker.example.com",
        apiKey: "api-key",
        slackBotToken: "xoxb-test",
        slackChannel: "#test",
      });
    });
  });

  describe("getSummary", () => {
    test("returns a snapshot, not a mutable reference", () => {
      tracker.recordTurn({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 });
      const s1 = tracker.getSummary();
      tracker.recordTurn({ inputTokens: 2000, outputTokens: 1000, cacheReadTokens: 0, cacheCreationTokens: 0 });
      const s2 = tracker.getSummary();

      // s1 should not have been mutated
      expect(s1.totalInputTokens).toBe(1000);
      expect(s2.totalInputTokens).toBe(3000);
      expect(s1.turns).toBe(1);
      expect(s2.turns).toBe(2);
    });
  });
});
