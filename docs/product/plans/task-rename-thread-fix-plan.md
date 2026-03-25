# Task Terminology Migration + Thread Simplification — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rename ticket→task/Orchestrator→Conductor/TicketAgent→TaskAgent/ProjectAgent→ProjectLead across the entire codebase, simplify Slack thread handling to always use one thread per task, and add E2E tests for key flows.

**Architecture:** Mechanical rename across ~40 files, DB column migrations via existing `addColumn` + `ALTER TABLE RENAME COLUMN` pattern, simplified Slack handler that removes the @mention distinction, and new E2E test coverage for thread reply routing.

**Tech Stack:** TypeScript, Cloudflare Workers/Durable Objects, SQLite, Bun test runner

**Design doc:** `docs/product/plans/task-rename-thread-fix-design.md`

---

## Task 1: Core Types Rename

Rename all type definitions. Everything else depends on these.

**Files:**
- Modify: `api/src/types.ts`
- Modify: `api/src/state-machine.ts`
- Modify: `api/src/state-machine.test.ts`

**Step 1: Rename types in `api/src/types.ts`**

Apply these renames throughout the file:
- `TERMINAL_STATUSES` → keep (status values unchanged)
- `TerminalStatus` → keep
- `TICKET_STATES` → `TASK_STATES`
- `TicketState` → `TaskState`
- `VALID_TRANSITIONS` → keep
- `TicketEvent` → `TaskEvent`
- `ticketUUID` field → `taskUUID`
- `TicketRecord` → `TaskRecord`
- `ticket_uuid` field → `task_uuid`
- `ticket_id` field → `task_id`
- `TicketAgentConfig` → `TaskAgentConfig`
- `ticketUUID` field → `taskUUID`
- `ticketId` field → `taskId`
- `ticketTitle` field → `taskTitle`
- `TicketMetrics` → `TaskMetrics`
- `ticket_id` field → `task_id`
- `HeartbeatPayload.ticketUUID` → `HeartbeatPayload.taskUUID`
- `Bindings.ORCHESTRATOR` → `Bindings.CONDUCTOR`
- `Bindings.TICKET_AGENT` → `Bindings.TASK_AGENT`
- `Bindings.PROJECT_AGENT` → `Bindings.PROJECT_LEAD`

**Step 2: Update state-machine.ts**

- `TicketState` → `TaskState`
- `TicketRecord` → `TaskRecord`
- Update imports from types.ts

**Step 3: Update state-machine.test.ts**

- Update all type references
- Update imports

**Step 4: Run tests**

Run: `cd api && bun test src/state-machine.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add api/src/types.ts api/src/state-machine.ts api/src/state-machine.test.ts
git commit -m "refactor: rename Ticket types to Task types (types.ts, state-machine.ts)"
```

---

## Task 2: DB Schema Migration

Rename DB columns. The `addColumn` + `ALTER TABLE RENAME COLUMN` pattern is already established.

**Files:**
- Modify: `api/src/db.ts`

**Step 1: Add column rename migrations to `initSchema()` in db.ts**

After existing migrations, add:
```typescript
// Migration: rename ticket terminology → task
try { sql.exec("ALTER TABLE tickets RENAME TO tasks"); } catch { /* already renamed */ }
try { sql.exec("ALTER TABLE tasks RENAME COLUMN ticket_uuid TO task_uuid"); } catch { /* already renamed */ }
try { sql.exec("ALTER TABLE tasks RENAME COLUMN ticket_id TO task_id"); } catch { /* already renamed */ }
```

Also update the `CREATE TABLE IF NOT EXISTS` statement to use `tasks` as the table name with `task_uuid` and `task_id` columns (for fresh installs).

Update all other SQL in db.ts that references `tickets` table or `ticket_uuid`/`ticket_id` columns.

Rename `slack_thread_map.linear_issue_id` references if used in db.ts.

Update `ensureTicketMetrics` → `ensureTaskMetrics`, and the `ticket_metrics` table references.

**Step 2: Run tests**

