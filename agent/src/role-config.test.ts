import { describe, expect, test } from "bun:test";
import { resolveRoleConfig } from "./role-config";

describe("resolveRoleConfig", () => {
  describe("ticket-agent (default)", () => {
    test("undefined agentRole resolves to ticket-agent", () => {
      const config = resolveRoleConfig(undefined, undefined);
      expect(config.role).toBe("ticket-agent");
      expect(config.isProjectLead).toBe(false);
      expect(config.isConductor).toBe(false);
      expect(config.maxTurns).toBe(200);
      expect(config.sessionTimeoutMs).toBe(2 * 60 * 60 * 1000);
      expect(config.idleTimeoutMs).toBe(30 * 60 * 1000);
      expect(config.persistAfterSession).toBe(false);
      expect(config.exitOnError).toBe(true);
      expect(config.peRepoRequired).toBe(false);
      expect(config.peRepo).toBe("fryanpan/product-engineer");
    });

    test("unrecognized agentRole resolves to ticket-agent", () => {
      const config = resolveRoleConfig("unknown");
      expect(config.role).toBe("ticket-agent");
      expect(config.isProjectLead).toBe(false);
    });
  });

  describe("ticket-agent with research mode", () => {
    test("research mode extends timeouts", () => {
      const config = resolveRoleConfig(undefined, "research");
      expect(config.role).toBe("ticket-agent");
      expect(config.sessionTimeoutMs).toBe(4 * 60 * 60 * 1000);
      expect(config.idleTimeoutMs).toBe(60 * 60 * 1000); // 1 hour idle before auto-suspend
    });

    test("research mode persists after session for followup", () => {
      const config = resolveRoleConfig(undefined, "research");
      expect(config.maxTurns).toBe(200);
      expect(config.persistAfterSession).toBe(true); // stays alive for thread replies
      expect(config.exitOnError).toBe(true);
      expect(config.peRepoRequired).toBe(false);
    });
  });

  describe("project-lead", () => {
    test("project-lead has infinite timeouts", () => {
      const config = resolveRoleConfig("project-lead");
      expect(config.role).toBe("project-lead");
      expect(config.isProjectLead).toBe(true);
      expect(config.isConductor).toBe(false);
      expect(config.maxTurns).toBe(1000);
      expect(config.sessionTimeoutMs).toBe(Infinity);
      expect(config.idleTimeoutMs).toBe(Infinity);
      expect(config.persistAfterSession).toBe(true);
      expect(config.exitOnError).toBe(false);
      expect(config.peRepoRequired).toBe(true);
    });

    test("research mode is ignored for project-lead", () => {
      const config = resolveRoleConfig("project-lead", "research");
      expect(config.sessionTimeoutMs).toBe(Infinity);
      expect(config.idleTimeoutMs).toBe(Infinity);
    });
  });

  describe("conductor", () => {
    test("conductor is a project-lead with isConductor flag", () => {
      const config = resolveRoleConfig("conductor");
      expect(config.role).toBe("conductor");
      expect(config.isProjectLead).toBe(true);
      expect(config.isConductor).toBe(true);
      expect(config.maxTurns).toBe(1000);
      expect(config.sessionTimeoutMs).toBe(Infinity);
      expect(config.idleTimeoutMs).toBe(Infinity);
      expect(config.persistAfterSession).toBe(true);
      expect(config.exitOnError).toBe(false);
      expect(config.peRepoRequired).toBe(true);
    });

    test("research mode is ignored for conductor", () => {
      const config = resolveRoleConfig("conductor", "research");
      expect(config.sessionTimeoutMs).toBe(Infinity);
      expect(config.idleTimeoutMs).toBe(Infinity);
    });
  });

  describe("peRepo", () => {
    test("all roles include peRepo", () => {
      const ticket = resolveRoleConfig();
      const lead = resolveRoleConfig("project-lead");
      const conductor = resolveRoleConfig("conductor");
      expect(ticket.peRepo).toBe("fryanpan/product-engineer");
      expect(lead.peRepo).toBe("fryanpan/product-engineer");
      expect(conductor.peRepo).toBe("fryanpan/product-engineer");
    });
  });
});
