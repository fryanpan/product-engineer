import { TERMINAL_STATUSES, type TicketState, type TicketRecord } from "./types";
import { applyTransition, isTerminal as isTerminalStatus } from "./state-machine";

export interface CreateTicketParams {
  ticketUUID: string;
  product: string;
  slackThreadTs?: string;
  slackChannel?: string;
  ticketId?: string;
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
  mode?: "coding" | "research" | "flexible";
  slackPersona?: { username: string; icon_emoji?: string; icon_url?: string };
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
    const existing = this.getTicket(params.ticketUUID);
    if (existing && !this.isTerminal(params.ticketUUID)) {
      throw new Error(`Ticket ${params.ticketUUID} already exists (status: ${existing.status})`);
    }

    // If re-creating after terminal, reset everything
    if (existing) {
      this.sql.exec("DELETE FROM tickets WHERE ticket_uuid = ?", params.ticketUUID);
    }

    this.sql.exec(
      `INSERT INTO tickets (ticket_uuid, product, status, slack_thread_ts, slack_channel, ticket_id, title, agent_active)
       VALUES (?, ?, 'created', ?, ?, ?, ?, 0)`,
      params.ticketUUID, params.product,
      params.slackThreadTs || null, params.slackChannel || null,
      params.ticketId || null, params.title || null,
    );

