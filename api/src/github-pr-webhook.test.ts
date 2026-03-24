/**
 * Tests for GitHub PR webhook handling (pr_merged, pr_closed) in the orchestrator.
 *
 * The Orchestrator.handleEvent method is private and requires the Cloudflare
 * Container runtime, so we can't instantiate the DO directly. These tests
 * replicate the handleEvent flow using the same AgentManager calls and SQL
 * queries that handleEvent performs, verifying:
 *   1. pr_merged → ticket transitions to "merged", agent_active=0
 *   2. pr_closed → ticket transitions to "closed", agent_active=0
 *   3. Terminal ticket rejection — events to terminal tickets are ignored
 *   4. Branch-to-UUID resolution — GitHub events resolve branch names to ticket UUIDs
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { AgentManager } from "./agent-manager";
import { TERMINAL_STATUSES } from "./types";

// ── Mocks (same pattern as agent-manager.test.ts) ─────────────────────────────

function createMockSql() {
  const tickets = new Map<string, Record<string, unknown>>();

  return {
    exec(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim();

      if (trimmed.startsWith("INSERT INTO tickets")) {
        const [ticketUUID, product, slackTs, slackCh, ticketId, title] = params;
        tickets.set(ticketUUID as string, {
          ticket_uuid: ticketUUID, product,
          status: "created",
          slack_thread_ts: slackTs || null,
          slack_channel: slackCh || null,
          pr_url: null,
          branch_name: null,
          ticket_id: ticketId || null,
          title: title || null,
          agent_active: 0,
          transcript_r2_key: null,
          session_id: null,
          last_heartbeat: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return { toArray: () => [] };
      }

      if (trimmed.startsWith("DELETE FROM tickets")) {
        tickets.delete(params[0] as string);
        return { toArray: () => [] };
      }

      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tickets") && trimmed.includes("WHERE ticket_uuid =")) {
        const ticketUUID = params[0] as string;
        const row = tickets.get(ticketUUID);
        return { toArray: () => row ? [{ ...row }] : [] };
      }

      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tickets") && trimmed.includes("WHERE ticket_id")) {
        const ticketId = params[0] as string;
        const match = [...tickets.values()].find(t => t.ticket_id === ticketId);
        return { toArray: () => match ? [{ ...match }] : [] };
      }

      // Branch-name lookup (handleEvent's resolution query)
      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tickets") && trimmed.includes("branch_name")) {
        const branch1 = params[0] as string;
        const branch2 = params[1] as string;
        const match = [...tickets.values()].find(
          t => t.branch_name === branch1 || t.branch_name === branch2,
        );
        return { toArray: () => match ? [{ ticket_uuid: match.ticket_uuid }] : [] };
      }

      if (trimmed.includes("agent_active = 1") && trimmed.includes("status IN")) {
        const statusMatch = trimmed.match(/IN \(([^)]+)\)/);
        const statuses = statusMatch ? statusMatch[1].split(",").map(s => s.trim().replace(/'/g, "")) : [];
        const matching = [...tickets.values()].filter(
          t => t.agent_active === 1 && statuses.includes(t.status as string),
        );
        return { toArray: () => matching.map(t => ({ ticket_uuid: t.ticket_uuid })) };
      }

      if (trimmed.startsWith("UPDATE tickets SET")) {
        const id = params[params.length - 1] as string;
        const row = tickets.get(id);
        if (!row) return { toArray: () => [] };

        if (trimmed.includes("AND agent_active = 1") && row.agent_active !== 1) {
          return { toArray: () => [] };
        }

        const setClause = trimmed.match(/SET (.+) WHERE/)?.[1] || "";
        const setParts = setClause.split(",").map(s => s.trim());
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
          }
          // Handle inline string values like status = 'merged' or status = 'closed'
          const inlineMatch = part.match(/(\w+)\s*=\s*'([^']+)'/);
          if (inlineMatch) {
            row[inlineMatch[1]] = inlineMatch[2];
          }
        }
        row.updated_at = new Date().toISOString();
        return { toArray: () => [] };
      }

      if (trimmed.startsWith("SELECT") && trimmed.includes("agent_active = 1")) {
        const active = [...tickets.values()].filter(t => t.agent_active === 1);
        return { toArray: () => active };
      }

      return { toArray: () => [] };
    },
    _tickets: tickets,
  };
}

function createMockTicketAgentNs() {
  const agents = new Map<string, {
    fetchCalls: Array<{ url: string; method: string; body?: string }>;
    nextResponse: Response;
  }>();

  return {
    idFromName(name: string) { return { name }; },
    get(id: { name: string }) {
      if (!agents.has(id.name)) {
        agents.set(id.name, { fetchCalls: [], nextResponse: new Response("ok", { status: 200 }) });
      }
      const agent = agents.get(id.name)!;
      return {
        fetch: async (req: Request) => {
          const body = req.method === "POST" ? await req.text() : undefined;
          agent.fetchCalls.push({ url: req.url, method: req.method, body });
          return agent.nextResponse.clone();
        },
      };
    },
    _agents: agents,
  };
}

/** Helper: advance a ticket through valid transitions to pr_open with active agent */
function setupPrOpenTicket(
  manager: AgentManager,
  sql: ReturnType<typeof createMockSql>,
  ticketUUID: string,
) {
  manager.createTicket({ ticketUUID, product: "test-app" });
  manager.updateStatus(ticketUUID, { status: "reviewing" });
  manager.updateStatus(ticketUUID, { status: "spawning" });
  manager.updateStatus(ticketUUID, { status: "active" });
  manager.updateStatus(ticketUUID, { status: "pr_open" });
  sql._tickets.get(ticketUUID)!.agent_active = 1;
}

