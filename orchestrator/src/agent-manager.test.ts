import { describe, it, expect, beforeEach } from "bun:test";
import { AgentManager, type CreateTicketParams, type SpawnConfig } from "./agent-manager";
import { VALID_TRANSITIONS, TERMINAL_STATUSES, TICKET_STATES, type TicketState } from "./types";

// In-memory SQLite mock — stores tickets as a Map
function createMockSql() {
  const tickets = new Map<string, Record<string, unknown>>();

  return {
    exec(sql: string, ...params: unknown[]) {
      const trimmed = sql.trim();

      // INSERT INTO tickets
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
          last_heartbeat: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return { toArray: () => [] };
      }

      // DELETE FROM tickets WHERE ticket_uuid = ?
      if (trimmed.startsWith("DELETE FROM tickets")) {
        tickets.delete(params[0] as string);
        return { toArray: () => [] };
      }

      // SELECT * FROM tickets WHERE ticket_uuid = ?
      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tickets") && trimmed.includes("WHERE ticket_uuid =")) {
        const ticketUUID = params[0] as string;
        const row = tickets.get(ticketUUID);
        return { toArray: () => row ? [{ ...row }] : [] };
      }

      // SELECT * FROM tickets WHERE ticket_id = ?
      if (trimmed.startsWith("SELECT") && trimmed.includes("FROM tickets") && trimmed.includes("WHERE ticket_id")) {
        const ticketId = params[0] as string;
        const match = [...tickets.values()].find(t => t.ticket_id === ticketId);
        return { toArray: () => match ? [{ ...match }] : [] };
      }

      // SELECT ticket_uuid FROM tickets WHERE agent_active = 1 AND status IN (...)
      if (trimmed.includes("agent_active = 1") && trimmed.includes("status IN")) {
        const statusMatch = trimmed.match(/IN \(([^)]+)\)/);
        const statuses = statusMatch ? statusMatch[1].split(",").map(s => s.trim().replace(/'/g, "")) : [];
        const matching = [...tickets.values()].filter(
          t => t.agent_active === 1 && statuses.includes(t.status as string),
        );
        return { toArray: () => matching.map(t => ({ ticket_uuid: t.ticket_uuid })) };
      }

      // UPDATE tickets SET ... WHERE ticket_uuid = ? AND agent_active = 1
      // UPDATE tickets SET ... WHERE ticket_uuid = ?
      if (trimmed.startsWith("UPDATE tickets SET")) {
        const id = params[params.length - 1] as string;
        const row = tickets.get(id);
        if (!row) return { toArray: () => [] };

        // Check for agent_active = 1 condition in WHERE clause
        if (trimmed.includes("AND agent_active = 1") && row.agent_active !== 1) {
          return { toArray: () => [] };
        }

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
          } else if (part.match(/agent_active\s*=\s*0/)) {
            row.agent_active = 0;
          } else if (part.match(/agent_active\s*=\s*1/)) {
            row.agent_active = 1;
          }
        }
        row.updated_at = new Date().toISOString();
        return { toArray: () => [] };
      }

      // SELECT * FROM tickets WHERE agent_active = 1 ORDER BY ...
      if (trimmed.startsWith("SELECT") && trimmed.includes("agent_active = 1")) {
        const active = [...tickets.values()].filter(t => t.agent_active === 1);
        return { toArray: () => active };
      }

      return { toArray: () => [] };
    },
    // Expose for test assertions
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
    setResponse(ticketId: string, status: number, body = "") {
      if (!agents.has(ticketId)) {
        agents.set(ticketId, { fetchCalls: [], nextResponse: new Response(body, { status }) });
      } else {
        agents.get(ticketId)!.nextResponse = new Response(body, { status });
      }
    },
  };
}

