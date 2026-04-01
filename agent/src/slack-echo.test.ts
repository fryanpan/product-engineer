import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SlackEcho, formatToolSummary } from "./slack-echo";

// ── Mock fetch ───────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

function createMockFetch(haikusRespond = true) {
  const calls: FetchCall[] = [];

  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = url.toString();
    calls.push({
      url: urlStr,
      body: JSON.parse((init?.body as string) ?? "{}"),
    });

    if (urlStr.includes("anthropic.com")) {
      if (!haikusRespond) {
        return new Response(JSON.stringify({ error: "fail" }), { status: 500 });
      }
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Reading config and running tests." }],
        }),
        { status: 200 },
      );
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  return { fn: fn as typeof fetch, calls };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slackCalls(calls: FetchCall[]) {
  return calls.filter((c) => c.url.includes("slack.com"));
}

function haikusCalls(calls: FetchCall[]) {
  return calls.filter((c) => c.url.includes("anthropic.com"));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SlackEcho", () => {
  let mockFetch: ReturnType<typeof createMockFetch>;
  let echo: SlackEcho;

  beforeEach(() => {
    mockFetch = createMockFetch();
    echo = new SlackEcho({
      slackBotToken: "xoxb-test-token",
      slackChannel: "C123",
      slackThreadTs: "1234567890.123456",
      anthropicApiKey: "sk-ant-test",
      fetchFn: mockFetch.fn,
    });
  });

  afterEach(async () => {
    await echo.stop();
  });

  // ── echoAssistantText ──────────────────────────────────────────────────

  describe("echoAssistantText", () => {
    test("skips posting if no threadTs", async () => {
      const noThread = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        anthropicApiKey: "sk-ant-test",
        fetchFn: mockFetch.fn,
      });

      noThread.echoAssistantText("hello");
      await noThread.stop();

      expect(slackCalls(mockFetch.calls)).toHaveLength(0);
    });

    test("posts after threadTs is set via setThreadTs", async () => {
      const noThread = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        anthropicApiKey: "sk-ant-test",
        fetchFn: mockFetch.fn,
      });

      noThread.echoAssistantText("ignored");
      noThread.setThreadTs("111.222");
      noThread.echoAssistantText("posted");
      await noThread.stop();

      // "ignored" is dropped — no threadTs at call time.
      // "posted" posts immediately after threadTs is set.
      expect(slackCalls(mockFetch.calls)).toHaveLength(1);
      expect(slackCalls(mockFetch.calls)[0].body.thread_ts).toBe("111.222");
    });

    test("posts each assistant text immediately without buffering", async () => {
      echo.echoAssistantText("first");
      echo.echoAssistantText("second");
      echo.echoAssistantText("third");

      // All three posted immediately — no buffering
      expect(slackCalls(mockFetch.calls)).toHaveLength(3);

      const texts = slackCalls(mockFetch.calls).map((c) => c.body.text as string);
      expect(texts[0]).toStartWith("\u{1F4AC}");
      expect(texts[0]).toContain("first");
      expect(texts[1]).toContain("second");
      expect(texts[2]).toContain("third");
    });

    test("sends correct Slack API payload", async () => {
      echo.echoAssistantText("hello world");
      await echo.stop();

      const call = slackCalls(mockFetch.calls)[0];
      expect(call.url).toBe("https://slack.com/api/chat.postMessage");
      expect(call.body.channel).toBe("C123");
      expect(call.body.thread_ts).toBe("1234567890.123456");
    });

    test("includes persona fields when provided", async () => {
      const echoWithPersona = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        slackThreadTs: "111.222",
        slackPersona: { username: "PE Bot", icon_emoji: ":robot:" },
        anthropicApiKey: "sk-ant-test",
        fetchFn: mockFetch.fn,
      });

      echoWithPersona.echoAssistantText("hi");
      await echoWithPersona.stop();

      const body = slackCalls(mockFetch.calls)[0].body;
      expect(body.username).toBe("PE Bot");
      expect(body.icon_emoji).toBe(":robot:");
    });

    test("no Slack post if buffer is empty on stop", async () => {
      await echo.stop();
      expect(slackCalls(mockFetch.calls)).toHaveLength(0);
    });

    test("posts URL-containing message immediately", async () => {
      echo.echoAssistantText(
        "Task complete. PR opened at https://github.com/org/repo/pull/42 — ready for review!",
      );

      expect(slackCalls(mockFetch.calls)).toHaveLength(1);
      const text = slackCalls(mockFetch.calls)[0].body.text as string;
      expect(text).toStartWith("\u{1F4AC}");
      expect(text).toContain("https://github.com");
    });

    test("assistant text does NOT call Haiku", async () => {
      echo.echoAssistantText(
        "Task complete. PR opened at https://github.com/org/repo/pull/123 — merged!",
      );
      await echo.stop();

      // No Haiku summarization for assistant text
      expect(haikusCalls(mockFetch.calls)).toHaveLength(0);
    });

    test("short message posts immediately", async () => {
      echo.echoAssistantText("Reading files now");
      expect(slackCalls(mockFetch.calls)).toHaveLength(1);
    });

    test("short question posts immediately", async () => {
      echo.echoAssistantText("Ok?");
      expect(slackCalls(mockFetch.calls)).toHaveLength(1);
    });

    test("very long passthrough message is truncated to MAX_PASSTHROUGH_LENGTH", async () => {
      const longMsg = "https://github.com/org/repo/pull/1 " + "x".repeat(3100);
      echo.echoAssistantText(longMsg);

      expect(slackCalls(mockFetch.calls)).toHaveLength(1);
      const text = slackCalls(mockFetch.calls)[0].body.text as string;
      expect(text).toContain("... [truncated]");
      // 💬 prefix + space + 3000 chars + "... [truncated]"
      expect(text.length).toBeLessThan(3_020);
    });
  });

  // ── echoToolUse ────────────────────────────────────────────────────────

  describe("echoToolUse", () => {
    test("skips if no threadTs", async () => {
      const noThread = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        fetchFn: mockFetch.fn,
      });

      noThread.echoToolUse("Bash", { command: "ls" });
      await noThread.stop();
      expect(slackCalls(mockFetch.calls)).toHaveLength(0);
    });

    test("skips notify_slack tool", async () => {
      echo.echoToolUse("notify_slack", { message: "hi" });
      await echo.stop();
      expect(slackCalls(mockFetch.calls)).toHaveLength(0);
    });

    test("skips ask_question tool", async () => {
      echo.echoToolUse("ask_question", { question: "what?" });
      await echo.stop();
      // ask_question is skipped in echoToolUse; if nothing else buffered, no post
      expect(slackCalls(mockFetch.calls)).toHaveLength(0);
    });

    test("skips update_task_status tool", async () => {
      echo.echoToolUse("update_task_status", { status: "done" });
      await echo.stop();
      expect(slackCalls(mockFetch.calls)).toHaveLength(0);
    });

    test("buffers tool use and posts on stop", async () => {
      echo.echoToolUse("Bash", { command: "ls -la", description: "List files" });

      // Not posted immediately
      expect(slackCalls(mockFetch.calls)).toHaveLength(0);

      await echo.stop();

      expect(slackCalls(mockFetch.calls)).toHaveLength(1);
      expect(slackCalls(mockFetch.calls)[0].body.text).toContain("Reading config");
    });

    test("formats Bash tool with description", async () => {
      echo.echoToolUse("Bash", { command: "npm test --coverage", description: "Run tests" });
      await echo.stop();

      // The Haiku call should receive the tool summary in its activity
      const haiku = haikusCalls(mockFetch.calls)[0];
      const content = (haiku.body.messages as any)[0].content as string;
      expect(content).toContain("Run tests");
    });

    test("formats Read tool with short path", async () => {
      echo.echoToolUse("Read", { file_path: "/home/user/project/src/index.ts" });
      await echo.stop();

      const haiku = haikusCalls(mockFetch.calls)[0];
      const content = (haiku.body.messages as any)[0].content as string;
      expect(content).toContain("src/index.ts");
    });

    test("formats Edit tool with short path", async () => {
      echo.echoToolUse("Edit", { file_path: "/a/b/c/file.ts", old_string: "x", new_string: "y" });
      await echo.stop();

      const haiku = haikusCalls(mockFetch.calls)[0];
      const content = (haiku.body.messages as any)[0].content as string;
      expect(content).toContain("c/file.ts");
    });
  });

  // ── flush (ask_question path) ─────────────────────────────────────────

  describe("flush", () => {
    test("posts immediately when called", async () => {
      echo.echoAssistantText("reading files");
      echo.echoToolUse("Read", { file_path: "/src/config.ts" });

      // echoAssistantText already posted once immediately
      expect(slackCalls(mockFetch.calls)).toHaveLength(1);

      await echo.flush();

      // flush() posts the buffered tool use — total 2 posts
      expect(slackCalls(mockFetch.calls)).toHaveLength(2);
    });

    test("is a no-op when nothing pending", async () => {
      await echo.flush();
      expect(slackCalls(mockFetch.calls)).toHaveLength(0);
    });

    test("clears buffer after flush — second flush is no-op", async () => {
      echo.echoAssistantText("first");
      await echo.flush();
      await echo.flush();

      expect(slackCalls(mockFetch.calls)).toHaveLength(1);
    });
  });

  // ── Haiku fallback ─────────────────────────────────────────────────────

  describe("Haiku fallback", () => {
    test("falls back to truncated raw text when no API key (tool use)", async () => {
      const noKey = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        slackThreadTs: "111.222",
        // no anthropicApiKey
        fetchFn: mockFetch.fn,
      });

      noKey.echoToolUse("Bash", { command: "ls", description: "List files" });
      await noKey.stop();

      // No Haiku call
      expect(haikusCalls(mockFetch.calls)).toHaveLength(0);
      // Still posts to Slack with raw text
      expect(slackCalls(mockFetch.calls)).toHaveLength(1);
      expect(slackCalls(mockFetch.calls)[0].body.text).toContain("List files");
    });

    test("falls back to raw text when Haiku API fails (tool use)", async () => {
      const failFetch = createMockFetch(false);
      const failEcho = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        slackThreadTs: "111.222",
        anthropicApiKey: "sk-ant-test",
        fetchFn: failFetch.fn,
      });

      failEcho.echoToolUse("Bash", { command: "ls", description: "List files" });
      await failEcho.stop();

      // Still posts to Slack (with fallback text)
      expect(slackCalls(failFetch.calls)).toHaveLength(1);
      expect(slackCalls(failFetch.calls)[0].body.text).toContain("List files");
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    test("silently catches Slack fetch errors on flush", async () => {
      const failFetch = (() => {
        throw new Error("network error");
      }) as unknown as typeof fetch;

      const failEcho = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        slackThreadTs: "111.222",
        fetchFn: failFetch,
      });

      failEcho.echoAssistantText("test");
      // Should not throw
      await failEcho.stop();
    });
  });
});

