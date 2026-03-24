import { VALID_TRANSITIONS, TERMINAL_STATUSES, type TicketState, type TicketRecord } from "./types";

/** Flat transition list derived from VALID_TRANSITIONS map. */
export const TRANSITIONS: { from: TicketState; to: TicketState }[] = [];
for (const [from, toStates] of Object.entries(VALID_TRANSITIONS)) {
  for (const to of toStates) {
    TRANSITIONS.push({ from: from as TicketState, to: to as TicketState });
  }
}

/** Check if a transition from one state to another is valid. */
export function canTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from as TicketState];
  if (!allowed) return false;
  return (allowed as readonly string[]).includes(to);
}

/** Check if a status is terminal (no transitions out). */
export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Apply a state transition to a ticket, returning a new TicketRecord with updated fields.
 * Returns null if the transition is invalid.
 *
 * Side effects encoded in the returned record:
 * - Terminal states: agent_active = 0
 * - spawning → active: agent_active = 1
 * - All transitions: updated_at = current ISO timestamp
 */
export function applyTransition(ticket: TicketRecord, to: TicketState): TicketRecord | null {
  if (!canTransition(ticket.status, to)) {
    return null;
  }

  const updated: TicketRecord = { ...ticket };
  updated.status = to;
  updated.updated_at = new Date().toISOString();

  // Terminal states deactivate the agent
  if (isTerminal(to)) {
    updated.agent_active = 0;
  }

  // Suspended state deactivates the agent — container exits on suspend
  if (to === "suspended") {
    updated.agent_active = 0;
  }

  // spawning → active activates the agent
  if (ticket.status === "spawning" && to === "active") {
    updated.agent_active = 1;
  }

  return updated;
}
