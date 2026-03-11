import { VALID_TRANSITIONS, TERMINAL_STATUSES, type TicketState, type TicketRecord } from "./types";

export interface CreateTicketParams {
  id: string;
  product: string;
  slackThreadTs?: string;
  slackChannel?: string;
  identifier?: string;
  title?: string;
}

export interface StatusUpdate {
  status?: TicketState;
  pr_url?: string;
  branch_name?: string;
  slack_thread_ts?: string;
  transcript_r2_key?: string;
}

export interface SpawnConfig {
  product: string;
  repos: string[];
  slackChannel: string;
  slackThreadTs?: string;
  secrets: Record<string, string>;
  gatewayConfig?: { account_id: string; gateway_id: string } | null;
  model?: string;
}

interface SqlResult {
  toArray(): Record<string, unknown>[];
}

interface SqlExec {
  exec(sql: string, ...params: unknown[]): SqlResult;
}

export interface AgentManagerOptions {
  /** Base retry delay in ms for sendEvent backoff. Default 2000. */
  retryDelayMs?: number;
}

export class AgentManager {
  private retryDelayMs: number;

  constructor(
    private sql: SqlExec,
    private env: Record<string, unknown>,
    options?: AgentManagerOptions,
  ) {
    this.retryDelayMs = options?.retryDelayMs ?? 2000;
  }

  createTicket(params: CreateTicketParams): TicketRecord {
    const existing = this.getTicket(params.id);
    if (existing && !this.isTerminal(params.id)) {
      throw new Error(`Ticket ${params.id} already exists (status: ${existing.status})`);
    }

    // If re-creating after terminal, reset everything
    if (existing) {
      this.sql.exec("DELETE FROM tickets WHERE id = ?", params.id);
    }

    this.sql.exec(
      `INSERT INTO tickets (id, product, status, slack_thread_ts, slack_channel, identifier, title, agent_active)
       VALUES (?, ?, 'created', ?, ?, ?, ?, 0)`,
      params.id, params.product,
      params.slackThreadTs || null, params.slackChannel || null,
      params.identifier || null, params.title || null,
    );

    return this.getTicket(params.id)!;
  }

  getTicket(ticketId: string): TicketRecord | null {
    const row = this.sql.exec(
      "SELECT * FROM tickets WHERE id = ?", ticketId,
    ).toArray()[0] as unknown as TicketRecord | undefined;
    return row || null;
  }

  /** Look up a ticket by its human-readable identifier (e.g., "PES-23"). */
  getTicketByIdentifier(identifier: string): TicketRecord | null {
    const row = this.sql.exec(
      "SELECT * FROM tickets WHERE identifier = ?", identifier,
    ).toArray()[0] as unknown as TicketRecord | undefined;
    return row || null;
  }

  isTerminal(ticketId: string): boolean {
    const ticket = this.getTicket(ticketId);
    if (!ticket) return false;
    return (TERMINAL_STATUSES as readonly string[]).includes(ticket.status);
  }

  /** Check if a status string is terminal (no ticket lookup needed). */
  isTerminalStatus(status: string): boolean {
    return (TERMINAL_STATUSES as readonly string[]).includes(status);
  }

  updateStatus(ticketId: string, update: StatusUpdate): TicketRecord {
    const ticket = this.getTicket(ticketId);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);

    if (this.isTerminal(ticketId)) {
      console.log(`[AgentManager] Ignoring update for terminal ticket ${ticketId}`);
      return ticket;
    }

    // Validate state transition if status is changing
    if (update.status && update.status !== ticket.status) {
      const currentState = ticket.status as TicketState;
      const allowed = VALID_TRANSITIONS[currentState];
      if (!allowed || !(allowed as readonly string[]).includes(update.status)) {
        throw new Error(
          `Invalid transition: ${currentState} → ${update.status} (allowed: ${(allowed || []).join(", ")})`
        );
      }
    }

