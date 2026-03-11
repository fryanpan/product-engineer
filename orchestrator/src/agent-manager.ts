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

interface SqlResult {
  toArray(): Record<string, unknown>[];
}

interface SqlExec {
  exec(sql: string, ...params: unknown[]): SqlResult;
}

export class AgentManager {
  constructor(
    private sql: SqlExec,
    private env: Record<string, unknown>,
  ) {}

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
    ).toArray()[0] as TicketRecord | undefined;
    return row || null;
  }

  isTerminal(ticketId: string): boolean {
    const ticket = this.getTicket(ticketId);
    if (!ticket) return false;
    return (TERMINAL_STATUSES as readonly string[]).includes(ticket.status);
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
}
