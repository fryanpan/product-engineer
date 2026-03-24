import { describe, it, expect, beforeEach } from "bun:test";
import { TICKET_STATES, TERMINAL_STATUSES, type TicketState } from "./types";

/**
 * Tests for supervisor tick, heartbeat auto-transition, status validation,
 * and terminal state protection in the orchestrator.
 *
 * These tests exercise the logic from orchestrator.ts methods:
 * - handleHeartbeat(): auto-transition spawning → active, ci_status/needs_attention updates
 * - runSupervisorTick(): stale agent detection
 * - handleStatusUpdate(): status validation, terminal state protection
 * - handleEvent(): terminal ticket rejection
 *
 * Since we can't instantiate the full Durable Object, we extract the logic
 * into lightweight helpers that mirror what the orchestrator does, backed
 * by the same mock SQL layer used in agent-manager.test.ts.
 */

// ─── Mock SQL layer (same pattern as agent-manager.test.ts) ──────────────────

function createMockSql() {
  const tickets = new Map<string, Record<string, unknown>>();

  return {
    exec(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim();

      // INSERT INTO tickets
      if (trimmed.startsWith("INSERT INTO tickets")) {
        const [ticketUUID, product, slackTs, slackCh, ticketId, title] = params;
        tickets.set(ticketUUID as string, {
          ticket_uuid: ticketUUID,
          product,
          status: "created",
          slack_thread_ts: slackTs || null,
          slack_channel: slackCh || null,
          pr_url: null,
          branch_name: null,
          ticket_id: ticketId || null,
          title: title || null,
          agent_active: 0,
          agent_message: null,
          ci_status: null,
          needs_attention: null,
          needs_attention_reason: null,
          transcript_r2_key: null,
          session_id: null,
          last_heartbeat: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return { toArray: () => [] };
      }

      // SELECT ... FROM tickets WHERE ticket_uuid = ?
      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tickets") && trimmed.includes("WHERE ticket_uuid =")) {
        const ticketUUID = params[0] as string;
        const row = tickets.get(ticketUUID);
        return { toArray: () => (row ? [{ ...row }] : []) };
      }

      // SELECT ... FROM tickets WHERE slack_thread_ts = ?
      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tickets") && trimmed.includes("WHERE slack_thread_ts =")) {
        const threadTs = params[0] as string;
        const row = [...tickets.values()].find((t) => t.slack_thread_ts === threadTs);
        return { toArray: () => (row ? [{ ...row }] : []) };
      }

      // SELECT stale agents (supervisor tick query)
      if (trimmed.includes("agent_active = 1") && trimmed.includes("last_heartbeat IS NOT NULL") && trimmed.includes("-5 minutes")) {
        // For testing, we compare last_heartbeat against 5 minutes ago
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
        const stale = [...tickets.values()].filter(
          (t) =>
            t.agent_active === 1 &&
            t.last_heartbeat !== null &&
            new Date(t.last_heartbeat as string) < fiveMinAgo,
        );
        return {
          toArray: () =>
            stale.map((t) => ({
              ticket_uuid: t.ticket_uuid,
              product: t.product,
              last_heartbeat: t.last_heartbeat,
            })),
        };
      }

      // UPDATE tickets SET ... WHERE ticket_uuid = ?
      if (trimmed.startsWith("UPDATE tickets SET")) {
        const id = params[params.length - 1] as string;
        const row = tickets.get(id);
        if (!row) return { toArray: () => [] };

        // Check for agent_active = 1 condition in WHERE clause
        if (trimmed.includes("AND agent_active = 1") && row.agent_active !== 1) {
          return { toArray: () => [] };
        }

        // Parse SET clauses
        const setClause = trimmed.match(/SET (.+) WHERE/)?.[1] || "";
        const setParts = setClause.split(",").map((s) => s.trim());
        let paramIdx = 0;
        for (const part of setParts) {
          const eqMatch = part.match(/(\w+)\s*=\s*\?/);
          if (eqMatch) {
            row[eqMatch[1]] = params[paramIdx++];
          } else if (part.includes("datetime('now')")) {
            const field = part.split("=")[0].trim();
            row[field] = new Date().toISOString();
          } else if (part.match(/agent_active\s*=\s*0/)) {
            row.agent_active = 0;
          } else if (part.match(/agent_active\s*=\s*1/)) {
            row.agent_active = 1;
          } else if (part.match(/status\s*=\s*'(\w+)'/)) {
            const statusMatch = part.match(/status\s*=\s*'(\w+)'/);
            if (statusMatch) row.status = statusMatch[1];
          } else if (part.match(/(\w+)\s*=\s*'([^']*)'/)) {
            // Literal string value in SET clause (e.g., agent_message = 'some text')
            const literalMatch = part.match(/(\w+)\s*=\s*'([^']*)'/);
            if (literalMatch) row[literalMatch[1]] = literalMatch[2];
          }
        }
        row.updated_at = new Date().toISOString();
        return { toArray: () => [] };
      }

      // SELECT agent_active = 1 (for getActiveAgents)
      if (trimmed.startsWith("SELECT") && trimmed.includes("agent_active = 1")) {
        const active = [...tickets.values()].filter((t) => t.agent_active === 1);
        return { toArray: () => active };
      }

      return { toArray: () => [] };
    },
    _tickets: tickets,
  };
}

