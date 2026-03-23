import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SlackEcho, formatToolSummary } from "./slack-echo";

// ── Mock fetch ───────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

function createMockFetch() {
  const calls: FetchCall[] = [];

  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: url.toString(),
      body: JSON.parse((init?.body as string) ?? "{}"),
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  return { fn: fn as typeof fetch, calls };
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
      fetchFn: mockFetch.fn,
    });
  });

  // ── echoAssistantText ──────────────────────────────────────────────────

  describe("echoAssistantText", () => {
    test("skips posting if no threadTs", async () => {
      const noThread = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        fetchFn: mockFetch.fn,
      });

      noThread.echoAssistantText("hello");
      await noThread.flush();

      expect(mockFetch.calls).toHaveLength(0);
    });

    test("posts after threadTs is set via setThreadTs", async () => {
      const noThread = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        fetchFn: mockFetch.fn,
      });

      noThread.echoAssistantText("ignored");
      noThread.setThreadTs("111.222");
      noThread.echoAssistantText("posted");
      await noThread.flush();

      // Only "posted" should appear (the first was skipped)
      expect(mockFetch.calls).toHaveLength(1);
      expect(mockFetch.calls[0].body.text).toContain("posted");
      expect(mockFetch.calls[0].body.thread_ts).toBe("111.222");
    });

    test("debounces multiple rapid texts into one post", async () => {
      echo.echoAssistantText("first");
      echo.echoAssistantText("second");
      echo.echoAssistantText("third");

      // Nothing posted yet (debouncing)
      expect(mockFetch.calls).toHaveLength(0);

      await echo.flush();

      expect(mockFetch.calls).toHaveLength(1);
      const text = mockFetch.calls[0].body.text as string;
      expect(text).toContain("first");
      expect(text).toContain("second");
      expect(text).toContain("third");
      expect(text).toStartWith("\u{1F4AC}");
    });

    test("truncates text to 3000 chars", async () => {
      const longText = "x".repeat(4000);
      echo.echoAssistantText(longText);
      await echo.flush();

      const text = mockFetch.calls[0].body.text as string;
      // 💬 prefix + space + 3000 chars + "..."
      expect(text.length).toBeLessThanOrEqual(3006); // emoji + space + 3000 + "..."
      expect(text).toContain("...");
    });

    test("sends correct Slack API payload", async () => {
      echo.echoAssistantText("hello world");
      await echo.flush();

      const call = mockFetch.calls[0];
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
        fetchFn: mockFetch.fn,
      });

      echoWithPersona.echoAssistantText("hi");
      await echoWithPersona.flush();

      const body = mockFetch.calls[0].body;
      expect(body.username).toBe("PE Bot");
      expect(body.icon_emoji).toBe(":robot:");
    });

    test("fires after debounce timeout", async () => {
      echo.echoAssistantText("auto-fire");

      // Wait for debounce to fire
      await new Promise((r) => setTimeout(r, 600));

      expect(mockFetch.calls).toHaveLength(1);
      expect(mockFetch.calls[0].body.text).toContain("auto-fire");
    });
  });

  // ── echoToolUse ────────────────────────────────────────────────────────

  describe("echoToolUse", () => {
    test("skips if no threadTs", () => {
      const noThread = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        fetchFn: mockFetch.fn,
      });

      noThread.echoToolUse("Bash", { command: "ls" });
      expect(mockFetch.calls).toHaveLength(0);
    });

    test("skips notify_slack tool", () => {
      echo.echoToolUse("notify_slack", { message: "hi" });
      expect(mockFetch.calls).toHaveLength(0);
    });

    test("skips ask_question tool", () => {
      echo.echoToolUse("ask_question", { question: "what?" });
      expect(mockFetch.calls).toHaveLength(0);
    });

    test("skips update_task_status tool", () => {
      echo.echoToolUse("update_task_status", { status: "done" });
      expect(mockFetch.calls).toHaveLength(0);
    });

    test("posts immediately (no debounce)", () => {
      echo.echoToolUse("Bash", { command: "ls -la" });

      // Posted synchronously (fire-and-forget)
      expect(mockFetch.calls).toHaveLength(1);
      expect(mockFetch.calls[0].body.text).toContain("Bash");
    });

    test("formats Bash tool with description only", () => {
      echo.echoToolUse("Bash", { command: "npm test --coverage", description: "Run tests" });

      const text = mockFetch.calls[0].body.text as string;
      expect(text).toContain("`Bash`");
      expect(text).toContain("Run tests");
      expect(text).not.toContain("npm test");
    });

    test("formats Bash tool without description as name only", () => {
      echo.echoToolUse("Bash", { command: "npm test --coverage" });

      const text = mockFetch.calls[0].body.text as string;
      expect(text).toContain("`Bash`");
      expect(text).not.toContain("npm test");
    });

    test("formats Read tool with short path only", () => {
      echo.echoToolUse("Read", { file_path: "/home/user/project/src/index.ts" });

      const text = mockFetch.calls[0].body.text as string;
      expect(text).toContain("`Bash`".replace("Bash", "Read"));
      expect(text).toContain("src/index.ts");
    });

    test("formats Edit tool with short path only", () => {
      echo.echoToolUse("Edit", { file_path: "/a/b/c/file.ts", old_string: "x", new_string: "y" });

      const text = mockFetch.calls[0].body.text as string;
      expect(text).toContain("`Edit`");
      expect(text).toContain("c/file.ts");
      expect(text).not.toContain("old_string");
    });

    test("formats Glob tool as name only", () => {
      echo.echoToolUse("Glob", { pattern: "**/*.test.ts" });

      const text = mockFetch.calls[0].body.text as string;
      expect(text).toContain("`Glob`");
      expect(text).not.toContain("**/*.test.ts");
    });

    test("formats Grep tool as name only", () => {
      echo.echoToolUse("Grep", { pattern: "import.*from" });

      const text = mockFetch.calls[0].body.text as string;
      expect(text).toContain("`Grep`");
      expect(text).not.toContain("import.*from");
    });

    test("formats Agent tool with description", () => {
      echo.echoToolUse("Agent", { description: "Analyze the codebase structure" });

      const text = mockFetch.calls[0].body.text as string;
      expect(text).toContain("`Agent`");
      expect(text).toContain("Analyze the codebase structure");
    });

    test("formats unknown tool as name only", () => {
      echo.echoToolUse("CustomTool", { foo: "bar", count: 42 });

      const text = mockFetch.calls[0].body.text as string;
      expect(text).toContain("`CustomTool`");
      expect(text).not.toContain('"foo"');
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────

  describe("error handling", () => {
    test("silently catches fetch errors on tool echo", () => {
      const failEcho = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        slackThreadTs: "111.222",
        fetchFn: (() => {
          throw new Error("network error");
        }) as unknown as typeof fetch,
      });

      // Should not throw
      expect(() => failEcho.echoToolUse("Bash", { command: "ls" })).not.toThrow();
    });

    test("silently catches fetch errors on text flush", async () => {
      const failEcho = new SlackEcho({
        slackBotToken: "xoxb-test",
        slackChannel: "C123",
        slackThreadTs: "111.222",
        fetchFn: (() => {
          throw new Error("network error");
        }) as unknown as typeof fetch,
      });

      failEcho.echoAssistantText("test");
      // Should not throw
      await failEcho.flush();
    });
  });

  // ── flush ──────────────────────────────────────────────────────────────

  describe("flush", () => {
    test("is a no-op when nothing pending", async () => {
      await echo.flush();
      expect(mockFetch.calls).toHaveLength(0);
    });

    test("clears pending text", async () => {
      echo.echoAssistantText("first");
      await echo.flush();
      await echo.flush(); // second flush should be no-op

      expect(mockFetch.calls).toHaveLength(1);
    });
  });
});

// ── formatToolSummary unit tests ─────────────────────────────────────────────

describe("formatToolSummary", () => {
  test("Bash with description returns description only", () => {
    const result = formatToolSummary("Bash", { command: "npm test", description: "Run tests" });
    expect(result).toBe("Run tests");
  });

  test("Bash without description returns empty", () => {
    const result = formatToolSummary("Bash", { command: "npm test" });
    expect(result).toBe("");
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
    expect(formatToolSummary("Read", { file_path: "/a/b/c/file.ts" })).toBe("`c/file.ts`");
    expect(formatToolSummary("Edit", { file_path: "/x/y.ts" })).toBe("`x/y.ts`");
  });
});
