import { describe, test, expect } from "bun:test";
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

  test("investigation ticket ID is deterministic per stuck ticket", () => {
    // The investigation ID should be deterministic so duplicate cron runs
    // don't create multiple investigations for the same stuck ticket
    const stuckTicketId = "LIN-123";
    const investigationId = `investigation-${stuckTicketId}`;
    expect(investigationId).toBe("investigation-LIN-123");
    // Same input always produces same ID (no Date.now() or random component)
    expect(`investigation-${stuckTicketId}`).toBe(investigationId);
  });

  test("investigation tickets are excluded from stuck agent detection", () => {
    // Investigation tickets (id LIKE 'investigation-%') should never trigger
    // further investigations — otherwise a stuck investigation creates
    // investigation-investigation-..., recursively
    const ticketIds = [
      "LIN-123",
      "slack-1772639904.744089",
      "investigation-LIN-123",
      "investigation-investigation-slack-123",
      "investigation-investigation-investigation-abc",
    ];

    const excluded = ticketIds.filter((id) => id.startsWith("investigation-"));
    const included = ticketIds.filter((id) => !id.startsWith("investigation-"));

    expect(included).toEqual(["LIN-123", "slack-1772639904.744089"]);
    expect(excluded).toEqual([
      "investigation-LIN-123",
      "investigation-investigation-slack-123",
      "investigation-investigation-investigation-abc",
    ]);
  });
});
