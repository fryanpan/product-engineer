import { describe, test, expect, mock, beforeEach } from "bun:test";
import { StatusUpdater, type StatusUpdaterConfig } from "./status-updater";

function makeConfig(overrides: Partial<StatusUpdaterConfig> = {}): StatusUpdaterConfig {
  return {
    workerUrl: "https://worker.example.com",
    apiKey: "api-key-test",
    ticketUUID: "ticket-uuid-123",
    slackBotToken: "xoxb-test",
    slackChannel: "#test-channel",
    slackThreadTs: "1234567890.123456",
    linearAppToken: "lin-test-token",
    ticketIdentifier: "PE-42",
    ticketTitle: "Fix the login bug",
    ...overrides,
  };
}

function makeMockFetch(responses: Array<Response | (() => Response)> = []) {
  let callIndex = 0;
  const calls: Array<{ url: string; opts: RequestInit }> = [];

  const defaultResponse = () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 });

  const fn = mock((url: string | URL | Request, opts?: RequestInit) => {
    calls.push({ url: url as string, opts: opts || {} });
    const response = responses[callIndex] || defaultResponse();
    callIndex++;
    return Promise.resolve(typeof response === "function" ? response() : response);
  });

  return { fn: fn as unknown as typeof fetch, calls };
}