// ─── Helpers that replicate orchestrator logic for testability ────────────────

/** Mimics handleHeartbeat logic from orchestrator.ts */
function handleHeartbeat(
  sql: ReturnType<typeof createMockSql>,
  payload: {
    ticketUUID: string;
    message?: string;
    ci_status?: string;
    needs_attention?: boolean;
    needs_attention_reason?: string;
  },
) {
  const { ticketUUID, message, ci_status, needs_attention, needs_attention_reason } = payload;

  // Record phone-home (update last_heartbeat + agent_message)
  const ticket = sql._tickets.get(ticketUUID);
  if (!ticket) return;
  if ((TERMINAL_STATUSES as readonly string[]).includes(ticket.status as string)) return;

  if (ticket.agent_active === 1) {
    ticket.last_heartbeat = new Date().toISOString();
    if (message) ticket.agent_message = message;
    ticket.updated_at = new Date().toISOString();
  }

  // Store expanded heartbeat fields
  if (ci_status !== undefined) {
    sql.exec(
      "UPDATE tickets SET ci_status = ?, updated_at = datetime('now') WHERE ticket_uuid = ?",
      ci_status,
      ticketUUID,
    );
  }
  if (needs_attention !== undefined) {
    sql.exec(
      "UPDATE tickets SET needs_attention = ?, updated_at = datetime('now') WHERE ticket_uuid = ?",
      needs_attention ? 1 : 0,
      ticketUUID,
    );
  }
  if (needs_attention_reason !== undefined) {
    sql.exec(
      "UPDATE tickets SET needs_attention_reason = ?, updated_at = datetime('now') WHERE ticket_uuid = ?",
      needs_attention_reason,
      ticketUUID,
    );
  }

  // Auto-transition spawning → active on first heartbeat
  const current = sql._tickets.get(ticketUUID);
  if (current?.status === "spawning") {
    sql.exec(
      "UPDATE tickets SET status = 'active', updated_at = datetime('now') WHERE ticket_uuid = ?",
      ticketUUID,
    );
  }
}

/** Mimics runSupervisorTick logic from orchestrator.ts */
function runSupervisorTick(sql: ReturnType<typeof createMockSql>): Array<{ ticket_uuid: string; product: string; last_heartbeat: string }> {
  const result = sql.exec(`
    SELECT ticket_uuid, product, last_heartbeat
    FROM tickets
    WHERE agent_active = 1
      AND last_heartbeat IS NOT NULL
      AND last_heartbeat < datetime('now', '-5 minutes')
  `).toArray() as Array<{ ticket_uuid: string; product: string; last_heartbeat: string }>;

  for (const agent of result) {
    sql.exec(
      "UPDATE tickets SET agent_message = 'heartbeat timeout — agent may be stuck', updated_at = datetime('now') WHERE ticket_uuid = ?",
      agent.ticket_uuid,
    );
  }

  return result;
}