Run: `cd api && bun test src/db.ts` (if tests exist) or `bun test` for full suite
Expected: Pass (migrations are idempotent)

**Step 3: Commit**

```bash
git add api/src/db.ts
git commit -m "refactor: migrate DB schema from tickets to tasks"
```

---

## Task 3: Agent Manager Rename

Rename `AgentManager` internals to use task terminology. Rename file.

**Files:**
- Rename: `api/src/agent-manager.ts` → `api/src/task-manager.ts`
- Rename: `api/src/agent-manager.test.ts` → `api/src/task-manager.test.ts`

**Step 1: Rename files**

```bash
git mv api/src/agent-manager.ts api/src/task-manager.ts
git mv api/src/agent-manager.test.ts api/src/task-manager.test.ts
```

**Step 2: Rename in task-manager.ts**

- Class name: `AgentManager` → `TaskManager`
- `CreateTicketParams` → `CreateTaskParams`
- `ticketUUID` → `taskUUID` (params and method args)
- `StatusUpdate` → keep name (still describes status updates)
- `SpawnConfig` → keep
- All SQL: `tickets` → `tasks`, `ticket_uuid` → `task_uuid`, `ticket_id` → `task_id`
- `createTicket()` → `createTask()`
- `getTicket()` → `getTask()`
- `getTicketByIdentifier()` → `getTaskByIdentifier()`
- `isTerminal()` — keep name
- `reopenTicket()` → `reopenTask()`
- Log messages: update "[AgentManager]" → "[TaskManager]"
- `env.TICKET_AGENT` → `env.TASK_AGENT`

**Step 3: Update task-manager.test.ts**

- Update all references to match new names
- Update mock SQL to use `tasks` table, `task_uuid` column
- Update imports

**Step 4: Run tests**

Run: `cd api && bun test src/task-manager.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add api/src/task-manager.ts api/src/task-manager.test.ts
git commit -m "refactor: rename AgentManager to TaskManager, ticket methods to task methods"
```

---

## Task 4: Conductor DO Rename (was Orchestrator)

Rename the main Durable Object class.

**Files:**
- Rename: `api/src/orchestrator.ts` → `api/src/conductor.ts`
- Rename: `api/src/orchestrator.test.ts` → `api/src/conductor.test.ts`
- Modify: `api/src/do-stubs.ts`

**Step 1: Rename files**

```bash
git mv api/src/orchestrator.ts api/src/conductor.ts
git mv api/src/orchestrator.test.ts api/src/conductor.test.ts
```

**Step 2: Rename in conductor.ts**

- Class name: `Orchestrator` → `Conductor`
- All `[Orchestrator]` log prefixes → `[Conductor]`
- All `ticketUUID` → `taskUUID`
- All `ticket` references in SQL queries → `task`
- `AgentManager` import → `TaskManager` (from task-manager.ts)
- `this.agentManager` → `this.taskManager`
- `handleTicketReview` → `handleTaskReview`
- `TicketEvent` → `TaskEvent`
- `env.TICKET_AGENT` → `env.TASK_AGENT`
- `env.PROJECT_AGENT` → `env.PROJECT_LEAD`
- `routeToProjectAgent` → `routeToProjectLead`
- `respawnSuspendedAgent` → `respawnSuspendedTask`
- All internal method names updated accordingly

**Step 3: Update conductor.test.ts**

- Update imports and all references

**Step 4: Update do-stubs.ts**

- Rename Orchestrator references to Conductor

**Step 5: Run tests**

Run: `cd api && bun test src/conductor.test.ts`
Expected: Pass

**Step 6: Commit**

```bash
git add api/src/conductor.ts api/src/conductor.test.ts api/src/do-stubs.ts
git commit -m "refactor: rename Orchestrator DO to Conductor"
```

---

## Task 5: TaskAgent DO Rename (was TicketAgent)

**Files:**
- Rename: `api/src/ticket-agent.ts` → `api/src/task-agent.ts`
- Rename: `api/src/ticket-agent.test.ts` → `api/src/task-agent.test.ts`

