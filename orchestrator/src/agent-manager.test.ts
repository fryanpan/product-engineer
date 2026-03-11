import { describe, it, expect, beforeEach } from "bun:test";
import { AgentManager, type CreateTicketParams } from "./agent-manager";
import { VALID_TRANSITIONS, TERMINAL_STATUSES, TICKET_STATES, type TicketState } from "./types";

// In-memory SQLite mock — stores tickets as a Map
function createMockSql() {
  const tickets = new Map<string, Record<string, unknown>>();

  return {
    exec(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim();

      // INSERT INTO tickets
      if (trimmed.startsWith("INSERT INTO tickets")) {
        const [id, product, slackTs, slackCh, identifier, title] = params;

        tickets.set(id as string, {
          id, product,
          status: "created",
          slack_thread_ts: slackTs || null,
          slack_channel: slackCh || null,
          pr_url: null,
          branch_name: null,
          identifier: identifier || null,
          title: title || null,
          agent_active: 0,
          transcript_r2_key: null,
          last_heartbeat: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return { toArray: () => [] };
      }

      // DELETE FROM tickets WHERE id = ?
      if (trimmed.startsWith("DELETE FROM tickets")) {
        tickets.delete(params[0] as string);
        return { toArray: () => [] };
      }

      // SELECT * FROM tickets WHERE id = ?
      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tickets") && trimmed.includes("WHERE id")) {
        const id = params[0] as string;
        const row = tickets.get(id);
        return { toArray: () => row ? [{ ...row }] : [] };
      }

      // SELECT * FROM tickets WHERE agent_active = 1
      if (trimmed.includes("agent_active = 1")) {
        const active = [...tickets.values()].filter(t => t.agent_active === 1);
        return { toArray: () => active };
      }

      // UPDATE tickets SET ... WHERE id = ?
      if (trimmed.startsWith("UPDATE tickets SET")) {
        const id = params[params.length - 1] as string;
        const row = tickets.get(id);
        if (!row) return { toArray: () => [] };

        // Parse SET clauses to figure out which fields to update
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
          } else if (part.includes("agent_active = 0")) {
            row.agent_active = 0;
          }
        }
        row.updated_at = new Date().toISOString();
        return { toArray: () => [] };
      }

      return { toArray: () => [] };
    },
    // Expose for test assertions
    _tickets: tickets,
  };
}

describe("State machine", () => {
  it("terminal states have no outgoing transitions", () => {
    for (const state of TERMINAL_STATUSES) {
      expect(VALID_TRANSITIONS[state]).toEqual([]);
    }
  });

  it("all transition targets are valid states", () => {
    const validStates = new Set<string>(TICKET_STATES);
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const target of targets) {
        expect(validStates.has(target)).toBe(true);
      }
    }
  });

  it("every non-terminal state can reach a terminal state", () => {
    const terminalSet = new Set<string>(TERMINAL_STATUSES);

    function canReachTerminal(state: TicketState, visited = new Set<string>()): boolean {
      if (terminalSet.has(state)) return true;
      if (visited.has(state)) return false;
      visited.add(state);
      return VALID_TRANSITIONS[state].some(next => canReachTerminal(next, new Set(visited)));
    }

    for (const state of TICKET_STATES) {
      if (!terminalSet.has(state)) {
        expect(canReachTerminal(state)).toBe(true);
      }
    }
  });
});