/** Mimics handleStatusUpdate status validation logic from orchestrator.ts */
function validateAndApplyStatus(
  sql: ReturnType<typeof createMockSql>,
  ticketUUID: string,
  body: {
    status?: string;
    pr_url?: string;
    branch_name?: string;
    agent_active?: number;
  },
): { ok: boolean; ignored?: boolean; reason?: string } {
  const ticket = sql._tickets.get(ticketUUID);
  if (!ticket) return { ok: false, reason: "ticket not found" };

  // Terminal state protection
  if ((TERMINAL_STATUSES as readonly string[]).includes(ticket.status as string)) {
    if (body.agent_active === undefined || body.agent_active !== 0) {
      return { ok: true, ignored: true, reason: "terminal ticket" };
    }
  }

  const updates: string[] = ["updated_at = datetime('now')", "last_heartbeat = datetime('now')"];
  const values: (string | number | null)[] = [];

  if (body.agent_active !== undefined) {
    updates.push("agent_active = ?");
    values.push(body.agent_active);
  }

  if (body.status) {
    // Validate against TICKET_STATES — reject invalid strings
    if (!(TICKET_STATES as readonly string[]).includes(body.status)) {
      // Invalid status: skip status update but continue processing other fields
    } else {
      updates.push("status = ?");
      values.push(body.status);

      // Terminal states: mark agent as inactive
      if ((TERMINAL_STATUSES as readonly string[]).includes(body.status)) {
        updates.push("agent_active = 0");
      }
    }
  }

  if (body.pr_url) {
    updates.push("pr_url = ?");
    values.push(body.pr_url);
  }
  if (body.branch_name) {
    updates.push("branch_name = ?");
    values.push(body.branch_name);
  }

  values.push(ticketUUID);
  sql.exec(`UPDATE tickets SET ${updates.join(", ")} WHERE ticket_uuid = ?`, ...values);

  return { ok: true };
}

/** Mimics handleEvent terminal state check from orchestrator.ts */
function checkEventTerminalGuard(
  sql: ReturnType<typeof createMockSql>,
  ticketUUID: string,
): { ignored: boolean; reason?: string } {
  const ticket = sql._tickets.get(ticketUUID);
  if (!ticket) return { ignored: false };

  if ((TERMINAL_STATUSES as readonly string[]).includes(ticket.status as string)) {
    return { ignored: true, reason: "terminal ticket" };
  }

  return { ignored: false };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function insertTicket(
  sql: ReturnType<typeof createMockSql>,
  ticketUUID: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  sql.exec(
    "INSERT INTO tickets (ticket_uuid, product, slack_thread_ts, slack_channel, ticket_id, title) VALUES (?, ?, ?, ?, ?, ?)",
    ticketUUID,
    overrides.product || "test-product",
    null,
    null,
    null,
    null,
  );
  // Apply overrides
  const ticket = sql._tickets.get(ticketUUID)!;
  for (const [key, value] of Object.entries(overrides)) {
    ticket[key] = value;
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Heartbeat auto-transition", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("transitions ticket from spawning → active on first heartbeat", () => {
    insertTicket(sql, "PE-1", { status: "spawning", agent_active: 1 });

    handleHeartbeat(sql, { ticketUUID: "PE-1", message: "agent starting" });

    const ticket = sql._tickets.get("PE-1")!;
    expect(ticket.status).toBe("active");
    expect(ticket.last_heartbeat).not.toBeNull();
    expect(ticket.agent_message).toBe("agent starting");
  });

  it("does not transition non-spawning tickets", () => {
    insertTicket(sql, "PE-2", { status: "active", agent_active: 1 });

    handleHeartbeat(sql, { ticketUUID: "PE-2", message: "still working" });

    const ticket = sql._tickets.get("PE-2")!;
    expect(ticket.status).toBe("active"); // stays active, not re-transitioned
    expect(ticket.last_heartbeat).not.toBeNull();
  });

  it("does not transition tickets in created state", () => {
    insertTicket(sql, "PE-3", { status: "created", agent_active: 1 });

    handleHeartbeat(sql, { ticketUUID: "PE-3" });

    expect(sql._tickets.get("PE-3")!.status).toBe("created");
  });

  it("skips heartbeat for terminal tickets", () => {
    insertTicket(sql, "PE-4", { status: "merged", agent_active: 0 });

    handleHeartbeat(sql, { ticketUUID: "PE-4", message: "late heartbeat" });

    const ticket = sql._tickets.get("PE-4")!;
    expect(ticket.status).toBe("merged");
    expect(ticket.last_heartbeat).toBeNull(); // not updated
    expect(ticket.agent_message).toBeNull(); // not updated
  });

  it("only updates heartbeat for active agents (agent_active=1)", () => {
    insertTicket(sql, "PE-5", { status: "active", agent_active: 0 });

    handleHeartbeat(sql, { ticketUUID: "PE-5", message: "orphaned heartbeat" });

    const ticket = sql._tickets.get("PE-5")!;
    expect(ticket.last_heartbeat).toBeNull(); // agent_active=0, no update
  });
});