**Step 1: Rename files**

```bash
git mv api/src/ticket-agent.ts api/src/task-agent.ts
git mv api/src/ticket-agent.test.ts api/src/task-agent.test.ts
```

**Step 2: Rename in task-agent.ts**

- Class name: `TicketAgent` → `TaskAgent`
- `TicketAgentConfig` → `TaskAgentConfig`
- `ticketUUID` → `taskUUID`
- All log prefixes updated

**Step 3: Update task-agent.test.ts**

**Step 4: Run tests**

Run: `cd api && bun test src/task-agent.test.ts`
Expected: Pass

**Step 5: Commit**

```bash
git add api/src/task-agent.ts api/src/task-agent.test.ts
git commit -m "refactor: rename TicketAgent DO to TaskAgent"
```

---

## Task 6: ProjectLead DO Rename (was ProjectAgent)

**Files:**
- Rename: `api/src/project-agent.ts` → `api/src/project-lead.ts`
- Rename: `api/src/project-agent.test.ts` → `api/src/project-lead.test.ts`
- Rename: `api/src/project-agent-router.ts` → `api/src/project-lead-router.ts`

**Step 1: Rename files**

```bash
git mv api/src/project-agent.ts api/src/project-lead.ts
git mv api/src/project-agent.test.ts api/src/project-lead.test.ts
git mv api/src/project-agent-router.ts api/src/project-lead-router.ts
```

**Step 2: Rename in all three files**

- Class name: `ProjectAgent` → `ProjectLead`
- `ProjectAgentConfig` → `ProjectLeadConfig`
- All `[ProjectAgent]` log prefixes → `[ProjectLead]`
- `env.PROJECT_AGENT` → `env.PROJECT_LEAD`
- Route paths: `/project-agent/` → `/project-lead/`
- Function names: `ensureProjectAgent` → `ensureProjectLead`, `routeToProjectAgent` → `routeToProjectLead`, etc.

**Step 3: Run tests**

Run: `cd api && bun test src/project-lead.test.ts`
Expected: Pass

**Step 4: Commit**

```bash
git add api/src/project-lead.ts api/src/project-lead.test.ts api/src/project-lead-router.ts
git commit -m "refactor: rename ProjectAgent DO to ProjectLead"
```

---

## Task 7: Worker Entry Point + Wrangler Config

Update the Worker routes and DO binding declarations.

**Files:**
- Modify: `api/src/index.ts`
- Modify: `api/wrangler.toml`

**Step 1: Update index.ts**

- Update all imports to new file names (conductor.ts, task-agent.ts, project-lead.ts, task-manager.ts)
- Export renamed classes: `Conductor`, `TaskAgent`, `ProjectLead`
- Update all binding references: `env.ORCHESTRATOR` → `env.CONDUCTOR`, etc.
- Update route paths: `/project-agent/` → `/project-lead/`
- All `ticketUUID` → `taskUUID` in route handlers

**Step 2: Update wrangler.toml**

Update both production and staging sections:

```toml
[durable_objects]
bindings = [
  { name = "CONDUCTOR", class_name = "Conductor" },
  { name = "TASK_AGENT", class_name = "TaskAgent" },
  { name = "PROJECT_LEAD", class_name = "ProjectLead" }
]

[[migrations]]
tag = "v5"
new_sqlite_classes = ["Conductor", "TaskAgent"]
deleted_classes = ["Orchestrator", "TicketAgent"]

[[migrations]]
tag = "v6"
new_classes = ["ProjectLead"]
deleted_classes = ["ProjectAgent"]
```

**Note:** The `deleted_classes` + `new_sqlite_classes` approach creates fresh DO storage. This is the clean-slate deploy approach approved by the user.

**Step 3: Run typecheck**

Run: `cd api && bunx tsc --noEmit`
Expected: Clean

**Step 4: Commit**

```bash
git add api/src/index.ts api/wrangler.toml
git commit -m "refactor: update Worker entry point and wrangler config for renamed DOs"
```

---

## Task 8: Slack Handler Simplification

