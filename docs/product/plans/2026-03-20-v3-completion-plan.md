# v3 Completion: Conductor + Self-Managing Agents

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete v3 by making ticket agents fully self-managing, renaming the orchestrator role to "Conductor," implementing the cross-product Conductor agent, and adding E2E tests that verify the Conductor can route work and provide status across projects.

**Architecture:** The Conductor is a persistent ProjectAgent with the `assistant` SKILL.md — it handles DMs, cross-project queries, and routes work to the right project lead. All three roles (Conductor, Project Lead, Ticket Agent) run the same `agent/src/server.ts` binary, differentiated only by env vars and SKILL.md files. Ticket agents own their full lifecycle including CI monitoring and merge decisions — the orchestrator DO becomes a thin state store with zero decision logic.

**Tech Stack:** Cloudflare Workers + Durable Objects + Containers, Agent SDK, Bun, Hono, SQLite

---

## Current State (what's done vs what's not)

| Component | Status | What's Missing |
|-----------|--------|----------------|
| ProjectAgent DO | ✅ Done | Works for per-product agents |
| Agent server dual-mode | ✅ Done | `AGENT_ROLE=project-lead` vs ticket agent |
| Injection detection (Slack) | ✅ Done | Wired and working |
| Injection detection (Linear/GitHub) | ❌ Code exists, NOT wired | `normalizeLinearEvent`/`normalizeGitHubEvent` never called |
| Merge gate in orchestrator | ⚠️ Still there | Should move to ticket agent SKILL.md |
| Supervisor in orchestrator | ⚠️ Still there | Should move to project lead SKILL.md |
| Conductor (cross-product assistant) | ❌ SKILL.md exists, no routing | No way to reach the assistant agent |
| Self-managing ticket agent | ⚠️ Partial | `merge-gate.ts` exists but not integrated; SKILL.md says to self-manage but tools missing |
| E2E tests for Conductor | ❌ None | No tests for cross-project status, routing, delegation |
| Session state reset (project leads) | ❌ Bug | Counters not reset between sessions |

## Architecture After This Plan

```
User message in any channel
  → Worker (HMAC + injection scan for ALL sources)
    → Orchestrator DO (thin: channel→product lookup, ticket CRUD)
      → Conductor (assistant): DMs, cross-project, unrouted
      → Project Lead (per product): manages tickets, spawns agents
        → Ticket Agent (per ticket): fully self-managing
```

All three roles run `agent/src/server.ts` with different `AGENT_ROLE` values:
- `conductor` — persistent, cross-product, assistant SKILL.md
- `project-lead` — persistent, per-product, coding-project-lead SKILL.md
- (empty) — ephemeral ticket agent, ticket-agent-coding SKILL.md

---

## Task 1: Wire injection scanning for Linear and GitHub webhooks

The `normalizeLinearEvent()` and `normalizeGitHubEvent()` functions exist and are tested, but are never called from the webhook handlers. This is a security gap.

**Files:**
- Modify: `orchestrator/src/orchestrator.ts` (handleEvent, handleSlackEvent)
- Modify: `orchestrator/src/index.ts` (webhook routes)
- Test: `orchestrator/src/security/integration-webhook.test.ts` (already exists, verify it passes)

**Step 1: Read the existing normalization functions**

Read `orchestrator/src/security/normalized-event.ts` to understand the `normalizeLinearEvent` and `normalizeGitHubEvent` signatures.

**Step 2: Wire Linear webhook injection scanning**

In `orchestrator/src/orchestrator.ts`, find `handleEvent()`. Before the existing logic, add injection scanning:

```typescript
// At the top of handleEvent, after extracting the event:
import { normalizeLinearEvent, normalizeGitHubEvent } from "./security/normalized-event";

// In handleEvent, before processing:
if (event.source === "linear") {
  const normalized = normalizeLinearEvent(event.payload);
  if (normalized.injectionDetected) {
    console.warn(`[Orchestrator] Injection detected in Linear event: ${normalized.injectionField}`);
    return; // Drop silently — don't process injected content
  }
}
```

**Step 3: Wire GitHub webhook injection scanning**

Same pattern for GitHub events in `handleEvent()`:

```typescript
if (event.source === "github") {
  const normalized = normalizeGitHubEvent(event.payload);
  if (normalized.injectionDetected) {
    console.warn(`[Orchestrator] Injection detected in GitHub event: ${normalized.injectionField}`);
    return;
  }
}
```

