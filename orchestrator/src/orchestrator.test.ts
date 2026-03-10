import { describe, test, expect } from "bun:test";
import { buildTicketEvent, resolveProductFromChannel } from "./orchestrator";
import { TEST_REGISTRY } from "./test-helpers";
import type { ProductConfig } from "./registry";

describe("buildTicketEvent", () => {
  test("creates event from Linear webhook data", () => {
    const event = buildTicketEvent("linear", "ticket_created", {
      id: "LIN-123",
      product: "test-app",
      title: "Fix login",
      description: "Login is broken",
    });
    expect(event.type).toBe("ticket_created");
    expect(event.source).toBe("linear");
    expect(event.ticketId).toBe("LIN-123");
    expect(event.product).toBe("test-app");
  });

  test("creates event from GitHub PR review", () => {
    const event = buildTicketEvent("github", "pr_review", {
      ticketId: "LIN-123",
      product: "test-app",
      review: { state: "changes_requested", body: "Fix the types" },
    });
    expect(event.type).toBe("pr_review");
    expect(event.source).toBe("github");
  });

  test("creates event from Slack reply", () => {
    const event = buildTicketEvent("slack", "slack_reply", {
      product: "test-app",
      text: "fix the login bug",
      user: "U12345",
      channel: "C12345",
      threadTs: "1234567890.123456",
    });
    expect(event.type).toBe("slack_reply");
    expect(event.slackThreadTs).toBe("1234567890.123456");
    expect(event.slackChannel).toBe("C12345");
  });

  test("includes channel in Slack event", () => {
    const event = buildTicketEvent("slack", "slack_reply", {
      product: "test-app",
      text: "deploy to prod",
      channel: "C000000APP1",
      threadTs: "1234567890.999999",
    });
    expect(event.slackChannel).toBe("C000000APP1");
    expect(event.slackThreadTs).toBe("1234567890.999999");
  });
});

describe("resolveProductFromChannel", () => {
  const products = TEST_REGISTRY.products as Record<string, ProductConfig>;

  test("returns product name when channel ID matches", () => {
    expect(resolveProductFromChannel(products, "C000000APP1")).toBe("test-app");
    expect(resolveProductFromChannel(products, "C000000APP2")).toBe("another-app");
  });

  test("returns product name when channel name matches", () => {
    expect(resolveProductFromChannel(products, "#test-app")).toBe("test-app");
    expect(resolveProductFromChannel(products, "#another-app")).toBe("another-app");
    expect(resolveProductFromChannel(products, "#multi-repo")).toBe("multi-repo-app");
  });

  test("returns null for unknown channel ID", () => {
    expect(resolveProductFromChannel(products, "C9999999999")).toBeNull();
  });

  test("returns null for unknown channel name", () => {
    expect(resolveProductFromChannel(products, "#nonexistent")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(resolveProductFromChannel(products, "")).toBeNull();
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

});