describe("Heartbeat expanded fields", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("updates ci_status when provided", () => {
    insertTicket(sql, "PE-1", { status: "active", agent_active: 1 });

    handleHeartbeat(sql, { ticketUUID: "PE-1", ci_status: "passing" });

    expect(sql._tickets.get("PE-1")!.ci_status).toBe("passing");
  });

  it("updates needs_attention when provided", () => {
    insertTicket(sql, "PE-1", { status: "active", agent_active: 1 });

    handleHeartbeat(sql, {
      ticketUUID: "PE-1",
      needs_attention: true,
      needs_attention_reason: "CI failing after 3 retries",
    });

    const ticket = sql._tickets.get("PE-1")!;
    expect(ticket.needs_attention).toBe(1);
    expect(ticket.needs_attention_reason).toBe("CI failing after 3 retries");
  });

  it("sets needs_attention to 0 when false", () => {
    insertTicket(sql, "PE-1", { status: "active", agent_active: 1, needs_attention: 1 });

    handleHeartbeat(sql, { ticketUUID: "PE-1", needs_attention: false });

    expect(sql._tickets.get("PE-1")!.needs_attention).toBe(0);
  });

  it("does not overwrite ci_status when not provided", () => {
    insertTicket(sql, "PE-1", { status: "active", agent_active: 1, ci_status: "pending" });

    handleHeartbeat(sql, { ticketUUID: "PE-1", message: "still working" });

    expect(sql._tickets.get("PE-1")!.ci_status).toBe("pending");
  });
});

describe("Supervisor tick: stale agent detection", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("detects agents with heartbeat older than 5 minutes", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertTicket(sql, "PE-1", {
      status: "active",
      agent_active: 1,
      last_heartbeat: tenMinAgo,
    });

    const stale = runSupervisorTick(sql);

    expect(stale.length).toBe(1);
    expect(stale[0].ticket_uuid).toBe("PE-1");
    // Check that agent_message was updated
    expect(sql._tickets.get("PE-1")!.agent_message).toBe(
      "heartbeat timeout — agent may be stuck",
    );
  });

  it("does not flag agents with recent heartbeats", () => {
    const oneMinAgo = new Date(Date.now() - 1 * 60 * 1000).toISOString();
    insertTicket(sql, "PE-2", {
      status: "active",
      agent_active: 1,
      last_heartbeat: oneMinAgo,
    });

    const stale = runSupervisorTick(sql);

    expect(stale.length).toBe(0);
    expect(sql._tickets.get("PE-2")!.agent_message).toBeNull();
  });

  it("does not flag inactive agents (agent_active=0)", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertTicket(sql, "PE-3", {
      status: "active",
      agent_active: 0,
      last_heartbeat: tenMinAgo,
    });

    const stale = runSupervisorTick(sql);
    expect(stale.length).toBe(0);
  });

  it("does not flag agents with no heartbeat (null)", () => {
    insertTicket(sql, "PE-4", {
      status: "spawning",
      agent_active: 1,
      last_heartbeat: null,
    });

    const stale = runSupervisorTick(sql);
    expect(stale.length).toBe(0);
  });

  it("detects multiple stale agents", () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    insertTicket(sql, "PE-A", { status: "active", agent_active: 1, last_heartbeat: tenMinAgo });
    insertTicket(sql, "PE-B", { status: "active", agent_active: 1, last_heartbeat: tenMinAgo });

    const stale = runSupervisorTick(sql);
    expect(stale.length).toBe(2);
  });
});

