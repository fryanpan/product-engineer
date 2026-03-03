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
  test("returns product name when channel ID matches my-app", () => {
    expect(resolveProductFromChannel("C000000APP1")).toBe("my-app");
  });

  test("returns product name when channel ID matches my-other-app", () => {
    expect(resolveProductFromChannel("C000000APP2")).toBe("my-other-app");
  });

  test("returns product name when channel name matches my-app", () => {
    expect(resolveProductFromChannel("#my-app")).toBe("my-app");
  });

  test("returns product name when channel name matches my-other-app", () => {
    expect(resolveProductFromChannel("#my-other-app")).toBe("my-other-app");
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