// ── formatToolSummary unit tests ─────────────────────────────────────────────

describe("formatToolSummary", () => {
  test("Bash with description returns description only", () => {
    const result = formatToolSummary("Bash", { command: "npm test", description: "Run tests" });
    expect(result).toBe("Run tests");
  });

  test("Bash without description falls back to command", () => {
    const result = formatToolSummary("Bash", { command: "npm test" });
    expect(result).toBe("npm test");
  });

  test("unknown tool returns empty", () => {
    const bigInput: Record<string, string> = {};
    for (let i = 0; i < 50; i++) bigInput[`key${i}`] = "value";
    const result = formatToolSummary("Unknown", bigInput);
    expect(result).toBe("");
  });

  test("handles missing fields gracefully", () => {
    expect(formatToolSummary("Bash", {})).toBe("");
    expect(formatToolSummary("Read", {})).toBe("");
    expect(formatToolSummary("Edit", {})).toBe("");
    expect(formatToolSummary("Agent", {})).toBe("");
  });

  test("Agent uses description field", () => {
    const result = formatToolSummary("Agent", { description: "Do something" });
    expect(result).toBe("Do something");
  });

  test("file tools show short path", () => {
    expect(formatToolSummary("Read", { file_path: "/a/b/c/file.ts" })).toBe("c/file.ts");
    expect(formatToolSummary("Edit", { file_path: "/x/y.ts" })).toBe("x/y.ts");
  });

  test("Bash with description uses description over command", () => {
    const result = formatToolSummary("Bash", { command: "bun test --coverage", description: "Run tests" });
    expect(result).toBe("Run tests");
  });

  test("Grep with pattern and path returns both", () => {
    const result = formatToolSummary("Grep", { pattern: "isPassthrough", path: "/workspace/agent/src" });
    expect(result).toContain("isPassthrough");
    expect(result).toContain("agent/src");
  });

  test("Grep with pattern only returns pattern", () => {
    const result = formatToolSummary("Grep", { pattern: "SlackEcho" });
    expect(result).toContain("SlackEcho");
  });

  test("Grep with no args returns empty", () => {
    expect(formatToolSummary("Grep", {})).toBe("");
  });

  test("Glob with pattern returns pattern", () => {
    const result = formatToolSummary("Glob", { pattern: "**/*.test.ts" });
    expect(result).toBe("**/*.test.ts");
  });

  test("Glob with no pattern returns empty", () => {
    expect(formatToolSummary("Glob", {})).toBe("");
  });
});

