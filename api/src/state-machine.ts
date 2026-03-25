import { VALID_TRANSITIONS, TERMINAL_STATUSES, type TaskState, type TaskRecord } from "./types";

/** Flat transition list derived from VALID_TRANSITIONS map. */
export const TRANSITIONS: { from: TaskState; to: TaskState }[] = [];
for (const [from, toStates] of Object.entries(VALID_TRANSITIONS)) {
  for (const to of toStates) {
    TRANSITIONS.push({ from: from as TaskState, to: to as TaskState });
  }
}

/** Check if a transition from one state to another is valid. */
export function canTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from as TaskState];
  if (!allowed) return false;
  return (allowed as readonly string[]).includes(to);
}

/** Check if a status is terminal (no transitions out). */
export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Apply a state transition to a task, returning a new TaskRecord with updated fields.
 * Returns null if the transition is invalid.
 *
 * Side effects encoded in the returned record:
 * - Terminal states: agent_active = 0
 * - spawning → active: agent_active = 1
 * - All transitions: updated_at = current ISO timestamp
 */
export function applyTransition(task: TaskRecord, to: TaskState): TaskRecord | null {
  if (!canTransition(task.status, to)) {
    return null;
  }

  const updated: TaskRecord = { ...task };
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

  // Reactivate agent when transitioning to active from inactive states
  if (to === "active" && (task.status === "spawning" || isTerminal(task.status))) {
    updated.agent_active = 1;
  }

  return updated;
}
