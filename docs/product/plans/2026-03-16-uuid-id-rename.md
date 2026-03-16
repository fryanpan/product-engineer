# UUID/ID Naming Convention Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename identifiers throughout the codebase to match Linear's convention: `uuid` for the internal UUID primary key, `id` for the human-readable identifier (e.g., "BC-163"). This also fixes a critical bug where supervisor actions (kill, trigger_merge_eval) silently fail because the LLM returns human-readable IDs but the code only looks up by UUID.

**Architecture:** Mechanical rename across types, orchestrator, agent, and tests. The database column names (`id`, `identifier`) stay unchanged — only TypeScript field/param names change. A defense-in-depth fallback is added to resolve human-readable IDs to UUIDs in the supervisor action execution path.

**Tech Stack:** TypeScript, Cloudflare Workers/Containers, SQLite

---

## Naming Convention

| What | Old name(s) | New name | Example value |
|------|-------------|----------|---------------|
| UUID primary key | `ticketId`, `internalId`, `id` (param) | `uuid` | `a751c66e-4f13-4b35-b070-9ce78bb8e101` |
| Human-readable ID | `ticketId` (template), `identifier` | `id` | `BC-163` |

**Exception:** `TicketRecord.id` stays as-is — it mirrors the DB `id` column. The `identifier` DB column also stays. Only TypeScript interface fields, method params, and template vars change.

---

### Task 1: Core Types (orchestrator/src/types.ts)

**Files:**
- Modify: `orchestrator/src/types.ts`

**Changes:**
- `TicketEvent.ticketId` → `TicketEvent.uuid`
- `TicketAgentConfig.ticketId` → `TicketAgentConfig.uuid`

---

### Task 2: Agent Manager (orchestrator/src/agent-manager.ts)

**Files:**
- Modify: `orchestrator/src/agent-manager.ts`

**Changes:**
- All method params: `ticketId: string` → `uuid: string`
- All log messages: update `${ticketId}` → `${uuid}`
- `getTicketByIdentifier` stays unchanged
- Internal SQL uses `WHERE id = ?` — the variable name changes but the query stays

---

### Task 3: Context Assembler + Supervisor Template (THE BUG FIX)

**Files:**
- Modify: `orchestrator/src/context-assembler.ts`
- Modify: `orchestrator/src/prompts/supervisor.mustache`

**Context Assembler changes (forSupervisor):**
- `ticketId` field → `id` (human-readable)
- `internalId` field → `uuid`
- Same for `stalePRs` and `queuedTickets` arrays

**Context Assembler changes (forTicketReview, forMergeGate):**
- Method param: `ticketId` → `uuid`
- Output field: keep `identifier` (it's the human-readable display name in those templates)

**Supervisor template changes:**
- `{{{ticketId}}}` → `{{{id}}}` in headings
- ADD `- **UUID:** {{{uuid}}}` to each agent section so the LLM can see it
- `{{{ticketId}}}` → `{{{id}}}` in stalePRs
- Update instruction: "Use the `uuid` field as the target"
- Update JSON example: `"target": "uuid or 'system'"`

---

### Task 4: Supervisor Action Execution — Add Fallback Resolution (orchestrator/src/orchestrator.ts)

**Files:**
- Modify: `orchestrator/src/orchestrator.ts` (supervisor action loop, ~line 1574-1640)

**Changes:**
Add a resolution step at the top of the action loop (before the switch statement) that resolves `action.target` to a UUID if it isn't one already:

```typescript
// Resolve target to UUID — defense in depth if LLM returns human-readable ID
let resolvedTarget = action.target;
if (action.target !== "system") {
  const direct = this.agentManager.getTicket(action.target);
  if (!direct) {
    const byIdentifier = this.agentManager.getTicketByIdentifier(action.target);
    if (byIdentifier) {
      console.log(`[Orchestrator] Resolved supervisor target ${action.target} → ${byIdentifier.id}`);
      resolvedTarget = byIdentifier.id;
    }
  }
}
```

Then use `resolvedTarget` instead of `action.target` in all switch cases.

---

### Task 5: Orchestrator Event Handling (orchestrator/src/orchestrator.ts)

**Files:**
- Modify: `orchestrator/src/orchestrator.ts`

**Changes:**
- `buildTicketEvent()`: field `ticketId` → `uuid` in the returned object; also update param access from `data.ticketId` → `data.uuid` (with fallback to `data.ticketId` for backward compat from webhooks)
- `sanitizeTicketId()` → `sanitizeUuid()` (rename function)
- `handleEvent()`: all `event.ticketId` → `event.uuid`
- All other references to `event.ticketId` or `ticketId` throughout orchestrator.ts

---

### Task 6: TicketAgent + Webhooks

**Files:**
- Modify: `orchestrator/src/ticket-agent.ts`
- Modify: `orchestrator/src/webhooks.ts`

**TicketAgent changes:**
- `resolveAgentEnvVars()`: `config.ticketId` → `config.uuid`, env var key stays `TICKET_ID` (backward compat with running containers)
- `bufferEvent()`: `event.ticketId` → `event.uuid`
- `alarm()`: `config.ticketId` → `config.uuid`
- `spawnAgent()` call in agent-manager: `ticketId` field in JSON body → `uuid`

**Webhooks changes:**
- All `ticketId:` in TicketEvent construction → `uuid:`

---

### Task 7: Worker Routes (orchestrator/src/index.ts)

**Files:**
- Modify: `orchestrator/src/index.ts`

**Changes:**
- Route params and JSON body fields: `ticketId` → `uuid`
- URL route patterns like `/api/agent/:ticketId/` → `/api/agent/:uuid/` (or keep path param name and just rename the extracted variable)

---

### Task 8: Agent Code (agent/src/)

**Files:**
- Modify: `agent/src/config.ts`
- Modify: `agent/src/server.ts`
- Modify: `agent/src/tools.ts`

**config.ts changes:**
- `AgentConfig.ticketId` → `AgentConfig.uuid`
- `TicketEvent.ticketId` → `TicketEvent.uuid`
- `loadConfig()`: `ticketId: required("TICKET_ID")` → `uuid: required("TICKET_ID")`

**server.ts + tools.ts changes:**
- All `config.ticketId` → `config.uuid`
- All `event.ticketId` → `event.uuid`

---

### Task 9: Tests

**Files:**
- Modify: All `*.test.ts` files in `orchestrator/src/` and `agent/src/`

**Changes:**
- Update all `ticketId:` field assignments in test data to `uuid:`
- Update all assertions referencing `ticketId`
- Update mock data structures

---

### Task 10: Run Tests + Fix

**Steps:**
1. `cd orchestrator && bun test`
2. `cd agent && bun test`
3. Fix any remaining failures

---

### Task 11: Commit

Commit with message: "fix: rename ticketId→uuid and internalId→uuid, add supervisor target fallback resolution"