/**
 * Simulate the handleEvent pr_merged flow from orchestrator.ts lines 1104-1123.
 * Uses try/catch fallback to raw SQL, same as the real implementation.
 */
async function simulatePrMerged(
  manager: AgentManager,
  sql: ReturnType<typeof createMockSql>,
  ticketUUID: string,
) {
  const ticket = manager.getTicket(ticketUUID);
  if (!ticket) return;

  try {
    manager.updateStatus(ticketUUID, { status: "merged" });
  } catch {
    sql.exec(
      "UPDATE tickets SET status = 'merged', agent_active = 0, updated_at = datetime('now') WHERE ticket_uuid = ?",
      ticketUUID,
    );
  }
  await manager.stopAgent(ticketUUID, "pr_merged").catch(() => {});
}

/**
 * Simulate the handleEvent pr_closed flow from orchestrator.ts lines 1126-1145.
 */
async function simulatePrClosed(
  manager: AgentManager,
  sql: ReturnType<typeof createMockSql>,
  ticketUUID: string,
) {
  const ticket = manager.getTicket(ticketUUID);
  if (!ticket) return;

  try {
    manager.updateStatus(ticketUUID, { status: "closed" });
  } catch {
    sql.exec(
      "UPDATE tickets SET status = 'closed', agent_active = 0, updated_at = datetime('now') WHERE ticket_uuid = ?",
      ticketUUID,
    );
  }
  await manager.stopAgent(ticketUUID, "pr_closed").catch(() => {});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("handleEvent: pr_merged", () => {
  let sql: ReturnType<typeof createMockSql>;
  let mockNs: ReturnType<typeof createMockTicketAgentNs>;
  let manager: AgentManager;

  beforeEach(() => {
    sql = createMockSql();
    mockNs = createMockTicketAgentNs();
    manager = new AgentManager(sql, { TICKET_AGENT: mockNs });
  });

  test("transitions ticket to 'merged' and sets agent_active=0", async () => {
    setupPrOpenTicket(manager, sql, "uuid-1");

    await simulatePrMerged(manager, sql, "uuid-1");

    const updated = manager.getTicket("uuid-1")!;
    expect(updated.status).toBe("merged");
    expect(updated.agent_active).toBe(0);
  });

  test("stopAgent sends /mark-terminal to TicketAgent DO", async () => {
    setupPrOpenTicket(manager, sql, "uuid-2");

    await simulatePrMerged(manager, sql, "uuid-2");

    const calls = mockNs._agents.get("uuid-2")!.fetchCalls;
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://internal/mark-terminal");
    expect(calls[0].method).toBe("POST");
  });

  test("force-updates via raw SQL when state transition is invalid", async () => {
    // Ticket in 'active' — merged is not a valid transition from active
    manager.createTicket({ ticketUUID: "uuid-3", product: "test-app" });
    manager.updateStatus("uuid-3", { status: "reviewing" });
    manager.updateStatus("uuid-3", { status: "spawning" });
    manager.updateStatus("uuid-3", { status: "active" });
    sql._tickets.get("uuid-3")!.agent_active = 1;

    // updateStatus silently rejects the invalid transition, so we detect and
    // fall back to raw SQL (same as handleEvent's catch block)
    try {
      manager.updateStatus("uuid-3", { status: "merged" });
      if (manager.getTicket("uuid-3")!.status !== "merged") {
        throw new Error("transition rejected");
      }
    } catch {
      sql.exec(
        "UPDATE tickets SET status = 'merged', agent_active = 0, updated_at = datetime('now') WHERE ticket_uuid = ?",
        "uuid-3",
      );
    }

    const updated = manager.getTicket("uuid-3")!;
    expect(updated.status).toBe("merged");
    expect(updated.agent_active).toBe(0);
  });

  test("is idempotent — merging an already-merged ticket does not throw", async () => {
    setupPrOpenTicket(manager, sql, "uuid-4");

    await simulatePrMerged(manager, sql, "uuid-4");
    // Second merge event (e.g., duplicate webhook) should not throw
    await simulatePrMerged(manager, sql, "uuid-4");

    const updated = manager.getTicket("uuid-4")!;
    expect(updated.status).toBe("merged");
    expect(updated.agent_active).toBe(0);
  });
});

describe("handleEvent: pr_closed", () => {
  let sql: ReturnType<typeof createMockSql>;
  let mockNs: ReturnType<typeof createMockTicketAgentNs>;
  let manager: AgentManager;

  beforeEach(() => {
    sql = createMockSql();
    mockNs = createMockTicketAgentNs();
    manager = new AgentManager(sql, { TICKET_AGENT: mockNs });
  });

  test("transitions ticket to 'closed' and sets agent_active=0", async () => {
    setupPrOpenTicket(manager, sql, "uuid-1");

    await simulatePrClosed(manager, sql, "uuid-1");

    const updated = manager.getTicket("uuid-1")!;
    expect(updated.status).toBe("closed");
    expect(updated.agent_active).toBe(0);
  });

  test("stopAgent sends /mark-terminal on close", async () => {
    setupPrOpenTicket(manager, sql, "uuid-2");

    await simulatePrClosed(manager, sql, "uuid-2");

    const calls = mockNs._agents.get("uuid-2")!.fetchCalls;
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://internal/mark-terminal");
    expect(calls[0].method).toBe("POST");
  });

  test("force-updates via raw SQL when state transition is invalid", async () => {
    // Ticket in 'active' — closed is not a valid transition from active
    manager.createTicket({ ticketUUID: "uuid-3", product: "test-app" });
    manager.updateStatus("uuid-3", { status: "reviewing" });
    manager.updateStatus("uuid-3", { status: "spawning" });
    manager.updateStatus("uuid-3", { status: "active" });
    sql._tickets.get("uuid-3")!.agent_active = 1;

    try {
      manager.updateStatus("uuid-3", { status: "closed" });
      if (manager.getTicket("uuid-3")!.status !== "closed") {
        throw new Error("transition rejected");
      }
    } catch {
      sql.exec(
        "UPDATE tickets SET status = 'closed', agent_active = 0, updated_at = datetime('now') WHERE ticket_uuid = ?",
        "uuid-3",
      );
    }

    const updated = manager.getTicket("uuid-3")!;
    expect(updated.status).toBe("closed");
    expect(updated.agent_active).toBe(0);
  });

  test("is idempotent — closing an already-closed ticket does not throw", async () => {
    setupPrOpenTicket(manager, sql, "uuid-4");

    await simulatePrClosed(manager, sql, "uuid-4");
    await simulatePrClosed(manager, sql, "uuid-4");

    const updated = manager.getTicket("uuid-4")!;
    expect(updated.status).toBe("closed");
    expect(updated.agent_active).toBe(0);
  });
});

describe("handleEvent: terminal ticket rejection", () => {
  let sql: ReturnType<typeof createMockSql>;
  let mockNs: ReturnType<typeof createMockTicketAgentNs>;
  let manager: AgentManager;

  beforeEach(() => {
    sql = createMockSql();
    mockNs = createMockTicketAgentNs();
    manager = new AgentManager(sql, { TICKET_AGENT: mockNs });
  });

  test("ignores events for tickets in 'merged' state", async () => {
    setupPrOpenTicket(manager, sql, "uuid-1");
    await simulatePrMerged(manager, sql, "uuid-1");

    expect(manager.isTerminal("uuid-1")).toBe(true);

    // sendEvent should skip terminal tickets without making fetch calls
    await manager.sendEvent("uuid-1", { type: "pr_review", payload: {} });

    // The agent entry exists from stopAgent's /mark-terminal call, but no
    // additional event calls should be made beyond that
    const calls = mockNs._agents.get("uuid-1")!.fetchCalls;
    // Only the /mark-terminal call from simulatePrMerged, no /event call
    expect(calls.every(c => c.url !== "http://internal/event")).toBe(true);
  });

  test("ignores events for tickets in 'closed' state", async () => {
    manager.createTicket({ ticketUUID: "uuid-2", product: "test-app" });
    manager.updateStatus("uuid-2", { status: "reviewing" });
    manager.updateStatus("uuid-2", { status: "closed" });

    expect(manager.isTerminal("uuid-2")).toBe(true);
    await manager.sendEvent("uuid-2", { type: "slack_reply", payload: {} });
    expect(mockNs._agents.has("uuid-2")).toBe(false);
  });

  test("ignores events for tickets in 'failed' state", async () => {
    manager.createTicket({ ticketUUID: "uuid-3", product: "test-app" });
    manager.updateStatus("uuid-3", { status: "failed" });

    expect(manager.isTerminal("uuid-3")).toBe(true);
    await manager.sendEvent("uuid-3", { type: "ticket_created", payload: {} });
    expect(mockNs._agents.has("uuid-3")).toBe(false);
  });

  test("ignores events for tickets in 'deferred' state", async () => {
    manager.createTicket({ ticketUUID: "uuid-4", product: "test-app" });
    manager.updateStatus("uuid-4", { status: "reviewing" });
    manager.updateStatus("uuid-4", { status: "deferred" });

    expect(manager.isTerminal("uuid-4")).toBe(true);
    await manager.sendEvent("uuid-4", { type: "linear_comment", payload: {} });
    expect(mockNs._agents.has("uuid-4")).toBe(false);
  });

  test("all terminal statuses are correctly detected", () => {
    for (const terminalStatus of TERMINAL_STATUSES) {
      const id = `terminal-${terminalStatus}`;
      manager.createTicket({ ticketUUID: id, product: "test-app" });

      // Get to terminal via valid path
      if (terminalStatus === "merged") {
        manager.updateStatus(id, { status: "reviewing" });
        manager.updateStatus(id, { status: "spawning" });
        manager.updateStatus(id, { status: "active" });
        manager.updateStatus(id, { status: "pr_open" });
        manager.updateStatus(id, { status: "merged" });
      } else if (terminalStatus === "closed") {
        manager.updateStatus(id, { status: "reviewing" });
        manager.updateStatus(id, { status: "closed" });
      } else if (terminalStatus === "failed") {
        manager.updateStatus(id, { status: "failed" });
      } else if (terminalStatus === "deferred") {
        manager.updateStatus(id, { status: "reviewing" });
        manager.updateStatus(id, { status: "deferred" });
      }

      expect(manager.isTerminal(id)).toBe(true);
    }
  });

  test("non-terminal tickets are NOT rejected", async () => {
    manager.createTicket({ ticketUUID: "uuid-active", product: "test-app" });
    manager.updateStatus("uuid-active", { status: "reviewing" });
    manager.updateStatus("uuid-active", { status: "spawning" });
    manager.updateStatus("uuid-active", { status: "active" });
    sql._tickets.get("uuid-active")!.agent_active = 1;

    expect(manager.isTerminal("uuid-active")).toBe(false);

    await manager.sendEvent("uuid-active", { type: "pr_review", payload: {} });

    const calls = mockNs._agents.get("uuid-active")!.fetchCalls;
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://internal/event");
  });
});

describe("handleEvent: branch-to-UUID resolution", () => {
  let sql: ReturnType<typeof createMockSql>;
  let manager: AgentManager;

  beforeEach(() => {
    sql = createMockSql();
    manager = new AgentManager(sql, {});
  });

  test("resolves ticket/ branch prefix to ticket UUID", () => {
    manager.createTicket({ ticketUUID: "linear-uuid-abc", product: "test-app", ticketId: "PES-5" });
    manager.updateStatus("linear-uuid-abc", { branch_name: "ticket/PES-5" });

    // Simulate handleEvent's SQL query for branch resolution
    const result = sql.exec(
      "SELECT ticket_uuid FROM tickets WHERE branch_name = ? OR branch_name = ?",
      "ticket/PES-5", "feedback/PES-5",
    ).toArray()[0] as { ticket_uuid: string } | undefined;

    expect(result).not.toBeUndefined();
    expect(result!.ticket_uuid).toBe("linear-uuid-abc");
  });

  test("resolves feedback/ branch prefix to ticket UUID", () => {
    manager.createTicket({ ticketUUID: "linear-uuid-def", product: "test-app", ticketId: "PES-10" });
    manager.updateStatus("linear-uuid-def", { branch_name: "feedback/PES-10" });

    const result = sql.exec(
      "SELECT ticket_uuid FROM tickets WHERE branch_name = ? OR branch_name = ?",
      "ticket/PES-10", "feedback/PES-10",
    ).toArray()[0] as { ticket_uuid: string } | undefined;

    expect(result).not.toBeUndefined();
    expect(result!.ticket_uuid).toBe("linear-uuid-def");
  });

  test("falls back to ticket_id when branch_name is not set", () => {
    manager.createTicket({ ticketUUID: "linear-uuid-ghi", product: "test-app", ticketId: "PES-7" });
    // No branch_name — simulates early lifecycle before agent reports branch

    const byBranch = sql.exec(
      "SELECT ticket_uuid FROM tickets WHERE branch_name = ? OR branch_name = ?",
      "ticket/PES-7", "feedback/PES-7",
    ).toArray()[0] as { ticket_uuid: string } | undefined;
    expect(byBranch).toBeUndefined();

    // Fall back to getTicketByIdentifier (same as handleEvent)
    const byIdentifier = manager.getTicketByIdentifier("PES-7");
    expect(byIdentifier).not.toBeNull();
    expect(byIdentifier!.ticket_uuid).toBe("linear-uuid-ghi");
  });

  test("returns nothing when neither branch nor identifier matches", () => {
    manager.createTicket({ ticketUUID: "linear-uuid-xyz", product: "test-app" });
    // No branch_name and no ticket_id

    const byBranch = sql.exec(
      "SELECT ticket_uuid FROM tickets WHERE branch_name = ? OR branch_name = ?",
      "ticket/UNKNOWN-99", "feedback/UNKNOWN-99",
    ).toArray()[0] as { ticket_uuid: string } | undefined;
    expect(byBranch).toBeUndefined();

    const byIdentifier = manager.getTicketByIdentifier("UNKNOWN-99");
    expect(byIdentifier).toBeNull();
  });

  test("end-to-end: branch resolution + pr_merged updates correct ticket", async () => {
    const mockNs = createMockTicketAgentNs();
    manager = new AgentManager(sql, { TICKET_AGENT: mockNs });

    // Create ticket under Linear UUID, set branch after agent starts working
    manager.createTicket({ ticketUUID: "linear-uuid-merge", product: "test-app", ticketId: "PES-12" });
    manager.updateStatus("linear-uuid-merge", { status: "reviewing" });
    manager.updateStatus("linear-uuid-merge", { status: "spawning" });
    manager.updateStatus("linear-uuid-merge", { status: "active" });
    manager.updateStatus("linear-uuid-merge", { status: "pr_open" });
    manager.updateStatus("linear-uuid-merge", { branch_name: "ticket/PES-12" });
    sql._tickets.get("linear-uuid-merge")!.agent_active = 1;

    // GitHub webhook arrives with taskId "PES-12" (extracted from branch name)
    // handleEvent resolves it to "linear-uuid-merge" via branch lookup
    const byBranch = sql.exec(
      "SELECT ticket_uuid FROM tickets WHERE branch_name = ? OR branch_name = ?",
      "ticket/PES-12", "feedback/PES-12",
    ).toArray()[0] as { ticket_uuid: string };
    const resolvedUUID = byBranch.ticket_uuid;
    expect(resolvedUUID).toBe("linear-uuid-merge");

    // Then pr_merged is handled using the resolved UUID
    await simulatePrMerged(manager, sql, resolvedUUID);

    const updated = manager.getTicket("linear-uuid-merge")!;
    expect(updated.status).toBe("merged");
    expect(updated.agent_active).toBe(0);
  });

  test("end-to-end: identifier fallback + pr_closed updates correct ticket", async () => {
    const mockNs = createMockTicketAgentNs();
    manager = new AgentManager(sql, { TICKET_AGENT: mockNs });

    // Ticket with identifier but no branch_name yet
    manager.createTicket({ ticketUUID: "linear-uuid-close", product: "test-app", ticketId: "PES-15" });
    manager.updateStatus("linear-uuid-close", { status: "reviewing" });
    manager.updateStatus("linear-uuid-close", { status: "spawning" });
    manager.updateStatus("linear-uuid-close", { status: "active" });
    manager.updateStatus("linear-uuid-close", { status: "pr_open" });
    sql._tickets.get("linear-uuid-close")!.agent_active = 1;

    // Branch lookup fails (no branch_name set)
    const byBranch = sql.exec(
      "SELECT ticket_uuid FROM tickets WHERE branch_name = ? OR branch_name = ?",
      "ticket/PES-15", "feedback/PES-15",
    ).toArray()[0] as { ticket_uuid: string } | undefined;
    expect(byBranch).toBeUndefined();

    // Fall back to identifier
    const byIdentifier = manager.getTicketByIdentifier("PES-15");
    expect(byIdentifier).not.toBeNull();
    const resolvedUUID = byIdentifier!.ticket_uuid;

    await simulatePrClosed(manager, sql, resolvedUUID);

    const updated = manager.getTicket("linear-uuid-close")!;
    expect(updated.status).toBe("closed");
    expect(updated.agent_active).toBe(0);
  });
});
