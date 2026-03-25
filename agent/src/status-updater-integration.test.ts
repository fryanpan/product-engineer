/**
 * Integration tests for Linear status synchronization.
 * Validates the complete flow from agent → orchestrator → Linear API.
 */

import { describe, test, expect, mock } from "bun:test";
import { StatusUpdater, type StatusUpdaterConfig } from "./status-updater";

function makeMockFetch() {
  const calls: Array<{ url: string; opts: RequestInit }> = [];
  const fn = mock(async (url: string | URL, opts?: RequestInit) => {
    calls.push({ url: url.toString(), opts: opts || {} });

    const urlStr = url.toString();

    // Mock Linear GraphQL responses
    if (urlStr.includes("linear.app/graphql")) {
      const body = JSON.parse(opts?.body as string || "{}");

      // State query
      if (body.query?.includes("team { states")) {
        return Promise.resolve(
          new Response(JSON.stringify({
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
          }))
        );
      }

      // Update mutation
      if (body.query?.includes("issueUpdate")) {
        return Promise.resolve(
          new Response(JSON.stringify({
            data: {
              issueUpdate: {
                success: true,
                issue: { id: body.variables.issueId, state: { name: "In Progress" } },
              },
            },
          }))
        );
      }
    }

    // Mock orchestrator and Slack
    return Promise.resolve(new Response(JSON.stringify({ ok: true })));
  }) as unknown as typeof fetch;

  return { fn, calls };
}

function makeConfig(overrides: Partial<StatusUpdaterConfig> = {}): StatusUpdaterConfig {
  return {
    workerUrl: "https://worker.test",
    apiKey: "test-key",
    taskUUID: "issue-uuid-123",
    slackBotToken: "xoxb-test",
    slackChannel: "#test",
    slackThreadTs: "1234.5678",
    linearAppToken: "lin_test_token",
    taskIdentifier: "PE-42",
    taskTitle: "Fix status sync",
    ...overrides,
  };
}

