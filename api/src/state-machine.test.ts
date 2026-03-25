import { describe, test, expect } from "bun:test";
import { canTransition, isTerminal, applyTransition } from "./state-machine";
import { TERMINAL_STATUSES, type TaskRecord } from "./types";

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_uuid: "test-uuid",
    product: "test",
    status: "created",
    slack_thread_ts: null,
    slack_channel: null,
    pr_url: null,
    branch_name: null,
    task_id: null,
    title: null,
    agent_active: 0,
    agent_message: null,
    checks_passed: 0,
    last_merge_decision_sha: null,
    transcript_r2_key: null,
    session_id: null,
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

  test("terminal states can only transition to active (reopen)", () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(canTransition(terminal, "active")).toBe(true);
      expect(canTransition(terminal, "created")).toBe(false);
      expect(canTransition(terminal, "spawning")).toBe(false);
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
    expect(isTerminal("suspended")).toBe(false);
  });
});

describe("applyTransition", () => {
  test("valid transition: created → reviewing", () => {
    const task = makeTask({ status: "created" });
    const result = applyTransition(task, "reviewing");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("reviewing");
    expect(result!.updated_at).not.toBe(task.updated_at);
  });

  test("invalid transition: created → merged returns null", () => {
    const task = makeTask({ status: "created" });
    const result = applyTransition(task, "merged");
    expect(result).toBeNull();
  });

  test("terminal states set agent_active=0", () => {
    for (const terminal of TERMINAL_STATUSES) {
      // Find a valid "from" state for this terminal
      const fromState = terminal === "merged" ? "pr_open" : "reviewing";
      const task = makeTask({ status: fromState, agent_active: 1 });
      const result = applyTransition(task, terminal);
      expect(result).not.toBeNull();
      expect(result!.agent_active).toBe(0);
    }
  });

  test("spawning → active sets agent_active=1", () => {
    const task = makeTask({ status: "spawning", agent_active: 0 });
    const result = applyTransition(task, "active");
    expect(result).not.toBeNull();
    expect(result!.agent_active).toBe(1);
    expect(result!.status).toBe("active");
  });

  test("terminal states can transition to active (reopen)", () => {
    for (const terminal of TERMINAL_STATUSES) {
      const task = makeTask({ status: terminal, agent_active: 0 });
      const result = applyTransition(task, "active");
      expect(result).not.toBeNull();
      expect(result!.status).toBe("active");
    }
  });

  test("does not mutate the original task", () => {
    const task = makeTask({ status: "created" });
    const originalStatus = task.status;
    applyTransition(task, "reviewing");
    expect(task.status).toBe(originalStatus);
  });

  test("active → suspended is valid and deactivates agent", () => {
    const task = makeTask({ status: "active", agent_active: 1 });
    const result = applyTransition(task, "suspended");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("suspended");
    // suspended stops the container, so agent_active should be 0
    expect(result!.agent_active).toBe(0);
  });

  test("suspended → active is valid", () => {
    const task = makeTask({ status: "suspended", agent_active: 0 });
    const result = applyTransition(task, "active");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("active");
  });

  test("suspended → closed is valid", () => {
    const task = makeTask({ status: "suspended", agent_active: 0 });
    const result = applyTransition(task, "closed");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("closed");
    expect(result!.agent_active).toBe(0);
  });

  test("suspended cannot transition to merged or pr_open", () => {
    const task = makeTask({ status: "suspended" });
    expect(applyTransition(task, "merged")).toBeNull();
    expect(applyTransition(task, "pr_open")).toBeNull();
  });

  test("sets updated_at to current ISO timestamp", () => {
    const task = makeTask({ status: "created", updated_at: "2020-01-01T00:00:00.000Z" });
    const before = new Date().toISOString();
    const result = applyTransition(task, "reviewing");
    const after = new Date().toISOString();
    expect(result).not.toBeNull();
    expect(result!.updated_at >= before).toBe(true);
    expect(result!.updated_at <= after).toBe(true);
  });
});
