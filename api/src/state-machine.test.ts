import { describe, test, expect } from "bun:test";
import { canTransition, isTerminal, applyTransition } from "./state-machine";
import { TERMINAL_STATUSES, type TicketRecord } from "./types";

function makeTicket(overrides: Partial<TicketRecord> = {}): TicketRecord {
  return {
    ticket_uuid: "test-uuid",
    product: "test",
    status: "created",
    slack_thread_ts: null,
    slack_channel: null,
    pr_url: null,
    branch_name: null,
    ticket_id: null,
    title: null,
    agent_active: 0,
    agent_message: null,
    checks_passed: 0,
    last_merge_decision_sha: null,
    transcript_r2_key: null,
    last_heartbeat: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("canTransition", () => {
  test("returns true for valid transition: created → reviewing", () => {
    expect(canTransition("created", "reviewing")).toBe(true);
  });

  test("returns false for invalid transition: created → merged", () => {
    expect(canTransition("created", "merged")).toBe(false);
  });

  test("returns true for self-transition: active → active", () => {
    expect(canTransition("active", "active")).toBe(true);
  });

  test("returns false for any transition out of terminal states", () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(canTransition(terminal, "created")).toBe(false);
      expect(canTransition(terminal, "active")).toBe(false);
    }
  });
});

describe("isTerminal", () => {
  test("identifies terminal states", () => {
    expect(isTerminal("merged")).toBe(true);
    expect(isTerminal("closed")).toBe(true);
    expect(isTerminal("deferred")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
  });

  test("non-terminal states return false", () => {
    expect(isTerminal("created")).toBe(false);
    expect(isTerminal("active")).toBe(false);
    expect(isTerminal("pr_open")).toBe(false);
    expect(isTerminal("spawning")).toBe(false);
  });
});

describe("applyTransition", () => {
  test("valid transition: created → reviewing", () => {
    const ticket = makeTicket({ status: "created" });
    const result = applyTransition(ticket, "reviewing");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("reviewing");
    expect(result!.updated_at).not.toBe(ticket.updated_at);
  });

  test("invalid transition: created → merged returns null", () => {
    const ticket = makeTicket({ status: "created" });
    const result = applyTransition(ticket, "merged");
    expect(result).toBeNull();
  });

  test("terminal states set agent_active=0", () => {
    for (const terminal of TERMINAL_STATUSES) {
      // Find a valid "from" state for this terminal
      const fromState = terminal === "merged" ? "pr_open" : "reviewing";
      const ticket = makeTicket({ status: fromState, agent_active: 1 });
      const result = applyTransition(ticket, terminal);
      expect(result).not.toBeNull();
      expect(result!.agent_active).toBe(0);
    }
  });

  test("spawning → active sets agent_active=1", () => {
    const ticket = makeTicket({ status: "spawning", agent_active: 0 });
    const result = applyTransition(ticket, "active");
    expect(result).not.toBeNull();
    expect(result!.agent_active).toBe(1);
    expect(result!.status).toBe("active");
  });

  test("no transitions out of terminal states", () => {
    for (const terminal of TERMINAL_STATUSES) {
      const ticket = makeTicket({ status: terminal });
      const result = applyTransition(ticket, "active");
      expect(result).toBeNull();
    }
  });

  test("does not mutate the original ticket", () => {
    const ticket = makeTicket({ status: "created" });
    const originalStatus = ticket.status;
    applyTransition(ticket, "reviewing");
    expect(ticket.status).toBe(originalStatus);
  });

  test("sets updated_at to current ISO timestamp", () => {
    const ticket = makeTicket({ status: "created", updated_at: "2020-01-01T00:00:00.000Z" });
    const before = new Date().toISOString();
    const result = applyTransition(ticket, "reviewing");
    const after = new Date().toISOString();
    expect(result).not.toBeNull();
    expect(result!.updated_at >= before).toBe(true);
    expect(result!.updated_at <= after).toBe(true);
  });
});