**Step 4: Run existing tests**

```bash
cd orchestrator && bun test security/
```
Expected: All security tests pass.

**Step 5: Commit**

```bash
git add orchestrator/src/orchestrator.ts
git commit -m "fix: wire injection scanning for Linear and GitHub webhooks"
```

---

## Task 2: Fix project-lead session state reset

When a project-lead session completes, counters and timestamps are not reset, causing stale state in the next session.

**Files:**
- Modify: `agent/src/server.ts` (~lines 728-760, session completion and error paths)

**Step 1: Find the session completion path for project leads**

In `agent/src/server.ts`, find the `if (isProjectLead)` block after session completion (~line 728). Currently it only resets `sessionStatus` and `messageYielder`.

**Step 2: Add full state reset**

```typescript
if (isProjectLead) {
  console.log("[Agent] Project lead session completed — staying alive for next event");
  sessionStatus = "idle";
  messageYielder = null;
  // Reset session state for next event
  sessionMessageCount = 0;
  sessionStartTime = 0;
  sessionError = "";
  lastStderr = "";
  lastToolCall = "";
  lastAssistantText = "";
  lastUserPrompt = "";
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCacheReadTokens = 0;
  totalCacheCreationTokens = 0;
  totalCostUsd = 0;
  turnUsageLog = [];
}
```

**Step 3: Apply same reset in the error recovery path**

Find the `if (isProjectLead)` block in the error handler (~line 757) and add the same resets.

**Step 4: Commit**

```bash
git add agent/src/server.ts
git commit -m "fix: fully reset session state between project-lead sessions"
```

---

## Task 3: Add `check_ci_status` and `merge_pr` tools to agent

Ticket agents need tools to check CI and merge PRs themselves. The `merge-gate.ts` module exists but isn't exposed as agent tools.

**Files:**
- Modify: `agent/src/tools.ts` — add `check_ci_status` and `merge_pr` tools
- Modify: `agent/src/merge-gate.ts` — export functions for tool use
- Test: `agent/src/merge-gate.test.ts` (already exists)

**Step 1: Read the existing merge-gate module**

Read `agent/src/merge-gate.ts` to understand what functions exist.

**Step 2: Add check_ci_status tool**

In `agent/src/tools.ts`, add a tool that calls the GitHub commit statuses API:

```typescript
const checkCiStatus = tool(
  "check_ci_status",
  "Check CI status for the current PR. Returns commit statuses (passing/failing/pending). Use this after opening a PR to monitor CI.",
  {
    pr_url: z.string().describe("The PR URL to check CI for"),
  },
  async ({ pr_url }) => {
    // Extract owner/repo and PR number from URL
    const match = pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!match) {
      return { content: [{ type: "text" as const, text: `Invalid PR URL: ${pr_url}` }] };
    }
    const [, repo, prNumber] = match;

    try {
      // Get PR to find head SHA
      const prRes = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
        headers: {
          Authorization: `Bearer ${config.githubToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      if (!prRes.ok) {
        return { content: [{ type: "text" as const, text: `Failed to fetch PR: ${prRes.status}` }] };
      }
      const prData = await prRes.json() as { head: { sha: string } };

      // Get commit statuses
      const statusRes = await fetch(`https://api.github.com/repos/${repo}/commits/${prData.head.sha}/status`, {
        headers: {
          Authorization: `Bearer ${config.githubToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      });
      if (!statusRes.ok) {
        return { content: [{ type: "text" as const, text: `Failed to fetch CI status: ${statusRes.status}` }] };
      }
      const statusData = await statusRes.json() as {
        state: string;
        statuses: Array<{ context: string; state: string; description: string | null }>;
      };

      if (statusData.statuses.length === 0) {
        return { content: [{ type: "text" as const, text: "No CI configured for this repository." }] };
      }

      const summary = statusData.statuses
        .map(s => `- ${s.context}: ${s.state}${s.description ? ` (${s.description})` : ""}`)
        .join("\n");

      return {
        content: [{ type: "text" as const, text: `CI Status: ${statusData.state}\n\n${summary}` }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error checking CI: ${err}` }] };
    }
  },
);
```

**Step 3: Add merge_pr tool**

```typescript
const mergePr = tool(
  "merge_pr",
  "Merge a PR using squash merge. Only call this when CI is passing and you're confident the PR is ready. This is irreversible.",
  {
    pr_url: z.string().describe("The PR URL to merge"),
  },
  async ({ pr_url }) => {
    const match = pr_url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!match) {
      return { content: [{ type: "text" as const, text: `Invalid PR URL: ${pr_url}` }] };
    }
    const [, repo, prNumber] = match;

    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${config.githubToken}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ merge_method: "squash" }),
      });

      if (!res.ok) {
        const data = await res.json() as { message?: string };
        return { content: [{ type: "text" as const, text: `Merge failed: ${res.status} ${data.message || ""}` }] };
      }

      // Report status to orchestrator
      try {
        await fetch(`${config.workerUrl}/api/internal/status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.apiKey,
          },
          body: JSON.stringify({
            ticketUUID: config.ticketUUID,
            status: "merged",
          }),
        });
      } catch { /* best effort */ }

      return { content: [{ type: "text" as const, text: "PR merged successfully!" }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error merging PR: ${err}` }] };
    }
  },
);
```

**Step 4: Add tools to the return array**

In `createTools()`, add both tools to the return:

```typescript
return { tools: [notifySlack, askQuestion, updateTaskStatus, checkCiStatus, mergePr, listTranscripts, fetchTranscript, fetchSlackFile] };
```

**Step 5: Run tests**

```bash
cd agent && bun test
```

**Step 6: Commit**

```bash
git add agent/src/tools.ts
git commit -m "feat: add check_ci_status and merge_pr tools for self-managing ticket agents"
```

---

## Task 4: Update ticket-agent-coding SKILL.md for full self-management

Now that the tools exist, update the SKILL.md to give explicit instructions for CI monitoring and merge flow.

**Files:**
- Modify: `.claude/skills/ticket-agent-coding/SKILL.md`

**Step 1: Update the SKILL.md**

Replace the current content with enhanced self-management instructions. The key additions:
- Explicit CI monitoring loop using `check_ci_status` tool
- Merge flow using `merge_pr` tool
- Status reporting via `update_task_status` at every phase
- Communication to Slack at key milestones

```markdown
---
name: ticket-agent-coding
description: Self-managing ticket agent for coding tasks — handles implementation, CI monitoring, merge gate, and communication
alwaysApply: false
---

# Self-Managing Ticket Agent (Coding)

You are an autonomous coding agent working on a single ticket. You handle the FULL lifecycle: understand → implement → PR → monitor CI → fix failures → merge → report done.

## CRITICAL: You own your lifecycle end-to-end

You are responsible for EVERYTHING from receiving the task to merging the PR. Nobody else monitors CI for you. Nobody else merges for you. You must do it all.

## Lifecycle

### 1. Understand
- Read the ticket description and any Slack thread context
- Read the target repo's CLAUDE.md and relevant code
- If genuinely unclear WHAT to do (not HOW), ask ONE question via `ask_question`
- Otherwise, start implementing immediately

### 2. Implement
- Follow the repo's conventions (check CLAUDE.md, existing patterns)
- Write tests alongside code (not after)
- Make small, logical commits
- Use `update_task_status` with status `in_progress`
- Use `notify_slack` to post a brief "Starting work on [task]" message

### 3. Open PR
- Push to a branch named after the ticket
- Open a PR with a clear description using `gh pr create`
- Use `update_task_status` with status `pr_open` and the `pr_url`
- Use `notify_slack` to post the PR link to the Slack thread

### 4. Monitor CI (YOU must do this)
- After opening the PR, wait 60 seconds, then call `check_ci_status` with the PR URL
- If CI is pending: wait 60 seconds and check again (up to 10 times)
- If CI fails: read the failure, fix the issue, push a new commit, restart CI monitoring
- If CI passes: proceed to merge
- Max 3 CI fix attempts before giving up and reporting via `notify_slack`

### 5. Merge (YOU must do this)
- When CI passes (or no CI configured), call `merge_pr` with the PR URL
- Use `update_task_status` with status `merged`
- Use `notify_slack` to post "PR merged! Task complete."

### 6. Handle Failure
- If you can't fix CI after 3 attempts: use `notify_slack` to explain what's failing
- Use `update_task_status` with status `failed`
- Exit cleanly

## Communication Rules
- Post to Slack at these milestones ONLY:
  1. Starting work (what you understood the task to be)
  2. PR opened (with link)
  3. CI failing (what's wrong, only if you can't fix it)
  4. Merged/completed
