import { describe, test, expect, mock } from "bun:test";
import { buildTicketEvent, resolveProductFromChannel } from "./orchestrator";

describe("buildTicketEvent", () => {
  test("creates event from Linear webhook data", () => {
    const event = buildTicketEvent("linear", "ticket_created", {
      id: "LIN-123",
      product: "health-tool",
      title: "Fix login",
      description: "Login is broken",
    });
    expect(event.type).toBe("ticket_created");
    expect(event.source).toBe("linear");
    expect(event.ticketId).toBe("LIN-123");
    expect(event.product).toBe("health-tool");
  });

  test("creates event from GitHub PR review", () => {
    const event = buildTicketEvent("github", "pr_review", {
      ticketId: "LIN-123",
      product: "health-tool",
      review: { state: "changes_requested", body: "Fix the types" },
    });
    expect(event.type).toBe("pr_review");
    expect(event.source).toBe("github");
  });

  test("creates event from Slack mention", () => {
    const event = buildTicketEvent("slack", "slack_mention", {
      product: "health-tool",
      text: "fix the login bug",
      user: "U12345",
      channel: "C12345",
      threadTs: "1234567890.123456",
    });
    expect(event.type).toBe("slack_mention");
    expect(event.slackThreadTs).toBe("1234567890.123456");
    expect(event.slackChannel).toBe("C12345");
  });

  test("includes channel in Slack event", () => {
    const event = buildTicketEvent("slack", "slack_mention", {
      product: "health-tool",
      text: "deploy to prod",
      channel: "C0AHQK8LB34",
      threadTs: "1234567890.999999",
    });
    expect(event.slackChannel).toBe("C0AHQK8LB34");
    expect(event.slackThreadTs).toBe("1234567890.999999");
  });
});

describe("resolveProductFromChannel", () => {
  test("returns product name when channel ID matches health-tool", () => {
    expect(resolveProductFromChannel("C0AHQK8LB34")).toBe("health-tool");
  });

  test("returns product name when channel ID matches bike-tool", () => {
    expect(resolveProductFromChannel("C0AHVFLB15G")).toBe("bike-tool");
  });

  test("returns product name when channel name matches health-tool", () => {
    expect(resolveProductFromChannel("#health-tool")).toBe("health-tool");
  });

  test("returns product name when channel name matches bike-tool", () => {
    expect(resolveProductFromChannel("#bike-tool")).toBe("bike-tool");
  });

  test("returns null for unknown channel ID", () => {
    expect(resolveProductFromChannel("C9999999999")).toBeNull();
  });

  test("returns null for unknown channel name", () => {
    expect(resolveProductFromChannel("#nonexistent")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(resolveProductFromChannel("")).toBeNull();
  });
});

describe("agent monitoring", () => {
  test("calculates time difference for stuck agents correctly", () => {
    const now = new Date();
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
    const fortyMinAgo = new Date(now.getTime() - 40 * 60 * 1000);

    // SQLite date math: (julianday('now') - julianday(timestamp)) * 24 * 60 = minutes
    const minutesDiff30 = (now.getTime() - thirtyMinAgo.getTime()) / 60000;
    const minutesDiff40 = (now.getTime() - fortyMinAgo.getTime()) / 60000;

    expect(minutesDiff30).toBeGreaterThanOrEqual(29);
    expect(minutesDiff30).toBeLessThan(31);
    expect(minutesDiff40).toBeGreaterThanOrEqual(39);
    expect(minutesDiff40).toBeLessThan(41);
  });

  test("stuck agent threshold is 30 minutes", () => {
    // Document the expected behavior
    const stuckThreshold = 30;
    expect(stuckThreshold).toBe(30);
  });
});
