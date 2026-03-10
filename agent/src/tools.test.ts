import { describe, test, expect, mock } from "bun:test";

// Mock the agent SDK before importing tools.ts
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  tool: () => {},
}));

import { persistSlackThreadTs } from "./tools";
import type { AgentConfig } from "./config";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ticketId: "slack-123",
    product: "test-app",
    repos: ["test-org/test-app"],
    anthropicApiKey: "ak-test",
    githubToken: "gh-test",
    slackBotToken: "xoxb-test",
    slackChannel: "#test",
    slackThreadTs: "",
    linearAppToken: "lin-test",
    workerUrl: "https://worker.example.com",
    apiKey: "api-key-test",
    ...overrides,
  };
}

describe("persistSlackThreadTs", () => {
  test("persists thread_ts on first successful attempt", async () => {
    const config = makeConfig();
    const mockFetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );

    await persistSlackThreadTs(config, "1234567890.123456", 3, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(config.slackThreadTs).toBe("1234567890.123456");

    // Verify the request body
    const call = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const [url, opts] = call;
    expect(url).toBe("https://worker.example.com/api/internal/status");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body.ticketId).toBe("slack-123");
    expect(body.slack_thread_ts).toBe("1234567890.123456");
  });

  test("retries on fetch failure and succeeds on second attempt", async () => {
    const config = makeConfig();
    let callCount = 0;
    const mockFetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error("network error"));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    await persistSlackThreadTs(config, "1234567890.123456", 3, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(config.slackThreadTs).toBe("1234567890.123456");
  });

  test("retries on non-ok status and succeeds on third attempt", async () => {
    const config = makeConfig();
    let callCount = 0;
    const mockFetch = mock(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });

    await persistSlackThreadTs(config, "1234567890.123456", 3, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(config.slackThreadTs).toBe("1234567890.123456");
  });

  test("gives up after max retries exhausted", async () => {
    const config = makeConfig();
    const mockFetch = mock(() =>
      Promise.resolve(new Response(null, { status: 500 })),
    );

    await persistSlackThreadTs(config, "1234567890.123456", 3, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Config still gets set locally as fallback even when persistence fails
    expect(config.slackThreadTs).toBe("1234567890.123456");
  });

  test("skips if slackThreadTs is already set", async () => {
    const config = makeConfig({ slackThreadTs: "already-set" });
    const mockFetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );

    await persistSlackThreadTs(config, "1234567890.123456", 3, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(config.slackThreadTs).toBe("already-set");
  });

  test("skips if ts is empty string", async () => {
    const config = makeConfig();
    const mockFetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );

    await persistSlackThreadTs(config, "", 3, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(config.slackThreadTs).toBe("");
  });

  test("uses default maxRetries of 3", async () => {
    const config = makeConfig();
    const mockFetch = mock(() =>
      Promise.resolve(new Response(null, { status: 500 })),
    );

    // Call without explicit maxRetries
    await persistSlackThreadTs(config, "1234567890.123456", undefined, mockFetch as any);

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
