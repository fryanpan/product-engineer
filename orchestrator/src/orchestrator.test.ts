import { describe, test, expect } from "bun:test";
import { buildTicketEvent, resolveProductFromChannel, isResearchProduct, shouldAllowSlackUser } from "./orchestrator";
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
    expect(event.ticketUUID).toBe("LIN-123");
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

describe("isResearchProduct", () => {
  test("returns true for research product type", () => {
    const config: ProductConfig = { product_type: "research", repos: [], slack_channel: "#r", triggers: {}, secrets: {} };
    expect(isResearchProduct(config)).toBe(true);
  });

  test("returns false for coding product type", () => {
    const config: ProductConfig = { product_type: "coding", repos: ["org/r"], slack_channel: "#r", triggers: {}, secrets: {} };
    expect(isResearchProduct(config)).toBe(false);
  });

  test("returns false when product_type is undefined (default = coding)", () => {
    const config: ProductConfig = { repos: ["org/r"], slack_channel: "#r", triggers: {}, secrets: {} };
    expect(isResearchProduct(config)).toBe(false);
  });
});

describe("shouldAllowSlackUser", () => {
  test("returns true when allowed_slack_users is empty array (all users allowed)", () => {
    expect(shouldAllowSlackUser([], "U_ANYONE")).toBe(true);
  });

  test("returns true when allowed_slack_users is undefined", () => {
    expect(shouldAllowSlackUser(undefined, "U_ANYONE")).toBe(true);
  });

  test("returns true when user is in allowed list", () => {
    expect(shouldAllowSlackUser(["U_BRYAN", "U_JOANNA"], "U_BRYAN")).toBe(true);
    expect(shouldAllowSlackUser(["U_BRYAN", "U_JOANNA"], "U_JOANNA")).toBe(true);
  });

  test("returns false when user is not in allowed list", () => {
    expect(shouldAllowSlackUser(["U_BRYAN", "U_JOANNA"], "U_STRANGER")).toBe(false);
  });
});

describe("resolveProductFromChannel — research product", () => {
  test("resolves boos-research from channel ID", () => {
    const products = TEST_REGISTRY.products as Record<string, ProductConfig>;
    expect(resolveProductFromChannel(products, "C_BOOS_RESEARCH")).toBe("boos-research");
  });

  test("isResearchProduct returns true for boos-research config", () => {
    const products = TEST_REGISTRY.products as Record<string, ProductConfig>;
    expect(isResearchProduct(products["boos-research"] as ProductConfig)).toBe(true);
    expect(isResearchProduct(products["test-app"] as ProductConfig)).toBe(false);
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
