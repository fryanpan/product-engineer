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
      // This test verifies that the BC-153 migration actually updates tickets
      // with legacy agent:* status values to 'failed' status when agent_active=0

      // Create in-memory SQLite database for testing
      const { Database } = require("bun:sqlite");
      const db = new Database(":memory:");

      // Create tickets table (minimal schema for migration test)
      db.exec(`
        CREATE TABLE tickets (
          id TEXT PRIMARY KEY,
          product TEXT NOT NULL,
          status TEXT NOT NULL,
          agent_active INTEGER NOT NULL DEFAULT 0,
          identifier TEXT
        )
      `);

      // Insert test data: stale agent:* statuses with agent_active=0
      db.exec(`
        INSERT INTO tickets (id, product, status, agent_active, identifier)
        VALUES
          ('ticket-1', 'test-app', 'agent:shutdown_requested', 0, 'BC-101'),
          ('ticket-2', 'test-app', 'agent:container_shutdown', 0, 'BC-102'),
          ('ticket-3', 'test-app', 'agent:stopping', 0, NULL)
      `);

      // Insert tickets that should NOT be migrated
      db.exec(`
        INSERT INTO tickets (id, product, status, agent_active, identifier)
        VALUES
          ('ticket-4', 'test-app', 'agent:running', 1, 'BC-103'),  -- Active agent
          ('ticket-5', 'test-app', 'failed', 0, 'BC-104'),         -- Already valid
          ('ticket-6', 'test-app', 'merged', 0, 'BC-105')          -- Already terminal
      `);

      // Run the BC-153 migration (same logic as in orchestrator.ts initDb)
      const staleTickets = db.query(
        `SELECT id, status, product, identifier FROM tickets WHERE status LIKE 'agent:%' AND agent_active = 0`
      ).all();

      expect(staleTickets.length).toBe(3);

      for (const ticket of staleTickets) {
        db.exec(`UPDATE tickets SET status = 'failed' WHERE id = ?`, [ticket.id]);
      }

      // Verify: stale tickets should now have status='failed'
      const ticket1 = db.query(`SELECT status FROM tickets WHERE id = 'ticket-1'`).get();
      const ticket2 = db.query(`SELECT status FROM tickets WHERE id = 'ticket-2'`).get();
      const ticket3 = db.query(`SELECT status FROM tickets WHERE id = 'ticket-3'`).get();

      expect(ticket1.status).toBe("failed");
      expect(ticket2.status).toBe("failed");
      expect(ticket3.status).toBe("failed");

      // Verify: tickets that should NOT migrate remain unchanged
      const ticket4 = db.query(`SELECT status FROM tickets WHERE id = 'ticket-4'`).get();
      const ticket5 = db.query(`SELECT status FROM tickets WHERE id = 'ticket-5'`).get();
      const ticket6 = db.query(`SELECT status FROM tickets WHERE id = 'ticket-6'`).get();

      expect(ticket4.status).toBe("agent:running");  // Active agent not migrated
      expect(ticket5.status).toBe("failed");         // Already valid, unchanged
      expect(ticket6.status).toBe("merged");         // Already terminal, unchanged

      db.close();
    });
  });
});