describe("StatusUpdater", () => {
  describe("updateOrchestrator", () => {
    test("POSTs correct payload to internal status endpoint", async () => {
      const { fn, calls } = makeMockFetch();
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateOrchestrator("in_progress");

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://worker.example.com/api/internal/status");
      expect(calls[0].opts.method).toBe("POST");

      const headers = calls[0].opts.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Internal-Key"]).toBe("api-key-test");

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.ticketUUID).toBe("ticket-uuid-123");
      expect(body.status).toBe("in_progress");
      expect(body.pr_url).toBeUndefined();
    });

    test("includes pr_url when provided", async () => {
      const { fn, calls } = makeMockFetch();
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateOrchestrator("pr_open", "https://github.com/org/repo/pull/1");

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.pr_url).toBe("https://github.com/org/repo/pull/1");
    });

    test("does not throw on fetch error", async () => {
      const fn = mock(() => Promise.reject(new Error("network error"))) as unknown as typeof fetch;
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      // Should not throw
      await updater.updateOrchestrator("failed");
    });
  });

  describe("updateLinear", () => {
    function makeLinearFetch() {
      const stateQueryResponse = new Response(
        JSON.stringify({
          data: {
            issue: {
              team: {
                states: {
                  nodes: [
                    { id: "state-1", name: "Todo" },
                    { id: "state-2", name: "In Progress" },
                    { id: "state-3", name: "In Review" },
                    { id: "state-4", name: "Done" },
                    { id: "state-5", name: "Canceled" },
                  ],
                },
              },
            },
          },
        }),
        { status: 200 },
      );

      const mutationResponse = new Response(
        JSON.stringify({
          data: { issueUpdate: { success: true, issue: { id: "issue-1", state: { name: "In Progress" } } } },
        }),
        { status: 200 },
      );

      return makeMockFetch([stateQueryResponse, mutationResponse]);
    }

    test("queries workflow states then mutates to matching state", async () => {
      const { fn, calls } = makeLinearFetch();
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateLinear("in_progress", "issue-abc");

      // Two calls: query + mutation
      expect(calls).toHaveLength(2);

      // First call: state query
      expect(calls[0].url).toBe("https://api.linear.app/graphql");
      const queryBody = JSON.parse(calls[0].opts.body as string);
      expect(queryBody.variables.issueId).toBe("issue-abc");
      expect(queryBody.query).toContain("issue(id: $issueId)");

      // Second call: mutation
      const mutationBody = JSON.parse(calls[1].opts.body as string);
      expect(mutationBody.variables.issueId).toBe("issue-abc");
      expect(mutationBody.variables.stateId).toBe("state-2"); // "In Progress"
      expect(mutationBody.query).toContain("issueUpdate");
    });

    test("maps pr_open to In Review state", async () => {
      const { fn, calls } = makeLinearFetch();
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateLinear("pr_open", "issue-abc");

      const mutationBody = JSON.parse(calls[1].opts.body as string);
      expect(mutationBody.variables.stateId).toBe("state-3"); // "In Review"
    });

    test("maps merged to Done state", async () => {
      const { fn, calls } = makeLinearFetch();
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateLinear("merged", "issue-abc");

      const mutationBody = JSON.parse(calls[1].opts.body as string);
      expect(mutationBody.variables.stateId).toBe("state-4"); // "Done"
    });

    test("maps failed to Canceled state", async () => {
      const { fn, calls } = makeLinearFetch();
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateLinear("failed", "issue-abc");

      const mutationBody = JSON.parse(calls[1].opts.body as string);
      expect(mutationBody.variables.stateId).toBe("state-5"); // "Canceled"
    });

    test("skips when no linearAppToken", async () => {
      const { fn, calls } = makeMockFetch();
      const updater = new StatusUpdater(makeConfig({ linearAppToken: undefined, fetchFn: fn }));

      await updater.updateLinear("in_progress", "issue-abc");

      expect(calls).toHaveLength(0);
    });

    test("skips empty linearAppToken", async () => {
      const { fn, calls } = makeMockFetch();
      const updater = new StatusUpdater(makeConfig({ linearAppToken: "", fetchFn: fn }));

      await updater.updateLinear("in_progress", "issue-abc");

      expect(calls).toHaveLength(0);
    });

    test("does not mutate when target state not found", async () => {
      const noMatchResponse = new Response(
        JSON.stringify({
          data: {
            issue: {
              team: {
                states: {
                  nodes: [{ id: "state-1", name: "Backlog" }],
                },
              },
            },
          },
        }),
        { status: 200 },
      );
      const { fn, calls } = makeMockFetch([noMatchResponse]);
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateLinear("in_progress", "issue-abc");

      // Only the query, no mutation
      expect(calls).toHaveLength(1);
    });

    test("includes Authorization header with Bearer token", async () => {
      const { fn, calls } = makeLinearFetch();
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateLinear("in_progress", "issue-abc");

      const headers = calls[0].opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer lin-test-token");
    });
  });

  describe("updateSlackStatus", () => {
    test("sends chat.update with correct format for in_progress", async () => {
      const slackResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
      const { fn, calls } = makeMockFetch([slackResponse]);
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateSlackStatus("in_progress");

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://slack.com/api/chat.update");

      const headers = calls[0].opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer xoxb-test");

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.channel).toBe("#test-channel");
      expect(body.ts).toBe("1234567890.123456");
      expect(body.text).toBe("⏳ IN PROGRESS - PE-42: Fix the login bug");
    });

    test("shows checkmark for merged status", async () => {
      const slackResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
      const { fn, calls } = makeMockFetch([slackResponse]);
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateSlackStatus("merged");

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.text).toContain("✅ DONE");
    });

    test("shows eyes emoji for pr_open", async () => {
      const slackResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
      const { fn, calls } = makeMockFetch([slackResponse]);
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateSlackStatus("pr_open");

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.text).toContain("👀 IN REVIEW");
    });

    test("shows X for failed status", async () => {
      const slackResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
      const { fn, calls } = makeMockFetch([slackResponse]);
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateSlackStatus("failed");

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.text).toContain("❌ FAILED");
    });

    test("skips when no slackThreadTs", async () => {
      const { fn, calls } = makeMockFetch();
      const updater = new StatusUpdater(makeConfig({ slackThreadTs: undefined, fetchFn: fn }));

      await updater.updateSlackStatus("in_progress");

      expect(calls).toHaveLength(0);
    });

    test("skips when slackThreadTs is empty string", async () => {
      const { fn, calls } = makeMockFetch();
      const updater = new StatusUpdater(makeConfig({ slackThreadTs: "", fetchFn: fn }));

      await updater.updateSlackStatus("in_progress");

      expect(calls).toHaveLength(0);
    });

    test("uses ticketUUID as fallback identifier", async () => {
      const slackResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
      const { fn, calls } = makeMockFetch([slackResponse]);
      const updater = new StatusUpdater(
        makeConfig({ ticketIdentifier: undefined, fetchFn: fn }),
      );

      await updater.updateSlackStatus("in_progress");

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.text).toContain("ticket-uuid-123:");
    });

    test("truncates long titles to 100 chars", async () => {
      const longTitle = "A".repeat(150);
      const slackResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
      const { fn, calls } = makeMockFetch([slackResponse]);
      const updater = new StatusUpdater(makeConfig({ ticketTitle: longTitle, fetchFn: fn }));

      await updater.updateSlackStatus("in_progress");

      const body = JSON.parse(calls[0].opts.body as string);
      // Should be truncated to 100 chars + "..."
      expect(body.text).toContain("A".repeat(100) + "...");
    });

    test("truncates at first sentence if under 100 chars", async () => {
      const titleWithSentence = "Fix the critical login bug. Then also update the dashboard and refactor the entire authentication system to use OAuth 2.0.";
      const slackResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
      const { fn, calls } = makeMockFetch([slackResponse]);
      const updater = new StatusUpdater(makeConfig({ ticketTitle: titleWithSentence, fetchFn: fn }));

      await updater.updateSlackStatus("in_progress");

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.text).toContain("Fix the critical login bug.");
      expect(body.text).not.toContain("refactor");
    });

    test("defaults to 'Working on task' when no title", async () => {
      const slackResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
      const { fn, calls } = makeMockFetch([slackResponse]);
      const updater = new StatusUpdater(makeConfig({ ticketTitle: undefined, fetchFn: fn }));

      await updater.updateSlackStatus("in_progress");

      const body = JSON.parse(calls[0].opts.body as string);
      expect(body.text).toContain("Working on task");
    });

    test("does not throw on fetch error", async () => {
      const fn = mock(() => Promise.reject(new Error("network error"))) as unknown as typeof fetch;
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateSlackStatus("in_progress");
    });
  });

  describe("updateAll", () => {
    test("calls all three methods in parallel", async () => {
      // Mock responses: orchestrator, Linear query, Linear mutation, Slack
      const responses = [
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
        new Response(
          JSON.stringify({
            data: {
              issue: {
                team: {
                  states: {
                    nodes: [
                      { id: "state-2", name: "In Progress" },
                      { id: "state-4", name: "Done" },
                    ],
                  },
                },
              },
            },
          }),
          { status: 200 },
        ),
        new Response(
          JSON.stringify({ data: { issueUpdate: { success: true } } }),
          { status: 200 },
        ),
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ];
      const { fn, calls } = makeMockFetch(responses);
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateAll("in_progress");

      // Orchestrator + Linear query + Linear mutation + Slack = 4 calls
      expect(calls).toHaveLength(4);

      const urls = calls.map((c) => c.url);
      expect(urls).toContain("https://worker.example.com/api/internal/status");
      expect(urls).toContain("https://api.linear.app/graphql");
      expect(urls).toContain("https://slack.com/api/chat.update");
    });

    test("passes pr_url to orchestrator", async () => {
      const responses = [
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
        new Response(
          JSON.stringify({
            data: {
              issue: {
                team: { states: { nodes: [{ id: "s1", name: "In Review" }] } },
              },
            },
          }),
          { status: 200 },
        ),
        new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 }),
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ];
      const { fn, calls } = makeMockFetch(responses);
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateAll("pr_open", { pr_url: "https://github.com/org/repo/pull/5" });

      const orchestratorCall = calls.find((c) =>
        c.url.includes("/api/internal/status"),
      );
      const body = JSON.parse(orchestratorCall!.opts.body as string);
      expect(body.pr_url).toBe("https://github.com/org/repo/pull/5");
    });

    test("uses linearTicketId override when provided", async () => {
      const responses = [
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
        new Response(
          JSON.stringify({
            data: {
              issue: {
                team: { states: { nodes: [{ id: "s1", name: "In Progress" }] } },
              },
            },
          }),
          { status: 200 },
        ),
        new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 }),
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ];
      const { fn, calls } = makeMockFetch(responses);
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateAll("in_progress", { linearTicketId: "custom-ticket-id" });

      const linearCall = calls.find(
        (c) => c.url === "https://api.linear.app/graphql",
      );
      const body = JSON.parse(linearCall!.opts.body as string);
      expect(body.variables.issueId).toBe("custom-ticket-id");
    });

    test("defaults linearTicketId to ticketUUID", async () => {
      const responses = [
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
        new Response(
          JSON.stringify({
            data: {
              issue: {
                team: { states: { nodes: [{ id: "s1", name: "In Progress" }] } },
              },
            },
          }),
          { status: 200 },
        ),
        new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 }),
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ];
      const { fn, calls } = makeMockFetch(responses);
      const updater = new StatusUpdater(makeConfig({ fetchFn: fn }));

      await updater.updateAll("in_progress");

      const linearCall = calls.find(
        (c) => c.url === "https://api.linear.app/graphql",
      );
      const body = JSON.parse(linearCall!.opts.body as string);
      expect(body.variables.issueId).toBe("ticket-uuid-123");
    });

    test("skips Linear and Slack when tokens/ts missing", async () => {
      const { fn, calls } = makeMockFetch();
      const updater = new StatusUpdater(
        makeConfig({
          linearAppToken: undefined,
          slackThreadTs: undefined,
          fetchFn: fn,
        }),
      );

      await updater.updateAll("in_progress");

      // Only orchestrator call
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain("/api/internal/status");
    });
  });
});
