# Fix Agent Lifecycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix five agent lifecycle issues: disable broken investigation flow, add git-branch-based auto-resume after deploy, reduce container TTL to 2h, and fix skill compliance (no direct-to-main pushes, explicit code review + retro steps).

**Architecture:** Replace R2-FUSE-based session persistence with git-branch-based persistence. Agents create a remote branch on work start, commit/push frequently, and auto-resume from the branch after container restart. Disable the cron health check that was killing working agents. Rewrite skill instructions for clarity on merge policy, code review, and retro requirements.

**Tech Stack:** TypeScript (Bun), Cloudflare Workers/Containers/DOs, Agent SDK

---

### Task 1: Disable investigation cron

The cron health check runs every 10 minutes and marks agents as `agent_active = 0` after 30 min without heartbeat. This kills potentially working agents and creates useless investigation records.

**Files:**
- Modify: `orchestrator/wrangler.toml:38-39`
- Modify: `orchestrator/src/orchestrator.ts:674-763` (make checkAgentHealth report-only)

**Step 1: Remove the cron trigger**

In `orchestrator/wrangler.toml`, remove the `[triggers]` section:

```toml
# REMOVE these lines:
# [triggers]
# crons = ["*/10 * * * *"]
```

**Step 2: Make checkAgentHealth report-only (keep as manual diagnostic)**

In `orchestrator/src/orchestrator.ts`, modify `checkAgentHealth()` to only report stuck agents without taking action (no marking inactive, no creating investigation tickets):

```typescript
private async checkAgentHealth(): Promise<Response> {
  const stuckThreshold = 30; // minutes
  const rows = this.ctx.storage.sql.exec(
    `SELECT id, product, status, last_heartbeat, slack_thread_ts, slack_channel, created_at
     FROM tickets
     WHERE agent_active = 1
       AND id NOT LIKE '%investigation-%'
       AND last_heartbeat IS NOT NULL
       AND (julianday('now') - julianday(last_heartbeat)) * 24 * 60 > ?`,
    stuckThreshold,
  ).toArray() as Array<{
    id: string;
    product: string;
    status: string;
    last_heartbeat: string;
    slack_thread_ts: string | null;
    slack_channel: string | null;
    created_at: string;
  }>;

  const results = rows.map(ticket => {
    const minutesStuck = Math.floor(
      (Date.now() - new Date(ticket.last_heartbeat).getTime()) / 60000,
    );
    return {
      ticketId: ticket.id,
      product: ticket.product,
      status: ticket.status,
      minutesStuck,
      lastHeartbeat: ticket.last_heartbeat,
    };
  });

  if (results.length > 0) {
    console.log(`[Orchestrator] ${results.length} agents with stale heartbeats (report only, no action taken)`);
  }

  return Response.json({ ok: true, stale_agents: results });
}
```

Remove the `createInvestigationTicket` method entirely, since it's no longer called.

Also remove the `scheduled` handler in `orchestrator/src/index.ts` since there's no cron to trigger it — or keep it as a no-op fallback.

**Step 3: Remove the now-unused `createInvestigationTicket` method**

Delete lines 765-854 from `orchestrator/src/orchestrator.ts`.

**Step 4: Clean up index.ts scheduled handler**

In `orchestrator/src/index.ts`, the `scheduled` handler can stay since it just calls `/check-health` which is now report-only. No change needed.

**Step 5: Update tests**

In `orchestrator/src/orchestrator.test.ts`, update or remove the investigation-related tests (lines 82-130). Keep the time calculation test, remove the investigation ticket tests since that feature is gone.

**Step 6: Commit**

```bash
git add orchestrator/wrangler.toml orchestrator/src/orchestrator.ts orchestrator/src/orchestrator.test.ts
git commit -m "fix: disable investigation cron that was killing working agents

The cron health check was marking agents as inactive after 30 min
without heartbeat, killing potentially working agents mid-task.
Converted checkAgentHealth to report-only diagnostic endpoint."
```

---

### Task 2: Reduce TicketAgent container TTL to 2 hours

**Files:**
- Modify: `orchestrator/src/ticket-agent.ts:59`

**Step 1: Change sleepAfter**

```typescript
// Change from:
sleepAfter = "96h"; // 4 days
// To:
sleepAfter = "2h";
```

**Step 2: Run existing tests to verify no breakage**