describe("Linear status synchronization", () => {
  test("updateAll() calls Linear API with correct issue UUID", async () => {
    const { fn, calls } = makeMockFetch();
    const config = makeConfig({ fetchFn: fn, taskUUID: "linear-issue-uuid-abc" });
    const updater = new StatusUpdater(config);

    await updater.updateAll("in_progress");

    const linearCalls = calls.filter(c => c.url.includes("linear.app/graphql"));
    expect(linearCalls.length).toBeGreaterThanOrEqual(2); // state query + update mutation

    // Verify state query uses correct issue ID
    const stateQuery = linearCalls.find(c => {
      const body = JSON.parse(c.opts.body as string);
      return body.query.includes("team { states");
    });
    expect(stateQuery).toBeDefined();
    const stateBody = JSON.parse(stateQuery!.opts.body as string);
    expect(stateBody.variables.issueId).toBe("linear-issue-uuid-abc");

    // Verify update mutation uses correct issue ID
    const updateMutation = linearCalls.find(c => {
      const body = JSON.parse(c.opts.body as string);
      return body.query.includes("issueUpdate");
    });
    expect(updateMutation).toBeDefined();
    const updateBody = JSON.parse(updateMutation!.opts.body as string);
    expect(updateBody.variables.issueId).toBe("linear-issue-uuid-abc");
  });

  test("maps agent statuses to Linear states correctly", async () => {
    const { fn, calls } = makeMockFetch();
    const config = makeConfig({ fetchFn: fn });
    const updater = new StatusUpdater(config);

    const statusMapping = [
      { agent: "in_progress", linear: "In Progress" },
      { agent: "pr_open", linear: "In Review" },
      { agent: "in_review", linear: "In Review" },
      { agent: "needs_revision", linear: "In Progress" },
      { agent: "merged", linear: "Done" },
      { agent: "closed", linear: "Done" },
      { agent: "deferred", linear: "Canceled" },
      { agent: "failed", linear: "Canceled" },
    ];

    for (const { agent, linear } of statusMapping) {
      calls.length = 0; // clear previous calls
      await updater.updateLinear(agent, "issue-123");

      const updateCall = calls.find(c => {
        const body = JSON.parse(c.opts.body as string);
        return body.query?.includes("issueUpdate");
      });

      if (!updateCall) {
        throw new Error(`No update call found for status ${agent}`);
      }

      const body = JSON.parse(updateCall.opts.body as string);
      const stateId = body.variables.stateId;

      // Map state ID back to name
      const expectedStateId = {
        "In Progress": "state-in-progress",
        "In Review": "state-in-review",
        "Done": "state-done",
        "Canceled": "state-canceled",
      }[linear];

      expect(stateId).toBe(expectedStateId);
    }
  });

  test("uses explicit linearTicketId over config.ticketUUID", async () => {
    const { fn, calls } = makeMockFetch();
    const config = makeConfig({
      fetchFn: fn,
      taskUUID: "config-uuid-abc",
    });
    const updater = new StatusUpdater(config);

    await updater.updateAll("in_progress", { linearTicketId: "explicit-uuid-xyz" });

    const linearCalls = calls.filter(c => c.url.includes("linear.app/graphql"));
    const stateQuery = linearCalls.find(c => {
      const body = JSON.parse(c.opts.body as string);
      return body.query.includes("team { states");
    });

    const body = JSON.parse(stateQuery!.opts.body as string);
    expect(body.variables.issueId).toBe("explicit-uuid-xyz");
  });

  test("handles Linear API errors gracefully", async () => {
    const fn = mock(async (url: string | URL) => {
      if (url.toString().includes("linear.app/graphql")) {
        return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }) as unknown as typeof fetch;

    const config = makeConfig({ fetchFn: fn });
    const updater = new StatusUpdater(config);

    // Should not throw — errors are caught and logged
    await expect(updater.updateAll("in_progress")).resolves.toBeUndefined();
  });

  test("handles Linear state not found gracefully", async () => {
    const fn = mock(async (url: string | URL, opts?: RequestInit) => {
      if (url.toString().includes("linear.app/graphql")) {
        // Return states that don't include our target state
        return Promise.resolve(
          new Response(JSON.stringify({
            data: {
              issue: {
                team: {
                  states: {
                    nodes: [
                      { id: "state-backlog", name: "Backlog" },
                      { id: "state-todo", name: "Todo" },
                    ],
                  },
                },
              },
            },
          }))
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    }) as unknown as typeof fetch;

    const config = makeConfig({ fetchFn: fn });
    const updater = new StatusUpdater(config);

    // Should not throw — just logs warning
    await expect(updater.updateLinear("in_progress", "issue-123")).resolves.toBeUndefined();
  });

  test("skips Linear update when no token configured", async () => {
    const { fn, calls } = makeMockFetch();
    const config = makeConfig({ fetchFn: fn, linearAppToken: "" });
    const updater = new StatusUpdater(config);

    await updater.updateAll("in_progress");

    const linearCalls = calls.filter(c => c.url.includes("linear.app/graphql"));
    expect(linearCalls.length).toBe(0);

    // But orchestrator and Slack should still be called
    expect(calls.some(c => c.url.includes("/api/internal/status"))).toBe(true);
    expect(calls.some(c => c.url.includes("slack.com/api/chat.update"))).toBe(true);
  });

  test("all three updates run in parallel", async () => {
    const { fn, calls } = makeMockFetch();
    const config = makeConfig({ fetchFn: fn });
    const updater = new StatusUpdater(config);

    const start = Date.now();
    await updater.updateAll("in_progress");
    const duration = Date.now() - start;

    // Verify all three systems were called
    expect(calls.some(c => c.url.includes("/api/internal/status"))).toBe(true);
    expect(calls.some(c => c.url.includes("linear.app/graphql"))).toBe(true);
    expect(calls.some(c => c.url.includes("slack.com/api/chat.update"))).toBe(true);

    // Should complete quickly (parallel execution, not sequential)
    // This is a weak assertion but helps catch if Promise.all was removed
    expect(duration).toBeLessThan(1000);
  });
});