The core behavioral change: simplify thread handling, remove @mention paths, always create task records.

**Files:**
- Modify: `api/src/slack-handler.ts`

**Step 1: Update imports and type references**

- `TicketEvent` → `TaskEvent`
- `AgentManager` → `TaskManager`
- `SlackHandlerDeps` — update type of `taskManager` (was `agentManager`), `routeToProjectLead` (was `routeToProjectAgent`), `respawnSuspendedTask` (was `respawnSuspendedAgent`), `handleTaskReview` (was `handleTicketReview`)

**Step 2: Update thread reply lookup (lines 310-390)**

- SQL: `SELECT task_uuid, product, status, agent_active FROM tasks WHERE slack_thread_ts = ?`
- `ticket` variable → `task`
- `agentManager` → `taskManager`
- `ticketUUID` → `taskUUID`

**Step 3: Remove @mention-specific branching in product channels**

Replace the current three-path split (lines 451-521) with unified handling:

```typescript
// Product channel: route ALL messages to ProjectLead.
// Always create a task record for thread reply tracking.
const rawText = (slackEvent.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
const slackThreadTs = slackEvent.thread_ts || slackEvent.ts;
const productConfig = products[product];
const hasLinear = !!productConfig.triggers?.linear?.project_name;

if (hasLinear) {
  // Linear path: create Linear issue, create task, route to ProjectLead
  // ... (existing Linear issue creation logic, but post updates in user's thread)
  // Key change: do NOT post a new top-level message.
  // Store slackThreadTs (user's original ts) as slack_thread_ts.
} else {
  // No-Linear path: create task record, route to ProjectLead
  const taskUUID = crypto.randomUUID();
  // Generate human-readable task_id via LLM (extend generateTicketSummary)
  taskManager.createTask({
    taskUUID,
    product,
    slackThreadTs: slackThreadTs || undefined,
    slackChannel: slackEvent.channel || undefined,
    title: rawText.slice(0, 100),
  });
  // Route to ProjectLead
}
```

**Step 4: Update `generateTicketSummary` → `generateTaskSummary`**

Extend the LLM prompt to also return a `taskId` field (human-readable, < 16 chars, slug-style):

```typescript
export async function generateTaskSummary(
  rawText: string, product: string, slackUser: string, env, sql,
): Promise<{ title: string; description: string; taskId: string }> {
  // ... existing LLM call, but updated prompt:
  // "Generate a JSON object with:
  //  - title: concise title (imperative, max 120 chars)
  //  - description: well-structured description
  //  - taskId: short unique slug (lowercase, hyphens, max 16 chars, e.g. 'fix-nav-bug')"
}
```

**Step 5: Remove the separate bot thread creation for Linear path**

