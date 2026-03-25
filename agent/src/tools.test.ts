import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// Mock the agent SDK before importing tools.ts
// The `tool` function captures the handler so we can invoke it directly in tests.
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (_name: string, _desc: string, _schema: unknown, handler: Function) => ({
    __name: _name,
    __handler: handler,
  }),
}));

import { persistSlackThreadTs, createTools } from "./tools";
import type { AgentConfig } from "./config";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    taskUUID: "slack-123",
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
    expect(body.taskUUID).toBe("slack-123");
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

// Helper to extract a tool handler by name from createTools result
function getToolHandler(config: AgentConfig, toolName: string): Function {
  const { tools } = createTools(config);
  const found = tools.find((t: any) => t.__name === toolName);
  if (!found) throw new Error(`Tool "${toolName}" not found`);
  return (found as any).__handler;
}

describe("update_task_status", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetchResponses(
    handlers: Array<{
      match: (url: string, init?: RequestInit) => boolean;
      response: () => Response;
    }>,
  ) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      calls.push({ url: urlStr, init });
      for (const h of handlers) {
        if (h.match(urlStr, init)) return h.response();
      }
      return new Response("Not found", { status: 404 });
    }) as any;
    return calls;
  }

  test("basic status update — calls orchestrator and returns success", async () => {
    const config = makeConfig();
    const handler = getToolHandler(config, "update_task_status");

    const calls = mockFetchResponses([
      {
        match: (url) => url.includes("/api/internal/status"),
        response: () => new Response(null, { status: 200 }),
      },
    ]);

    const result = await handler({ status: "in_progress" });

    expect(result.content[0].text).toBe("Task status updated to in_progress");
    // Should have called the orchestrator
    const orchestratorCall = calls.find((c) => c.url.includes("/api/internal/status"));
    expect(orchestratorCall).toBeTruthy();
    const body = JSON.parse(orchestratorCall!.init!.body as string);
    expect(body.taskUUID).toBe("slack-123");
    expect(body.status).toBe("in_progress");
  });

  test("Linear ticket state mapping — verifies all status→Linear state mappings", async () => {
    const expectedMappings: Record<string, string> = {
      in_progress: "In Progress",
      pr_open: "In Review",
      in_review: "In Review",
      needs_revision: "In Progress",
      merged: "Done",
      closed: "Done",
      deferred: "Canceled",
      failed: "Canceled",
      asking: "In Progress",
    };

    // For each status, mock Linear API and verify the correct state name is queried
    for (const [status, expectedLinearState] of Object.entries(expectedMappings)) {
      let queriedStateName: string | null = null;

      const config = makeConfig({ linearAppToken: "lin-test", taskUUID: "ticket-uuid-123" });
      const handler = getToolHandler(config, "update_task_status");

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/internal/status")) {
          return new Response(null, { status: 200 });
        }
        if (urlStr.includes("api.linear.app/graphql")) {
          const body = JSON.parse(init!.body as string);
          if (body.query.includes("team { states")) {
            // Return states so the tool can find the matching one
            return new Response(
              JSON.stringify({
                data: {
                  issue: {
                    team: {
                      states: {
                        nodes: [
                          { id: "state-in-progress", name: "In Progress" },
                          { id: "state-in-review", name: "In Review" },
                          { id: "state-done", name: "Done" },
                          { id: "state-canceled", name: "Canceled" },
                        ],
                      },
                    },
                  },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (body.query.includes("issueUpdate")) {
            // Capture which state ID was used in the mutation
            const stateId = body.variables.stateId;
            const stateMap: Record<string, string> = {
              "state-in-progress": "In Progress",
              "state-in-review": "In Review",
              "state-done": "Done",
              "state-canceled": "Canceled",
            };
            queriedStateName = stateMap[stateId] || null;
            return new Response(
              JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: "x", state: { name: queriedStateName } } } } }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }
        return new Response("Not found", { status: 404 });
      }) as any;

      await handler({ status });
      expect<string | null>(queriedStateName).toBe(expectedLinearState);
    }
  });

  test("updates Linear ticket when linearAppToken is configured", async () => {
    const config = makeConfig({ linearAppToken: "lin-test-token", taskUUID: "uuid-abc" });
    const handler = getToolHandler(config, "update_task_status");

    let linearQueryCalled = false;
    let linearMutationCalled = false;
    let mutationVariables: any = null;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/api/internal/status")) {
        return new Response(null, { status: 200 });
      }
      if (urlStr.includes("api.linear.app/graphql")) {
        const body = JSON.parse(init!.body as string);
        // Verify auth header
        expect(init!.headers).toBeTruthy();
        const headers = init!.headers as Record<string, string>;
        expect(headers.Authorization).toBe("Bearer lin-test-token");

        if (body.query.includes("team { states")) {
          linearQueryCalled = true;
          expect(body.variables.issueId).toBe("uuid-abc");
          return new Response(
            JSON.stringify({
              data: {
                issue: {
                  team: {
                    states: {
                      nodes: [
                        { id: "state-1", name: "In Progress" },
                        { id: "state-2", name: "Done" },
                      ],
                    },
                  },
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (body.query.includes("issueUpdate")) {
          linearMutationCalled = true;
          mutationVariables = body.variables;
          return new Response(
            JSON.stringify({ data: { issueUpdate: { success: true, issue: { id: "uuid-abc", state: { name: "Done" } } } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      return new Response("Not found", { status: 404 });
    }) as any;

    await handler({ status: "merged" });

    expect(linearQueryCalled).toBe(true);
    expect(linearMutationCalled).toBe(true);
    expect(mutationVariables.issueId).toBe("uuid-abc");
    expect(mutationVariables.stateId).toBe("state-2"); // "Done"
  });

  test("does not call Linear when linearAppToken is not set", async () => {
    const config = makeConfig({ linearAppToken: "" });
    const handler = getToolHandler(config, "update_task_status");

    let linearCalled = false;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("api.linear.app")) {
        linearCalled = true;
      }
      return new Response(null, { status: 200 });
    }) as any;

    await handler({ status: "in_progress" });
    expect(linearCalled).toBe(false);
  });

  test("updates Slack message when slackThreadTs is set", async () => {
    const config = makeConfig({
      slackThreadTs: "1234567890.000000",
      taskIdentifier: "PE-42",
      taskTitle: "Fix the widget",
    });
    const handler = getToolHandler(config, "update_task_status");

    let slackUpdateCalled = false;
    let slackUpdateBody: any = null;

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/api/internal/status")) {
        return new Response(null, { status: 200 });
      }
      if (urlStr.includes("slack.com/api/chat.update")) {
        slackUpdateCalled = true;
        slackUpdateBody = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(null, { status: 200 });
    }) as any;

    await handler({ status: "pr_open" });

    expect(slackUpdateCalled).toBe(true);
    expect(slackUpdateBody.ts).toBe("1234567890.000000");
    expect(slackUpdateBody.channel).toBe("#test");
    // Should contain the ticket identifier and a review-related emoji
    expect(slackUpdateBody.text).toContain("PE-42");
    expect(slackUpdateBody.text).toContain("IN REVIEW");
  });

  test("does not update Slack message when slackThreadTs is not set", async () => {
    const config = makeConfig({ slackThreadTs: "" });
    const handler = getToolHandler(config, "update_task_status");

    let slackUpdateCalled = false;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("slack.com/api/chat.update")) {
        slackUpdateCalled = true;
      }
      return new Response(null, { status: 200 });
    }) as any;

    await handler({ status: "in_progress" });
    expect(slackUpdateCalled).toBe(false);
  });

  test("gracefully handles orchestrator update failure — does not throw", async () => {
    const config = makeConfig({ linearAppToken: "" });
    const handler = getToolHandler(config, "update_task_status");

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/api/internal/status")) {
        throw new Error("Network unreachable");
      }
      return new Response(null, { status: 200 });
    }) as any;

    // Should not throw — error is caught internally
    const result = await handler({ status: "in_progress" });
    expect(result.content[0].text).toBe("Task status updated to in_progress");
  });

  test("gracefully handles Linear update failure — does not throw", async () => {
    const config = makeConfig({ linearAppToken: "lin-test", taskUUID: "uuid-123" });
    const handler = getToolHandler(config, "update_task_status");

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/api/internal/status")) {
        return new Response(null, { status: 200 });
      }
      if (urlStr.includes("api.linear.app/graphql")) {
        throw new Error("Linear API down");
      }
      return new Response(null, { status: 200 });
    }) as any;

    // Should not throw — Linear errors are caught internally
    const result = await handler({ status: "merged" });
    expect(result.content[0].text).toBe("Task status updated to merged");
  });

  test("sends pr_url to orchestrator when provided", async () => {
    const config = makeConfig({ linearAppToken: "" });
    const handler = getToolHandler(config, "update_task_status");

    let capturedBody: any = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/api/internal/status")) {
        capturedBody = JSON.parse(init!.body as string);
      }
      return new Response(null, { status: 200 });
    }) as any;

    await handler({ status: "pr_open", pr_url: "https://github.com/org/repo/pull/42" });

    expect(capturedBody.pr_url).toBe("https://github.com/org/repo/pull/42");
    expect(capturedBody.status).toBe("pr_open");
  });

  test("uses explicit linear_ticket_id over config.ticketUUID", async () => {
    const config = makeConfig({ linearAppToken: "lin-test", taskUUID: "config-uuid" });
    const handler = getToolHandler(config, "update_task_status");

    let queriedIssueId: string | null = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/api/internal/status")) {
        return new Response(null, { status: 200 });
      }
      if (urlStr.includes("api.linear.app/graphql")) {
        const body = JSON.parse(init!.body as string);
        if (body.query.includes("team { states")) {
          queriedIssueId = body.variables.issueId;
          return new Response(
            JSON.stringify({ data: { issue: { team: { states: { nodes: [] } } } } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }
      return new Response(null, { status: 200 });
    }) as any;

    await handler({ status: "in_progress", linear_ticket_id: "explicit-uuid" });

    expect<string | null>(queriedIssueId).toBe("explicit-uuid");
  });
});