    return this.getTicket(params.ticketUUID)!;
  }

  getTicket(ticketUUID: string): TicketRecord | null {
    const row = this.sql.exec(
      "SELECT * FROM tickets WHERE ticket_uuid = ?", ticketUUID,
    ).toArray()[0] as unknown as TicketRecord | undefined;
    return row || null;
  }

  /** Look up a ticket by its human-readable identifier (e.g., "PES-23"). */
  getTicketByIdentifier(identifier: string): TicketRecord | null {
    const row = this.sql.exec(
      "SELECT * FROM tickets WHERE ticket_id = ?", identifier,
    ).toArray()[0] as unknown as TicketRecord | undefined;
    return row || null;
  }

  isTerminal(ticketUUID: string): boolean {
    const ticket = this.getTicket(ticketUUID);
    if (!ticket) return false;
    return (TERMINAL_STATUSES as readonly string[]).includes(ticket.status);
  }

  /** Check if a status string is terminal (no ticket lookup needed). */
  isTerminalStatus(status: string): boolean {
    return (TERMINAL_STATUSES as readonly string[]).includes(status);
  }

  updateStatus(ticketUUID: string, update: StatusUpdate): TicketRecord {
    const ticket = this.getTicket(ticketUUID);
    if (!ticket) throw new Error(`Ticket ${ticketUUID} not found`);

    if (this.isTerminal(ticketUUID)) {
      console.log(`[AgentManager] Ignoring update for terminal ticket ${ticketUUID}`);
      return ticket;
    }

    // Use the pure state machine for status transitions
    let transitioned = ticket;
    if (update.status && update.status !== ticket.status) {
      const result = applyTransition(ticket, update.status);
      if (!result) {
        console.warn(
          `[AgentManager] Invalid transition: ${ticket.status} → ${update.status} for ${ticketUUID}`
        );
        return ticket;
      }
      transitioned = result;
      if (isTerminalStatus(update.status)) {
        console.log(`[AgentManager] Terminal state ${update.status} for ${ticketUUID}`);
      }
    }

    const sets: string[] = ["updated_at = datetime('now')"];
    const values: unknown[] = [];

    if (update.status) {
      sets.push("status = ?");
      values.push(transitioned.status);

      // agent_active side effects come from the state machine
      if (transitioned.agent_active !== ticket.agent_active) {
        sets.push("agent_active = ?");
        values.push(transitioned.agent_active);
      }
    }
    if (update.pr_url !== undefined) { sets.push("pr_url = ?"); values.push(update.pr_url); }
    if (update.branch_name !== undefined) { sets.push("branch_name = ?"); values.push(update.branch_name); }
    if (update.slack_thread_ts !== undefined) { sets.push("slack_thread_ts = ?"); values.push(update.slack_thread_ts); }
    if (update.transcript_r2_key !== undefined) { sets.push("transcript_r2_key = ?"); values.push(update.transcript_r2_key); }

    values.push(ticketUUID);
    this.sql.exec(`UPDATE tickets SET ${sets.join(", ")} WHERE ticket_uuid = ?`, ...values);

    return this.getTicket(ticketUUID)!;
  }

  /**
   * Spawn an agent container for a ticket.
   * Deploy re-spawn safe: accepts tickets in spawning/active state (re-initializes container).
   * For new spawns, transitions from reviewing/queued → spawning.
   */
  async spawnAgent(ticketUUID: string, config: SpawnConfig): Promise<void> {
    const ticket = this.getTicket(ticketUUID);
    if (!ticket) throw new Error(`Ticket ${ticketUUID} not found`);
    if (this.isTerminal(ticketUUID)) throw new Error(`Ticket ${ticketUUID} is terminal`);

    const isRespawn = ticket.status === "spawning" || ticket.status === "active";

    if (!isRespawn) {
      // New spawn — must be in reviewing or queued
      if (ticket.status !== "reviewing" && ticket.status !== "queued") {
        throw new Error(`Cannot spawn agent for ticket in ${ticket.status} state`);
      }
      // Transition to spawning
      this.updateStatus(ticketUUID, { status: "spawning" });
    }

    // Set agent_active=1
    this.sql.exec(
      "UPDATE tickets SET agent_active = 1, updated_at = datetime('now') WHERE ticket_uuid = ?",
      ticketUUID,
    );

    try {
      const agentNs = this.env.TICKET_AGENT as any;
      const id = agentNs.idFromName(ticketUUID);
      const agent = agentNs.get(id);

      // Initialize the agent container with config
      const initRes = await agent.fetch(new Request("http://internal/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketUUID,
          ticketId: ticket.ticket_id ?? undefined,
          ticketTitle: ticket.title ?? undefined,
          product: config.product,
          repos: config.repos,
          slackChannel: config.slackChannel,
          slackThreadTs: config.slackThreadTs || ticket.slack_thread_ts || undefined,
          secrets: config.secrets,
          gatewayConfig: config.gatewayConfig,
          model: config.model,
          mode: config.mode,
          slackPersona: config.slackPersona,
        }),
      }));

      if (!initRes.ok) {
        throw new Error(`Agent init failed: ${initRes.status}`);
      }
      console.log(`[AgentManager] Agent spawned for ${ticketUUID} (respawn=${isRespawn})`);
    } catch (err) {
      // On failure: mark agent inactive, transition to failed for new spawns
      if (!isRespawn) {
        try {
          this.updateStatus(ticketUUID, { status: "failed" });
        } catch {
          this.sql.exec(
            "UPDATE tickets SET status = 'failed', agent_active = 0, updated_at = datetime('now') WHERE ticket_uuid = ?",
            ticketUUID,
          );
        }
      } else {
        // Respawns keep current state so alarm can retry later
        this.sql.exec(
          "UPDATE tickets SET agent_active = 0, updated_at = datetime('now') WHERE ticket_uuid = ?",
          ticketUUID,
        );
      }
      console.error(`[AgentManager] Failed to spawn agent for ${ticketUUID}:`, err);
      throw err;
    }
  }

  /**
   * Stop an agent. Idempotent — safe to call on already-stopped agents.
   */
  async stopAgent(ticketUUID: string, reason: string): Promise<void> {
    console.log(`[AgentManager] Stopping agent for ${ticketUUID}: ${reason}`);

    // Set agent_active=0 in DB first
    this.sql.exec(
      "UPDATE tickets SET agent_active = 0, updated_at = datetime('now') WHERE ticket_uuid = ?",
      ticketUUID,
    );

    // Notify TicketAgent DO — best-effort, don't throw on failure
    try {
      const agentNs = this.env.TICKET_AGENT as any;
      const id = agentNs.idFromName(ticketUUID);
      const agent = agentNs.get(id);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      await agent.fetch(
        new Request("http://internal/mark-terminal", { method: "POST", signal: controller.signal })
      ).finally(() => clearTimeout(timeout));
    } catch (err) {
      // Timeout or network error — agent may already be dead
      console.warn(`[AgentManager] Could not notify agent for ${ticketUUID}:`, err);
    }
  }

  /**
   * Send an event to a running agent. Retries with backoff.
   */
  async sendEvent(ticketUUID: string, event: unknown): Promise<void> {
    const ticket = this.getTicket(ticketUUID);
    if (!ticket) throw new Error(`Ticket ${ticketUUID} not found`);
    if (this.isTerminal(ticketUUID)) {
      console.log(`[AgentManager] Ignoring event for terminal ticket ${ticketUUID}`);
      return;
    }
    if (ticket.agent_active !== 1) {
      console.log(`[AgentManager] No active agent for ${ticketUUID}, skipping event`);
      return;
    }

    const agentNs = this.env.TICKET_AGENT as any;
    const id = agentNs.idFromName(ticketUUID);
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
      console.warn(`[AgentManager] Agent not ready for ${ticketUUID}, retry ${attempt + 1}/3`);
      await new Promise(r => setTimeout(r, this.retryDelayMs * (attempt + 1)));
    }

    // Exhausted retries — mark agent inactive but don't terminal-fail the ticket.
    // Transient 503s (cold start, deploy recovery) should leave the ticket retryable
    // so supervisor or thread replies can re-activate it later.
    console.error(`[AgentManager] Event delivery failed after retries for ${ticketUUID}`);
    this.sql.exec(
      "UPDATE tickets SET agent_active = 0, updated_at = datetime('now') WHERE ticket_uuid = ?",
      ticketUUID,
    );
  }

  /**
   * Re-activate an agent for a ticket (e.g., user replied in thread).
   * Only works for non-terminal tickets.
   */
  reactivate(ticketUUID: string): void {
    if (this.isTerminal(ticketUUID)) {
      console.log(`[AgentManager] Cannot reactivate terminal ticket ${ticketUUID}`);
      return;
    }
    this.sql.exec(
      "UPDATE tickets SET agent_active = 1, updated_at = datetime('now') WHERE ticket_uuid = ?",
      ticketUUID,
    );
    console.log(`[AgentManager] Reactivated agent for ${ticketUUID}`);
  }

  /**
   * Reopen a terminal ticket (e.g., user replied in a completed thread).
   * Transitions terminal → active, sets agent_active=1, and clears the
   * TicketAgent DO's terminal flag so the container can restart.
   */
  async reopenTicket(ticketUUID: string): Promise<void> {
    const ticket = this.getTicket(ticketUUID);
    if (!ticket) throw new Error(`Ticket ${ticketUUID} not found`);
    if (!this.isTerminalStatus(ticket.status)) {
      console.log(`[AgentManager] Ticket ${ticketUUID} is not terminal (${ticket.status}) — skipping reopen`);
      return;
    }

    // Bypass updateStatus() which has a terminal guard — direct SQL update.
    // The state machine allows terminal → active (types.ts VALID_TRANSITIONS).
    this.sql.exec(
      "UPDATE tickets SET status = ?, agent_active = 1, updated_at = datetime('now') WHERE ticket_uuid = ?",
      "active",
      ticketUUID,
    );

    // Clear the TicketAgent DO's terminal flag so it accepts events again
    try {
      const agentNs = this.env.TICKET_AGENT as any;
      const id = agentNs.idFromName(ticketUUID);
      const agent = agentNs.get(id);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      await agent.fetch(
        new Request("http://internal/clear-terminal", { method: "POST", signal: controller.signal })
      ).finally(() => clearTimeout(timeout));
    } catch (err) {
      console.warn(`[AgentManager] Could not clear terminal flag on DO for ${ticketUUID}:`, err);
    }

    console.log(`[AgentManager] Reopened terminal ticket ${ticketUUID}`);
  }

  recordHeartbeat(ticketUUID: string): void {
    this.sql.exec(
      "UPDATE tickets SET last_heartbeat = datetime('now'), updated_at = datetime('now') WHERE ticket_uuid = ? AND agent_active = 1",
      ticketUUID,
    );
  }

  /** Record a phone-home from the agent: updates heartbeat timestamp and optional log message. */
  recordPhoneHome(ticketUUID: string, message?: string): void {
    if (this.isTerminal(ticketUUID)) return;
    if (message) {
      this.sql.exec(
        "UPDATE tickets SET last_heartbeat = datetime('now'), agent_message = ?, updated_at = datetime('now') WHERE ticket_uuid = ? AND agent_active = 1",
        message, ticketUUID,
      );
    } else {
      this.recordHeartbeat(ticketUUID);
    }
  }

  getActiveAgents(): TicketRecord[] {
    return this.sql.exec(
      "SELECT * FROM tickets WHERE agent_active = 1 ORDER BY updated_at DESC",
    ).toArray() as unknown as TicketRecord[];
  }

  async stopAllAgents(reason: string): Promise<void> {
    const agents = this.getActiveAgents();
    for (const agent of agents) {
      await this.stopAgent(agent.ticket_uuid, reason).catch(err =>
        console.error(`[AgentManager] Failed to stop ${agent.ticket_uuid}:`, err)
      );
    }
  }

  async cleanupInactive(): Promise<void> {
    const terminalList = TERMINAL_STATUSES.map(s => `'${s}'`).join(", ");
    const inactive = this.sql.exec(
      `SELECT ticket_uuid FROM tickets WHERE agent_active = 1 AND status IN (${terminalList})`,
    ).toArray() as { ticket_uuid: string }[];

    for (const { ticket_uuid } of inactive) {
      await this.stopAgent(ticket_uuid, "cleanup: terminal but still active").catch(() => {});
    }
  }
}