    const sets: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    if (update.status) {
      sets.push("status = ?");
      values.push(update.status);

      // Auto-set agent_active=0 on terminal
      if ((TERMINAL_STATUSES as readonly string[]).includes(update.status)) {
        sets.push("agent_active = 0");
        console.log(`[AgentManager] Terminal state ${update.status} for ${ticketId}`);
      }
    }
    if (update.pr_url !== undefined) { sets.push("pr_url = ?"); values.push(update.pr_url); }
    if (update.branch_name !== undefined) { sets.push("branch_name = ?"); values.push(update.branch_name); }
    if (update.slack_thread_ts !== undefined) { sets.push("slack_thread_ts = ?"); values.push(update.slack_thread_ts); }
    if (update.transcript_r2_key !== undefined) { sets.push("transcript_r2_key = ?"); values.push(update.transcript_r2_key); }

    values.push(ticketId);
    this.sql.exec(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`, ...values);

    return this.getTicket(ticketId)!;
  }

  /**
   * Spawn an agent container for a ticket.
   * Deploy re-spawn safe: accepts tickets in spawning/active state (re-initializes container).
   * For new spawns, transitions from reviewing/queued → spawning.
   */
  async spawnAgent(ticketId: string, config: SpawnConfig): Promise<void> {
    const ticket = this.getTicket(ticketId);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
    if (this.isTerminal(ticketId)) throw new Error(`Ticket ${ticketId} is terminal`);

    const isRespawn = ticket.status === "spawning" || ticket.status === "active";

    if (!isRespawn) {
      // New spawn — must be in reviewing or queued
      if (ticket.status !== "reviewing" && ticket.status !== "queued") {
        throw new Error(`Cannot spawn agent for ticket in ${ticket.status} state`);
      }
      // Transition to spawning
      this.updateStatus(ticketId, { status: "spawning" });
    }

    // Set agent_active=1
    this.sql.exec(
      "UPDATE tickets SET agent_active = 1, updated_at = datetime('now') WHERE id = ?",
      ticketId,
    );

    try {
      const agentNs = this.env.TICKET_AGENT as any;
      const id = agentNs.idFromName(ticketId);
      const agent = agentNs.get(id);

      // Initialize the agent container with config
      const initRes = await agent.fetch(new Request("http://internal/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketId,
          product: config.product,
          repos: config.repos,
          slackChannel: config.slackChannel,
          slackThreadTs: config.slackThreadTs || ticket.slack_thread_ts || undefined,
          secrets: config.secrets,
          gatewayConfig: config.gatewayConfig,
          model: config.model,
        }),
      }));

      if (!initRes.ok) {
        throw new Error(`Agent init failed: ${initRes.status}`);
      }
      console.log(`[AgentManager] Agent spawned for ${ticketId} (respawn=${isRespawn})`);
    } catch (err) {
      // On failure: mark agent inactive, transition to failed for new spawns
      if (!isRespawn) {
        try {
          this.updateStatus(ticketId, { status: "failed" });
        } catch {
          this.sql.exec(
            "UPDATE tickets SET status = 'failed', agent_active = 0, updated_at = datetime('now') WHERE id = ?",
            ticketId,
          );
        }
      } else {
        // Respawns keep current state so alarm can retry later
        this.sql.exec(
          "UPDATE tickets SET agent_active = 0, updated_at = datetime('now') WHERE id = ?",
          ticketId,
        );
      }
      console.error(`[AgentManager] Failed to spawn agent for ${ticketId}:`, err);
      throw err;
    }
  }

  /**
   * Stop an agent. Idempotent — safe to call on already-stopped agents.
   */
  async stopAgent(ticketId: string, reason: string): Promise<void> {
    console.log(`[AgentManager] Stopping agent for ${ticketId}: ${reason}`);

    // Set agent_active=0 in DB first
    this.sql.exec(
      "UPDATE tickets SET agent_active = 0, updated_at = datetime('now') WHERE id = ?",
      ticketId,
    );

    // Notify TicketAgent DO — best-effort, don't throw on failure
    try {
      const agentNs = this.env.TICKET_AGENT as any;
      const id = agentNs.idFromName(ticketId);
      const agent = agentNs.get(id);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      await agent.fetch(
        new Request("http://internal/mark-terminal", { method: "POST", signal: controller.signal })
      ).finally(() => clearTimeout(timeout));
    } catch (err) {
      // Timeout or network error — agent may already be dead
      console.warn(`[AgentManager] Could not notify agent for ${ticketId}:`, err);
    }
  }

  /**
   * Send an event to a running agent. Retries with backoff.
   */
  async sendEvent(ticketId: string, event: unknown): Promise<void> {
    const ticket = this.getTicket(ticketId);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
    if (this.isTerminal(ticketId)) {
      console.log(`[AgentManager] Ignoring event for terminal ticket ${ticketId}`);
      return;
    }
    if (ticket.agent_active !== 1) {
      console.log(`[AgentManager] No active agent for ${ticketId}, skipping event`);
      return;
    }

    const agentNs = this.env.TICKET_AGENT as any;
    const id = agentNs.idFromName(ticketId);
    const agent = agentNs.get(id);

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await agent.fetch(new Request("http://internal/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }));

      if (res.ok) return;
      if (res.status !== 503) {
        throw new Error(`Event delivery failed: ${res.status}`);
      }

      // Container not ready, backoff and retry
      console.warn(`[AgentManager] Agent not ready for ${ticketId}, retry ${attempt + 1}/3`);
      await new Promise(r => setTimeout(r, this.retryDelayMs * (attempt + 1)));
    }

    // Exhausted retries — mark agent inactive but don't terminal-fail the ticket.
    // Transient 503s (cold start, deploy recovery) should leave the ticket retryable
    // so supervisor or thread replies can re-activate it later.
    console.error(`[AgentManager] Event delivery failed after retries for ${ticketId}`);
    this.sql.exec(
      "UPDATE tickets SET agent_active = 0, updated_at = datetime('now') WHERE id = ?",
      ticketId,
    );
  }

  /**
   * Re-activate an agent for a ticket (e.g., user replied in thread).
   * Only works for non-terminal tickets.
   */
  reactivate(ticketId: string): void {
    if (this.isTerminal(ticketId)) {
      console.log(`[AgentManager] Cannot reactivate terminal ticket ${ticketId}`);
      return;
    }
    this.sql.exec(
      "UPDATE tickets SET agent_active = 1, updated_at = datetime('now') WHERE id = ?",
      ticketId,
    );
    console.log(`[AgentManager] Reactivated agent for ${ticketId}`);
  }

  recordHeartbeat(ticketId: string): void {
    this.sql.exec(
      "UPDATE tickets SET last_heartbeat = datetime('now'), updated_at = datetime('now') WHERE id = ? AND agent_active = 1",
      ticketId,
    );
  }

  getActiveAgents(): TicketRecord[] {
    return this.sql.exec(
      "SELECT * FROM tickets WHERE agent_active = 1 ORDER BY updated_at DESC",
    ).toArray() as unknown as TicketRecord[];
  }

  async stopAllAgents(reason: string): Promise<void> {
    const agents = this.getActiveAgents();
    for (const agent of agents) {
      await this.stopAgent(agent.id, reason).catch(err =>
        console.error(`[AgentManager] Failed to stop ${agent.id}:`, err)
      );
    }
  }

  async cleanupInactive(): Promise<void> {
    const terminalList = TERMINAL_STATUSES.map(s => `'${s}'`).join(", ");
    const inactive = this.sql.exec(
      `SELECT id FROM tickets WHERE agent_active = 1 AND status IN (${terminalList})`,
    ).toArray() as { id: string }[];

    for (const { id } of inactive) {
      await this.stopAgent(id, "cleanup: terminal but still active").catch(() => {});
    }
  }
}
