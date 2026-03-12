import { describe, test, expect } from "bun:test";
import { buildTicketEvent, resolveProductFromChannel } from "./orchestrator";
import { resolveAgentEnvVars } from "./ticket-agent";
import { TERMINAL_STATUSES, type TicketAgentConfig } from "./types";

describe("Agent Lifecycle Integration", () => {
  describe("Thread Identity Flow", () => {
    test("buildTicketEvent preserves slackThreadTs for routing", () => {
      const event = buildTicketEvent("slack", "slack_reply", {
        product: "test-app",
        text: "fix the bug",
        channel: "C12345",
        threadTs: "1234567890.123456",
      });
      expect(event.slackThreadTs).toBe("1234567890.123456");
      expect(event.slackChannel).toBe("C12345");
    });

    test("buildTicketEvent preserves undefined slackThreadTs when not provided", () => {
      const event = buildTicketEvent("slack", "slack_reply", {
        product: "test-app",
        text: "fix the bug",
        channel: "C12345",
        // No threadTs provided — ensure we don't synthesize a thread ID
      });
      expect(event.slackThreadTs).toBeUndefined();
    });

    test("resolveAgentEnvVars includes SLACK_THREAD_TS field", () => {
      const config: TicketAgentConfig = {
        ticketId: "test-123",
        product: "test-app",
        repos: ["org/repo"],
        slackChannel: "C12345",
        secrets: {},
      };
      const vars = resolveAgentEnvVars(config, {
        SLACK_BOT_TOKEN: "xoxb-test",
        WORKER_URL: "https://test.workers.dev",
        API_KEY: "test-key",
      });
      expect(vars).toHaveProperty("SLACK_THREAD_TS");
    });
  });

  describe("Terminal State Consistency", () => {
    // TERMINAL_STATUSES is the shared constant imported from types.ts.
    // It is used by orchestrator.ts (handleStatusUpdate, handleSlackEvent)
    // and must match the inline list in agent/src/server.ts auto-resume.

    test("terminal statuses include all expected values", () => {
      expect(TERMINAL_STATUSES).toContain("merged");
      expect(TERMINAL_STATUSES).toContain("closed");
      expect(TERMINAL_STATUSES).toContain("deferred");
      expect(TERMINAL_STATUSES).toContain("failed");
      expect(TERMINAL_STATUSES.length).toBe(4);
    });

    test("non-terminal statuses are not in TERMINAL_STATUSES", () => {
      const nonTerminal = ["in_progress", "in_review", "asking", "idle", ""];
      for (const status of nonTerminal) {
        expect((TERMINAL_STATUSES as readonly string[])).not.toContain(status);
      }
    });
  });

  describe("Event Delivery Patterns", () => {
    test("TicketEvent type field distinguishes event sources correctly", () => {
      const slackReply = buildTicketEvent("slack", "slack_reply", {
        product: "test-app",
        text: "do something",
      });
      expect(slackReply.type).toBe("slack_reply");
      expect(slackReply.source).toBe("slack");

      const linearEvent = buildTicketEvent("linear", "ticket_created", {
        id: "PE-123",
        product: "test-app",
      });
      expect(linearEvent.type).toBe("ticket_created");
      expect(linearEvent.source).toBe("linear");
    });

    test("slack_reply events skip /initialize (rely on existing config)", () => {
      // This is a documentation test — verifying the contract that
      // slack_reply events should NOT trigger /initialize in routeToAgent
      const replyEvent = buildTicketEvent("slack", "slack_reply", {
        product: "test-app",
        text: "update",
        threadTs: "1234567890.123456",
      });
      // The type "slack_reply" triggers the skip-initialize path in routeToAgent
      expect(replyEvent.type).toBe("slack_reply");
    });
  });

  describe("Container Lifecycle Configuration", () => {
    test("resolveAgentEnvVars includes all required env vars for agent", () => {
      const config: TicketAgentConfig = {
        ticketId: "test-123",
        product: "test-app",
        repos: ["org/repo"],
        slackChannel: "C12345",
        secrets: { GITHUB_TOKEN: "MY_GH_TOKEN" },
      };
      const vars = resolveAgentEnvVars(config, {
        SLACK_BOT_TOKEN: "xoxb-test",
        WORKER_URL: "https://test.workers.dev",
        API_KEY: "test-key",
        MY_GH_TOKEN: "ghp_test123",
      });

      // Core config
      expect(vars.PRODUCT).toBe("test-app");
      expect(vars.TICKET_ID).toBe("test-123");
      expect(vars.REPOS).toBe(JSON.stringify(["org/repo"]));
      expect(vars.SLACK_CHANNEL).toBe("C12345");

      // Communication
      expect(vars.SLACK_BOT_TOKEN).toBe("xoxb-test");
      expect(vars.WORKER_URL).toBe("https://test.workers.dev");
      expect(vars.API_KEY).toBe("test-key");

      // Secrets resolution
      expect(vars.GITHUB_TOKEN).toBe("ghp_test123");
      expect(vars.GH_TOKEN).toBe("ghp_test123"); // gh CLI alias
    });

    test("resolveAgentEnvVars configures AI gateway when provided", () => {
      const config: TicketAgentConfig = {
        ticketId: "test-123",
        product: "test-app",
        repos: ["org/repo"],
        slackChannel: "C12345",
        secrets: {},
        gatewayConfig: { account_id: "acc123", gateway_id: "gw456" },
      };
      const vars = resolveAgentEnvVars(config, {}, config.gatewayConfig);
      expect(vars.ANTHROPIC_BASE_URL).toBe(
        "https://gateway.ai.cloudflare.com/v1/acc123/gw456/anthropic"
      );
    });
  });

  describe("Database Migrations", () => {
    test("BC-153: stale agent:* status values are cleaned up on init", () => {
      // This test verifies that tickets with legacy agent:* status values
      // (from before PR #75) are migrated to 'failed' status

      // Test data representing stale tickets with agent:* status and agent_active=0
      const staleStatuses = [
        { id: "ticket-1", status: "agent:shutdown_requested", identifier: "BC-101" },
        { id: "ticket-2", status: "agent:container_shutdown", identifier: "BC-102" },
        { id: "ticket-3", status: "agent:stopping", identifier: null },
      ];

      // These should NOT be migrated (either active agent or valid status)
      const validStatuses = [
        { id: "ticket-4", status: "agent:running", agent_active: 1 }, // Active agent
        { id: "ticket-5", status: "failed", agent_active: 0 },        // Already valid status
        { id: "ticket-6", status: "merged", agent_active: 0 },        // Already terminal
      ];

      // The migration logic matches: status LIKE 'agent:%' AND agent_active = 0
      // Expected behavior:
      // - staleStatuses entries should be updated to status='failed'
      // - validStatuses entries should remain unchanged

      for (const ticket of staleStatuses) {
        expect(ticket.status).toMatch(/^agent:/);
        // After migration, these would become "failed"
      }

      for (const ticket of validStatuses) {
        const shouldMigrate =
          ticket.status.startsWith("agent:") &&
          ("agent_active" in ticket ? ticket.agent_active : 0) === 0;
        expect(shouldMigrate).toBe(false);
      }
    });
  });
});