- Don't spam — 4 messages max per task
- Use the product's Slack persona if configured

## Status Reporting
Call `update_task_status` at every phase transition:
- `in_progress` — when you start implementing
- `pr_open` — when PR is created (include pr_url)
- `in_review` — when waiting for CI
- `merged` — when PR is merged
- `failed` — if you give up
```

**Step 2: Commit**

```bash
git add .claude/skills/ticket-agent-coding/SKILL.md
git commit -m "feat: update ticket agent SKILL.md for full self-management with CI and merge"
```

---

## Task 5: Remove merge gate from orchestrator

Now that ticket agents self-manage, remove the orchestrator's merge gate evaluation. Keep the `handleStatusUpdate` endpoint (agents still report status) but remove the automatic merge gate trigger.

**Files:**
- Modify: `orchestrator/src/orchestrator.ts` — remove `evaluateMergeGate`, `autoMergePR`, merge gate retry logic
- Keep: `handleStatusUpdate` (status tracking), `handleHeartbeat` (heartbeat tracking)

**Step 1: Remove evaluateMergeGate and autoMergePR**

In `orchestrator/src/orchestrator.ts`:
- Delete the `evaluateMergeGate()` method entirely
- Delete the `autoMergePR()` method entirely
- Remove the `fetchCIStatus()` helper if it exists
- Remove the merge gate retry alarm logic from `alarm()`
- Remove the `checks_passed` trigger from `handleEvent`

**Step 2: Remove merge gate trigger from handleStatusUpdate**

In `handleStatusUpdate()`, remove the block that calls `evaluateMergeGate` when `pr_url` is reported. Keep the status update logic — just stop triggering merge decisions.

**Step 3: Clean up merge_gate_retries table references**

Remove any reads/writes to the `merge_gate_retries` table. Keep the table creation (for backward compatibility during deploy) but stop using it.

**Step 4: Run tests**

```bash
cd orchestrator && bun test
```

Fix any tests that reference the removed methods.

**Step 5: Commit**

```bash
git add orchestrator/src/orchestrator.ts
git commit -m "refactor: remove merge gate from orchestrator — ticket agents now self-manage"
```

---

## Task 6: Add `AGENT_ROLE=conductor` support to agent server

The Conductor is another persistent agent role. It shares the same core as project leads but uses the `assistant` SKILL.md and doesn't clone product repos.

**Files:**
- Modify: `agent/src/server.ts` — add conductor role handling
- Modify: `agent/src/config.ts` — handle conductor config

**Step 1: Update role detection**

In `agent/src/server.ts`, update the role detection:

```typescript
const _isProjectLeadRole = process.env.AGENT_ROLE === "project-lead" || process.env.AGENT_ROLE === "conductor";
const isConductor = process.env.AGENT_ROLE === "conductor";
const isProjectLead = process.env.AGENT_ROLE === "project-lead";
// isPersistentRole covers both conductor and project-lead
const isPersistentRole = _isProjectLeadRole;
```

Replace all references to `_isProjectLeadRole` and `isProjectLead` with `isPersistentRole` where the behavior is "stay alive / no timeout" (timeouts, session reset, no process.exit).

Keep `isProjectLead` for clone behavior (conductor clones PE repo only, not target repos).

**Step 2: Update cloneRepos for conductor**

The conductor only needs the PE repo (for skills), no target repos:

```typescript
if (isConductor) {
  // Conductor only clones PE repo for skills
  reposToClone = [PE_REPO];
  agentCwd = `/workspace/${PE_REPO.split("/").pop()}`;
  additionalDirs = [];
} else if (isProjectLead) {
  // Project lead clones PE repo + target repos
  reposToClone = [PE_REPO, ...config.repos.filter(r => r !== PE_REPO)];
  agentCwd = `/workspace/${PE_REPO.split("/").pop()}`;
  additionalDirs = config.repos.filter(r => r !== PE_REPO).map(r => `/workspace/${r.split("/").pop()}`);
} else {
  // Ticket agent clones target repos only
  reposToClone = config.repos;
  // ...existing logic
}
```

**Step 3: Commit**

```bash
git add agent/src/server.ts agent/src/config.ts
git commit -m "feat: add conductor role to agent server — persistent cross-product agent"
```

---

## Task 7: Implement Conductor routing in orchestrator

Add the Conductor as a special ProjectAgent that receives unrouted events, DMs, and cross-product queries.

**Files:**
- Modify: `orchestrator/src/orchestrator.ts` — add conductor routing
- Modify: `orchestrator/src/project-agent.ts` — support conductor config

**Step 1: Add conductor initialization**

In `orchestrator/src/orchestrator.ts`, add a method to ensure the Conductor is running:

```typescript
private async ensureConductor(): Promise<DurableObjectStub> {
  const id = this.env.PROJECT_AGENT.idFromName("__conductor__");
  const stub = this.env.PROJECT_AGENT.get(id);

  const conductorConfig = {
    product: "__conductor__",
    repos: [],
    slackChannel: "", // Conductor responds in whatever channel it receives events from
    secrets: {
      ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
    },
    mode: "flexible" as const,
    model: "sonnet",
  };

  await stub.fetch(new Request("http://project-agent/ensure-running", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conductorConfig),
  }));

  return stub;
}
```

**Step 2: Update resolveProjectAgentEnvVars for conductor**

In `orchestrator/src/project-agent.ts`, the `resolveProjectAgentEnvVars` function needs to set `AGENT_ROLE=conductor` when `product === "__conductor__"`:

```typescript
AGENT_ROLE: config.product === "__conductor__" ? "conductor" : "project-lead",
```

**Step 3: Route unmatched events to Conductor**

In `handleSlackEvent()`, when no product matches the channel, route to the Conductor instead of ignoring:

```typescript
// After channel→product lookup fails:
if (!product) {
  // Route to Conductor for unmatched channels / DMs
  try {
    const conductorStub = await this.ensureConductor();
    const event: TicketEvent = {
      type: "slack_mention",
      source: "slack",
      ticketUUID: `conductor-${slackEvent.ts || Date.now()}`,
      product: "__conductor__",
      payload: { text: rawText, user, channel: slackEvent.channel, ts: slackEvent.ts },
      slackThreadTs: slackEvent.thread_ts || slackEvent.ts,
      slackChannel: slackEvent.channel,
    };
    await conductorStub.fetch(new Request("http://project-agent/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    }));
    return Response.json({ ok: true, routed: "conductor" });
  } catch (err) {
    console.error("[Orchestrator] Failed to route to Conductor:", err);
    return Response.json({ error: "routing_failed" }, { status: 500 });
  }
}
```

**Step 4: Add conductor status to the project-agent/status endpoint**

In `handleProjectAgentRoute`, ensure the status endpoint also includes the conductor:

The existing status endpoint already iterates all products. Just need to make sure `__conductor__` is included. Add it to the list if not already a registered product.

**Step 5: Commit**

```bash
git add orchestrator/src/orchestrator.ts orchestrator/src/project-agent.ts
git commit -m "feat: implement Conductor routing — cross-product assistant agent"
```

---

## Task 8: Enhance assistant SKILL.md for Conductor

Update the assistant SKILL.md with concrete instructions for the Conductor's key use cases.

**Files:**
- Modify: `.claude/skills/assistant/SKILL.md`

**Step 1: Rewrite the SKILL.md**

```markdown
---
name: assistant
description: Cross-product assistant that handles DMs, unrouted events, and meta-queries
alwaysApply: false
---

# Conductor — Cross-Product Assistant

You are the Conductor. You coordinate across all registered products, handle direct messages, and route work to the right place.

## Your Core Responsibilities

### 1. Cross-Product Status
When asked "what's the status?" or "what's going on?":
- Use `list_tasks` to get all active tickets across products
- Group by product, show status and last activity
- Highlight anything needing attention (stale agents, failed tasks)

### 2. Route Work to Projects
When asked to "work on X for [product]" or "tell [product] to do Y":
- Identify which product the request is for
- Use `send_message_to_task` or `spawn_task` to route the work
- Tell the user: "I've sent that to [product]'s project lead — they'll handle it in #[channel]"

### 3. Start New Work
When asked to "build X" or "create Y" and a product is identified:
- Use `spawn_task` with the correct product and description
- Report back with the ticket UUID and where to follow progress

### 4. Answer System Questions
"How is the system performing?", "What failed recently?", "How much did we spend?":
- Use `list_tasks` with appropriate filters
- Summarize success/failure rates, costs, active work

### 5. Relay Directions to Project Leads
When the user says "tell [product] to [do something]" or gives follow-up instructions:
- Use `send_message_to_task` to forward the directions
- The project lead will receive them and act accordingly

## Communication Style
- Concise and helpful
- When routing, always tell the user WHERE the work will happen (which channel)
- For status, use bullet points grouped by product
- Don't over-explain — be an efficient coordinator

## Tools Available
- `notify_slack` — respond in the current channel
- `list_tasks` — get status across all products (via orchestrator API)
- `spawn_task` — create a new task for a product
- `send_message_to_task` — forward a message to a running agent
- `list_transcripts` / `fetch_transcript` — review agent work

## What You Don't Do
- You don't implement code yourself
- You don't manage individual tickets — that's the project lead's job
- You don't make decisions about how to implement — you route and coordinate
```

**Step 2: Commit**

```bash
git add .claude/skills/assistant/SKILL.md
git commit -m "feat: enhance Conductor SKILL.md with concrete routing and status instructions"
```

---

## Task 9: Add Conductor-specific tools (list_tasks, spawn_task, send_message_to_task)

The Conductor needs tools that call the orchestrator's internal API to manage work across products.

**Files:**
- Modify: `agent/src/tools.ts` — add conductor-specific tools
- The tools call the orchestrator's existing `/api/project-agent/*` and `/api/orchestrator/*` endpoints

**Step 1: Add list_tasks tool**

```typescript
const listTasks = tool(
  "list_tasks",
  "List all active tasks across all products. Returns ticket ID, product, status, and last activity.",
  {
    status_filter: z.string().optional().describe("Filter by status (e.g., 'active', 'pr_open')"),
  },
  async ({ status_filter }) => {
    try {
      const res = await fetch(`${config.workerUrl}/api/orchestrator/status`, {
        headers: { "X-API-Key": config.apiKey },
      });
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Failed to list tasks: ${res.status}` }] };
      }
      const data = await res.json() as { activeAgents: Array<{ id: string; product: string; status: string; last_heartbeat: string | null; pr_url: string | null; agent_message: string | null }> };

      let agents = data.activeAgents || [];
      if (status_filter) {
        agents = agents.filter(a => a.status === status_filter);
      }

      if (agents.length === 0) {
        return { content: [{ type: "text" as const, text: "No active tasks found." }] };
      }

      const summary = agents.map(a =>
        `- **${a.product}** [${a.status}]: ${a.agent_message?.slice(0, 100) || "no recent message"}${a.pr_url ? ` | PR: ${a.pr_url}` : ""}`
      ).join("\n");

      return { content: [{ type: "text" as const, text: `Active tasks (${agents.length}):\n\n${summary}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  },
);
```

**Step 2: Add spawn_task tool**

```typescript
const spawnTask = tool(
  "spawn_task",
  "Create and start a new task for a specific product. The product's project lead will receive the task.",
  {
    product: z.string().describe("Product slug (e.g., 'staging-test-app')"),
    description: z.string().describe("Task description — what should be done"),
  },
  async ({ product, description }) => {
    try {
      const res = await fetch(`${config.workerUrl}/api/project-agent/spawn-task`, {
        method: "POST",
        headers: {
          "X-Internal-Key": config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ product, description }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: "text" as const, text: `Failed to spawn task: ${res.status} ${text}` }] };
      }
      const data = await res.json() as { ticketUUID?: string };
      return { content: [{ type: "text" as const, text: `Task spawned for ${product}: ${data.ticketUUID || "created"}` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  },
);
```

**Step 3: Add send_message_to_task tool**

```typescript
const sendMessageToTask = tool(
  "send_message_to_task",
  "Send a message to a running agent (project lead or ticket agent). Use this to relay instructions or provide context.",
  {
    product: z.string().describe("Product slug to send the message to"),
    message: z.string().describe("The message to send to the agent"),
  },
  async ({ product, message }) => {
    try {
      const res = await fetch(`${config.workerUrl}/api/project-agent/send-event`, {
        method: "POST",
        headers: {
          "X-Internal-Key": config.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          product,
          event: {
            type: "conductor_message",
            source: "internal",
            ticketUUID: `conductor-relay-${Date.now()}`,
            product,
            payload: { text: message, from: "conductor" },
          },
        }),
      });
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Failed to send message: ${res.status}` }] };
      }
      return { content: [{ type: "text" as const, text: `Message sent to ${product}'s project lead.` }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
  },
);
```

**Step 4: Conditionally include tools based on role**

In `createTools()`, add the conductor tools only when the role is conductor:

```typescript
const isConductor = process.env.AGENT_ROLE === "conductor";

const allTools = [notifySlack, askQuestion, updateTaskStatus, listTranscripts, fetchTranscript, fetchSlackFile];

if (isConductor) {
  allTools.push(listTasks, spawnTask, sendMessageToTask);
}

// Ticket agents and project leads get CI/merge tools
if (!isConductor) {
  allTools.push(checkCiStatus, mergePr);
}

return { tools: allTools };
```

**Step 5: Commit**

```bash
git add agent/src/tools.ts
git commit -m "feat: add conductor tools — list_tasks, spawn_task, send_message_to_task"
```

---

## Task 10: Add `send-event` endpoint to project-agent route

The Conductor's `send_message_to_task` tool needs an endpoint that forwards events to a specific product's ProjectAgent.

**Files:**
- Modify: `orchestrator/src/orchestrator.ts` — ensure `send-event` case in handleProjectAgentRoute works correctly

**Step 1: Verify the send-event endpoint exists and works**

Read the `handleProjectAgentRoute` method and check the `send-event` case. It should:
1. Accept `{ product, event }` in the body
2. Look up the product's ProjectAgent DO
3. Forward the event via `/event`

If the endpoint already exists and works, this is a no-op. If it needs fixes, apply them.

**Step 2: Test manually or via unit test**

**Step 3: Commit if changes were needed**

---

## Task 11: E2E test — Conductor cross-project status

Add E2E tests that verify the Conductor can answer cross-project status queries.

**Files:**
- Modify: `scripts/e2e-staging-test.ts` — add conductor test steps

**Step 1: Add step for Conductor status query**

Send a DM (or message in an unmapped channel) asking "what's the status of all tasks?" and verify the Conductor responds.

Since we may not have an unmapped channel, we can test via the internal endpoint:

```typescript
async function stepC1_conductorStatusQuery(ctx: TestContext): Promise<void> {
  log("conductor-1", "Testing Conductor cross-project status query...");

  // Send a status query to an unmapped channel (or via internal endpoint)
  // The Conductor should receive this and respond
  if (!SLACK_APP_TOKEN) {
    logWarn("conductor-1", "Skipping (SLACK_APP_TOKEN not set)");
    return;
  }

  const testChannel = "CUNMAPPED_TEST"; // Not mapped to any product
  const res = await fetch(`${STAGING_URL}/api/internal/slack-event`, {
    method: "POST",
    headers: {
      "X-Internal-Key": SLACK_APP_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "app_mention",
      text: "<@BOT> What's the status of all projects?",
      user: "U_E2E_CONDUCTOR",
      channel: testChannel,
      ts: `${Date.now() / 1000}`,
    }),
  });

  if (!res.ok) {
    logWarn("conductor-1", `Conductor routing returned ${res.status}`);
    return;
  }

  const data = await res.json() as { routed?: string };
  if (data.routed === "conductor") {
    logSuccess("conductor-1", "Event routed to Conductor successfully");
  } else {
    logWarn("conductor-1", `Event was not routed to Conductor: ${JSON.stringify(data)}`);
  }
}
```

**Step 2: Add step for Conductor work delegation**

```typescript
async function stepC2_conductorDelegateWork(ctx: TestContext): Promise<void> {
  log("conductor-2", "Testing Conductor work delegation...");

  if (!SLACK_APP_TOKEN) {
    logWarn("conductor-2", "Skipping (SLACK_APP_TOKEN not set)");
    return;
  }

  const testChannel = "CUNMAPPED_TEST";
  const res = await fetch(`${STAGING_URL}/api/internal/slack-event`, {
    method: "POST",
    headers: {
      "X-Internal-Key": SLACK_APP_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "app_mention",
      text: "<@BOT> Please start working on a test task for staging-test-app: add a hello world function",
      user: "U_E2E_CONDUCTOR",
      channel: testChannel,
      ts: `${Date.now() / 1000}`,
    }),
  });

  if (!res.ok) {
    logWarn("conductor-2", `Conductor routing returned ${res.status}`);
    return;
  }

  const data = await res.json() as { routed?: string };
  if (data.routed === "conductor") {
    logSuccess("conductor-2", "Work delegation request routed to Conductor");
  } else {
    logWarn("conductor-2", `Unexpected routing: ${JSON.stringify(data)}`);
  }
}
```

**Step 3: Add step for Conductor relay to project lead**

```typescript
async function stepC3_conductorRelayDirections(ctx: TestContext): Promise<void> {
  log("conductor-3", "Testing Conductor relay to project lead...");

  if (!SLACK_APP_TOKEN) {
    logWarn("conductor-3", "Skipping (SLACK_APP_TOKEN not set)");
    return;
  }

  // Send a follow-up in the Conductor's thread
  const testChannel = "CUNMAPPED_TEST";
  const res = await fetch(`${STAGING_URL}/api/internal/slack-event`, {
    method: "POST",
    headers: {
      "X-Internal-Key": SLACK_APP_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "app_mention",
      text: "<@BOT> Tell staging-test-app to prioritize the hello world function and make sure it has tests",
      user: "U_E2E_CONDUCTOR",
      channel: testChannel,
      ts: `${Date.now() / 1000}`,
    }),
  });

  if (!res.ok) {
    logWarn("conductor-3", `Conductor routing returned ${res.status}`);
    return;
  }

  const data = await res.json() as { routed?: string };
  if (data.routed === "conductor") {
    logSuccess("conductor-3", "Relay directions request routed to Conductor");
  } else {
    logWarn("conductor-3", `Unexpected routing: ${JSON.stringify(data)}`);
  }
}
```

**Step 4: Wire new steps into the test runner**

Add a `--conductor` flag or include in `--medium` mode:

```typescript
if (mode === "medium" || mode === "full") {
  // Existing steps 4-6...

  // Conductor tests
  await stepC1_conductorStatusQuery(ctx);
  await stepC2_conductorDelegateWork(ctx);
  await stepC3_conductorRelayDirections(ctx);
}
```

**Step 5: Commit**

```bash
git add scripts/e2e-staging-test.ts
git commit -m "feat: add E2E tests for Conductor — status query, work delegation, relay"
```

---

## Task 12: Remove dead merge gate code and clean up

Final cleanup — remove stale code, update docs.

**Files:**
- Modify: `orchestrator/src/orchestrator.ts` — remove dead `ready_to_merge` handling
- Modify: `docs/architecture/architecture.md` — update merge gate section
- Modify: `docs/deployment-safety.md` — update for v3
- Remove: `orchestrator/src/prompts/merge-gate.mustache` (if still exists)

**Step 1: Remove `ready_to_merge` dead code from handleHeartbeat**

In `handleHeartbeat`, the `ready_to_merge` field is received but never acted on. Remove the logging and the field from the interface (or keep the field but document it as "agent self-manages, this is informational only").

**Step 2: Update architecture doc**

Update the merge gate section in `docs/architecture/architecture.md` to reflect that ticket agents now self-manage their merge flow.

**Step 3: Update deployment-safety.md**

Update `docs/deployment-safety.md` to reflect v3 changes (CLAUDE.md says this must be checked when changing orchestrator.ts).

**Step 4: Run all tests**

```bash
cd orchestrator && bun test
cd agent && bun test
```

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: clean up dead merge gate code and update docs for v3"
```

---

## Task 13: Deploy to staging and run E2E tests

**Step 1: Deploy**

```bash
cd orchestrator && npx wrangler deploy --env staging
```

**Step 2: Run smoke tests**

```bash
bun run scripts/e2e-smoke-test.ts --env staging
```

**Step 3: Run medium E2E tests (includes Conductor)**

```bash
bun run scripts/e2e-staging-test.ts --medium
```

**Step 4: Run full E2E tests**

```bash
bun run scripts/e2e-staging-test.ts
```

**Step 5: Fix any issues found and re-test**

---

## Edge Case Matrix

| Scenario | Expected Behavior |
|----------|-------------------|
| Conductor receives message in unmapped channel | Routes to Conductor, responds with help |
| Conductor asked for status with no active agents | Returns "No active tasks" |
| Conductor asked to start work for unknown product | Returns error: "Product X not found" |
| Ticket agent CI fails 3x | Agent posts failure to Slack, sets status=failed, exits |
| Ticket agent merge fails (conflicts) | Agent posts error to Slack, sets needs_attention |
| ProjectAgent alarm fires with no config | Reschedules alarm (don't lose the keepalive) |
| Deploy replaces Conductor container | alarm() restarts, config from SQLite, events drained |
| Multiple events arrive while Conductor is busy | Events buffered (up to 50), processed when session completes |
