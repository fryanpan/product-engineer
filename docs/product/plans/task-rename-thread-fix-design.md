# Task Terminology Migration + Thread Simplification — Design

**Date:** 2026-03-25

## Problem

1. Thread replies to bot conversations in Slack are silently dropped because no task record is created when the ProjectLead handles work directly
2. The Linear ticket creation path creates a separate bot thread, causing confusion about which thread to reply in
3. Codebase terminology ("ticket", "Orchestrator", "TicketAgent", "ProjectAgent") doesn't match the README's evolved terminology ("task", "Conductor", "TaskAgent", "ProjectLead")

## Solution

### Terminology Rename

| Old | New | Scope |
|-----|-----|-------|
| `Orchestrator` (DO class + binding) | `Conductor` | Class, binding, file, all refs |
| `TicketAgent` (DO class + binding) | `TaskAgent` | Class, binding, file, all refs |
| `ProjectAgent` (DO class + binding) | `ProjectLead` | Class, binding, file, all refs |
| `ticket_uuid` / `ticketUUID` | `task_uuid` / `taskUUID` | DB column, types, code |
| `ticket_id` / `ticketId` | `task_id` / `taskId` | DB column, types, code |
| `TicketRecord` / `TicketEvent` / `TicketState` | `TaskRecord` / `TaskEvent` / `TaskState` | Types |
| `TICKET_AGENT` / `PROJECT_AGENT` / `ORCHESTRATOR` | `TASK_AGENT` / `PROJECT_LEAD` / `CONDUCTOR` | Wrangler bindings |

Full rename including DO classes. Clean-slate deploy (in-flight agents lost).

### Thread Behavior

**Slack-originated tasks:**
- Use the user's message `ts` as the canonical `slack_thread_ts`
- No separate bot thread. No acknowledgment message.
- All bot updates post as replies in the user's original thread
- Always create a task record in DB

**Linear-originated tasks (no existing Slack thread):**
- Bot creates a top-level message in the product's Slack channel
- That message's `ts` becomes the canonical `slack_thread_ts`

**One thread per task, always.**

### Slack Event Handling (simplified)

Remove the three-path split (`app_mention` vs plain message vs Linear). New flow:

```
Message arrives in product channel
  → Has thread_ts matching a known task? → Route to existing task (respawn if needed)
  → New message (top-level or untracked thread)? → Create task record, route to ProjectLead
```

@mention is treated identically to any other message. The `app_mention` vs `message` type distinction disappears for product channels.

### Task ID Generation

**Slack-originated tasks:**
- `task_uuid`: `crypto.randomUUID()`
- `task_id`: Human-readable, < 16 chars, LLM-generated slug from request text (e.g., "berlin-kids-fun", "fix-nav-bug")

**Linear-originated tasks:**
- `task_uuid`: Linear issue UUID
- `task_id`: Linear identifier (e.g., "PE-123")

The existing `generateTicketSummary()` LLM call is extended to also return a short slug-style ID.

## What Stays the Same

- State machine (same states, renamed types)
- Agent SDK integration
- Supervisor, merge gate, heartbeat mechanics
- Linear webhook handling (still creates tasks)
- GitHub webhook handling
- Conductor channel routing
- Container lifecycle (spawn, heartbeat, stop)