const defaultSpawnConfig: SpawnConfig = {
  product: "test-product",
  repos: ["org/repo"],
  slackChannel: "C123",
  secrets: { GITHUB_TOKEN: "gh-token" },
};

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
    ticketUUID: "PE-1",
    product: "test-product",
  };

  beforeEach(() => {
    sql = createMockSql();
    manager = new AgentManager(sql, {});
  });

  describe("createTicket", () => {
    it("creates ticket in 'created' state with agent_active=0", () => {
      const ticket = manager.createTicket(defaultParams);
      expect(ticket.ticket_uuid).toBe("PE-1");
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
        ticketUUID: "PE-2",
        product: "my-product",
        slackThreadTs: "1234.5678",
        slackChannel: "C123",
        ticketId: "PE-2",
        title: "Fix the bug",
      });

      expect(ticket.slack_thread_ts).toBe("1234.5678");
      expect(ticket.slack_channel).toBe("C123");
      expect(ticket.ticket_id).toBe("PE-2");
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
      expect(ticket!.ticket_uuid).toBe("PE-1");
      expect(ticket!.status).toBe("created");
    });
  });

  describe("getTicketByIdentifier", () => {
    it("returns null when no ticket has that identifier", () => {
      expect(manager.getTicketByIdentifier("PES-99")).toBeNull();
    });

    it("finds a ticket by its identifier", () => {
      manager.createTicket({ ticketUUID: "uuid-123", product: "test", ticketId: "PES-5" });
      const ticket = manager.getTicketByIdentifier("PES-5");
      expect(ticket).not.toBeNull();
      expect(ticket!.ticket_uuid).toBe("uuid-123");
      expect(ticket!.ticket_id).toBe("PES-5");
    });

    it("does not match by id when looking up by identifier", () => {
      manager.createTicket({ ticketUUID: "PES-5", product: "test" });
      // id is "PES-5" but identifier is null
      expect(manager.getTicketByIdentifier("PES-5")).toBeNull();
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
        manager.createTicket({ ticketUUID: id, product: "test" });

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

  describe("spawnAgent", () => {
    let mockNs: ReturnType<typeof createMockTicketAgentNs>;

    beforeEach(() => {
      mockNs = createMockTicketAgentNs();
      manager = new AgentManager(sql, { TICKET_AGENT: mockNs });
    });

    it("transitions from reviewing to spawning and sets agent_active=1", async () => {
      manager.createTicket(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });

      await manager.spawnAgent("PE-1", defaultSpawnConfig);

      const ticket = manager.getTicket("PE-1")!;
      expect(ticket.status).toBe("spawning");
      expect(ticket.agent_active).toBe(1);
    });

    it("sends /initialize to TicketAgent DO with correct config", async () => {
      manager.createTicket(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });

      await manager.spawnAgent("PE-1", {
        ...defaultSpawnConfig,
        slackThreadTs: "ts-123",
        model: "opus",
      });

      const calls = mockNs._agents.get("PE-1")!.fetchCalls;
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("http://internal/initialize");
      expect(calls[0].method).toBe("POST");
      const body = JSON.parse(calls[0].body!);
      expect(body.ticketUUID).toBe("PE-1");
      expect(body.product).toBe("test-product");
      expect(body.repos).toEqual(["org/repo"]);
      expect(body.slackThreadTs).toBe("ts-123");
      expect(body.model).toBe("opus");
    });

    it("allows re-spawn from spawning state (deploy recovery)", async () => {
      manager.createTicket(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });
      manager.updateStatus("PE-1", { status: "spawning" });

      await manager.spawnAgent("PE-1", defaultSpawnConfig);

      const ticket = manager.getTicket("PE-1")!;
      expect(ticket.status).toBe("spawning");
      expect(ticket.agent_active).toBe(1);
    });

    it("allows re-spawn from active state (deploy recovery)", async () => {
      manager.createTicket(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });
      manager.updateStatus("PE-1", { status: "spawning" });
      manager.updateStatus("PE-1", { status: "active" });

      await manager.spawnAgent("PE-1", defaultSpawnConfig);

      const ticket = manager.getTicket("PE-1")!;
      expect(ticket.status).toBe("active");
      expect(ticket.agent_active).toBe(1);
    });

    it("throws for ticket not in valid spawn state (e.g., created)", async () => {
      manager.createTicket(defaultParams);

      await expect(manager.spawnAgent("PE-1", defaultSpawnConfig)).rejects.toThrow(
        "Cannot spawn agent for ticket in created state"
      );
    });

    it("marks failed on init failure for new spawns", async () => {
      manager.createTicket(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });
      mockNs.setResponse("PE-1", 500, "error");

      await expect(manager.spawnAgent("PE-1", defaultSpawnConfig)).rejects.toThrow(
        "Agent init failed: 500"
      );

      const ticket = manager.getTicket("PE-1")!;
      expect(ticket.status).toBe("failed");
      expect(ticket.agent_active).toBe(0);
    });

    it("does NOT mark failed on init failure for respawns", async () => {
      manager.createTicket(defaultParams);
      manager.updateStatus("PE-1", { status: "reviewing" });
      manager.updateStatus("PE-1", { status: "spawning" });
      manager.updateStatus("PE-1", { status: "active" });
      mockNs.setResponse("PE-1", 500, "error");

      await expect(manager.spawnAgent("PE-1", defaultSpawnConfig)).rejects.toThrow(
        "Agent init failed: 500"
      );

      const ticket = manager.getTicket("PE-1")!;
      expect(ticket.status).toBe("active"); // Keeps current state
      expect(ticket.agent_active).toBe(0);
    });

    it("throws for terminal ticket", async () => {
      manager.createTicket(defaultParams);
      manager.updateStatus("PE-1", { status: "failed" });

      await expect(manager.spawnAgent("PE-1", defaultSpawnConfig)).rejects.toThrow(
        "Ticket PE-1 is terminal"
      );
    });

    it("throws for non-existent ticket", async () => {
      await expect(manager.spawnAgent("nonexistent", defaultSpawnConfig)).rejects.toThrow(
        "Ticket nonexistent not found"
      );
    });
  });

  describe("stopAgent", () => {
    let mockNs: ReturnType<typeof createMockTicketAgentNs>;

    beforeEach(() => {
      mockNs = createMockTicketAgentNs();
      manager = new AgentManager(sql, { TICKET_AGENT: mockNs });
    });

    it("sets agent_active=0", async () => {
      manager.createTicket(defaultParams);
      sql._tickets.get("PE-1")!.agent_active = 1;

      await manager.stopAgent("PE-1", "test stop");

      const ticket = manager.getTicket("PE-1")!;
      expect(ticket.agent_active).toBe(0);
    });

    it("sends /mark-terminal to TicketAgent DO", async () => {
      manager.createTicket(defaultParams);
      sql._tickets.get("PE-1")!.agent_active = 1;

      await manager.stopAgent("PE-1", "test stop");

      const calls = mockNs._agents.get("PE-1")!.fetchCalls;
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("http://internal/mark-terminal");
      expect(calls[0].method).toBe("POST");
    });

    it("is idempotent (calling twice doesn't throw)", async () => {
      manager.createTicket(defaultParams);
      sql._tickets.get("PE-1")!.agent_active = 1;

      await manager.stopAgent("PE-1", "first");
      await manager.stopAgent("PE-1", "second"); // should not throw

      expect(manager.getTicket("PE-1")!.agent_active).toBe(0);
    });
  });

  describe("sendEvent", () => {
    let mockNs: ReturnType<typeof createMockTicketAgentNs>;

    beforeEach(() => {
      mockNs = createMockTicketAgentNs();
      manager = new AgentManager(sql, { TICKET_AGENT: mockNs }, { retryDelayMs: 0 });
    });

    it("sends event to running agent", async () => {
      manager.createTicket(defaultParams);
      sql._tickets.get("PE-1")!.agent_active = 1;

      const event = { type: "test", payload: "data" };
      await manager.sendEvent("PE-1", event);

      const calls = mockNs._agents.get("PE-1")!.fetchCalls;
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("http://internal/event");
      expect(JSON.parse(calls[0].body!)).toEqual(event);
    });

    it("ignores terminal tickets", async () => {
      manager.createTicket(defaultParams);
      manager.updateStatus("PE-1", { status: "failed" });

      await manager.sendEvent("PE-1", { type: "test" });

      // No fetch calls should be made
      expect(mockNs._agents.has("PE-1")).toBe(false);
    });

    it("skips when no active agent (agent_active=0)", async () => {
      manager.createTicket(defaultParams);

      await manager.sendEvent("PE-1", { type: "test" });

      expect(mockNs._agents.has("PE-1")).toBe(false);
    });

    it("throws for non-existent ticket", async () => {
      await expect(manager.sendEvent("nonexistent", {})).rejects.toThrow(
        "Ticket nonexistent not found"
      );
    });

    it("marks agent inactive (not terminal) after 3 consecutive 503s", async () => {
      manager.createTicket(defaultParams);
      sql._tickets.get("PE-1")!.agent_active = 1;
      sql._tickets.get("PE-1")!.status = "active";
      mockNs.setResponse("PE-1", 503, "not ready");

      await manager.sendEvent("PE-1", { type: "test" });

      const ticket = manager.getTicket("PE-1")!;
      // Should NOT be terminal — transient 503s leave ticket retryable
      expect(ticket.status).toBe("active");
      expect(ticket.agent_active).toBe(0);
    });

    it("throws on non-503 error response", async () => {
      manager.createTicket(defaultParams);
      sql._tickets.get("PE-1")!.agent_active = 1;
      mockNs.setResponse("PE-1", 400, "bad request");

      await expect(manager.sendEvent("PE-1", {})).rejects.toThrow(
        "Event delivery failed: 400"
      );
    });
  });

  describe("recordHeartbeat", () => {
    it("updates last_heartbeat for active tickets", () => {
      manager.createTicket(defaultParams);
      sql._tickets.get("PE-1")!.agent_active = 1;

      manager.recordHeartbeat("PE-1");

      const ticket = manager.getTicket("PE-1")!;
      expect(ticket.last_heartbeat).not.toBeNull();
    });

    it("does not update last_heartbeat for inactive tickets", () => {
      manager.createTicket(defaultParams);
      // agent_active is 0 by default

      manager.recordHeartbeat("PE-1");

      const ticket = manager.getTicket("PE-1")!;
      expect(ticket.last_heartbeat).toBeNull();
    });
  });

  describe("getActiveAgents", () => {
    it("returns only active tickets", () => {
      manager.createTicket({ ticketUUID: "PE-1", product: "test" });
      manager.createTicket({ ticketUUID: "PE-2", product: "test" });
      sql._tickets.get("PE-1")!.agent_active = 1;

      const active = manager.getActiveAgents();
      expect(active.length).toBe(1);
      expect(active[0].ticket_uuid).toBe("PE-1");
    });

    it("returns empty array when none active", () => {
      manager.createTicket(defaultParams);

      const active = manager.getActiveAgents();
      expect(active).toEqual([]);
    });
  });

  describe("stopAllAgents", () => {
    let mockNs: ReturnType<typeof createMockTicketAgentNs>;

    beforeEach(() => {
      mockNs = createMockTicketAgentNs();
      manager = new AgentManager(sql, { TICKET_AGENT: mockNs });
    });

    it("stops all active agents", async () => {
      manager.createTicket({ ticketUUID: "PE-1", product: "test" });
      manager.createTicket({ ticketUUID: "PE-2", product: "test" });
      sql._tickets.get("PE-1")!.agent_active = 1;
      sql._tickets.get("PE-2")!.agent_active = 1;

      await manager.stopAllAgents("shutdown");

      expect(manager.getTicket("PE-1")!.agent_active).toBe(0);
      expect(manager.getTicket("PE-2")!.agent_active).toBe(0);
    });
  });

  describe("cleanupInactive", () => {
    let mockNs: ReturnType<typeof createMockTicketAgentNs>;

    beforeEach(() => {
      mockNs = createMockTicketAgentNs();
      manager = new AgentManager(sql, { TICKET_AGENT: mockNs });
    });

    it("stops agents that are terminal but still agent_active=1", async () => {
      manager.createTicket(defaultParams);
      manager.updateStatus("PE-1", { status: "failed" });
      // Simulate inconsistency: status is terminal but agent_active=1
      sql._tickets.get("PE-1")!.agent_active = 1;

      await manager.cleanupInactive();

      expect(manager.getTicket("PE-1")!.agent_active).toBe(0);
    });

    it("does not stop non-terminal active agents", async () => {
      manager.createTicket(defaultParams);
      sql._tickets.get("PE-1")!.agent_active = 1;
      // status is "created" — not terminal

      await manager.cleanupInactive();

      expect(manager.getTicket("PE-1")!.agent_active).toBe(1);
    });
  });

  describe("deploy resilience", () => {
    let mockNs: ReturnType<typeof createMockTicketAgentNs>;

    it("fresh AgentManager instance sees pre-deploy tickets", () => {
      // Create ticket with first instance
      const sql1 = createMockSql();
      const mgr1 = new AgentManager(sql1, {});
      mgr1.createTicket(defaultParams);
      mgr1.updateStatus("PE-1", { status: "reviewing" });

      // Simulate deploy: new instance, same SQL store
      const mgr2 = new AgentManager(sql1, {});
      const ticket = mgr2.getTicket("PE-1");
      expect(ticket).not.toBeNull();
      expect(ticket!.status).toBe("reviewing");
    });

    it("spawnAgent is safe to re-call after deploy (new instance, same SQL)", async () => {
      mockNs = createMockTicketAgentNs();
      const sharedSql = createMockSql();

      // First instance spawns
      const mgr1 = new AgentManager(sharedSql, { TICKET_AGENT: mockNs });
      mgr1.createTicket(defaultParams);
      mgr1.updateStatus("PE-1", { status: "reviewing" });
      await mgr1.spawnAgent("PE-1", defaultSpawnConfig);

      // Simulate deploy: new AgentManager, ticket is in "spawning" with agent_active=1
      const mgr2 = new AgentManager(sharedSql, { TICKET_AGENT: mockNs });
      await mgr2.spawnAgent("PE-1", defaultSpawnConfig); // re-spawn, should not throw

      expect(mgr2.getTicket("PE-1")!.agent_active).toBe(1);
    });

    it("stopAgent is idempotent across instances", async () => {
      mockNs = createMockTicketAgentNs();
      const sharedSql = createMockSql();
      const mgr1 = new AgentManager(sharedSql, { TICKET_AGENT: mockNs });
      mgr1.createTicket(defaultParams);
      sharedSql._tickets.get("PE-1")!.agent_active = 1;

      await mgr1.stopAgent("PE-1", "first");

      const mgr2 = new AgentManager(sharedSql, { TICKET_AGENT: mockNs });
      await mgr2.stopAgent("PE-1", "second"); // idempotent

      expect(mgr2.getTicket("PE-1")!.agent_active).toBe(0);
    });
  });

  describe("reactivate", () => {
    it("sets agent_active=1 for non-terminal ticket", () => {
      manager.createTicket(defaultParams);
      expect(manager.getTicket("PE-1")!.agent_active).toBe(0);

      manager.reactivate("PE-1");
      expect(manager.getTicket("PE-1")!.agent_active).toBe(1);
    });

    it("no-ops for terminal ticket", () => {
      manager.createTicket(defaultParams);
      manager.updateStatus("PE-1", { status: "failed" });

      manager.reactivate("PE-1");
      expect(manager.getTicket("PE-1")!.agent_active).toBe(0);
    });
  });

  describe("isTerminalStatus", () => {
    it("returns true for terminal statuses", () => {
      expect(manager.isTerminalStatus("merged")).toBe(true);
      expect(manager.isTerminalStatus("closed")).toBe(true);
      expect(manager.isTerminalStatus("deferred")).toBe(true);
      expect(manager.isTerminalStatus("failed")).toBe(true);
    });

    it("returns false for non-terminal statuses", () => {
      expect(manager.isTerminalStatus("created")).toBe(false);
      expect(manager.isTerminalStatus("active")).toBe(false);
      expect(manager.isTerminalStatus("pr_open")).toBe(false);
    });
  });
});