describe("Status validation: handleStatusUpdate", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("accepts valid TICKET_STATES status strings", () => {
    insertTicket(sql, "PE-1", { status: "active", agent_active: 1 });

    const result = validateAndApplyStatus(sql, "PE-1", { status: "pr_open" });

    expect(result.ok).toBe(true);
    expect(result.ignored).toBeUndefined();
    expect(sql._tickets.get("PE-1")!.status).toBe("pr_open");
  });

  it("rejects invalid status strings (e.g., 'agent:starting')", () => {
    insertTicket(sql, "PE-1", { status: "active", agent_active: 1 });

    const result = validateAndApplyStatus(sql, "PE-1", { status: "agent:starting" });

    expect(result.ok).toBe(true);
    // Status should NOT have changed
    expect(sql._tickets.get("PE-1")!.status).toBe("active");
  });

  it("rejects arbitrary strings not in TICKET_STATES", () => {
    insertTicket(sql, "PE-1", { status: "created", agent_active: 1 });

    for (const invalidStatus of ["in_progress", "running", "agent:cloning", "completed", "done", ""]) {
      // Reset
      sql._tickets.get("PE-1")!.status = "created";

      validateAndApplyStatus(sql, "PE-1", { status: invalidStatus });
      // Empty string may match but none of these are in TICKET_STATES
      if (!(TICKET_STATES as readonly string[]).includes(invalidStatus)) {
        expect(sql._tickets.get("PE-1")!.status).toBe("created");
      }
    }
  });

  it("still processes metadata fields when status is invalid", () => {
    insertTicket(sql, "PE-1", { status: "active", agent_active: 1 });

    validateAndApplyStatus(sql, "PE-1", {
      status: "agent:pushing",
      pr_url: "https://github.com/org/repo/pull/42",
      branch_name: "ticket/PE-1",
    });

    const ticket = sql._tickets.get("PE-1")!;
    expect(ticket.status).toBe("active"); // status unchanged
    expect(ticket.pr_url).toBe("https://github.com/org/repo/pull/42"); // metadata applied
    expect(ticket.branch_name).toBe("ticket/PE-1"); // metadata applied
  });

  it("marks agent_active=0 on terminal status transitions", () => {
    insertTicket(sql, "PE-1", { status: "active", agent_active: 1 });

    validateAndApplyStatus(sql, "PE-1", { status: "failed" });

    expect(sql._tickets.get("PE-1")!.agent_active).toBe(0);
  });

  it("all terminal statuses mark agent_active=0", () => {
    for (const terminal of TERMINAL_STATUSES) {
      const id = `term-${terminal}`;
      insertTicket(sql, id, { status: "active", agent_active: 1 });

      validateAndApplyStatus(sql, id, { status: terminal });

      expect(sql._tickets.get(id)!.agent_active).toBe(0);
    }
  });
});

describe("Terminal state protection in handleStatusUpdate", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("rejects status updates for terminal tickets", () => {
    insertTicket(sql, "PE-1", { status: "merged", agent_active: 0 });

    const result = validateAndApplyStatus(sql, "PE-1", { status: "active" });

    expect(result.ignored).toBe(true);
    expect(result.reason).toBe("terminal ticket");
    expect(sql._tickets.get("PE-1")!.status).toBe("merged");
  });

  it("allows explicit agent_active=0 for terminal tickets (dashboard kill)", () => {
    insertTicket(sql, "PE-1", { status: "failed", agent_active: 1 });

    const result = validateAndApplyStatus(sql, "PE-1", { agent_active: 0 });

    expect(result.ok).toBe(true);
    expect(result.ignored).toBeUndefined();
    expect(sql._tickets.get("PE-1")!.agent_active).toBe(0);
  });

  it("rejects heartbeat-style updates for all terminal statuses", () => {
    for (const terminal of TERMINAL_STATUSES) {
      const id = `term-${terminal}`;
      insertTicket(sql, id, { status: terminal, agent_active: 0 });

      const result = validateAndApplyStatus(sql, id, { status: "active" });

      expect(result.ignored).toBe(true);
      expect(result.reason).toBe("terminal ticket");
    }
  });
});

