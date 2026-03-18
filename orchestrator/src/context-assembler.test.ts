import { describe, it, expect } from "bun:test";
import { ContextAssembler } from "./context-assembler";

describe("ContextAssembler", () => {
  const mockSqlExec = (sql: string) => {
    // Return empty results for any query
    return { toArray: () => [] };
  };

  it("assembles ticket review context with correct shape", async () => {
    const assembler = new ContextAssembler({
      sqlExec: mockSqlExec as any,
      slackBotToken: "xoxb-test",
      linearAppToken: "lin_test",
      githubTokens: {},
    });

    const ctx = await assembler.forTicketReview({
      ticketUUID: "abc-123",
      identifier: "PE-42",
      title: "Fix button",
      description: "Make it green",
      priority: 3,
      labels: ["bug"],
      product: "health-tool",
      repos: ["acme-org/sample-app"],
      slackThreadTs: null,
      slackChannel: null,
    });

    expect(ctx.identifier).toBe("PE-42");
    expect(ctx.title).toBe("Fix button");
    expect(ctx.description).toBe("Make it green");
    expect(ctx.priority).toBe("Normal");
    expect(ctx.labels).toBe("bug");
    expect(ctx.productName).toBe("health-tool");
    expect(ctx.repos).toBe("acme-org/sample-app");
    expect(ctx.activeTickets).toBeArray();
    expect(ctx.activeCount).toBe(0);
    expect(ctx.linearComments).toBeArray();
    expect(ctx.slackThread).toBeArray();
  });

  it("converts priority numbers to labels", async () => {
    const assembler = new ContextAssembler({
      sqlExec: mockSqlExec as any,
      slackBotToken: "xoxb-test",
      linearAppToken: "lin_test",
      githubTokens: {},
    });

    // Test all priority levels
    for (const [num, label] of [[0, "None"], [1, "Urgent"], [2, "High"], [3, "Normal"], [4, "Low"]] as const) {
      const ctx = await assembler.forTicketReview({
        ticketUUID: "t", identifier: null, title: "", description: "",
        priority: num, labels: [], product: "p", repos: [],
        slackThreadTs: null, slackChannel: null,
      });
      expect(ctx.priority).toBe(label);
    }
  });

  it("returns error when PR fetch fails (invalid token)", async () => {
    const assembler = new ContextAssembler({
      sqlExec: mockSqlExec as any,
      slackBotToken: "xoxb-test",
      linearAppToken: "lin_test",
      githubTokens: { "health-tool": "ghp_test" }, // Invalid token will cause API to fail
    });

    const ctx = await assembler.forMergeGate({
      ticketUUID: "abc-123",
      identifier: "PE-42",
      title: "Fix button",
      product: "health-tool",
      pr_url: "https://github.com/org/repo/pull/1",
      branch: "ticket/abc-123",
      repo: "acme-org/sample-app",
    });

    // Should return error indicator instead of bogus data
    expect(ctx.error).toBe("pr_fetch_failed");
    expect(ctx.errorMessage).toContain("Failed to fetch PR details");
    expect(ctx.pr_url).toBe("https://github.com/org/repo/pull/1");
  });

  it("assembles supervisor context", async () => {
    const assembler = new ContextAssembler({
      sqlExec: mockSqlExec as any,
      slackBotToken: "xoxb-test",
      linearAppToken: "lin_test",
      githubTokens: {},
    });

    const ctx = await assembler.forSupervisor();
    expect(ctx.agentCount).toBe(0);
    expect(ctx.agents).toBeArray();
    expect(ctx.stalePRs).toBeArray();
    expect(ctx.queuedTickets).toBeArray();
  });

  it("assembles thread classify context", async () => {
    const assembler = new ContextAssembler({
      sqlExec: mockSqlExec as any,
      slackBotToken: "xoxb-test",
      linearAppToken: "lin_test",
      githubTokens: {},
    });

    const ctx = await assembler.forThreadClassify({
      user: "U12345",
      text: "What's the status?",
      ticketUUID: "abc-123",
      identifier: "PE-42",
      title: "Fix button",
      status: "in_progress",
      agentRunning: true,
    });

    expect(ctx.user).toBe("U12345");
    expect(ctx.text).toBe("What's the status?");
    expect(ctx.agentRunning).toBe("yes");
  });

  it("falls back to uuid when identifier is null", async () => {
    const assembler = new ContextAssembler({
      sqlExec: mockSqlExec as any,
      slackBotToken: "xoxb-test",
      linearAppToken: "lin_test",
      githubTokens: {},
    });

    const ctx = await assembler.forTicketReview({
      ticketUUID: "abc-123",
      identifier: null,
      title: "Fix button",
      description: "",
      priority: 3,
      labels: [],
      product: "health-tool",
      repos: [],
      slackThreadTs: null,
      slackChannel: null,
    });

    expect(ctx.identifier).toBe("abc-123");
  });
});