In the Linear ticket creation section (was lines 652-668):
- Remove: `postSlackMessage(...)` that creates a new top-level message
- Remove: The reply in user's thread saying "Follow progress above"
- Instead: Store `slackThreadTs` (user's original ts) directly as `slack_thread_ts`

**Step 6: Run tests**

Run: `cd api && bun test`
Expected: Some tests may need updating for new function signatures

**Step 7: Commit**

```bash
git add api/src/slack-handler.ts
git commit -m "feat: simplify Slack handler — one thread per task, always create task records"
```

---

## Task 9: Supporting Files Rename

Update all remaining files that import renamed modules.

**Files:**
- Modify: `api/src/webhooks.ts` — update imports, `ticketUUID` → `taskUUID`
- Modify: `api/src/container-env.ts` — update comments
- Modify: `api/src/persistent-config.ts` — update comments
- Modify: `api/src/event-buffer.ts` — update comments and type refs
- Modify: `api/src/observability.ts` — update refs
- Modify: `api/src/dashboard.ts` — update orchestrator refs to conductor
- Modify: `api/src/product-crud.ts` — update any ticket refs
- Modify: `api/src/registry.ts` — update any refs
- Modify: `api/src/slack-utils.ts` — update if needed
- Modify: `api/src/test-helpers.ts` — update mock orchestrator → conductor
- Modify: `api/src/supervisor.test.ts` — update all ticket → task refs
- Modify: `api/src/github-pr-webhook.test.ts` — update all refs
- Modify: `api/src/linear-webhook.test.ts` — update all refs
- Modify: `api/src/integration.test.ts` — update all refs
- Modify: `api/src/registry.test.ts` — update refs
- Modify: `api/src/security/normalized-event.ts` — update app_mention handling if needed
- Modify: `api/src/security/normalized-event.test.ts` — update test fixtures
- Modify: `api/src/security/integration.test.ts` — update fixtures
- Modify: `api/src/security/integration-webhook.test.ts` — update fixtures

**Step 1: Update all imports and references**

For each file, update:
- Import paths (orchestrator → conductor, ticket-agent → task-agent, etc.)
- Type names (TicketEvent → TaskEvent, etc.)
- Variable names (ticketUUID → taskUUID)
- SQL table references (tickets → tasks)

**Step 2: Run full test suite**

Run: `cd api && bun test`
Expected: All non-dependency-failure tests pass

**Step 3: Run typecheck**

Run: `cd api && bunx tsc --noEmit`
Expected: Clean

**Step 4: Commit**

```bash
git add api/src/
git commit -m "refactor: update all supporting files for task terminology"
```

---

## Task 10: Agent Package Rename

Update the agent server code that runs inside containers.

**Files:**
- Modify: `agent/src/server.ts` — rename TicketAgent refs
- Modify: `agent/src/tools.ts` — rename ticket refs
- Modify: `agent/src/config.ts` — rename config types
- Modify: `agent/src/role-config.ts` — rename refs
- Modify: `agent/src/workspace-setup.test.ts` — rename refs
- Modify: `agent/src/lifecycle.test.ts` — rename refs
- Modify: all other agent/src/ files with ticket references

**Step 1: Update all references**

- `TicketAgentConfig` → `TaskAgentConfig`
- `ticketUUID` → `taskUUID`
- `ticketId` → `taskId`
- `ticketTitle` → `taskTitle`
- Import paths if any point to api/src types

**Step 2: Run agent tests**

Run: `cd agent && bun test`
Expected: All pass

**Step 3: Commit**

```bash
git add agent/src/
git commit -m "refactor: update agent package for task terminology"
```

---

## Task 11: Container Code Rename

Update the orchestrator container (Socket Mode) code.

**Files:**
- Rename: `containers/orchestrator/` → `containers/conductor/` (directory)
- Modify: `containers/conductor/index.ts` — update log prefixes, WORKER_URL forwarding
- Modify: `containers/conductor/slack-socket.ts` — update if needed
- Modify: Dockerfile references if any

**Step 1: Rename directory and update contents**

```bash
git mv containers/orchestrator containers/conductor
```

Update `[Orchestrator Container]` log prefixes → `[Conductor Container]`.

**Step 2: Update wrangler.toml container references**

Ensure the container build path in wrangler.toml points to `containers/conductor/`.

**Step 3: Commit**

```bash
git add containers/
git commit -m "refactor: rename orchestrator container to conductor"
```

---

## Task 12: E2E Tests for Thread Reply Routing

Add E2E test coverage for the key flows that were broken.

**Files:**
- Modify: `scripts/e2e-staging-test.ts` — add thread reply test steps
- Create: `api/src/slack-handler.test.ts` — unit tests for the new unified handler

**Step 1: Write unit tests for slack-handler thread reply routing**

Create `api/src/slack-handler.test.ts` with mock SQL and deps:

```typescript
import { describe, it, expect } from "bun:test";
import { handleSlackEvent } from "./slack-handler";

// Test: thread reply to known task → routes to task (respawn if needed)
// Test: thread reply to unknown thread → creates new task, routes to ProjectLead
// Test: new top-level message in product channel → creates task record
// Test: @mention treated same as plain message
// Test: task record created with correct slack_thread_ts (user's original ts)
// Test: Linear-originated task uses Linear identifier as task_id
// Test: Slack-originated task gets LLM-generated task_id
// Test: terminal task gets reopened on thread reply
// Test: inactive task gets reactivated on thread reply
```

**Step 2: Write failing tests first**

Each test should:
1. Set up mock SQL with tasks table
2. Set up mock deps (taskManager, routeToProjectLead, etc.)
3. Call `handleSlackEvent` with a crafted event
4. Assert the expected behavior (task created, routed correctly, etc.)

**Step 3: Ensure tests pass with the new implementation**

Run: `cd api && bun test src/slack-handler.test.ts`
Expected: All pass

**Step 4: Add E2E thread reply steps to staging test**

In `scripts/e2e-staging-test.ts`, add steps for `--medium` mode:

- Step: Send a message in product channel → verify task record created
- Step: Reply in that thread → verify reply routed to existing task
- Step: Wait for task to complete → verify terminal state
- Step: Reply in thread again → verify task reopened and respawned

**Step 5: Commit**

```bash
git add api/src/slack-handler.test.ts scripts/e2e-staging-test.ts
git commit -m "test: add E2E tests for thread reply routing and task lifecycle"
```

---

## Task 13: Documentation Update

Update all docs to use new terminology.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/process/learnings.md`
- Modify: `docs/deployment-safety.md` (if exists)
- Modify: `docs/cloudflare-ai-gateway.md` and related
- Modify: `docs/troubleshooting/slack-thread-replies.md`
- Modify: Any skills that reference old terminology

**Step 1: Update CLAUDE.md**

- All "ticket" → "task"
- "Orchestrator" → "Conductor"
- "TicketAgent" → "TaskAgent"
- "ProjectAgent" → "ProjectLead"
- Architecture diagram updated
- Key Directories table updated
- File references updated (orchestrator.ts → conductor.ts, etc.)

**Step 2: Update learnings.md**

- Update all references to old class/function names

**Step 3: Update other docs**

**Step 4: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: update all documentation for task terminology"
```

---

## Task 14: Final Verification

**Step 1: Full test suite**

Run: `cd api && bun test`
Run: `cd agent && bun test`
Expected: All non-dependency-failure tests pass

**Step 2: Typecheck**

Run: `cd api && bunx tsc --noEmit`
Expected: Clean

**Step 3: Grep for stale references**

```bash
grep -r "TicketAgent\|TICKET_AGENT\|ticket_agent" api/src/ agent/src/ --include="*.ts" -l
grep -r "ProjectAgent\|PROJECT_AGENT\|project_agent" api/src/ agent/src/ --include="*.ts" -l
grep -r "Orchestrator\|ORCHESTRATOR" api/src/ agent/src/ --include="*.ts" -l
grep -r "ticketUUID\|ticket_uuid\|ticket_id" api/src/ agent/src/ --include="*.ts" -l
```

Expected: No matches (only in node_modules or comments explaining the migration)

**Step 4: Commit any remaining fixes**

**Step 5: Final commit**

```bash
git commit -m "refactor: complete task terminology migration — verified clean"
```

---

## Execution Notes

### Parallelization

Tasks 1-2 must go first (types + DB). After that:
- Tasks 3-6 (manager + three DO renames) can run in parallel
- Task 7 (index.ts + wrangler) depends on 3-6
- Task 8 (slack handler) depends on 3
- Task 9 (supporting files) depends on 3-7
- Tasks 10-11 (agent + container code) can run in parallel with 7-9
- Task 12 (E2E tests) depends on 8
- Task 13 (docs) can run in parallel with anything
- Task 14 (verification) runs last

### Risk Notes

- **DO class rename is a breaking deploy.** All in-flight agents die. Deploy during low-activity window.
- **DB migrations are one-way.** `ALTER TABLE RENAME` can't be undone without another migration.
- **`app_mention` is a Slack event type string.** We're not renaming the string — we're removing the special handling path. The Socket Mode filter still receives both `app_mention` and `message` events.
- **The `slack_thread_map` table** is used transiently during Linear ticket creation. It should also be updated to reference tasks instead of tickets.