```bash
cd orchestrator && bun test
```
Expected: all tests pass (sleepAfter is not tested directly).

**Step 3: Commit**

```bash
git add orchestrator/src/ticket-agent.ts
git commit -m "fix: reduce agent container TTL from 96h to 2h

Agents were staying alive for 4 days wasting resources. 2h is sufficient
since auto-resume from git branch handles container restarts."
```

---

### Task 3: Add auto-resume from git branch on agent startup

When an agent container restarts (deploy, crash, TTL expiry), it should automatically check for an existing work branch and resume from it.

**Files:**
- Modify: `agent/src/server.ts` (add auto-resume logic)
- Modify: `agent/src/prompt.ts` (add resume prompt builder)

**Step 1: Add helper to check for existing remote branch**

In `agent/src/server.ts`, add after the `cloneRepos()` function:

```typescript
async function checkAndCheckoutWorkBranch(): Promise<string | null> {
  const branchPrefixes = [`ticket/${config.ticketId}`, `feedback/${config.ticketId}`];

  for (const branch of branchPrefixes) {
    const check = Bun.spawn(["git", "ls-remote", "--heads", "origin", branch]);
    const output = await new Response(check.stdout).text();
    const exitCode = await check.exited;

    if (exitCode === 0 && output.trim().length > 0) {
      console.log(`[Agent] Found existing branch: ${branch}`);
      const checkout = Bun.spawn(["git", "checkout", "-b", branch, `origin/${branch}`]);
      const checkoutExit = await checkout.exited;
      if (checkoutExit !== 0) {
        // Branch might already exist locally
        const switch_ = Bun.spawn(["git", "checkout", branch]);
        await switch_.exited;
      }
      return branch;
    }
  }

  return null;
}
```

**Step 2: Add auto-resume startup logic**

In `agent/src/server.ts`, add after the server setup (after `export default`):

```typescript
// Auto-resume: if container restarts with a ticket config, check for existing
// work branch and resume the session without waiting for an event
setTimeout(async () => {
  if (sessionActive) return; // Event already triggered a session

  try {
    await cloneRepos();
    const branch = await checkAndCheckoutWorkBranch();

    if (branch) {
      console.log(`[Agent] Auto-resuming from branch: ${branch}`);
      phoneHome("auto_resume", `branch=${branch}`);

      // Get git state for context
      const logProc = Bun.spawn(["git", "log", "--oneline", "-10"]);
      const gitLog = await new Response(logProc.stdout).text();

      const statusProc = Bun.spawn(["git", "status", "--short"]);
      const gitStatus = await new Response(statusProc.stdout).text();

      // Check for existing PR
      const prProc = Bun.spawn(["gh", "pr", "view", "--json", "url,state,title", branch]);
      const prOutput = await new Response(prProc.stdout).text();
      const prExit = await prProc.exited;
      const prInfo = prExit === 0 ? prOutput.trim() : "No PR found";

      const resumePrompt = buildResumePrompt(branch, gitLog.trim(), gitStatus.trim(), prInfo);

      // Notify Slack about recovery
      if (config.slackChannel && config.slackBotToken) {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.slackBotToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: config.slackChannel,
            text: `Container restarted — resuming work from branch \`${branch}\``,
            ...(config.slackThreadTs && { thread_ts: config.slackThreadTs }),
          }),
        }).catch((err) => console.error("[Agent] Failed to post recovery message:", err));
      }

      await startSession(resumePrompt);
    } else {
      console.log("[Agent] No existing work branch found — waiting for event");
    }
  } catch (err) {
    console.error("[Agent] Auto-resume failed:", err);
    phoneHome("auto_resume_failed", String(err).slice(0, 200));
  }
}, 5000); // Wait 5s for container to stabilize
```

**Step 3: Add resume prompt builder to prompt.ts**

In `agent/src/prompt.ts`, add:

```typescript
export function buildResumePrompt(
  branch: string,
  gitLog: string,
  gitStatus: string,
  prInfo: string,
): string {
  return `Your container was restarted (deploy, crash, or TTL expiry). Your previous work is saved on branch \`${branch}\`.

## Git State

**Recent commits:**
\`\`\`
${gitLog || "(no commits on branch)"}
\`\`\`

**Working directory status:**
\`\`\`
${gitStatus || "(clean)"}
\`\`\`

**PR status:**
\`\`\`
${prInfo}
\`\`\`

## What To Do

1. Review the git log and status above to understand where you left off
2. If a PR exists and is approved, merge it
3. If a PR exists with requested changes, address them
4. If no PR exists, continue implementing and create one when ready
5. Follow the product-engineer skill for the rest of the workflow

**CRITICAL — Headless Execution Rules:**
- **NEVER use plan mode.** Do NOT call EnterPlanMode or ExitPlanMode.
- **No interactive UI tools.** Use the \`ask_question\` MCP tool for human input.`;
}
```

**Step 4: Import the new function in server.ts**

Update the import in `server.ts`:
```typescript
import { buildPrompt, buildEventPrompt, buildResumePrompt } from "./prompt";
```

**Step 5: Run tests**

```bash
cd agent && bun test
```
Expected: existing tests pass.

**Step 6: Commit**

```bash
git add agent/src/server.ts agent/src/prompt.ts
git commit -m "feat: auto-resume agent sessions from git branch after restart