describe("Terminal state protection in handleEvent", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("rejects events for merged tickets", () => {
    insertTicket(sql, "PE-1", { status: "merged", agent_active: 0 });

    const result = checkEventTerminalGuard(sql, "PE-1");

    expect(result.ignored).toBe(true);
    expect(result.reason).toBe("terminal ticket");
  });

  it("rejects events for closed tickets", () => {
    insertTicket(sql, "PE-1", { status: "closed", agent_active: 0 });

    const result = checkEventTerminalGuard(sql, "PE-1");

    expect(result.ignored).toBe(true);
  });

  it("rejects events for failed tickets", () => {
    insertTicket(sql, "PE-1", { status: "failed", agent_active: 0 });

    const result = checkEventTerminalGuard(sql, "PE-1");

    expect(result.ignored).toBe(true);
  });

  it("rejects events for deferred tickets", () => {
    insertTicket(sql, "PE-1", { status: "deferred", agent_active: 0 });

    const result = checkEventTerminalGuard(sql, "PE-1");

    expect(result.ignored).toBe(true);
  });

  it("allows events for non-terminal tickets", () => {
    for (const status of TICKET_STATES) {
      if ((TERMINAL_STATUSES as readonly string[]).includes(status)) continue;

      const id = `nonterm-${status}`;
      insertTicket(sql, id, { status, agent_active: 1 });

      const result = checkEventTerminalGuard(sql, id);

      expect(result.ignored).toBe(false);
    }
  });

  it("allows events for non-existent tickets (will be created)", () => {
    const result = checkEventTerminalGuard(sql, "nonexistent");
    expect(result.ignored).toBe(false);
  });
});

// ─── Thread reply routing decision ──────────────────────────────────────────

/**
 * Mirrors the thread reply routing logic in orchestrator.ts handleSlackEvent.
 * Determines whether a thread reply should respawn the container or route to
 * an existing one.
 */
function threadReplyRoutingDecision(
  sql: ReturnType<typeof createMockSql>,
  threadTs: string,
): { found: boolean; wasTerminal: boolean; needsRespawn: boolean } {
  const rows = sql.exec(
    "SELECT ticket_uuid, product, status, agent_active FROM tickets WHERE slack_thread_ts = ?",
    threadTs,
  ).toArray() as { ticket_uuid: string; product: string; status: string; agent_active: number }[];

  if (rows.length === 0) {
    return { found: false, wasTerminal: false, needsRespawn: false };
  }

  const ticket = rows[0];
  const isTerminal = (TERMINAL_STATUSES as readonly string[]).includes(ticket.status);

  // Terminal tickets get reopened and respawned (not ignored)
  const needsRespawn = isTerminal || ticket.status === "suspended" || ticket.agent_active === 0;
  return { found: true, wasTerminal: isTerminal, needsRespawn };
}

describe("Thread reply routing", () => {
  let sql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    sql = createMockSql();
  });

  it("returns not-found for unknown thread_ts", () => {
    const result = threadReplyRoutingDecision(sql, "unknown-ts");
    expect(result.found).toBe(false);
  });

  it("reopens and respawns merged tickets", () => {
    insertTicket(sql, "PE-1", { status: "merged", agent_active: 0, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(true);
    expect(result.needsRespawn).toBe(true);
  });

  it("reopens and respawns closed tickets", () => {
    insertTicket(sql, "PE-1", { status: "closed", agent_active: 0, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(true);
    expect(result.needsRespawn).toBe(true);
  });

  it("needs respawn for suspended tickets", () => {
    insertTicket(sql, "PE-1", { status: "suspended", agent_active: 0, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(false);
    expect(result.needsRespawn).toBe(true);
  });

  it("needs respawn for active tickets with agent_active=0 (dead container)", () => {
    insertTicket(sql, "PE-1", { status: "active", agent_active: 0, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(false);
    expect(result.needsRespawn).toBe(true);
  });

  it("needs respawn for pr_open tickets with agent_active=0 (post-deploy)", () => {
    insertTicket(sql, "PE-1", { status: "pr_open", agent_active: 0, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(false);
    expect(result.needsRespawn).toBe(true);
  });

  it("routes to existing container for active tickets with agent_active=1", () => {
    insertTicket(sql, "PE-1", { status: "active", agent_active: 1, slack_thread_ts: "thread-1" });

    const result = threadReplyRoutingDecision(sql, "thread-1");
    expect(result.wasTerminal).toBe(false);
    expect(result.needsRespawn).toBe(false);
  });
});