describe("AgentManager", () => {
  let sql: ReturnType<typeof createMockSql>;
  let manager: AgentManager;

  const defaultParams: CreateTicketParams = {
    id: "PE-1",
    product: "test-product",
  };

  beforeEach(() => {
    sql = createMockSql();
    manager = new AgentManager(sql, {});
  });

  describe("createTicket", () => {
    it("creates ticket in 'created' state with agent_active=0", () => {
      const ticket = manager.createTicket(defaultParams);
      expect(ticket.id).toBe("PE-1");
      expect(ticket.product).toBe("test-product");
      expect(ticket.status).toBe("created");
      expect(ticket.agent_active).toBe(0);
    });

    it("throws if ticket already exists in non-terminal state", () => {
      manager.createTicket(defaultParams);
      expect(() => manager.createTicket(defaultParams)).toThrow(
        "Ticket PE-1 already exists (status: created)"
      );
    });

    it("allows re-creating after terminal state", () => {
      manager.createTicket(defaultParams);
      // Transition to terminal: created → reviewing → spawning → active → pr_open → merged
      manager.updateStatus("PE-1", { status: "reviewing" });
      manager.updateStatus("PE-1", { status: "spawning" });
      manager.updateStatus("PE-1", { status: "active" });
      manager.updateStatus("PE-1", { status: "pr_open" });
      manager.updateStatus("PE-1", { status: "merged" });

      // Should be able to re-create
      const ticket = manager.createTicket(defaultParams);
      expect(ticket.status).toBe("created");
    });

    it("stores all provided fields", () => {
      const ticket = manager.createTicket({
        id: "PE-2",
        product: "my-product",
        slackThreadTs: "1234.5678",
        slackChannel: "C123",
        identifier: "PE-2",
        title: "Fix the bug",
      });

      expect(ticket.slack_thread_ts).toBe("1234.5678");
      expect(ticket.slack_channel).toBe("C123");
      expect(ticket.identifier).toBe("PE-2");
      expect(ticket.title).toBe("Fix the bug");
    });
  });

  describe("getTicket", () => {
    it("returns null for non-existent ticket", () => {
      expect(manager.getTicket("nonexistent")).toBeNull();
    });

    it("returns the ticket record after creation", () => {
      manager.createTicket(defaultParams);
      const ticket = manager.getTicket("PE-1");
      expect(ticket).not.toBeNull();
      expect(ticket!.id).toBe("PE-1");
      expect(ticket!.status).toBe("created");
    });
  });

  describe("isTerminal", () => {
    it("returns false for non-existent ticket", () => {
      expect(manager.isTerminal("nonexistent")).toBe(false);
    });

    it("returns false for 'created' ticket", () => {
      manager.createTicket(defaultParams);
      expect(manager.isTerminal("PE-1")).toBe(false);
    });

    it("returns true for each terminal status", () => {
      for (const terminalStatus of TERMINAL_STATUSES) {
        const id = `terminal-${terminalStatus}`;
        manager.createTicket({ id, product: "test" });

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
          // deferred has no inbound transitions in VALID_TRANSITIONS,
          // so we set it directly via the mock for this test
          sql._tickets.get(id)!.status = "deferred";
        }

        expect(manager.isTerminal(id)).toBe(true);
      }
    });
  });

  describe("updateStatus", () => {
    it("allows valid transitions (created -> reviewing)", () => {
      manager.createTicket(defaultParams);
      const ticket = manager.updateStatus("PE-1", { status: "reviewing" });
      expect(ticket.status).toBe("reviewing");
    });

    it("rejects invalid transitions (created -> merged)", () => {
      manager.createTicket(defaultParams);
      expect(() => manager.updateStatus("PE-1", { status: "merged" })).toThrow(
        "Invalid transition: created → merged"
      );
    });

    it("sets agent_active=0 on terminal transitions", () => {
      manager.createTicket(defaultParams);
      // Set agent_active=1 manually to verify it gets reset
      sql._tickets.get("PE-1")!.agent_active = 1;

      manager.updateStatus("PE-1", { status: "failed" });
      const ticket = manager.getTicket("PE-1");
      expect(ticket!.agent_active).toBe(0);
    });

    it("updates metadata fields without changing status", () => {
      manager.createTicket(defaultParams);
      const ticket = manager.updateStatus("PE-1", {
        pr_url: "https://github.com/org/repo/pull/1",
        branch_name: "fix/pe-1",
      });
      expect(ticket.pr_url).toBe("https://github.com/org/repo/pull/1");
      expect(ticket.branch_name).toBe("fix/pe-1");
      expect(ticket.status).toBe("created");
    });

    it("throws for non-existent ticket", () => {
      expect(() => manager.updateStatus("nonexistent", { status: "reviewing" })).toThrow(
        "Ticket nonexistent not found"
      );
    });

    it("ignores updates for terminal tickets (returns ticket without throwing)", () => {
      manager.createTicket(defaultParams);
      manager.updateStatus("PE-1", { status: "failed" });

      // Should not throw, just return the existing ticket
      const ticket = manager.updateStatus("PE-1", { status: "reviewing" as any });
      expect(ticket.status).toBe("failed");
    });

    it("handles multiple metadata fields in one update", () => {
      manager.createTicket(defaultParams);
      const ticket = manager.updateStatus("PE-1", {
        status: "reviewing",
        slack_thread_ts: "9999.0000",
        transcript_r2_key: "transcripts/pe-1.json",
      });
      expect(ticket.status).toBe("reviewing");
      expect(ticket.slack_thread_ts).toBe("9999.0000");
      expect(ticket.transcript_r2_key).toBe("transcripts/pe-1.json");
    });
  });
});