When a container restarts, the agent checks for an existing work branch
(ticket/<id> or feedback/<id>) on the remote. If found, it checks out
the branch and resumes the session with full git context."
```

---

### Task 4: Add TicketAgent alarm override for container liveness

Ensure the agent container stays alive and can auto-resume after deploy.

**Files:**
- Modify: `orchestrator/src/ticket-agent.ts`

**Step 1: Add alarm override**

```typescript
// After the onError method, add:
override async alarm(alarmProps: { isRetry: boolean; retryCount: number }) {
  // If this ticket has active work, keep the container alive
  const config = this.getConfig();
  if (config) {
    try {
      await this.containerFetch("http://localhost/health", { method: "GET" }, this.defaultPort);
    } catch {
      console.log(`[TicketAgent] Container not healthy for ${config.ticketId}, will auto-resume on restart`);
    }
  }
  return super.alarm(alarmProps);
}
```

**Step 2: Run tests**

```bash
cd orchestrator && bun test
```

**Step 3: Commit**

```bash
git add orchestrator/src/ticket-agent.ts
git commit -m "fix: add TicketAgent alarm override to keep container alive

Ensures agent container stays running after deploy by probing health
on alarm. containerFetch auto-starts the container if needed, which
triggers the auto-resume logic in the agent server."
```

---

### Task 5: Update product-engineer skill for compliance

Fix all behavior issues: explicit no-push-to-main, inline code review, mandatory retro push.

**Files:**
- Modify: `.claude/skills/product-engineer/SKILL.md`

**Step 1: Rewrite the skill**

Key changes:
1. Add explicit "NEVER push directly to main" rule at the top
2. Add "commit and push frequently" instruction during implementation
3. Replace reference to `code-review` plugin skill with inline checklist (plugin skills aren't available in agent containers)
4. Make retro push a numbered step (not sub-bullet)
5. Clarify that "auto-merge" means `gh pr merge`, never `git push origin main`
6. Add instruction to explicitly state code review results in Slack
7. Add instruction to push retro learnings to branch and mention in Slack

See the full rewritten skill in the implementation.

**Step 2: Commit**

```bash
git add .claude/skills/product-engineer/SKILL.md
git commit -m "fix: rewrite product-engineer skill for agent compliance

- Explicit NEVER push to main rule
- Inline code review checklist (plugin skills unavailable in containers)
- Mandatory retro push step before merge
- Frequent commit/push during implementation
- Clarify auto-merge means gh pr merge, not git push"
```

---

### Task 6: Update deployment-safety.md

**Files:**
- Modify: `docs/deployment-safety.md`

**Step 1: Update to reflect git-branch-based persistence**

Replace the R2 session persistence section with git-branch-based persistence description. Update the "What Happens During Deployment" table. Remove R2 FUSE troubleshooting section.

**Step 2: Commit**

```bash
git add docs/deployment-safety.md
git commit -m "docs: update deployment safety for git-branch-based resume"
```

---

### Task 7: Run all tests and verify

**Step 1: Run orchestrator tests**

```bash
cd orchestrator && bun test
```

**Step 2: Run agent tests**

```bash
cd agent && bun test
```

**Step 3: Verify no TypeScript errors**

```bash
cd orchestrator && bunx tsc --noEmit
cd agent && bunx tsc --noEmit
```
