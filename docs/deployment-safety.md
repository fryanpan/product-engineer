# Deployment Safety

This document describes how Product Engineer handles deployments without disrupting in-progress work.

## Goals

1. Deploy updates many times per day
2. Never lose in-progress work
3. Allow ticket agents to complete their work naturally
4. No manual intervention required during deployment

## Architecture: Single Worker

Product Engineer deploys as a **single worker** (`api/`) containing both the Orchestrator DO and TicketAgent DO classes:

```toml
# api/wrangler.toml
[durable_objects]
bindings = [
  { name = "ORCHESTRATOR", class_name = "Orchestrator" },
  { name = "TICKET_AGENT", class_name = "TicketAgent" }
]
```

Deploying updates the Worker code and container images. Running TicketAgent containers are not immediately affected — they continue until their current work completes or their container is replaced.

## How It Works

### TicketAgent Containers (2h TTL, git-branch persistence)

**Problem:** When you deploy, container images update, and Cloudflare may replace running containers.

**Solution:** Git branches are the persistence layer. Agents commit and push frequently during work, so the branch always reflects the latest state. On container restart, the agent auto-resumes by cloning the repo, checking out the existing branch, and starting a new session with full git context.

- Agent creates a branch (`ticket/<id>` or `feedback/<id>`) at work start
- Commits and pushes frequently during implementation — the branch is the persistence layer
- On container restart, the agent auto-resumes: clones repo, checks for existing remote branch, checks it out, starts a new session with git context
- No R2 dependency for session persistence (R2 is still used for transcript backup)
- Container TTL is 2h (not 96h/4 days) — short-lived containers with reliable resume

**Implementation — branch detection** (`agent/src/server.ts`):

```typescript
async function checkAndCheckoutWorkBranch(): Promise<string | null> {
  const branchPrefixes = [`ticket/${config.ticketId}`, `feedback/${config.ticketId}`];

  for (const branch of branchPrefixes) {
    const check = Bun.spawn(["git", "ls-remote", "--heads", "origin", branch]);
    const output = await new Response(check.stdout).text();
    const exitCode = await check.exited;

    if (exitCode === 0 && output.trim().length > 0) {
      console.log(`[Agent] Found existing branch on remote: ${branch}`);
      const checkout = Bun.spawn(["git", "checkout", branch]);
      const checkoutExit = await checkout.exited;
      if (checkoutExit !== 0) {
        // Branch doesn't exist locally, create tracking branch
        const track = Bun.spawn(["git", "checkout", "-b", branch, `origin/${branch}`]);
        await track.exited;
      }
      return branch;
    }
  }

  return null;
}
```

**Implementation — auto-resume on container start** (`agent/src/server.ts`):

```typescript
// Auto-resume: if container restarts with a ticket config, check for existing
// work branch and resume the session without waiting for an event.
// This fires after the server is listening, so /health can respond while we resume.
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
        await fetch("https://slack.com/api/chat.postMessage", { ... });
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

**Result:** Container replacement doesn't lose work. The agent clones, checks out its branch, reads git log/status/PR state, and resumes with a rich context prompt. No session files or FUSE mounts required.

**Why this works:** The branch on the remote always has the latest pushed commits. Even if the agent was mid-task, the resume prompt includes git log, working tree status, and PR info so the new session can pick up where the old one left off. This is simpler and more reliable than persisting opaque session files.

### Orchestrator Container (always-on, restarts gracefully)

**Problem:** The Orchestrator runs a Slack Socket Mode connection that must stay alive, but deployments update the container image.

**Solution:** The Orchestrator container restarts only when needed:
- Container is marked as stopped when it exits
- On next request, `ensureContainerRunning()` starts the new container
- Slack Socket Mode reconnects automatically
- SQLite state persists across restarts (tickets, status, thread_ts)

**Implementation:**

```typescript
// api/src/orchestrator.ts
override onStop(params: { exitCode: number; reason: string }) {
  console.error(`[Orchestrator] Container stopped: ${params.exitCode} ${params.reason}`);
  this.containerStarted = false; // Allow restart on next fetch
}

private async ensureContainerRunning() {
  if (this.containerStarted) {
    try {
      // Verify container is actually responsive (flag can go stale across deploys)
      const port = (this.ctx as any).container.getTcpPort(this.defaultPort);
      const res = await port.fetch("http://localhost/health", { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      console.warn("[Orchestrator] Container not responsive — restarting");
      this.containerStarted = false;
    }
  }
  await this.startAndWaitForPorts(this.defaultPort);
  this.containerStarted = true;
}
```

**Result:** Brief Slack disconnection (1-2 seconds) on deployment, then auto-reconnects. No events lost.

### Status Field Separation

**Problem:** The `status` field was being conflated between the formal state machine (12 states) and agent lifecycle messages (`agent:starting_session`, `agent:pushing_to_branch`). This caused merge gate failures and incorrect state checks.

**Solution:** Separate status from lifecycle:
- `status` — formal state machine only (`TICKET_STATES`). Validated in `handleStatusUpdate` — invalid values rejected with a log warning.
- `agent_message` — free-form lifecycle text. Updated via `/heartbeat` endpoint.
- `last_heartbeat` — timestamp of last heartbeat. Also updated via `/heartbeat`.
- Auto-transition: first heartbeat moves ticket from `spawning → active` automatically.

### Terminal State Protection

**Problem:** After an agent finishes (PR merged, ticket closed), webhook events could spawn a new agent for the same ticket.

**Solution:** Mark agents as inactive when they reach terminal states:
- `agent_active` column tracks whether an agent should receive events
- Set to `0` when status is `merged`, `closed`, `deferred`, or `failed`
- `routeToAgent()` checks this before spawning

**Implementation:**

```typescript
// api/src/orchestrator.ts
private async handleStatusUpdate(request: Request) {
  // ...
  const terminalStates = ["merged", "closed", "deferred", "failed"];
  if (status && terminalStates.includes(status)) {
    updates.push("agent_active = 0");
    console.log(`[Orchestrator] Marking agent inactive for terminal state: ${status}`);
  }
  // ...
}

private async routeToAgent(event: TicketEvent) {
  const ticket = this.ctx.storage.sql.exec(
    "SELECT agent_active, status FROM tickets WHERE id = ?",
    event.ticketId,
  ).toArray()[0];

  if (ticket && ticket.agent_active === 0) {
    console.log(`[Orchestrator] Skipping inactive agent for ${event.ticketId}`);
    return; // Don't spawn or route to this agent
  }
  // ...
}
```

**Result:** Once a ticket is done, webhook events (PR merged, Linear status changes) don't restart the agent.

### Linear Webhook Protection

**Problem:** Moving a Linear ticket to "Done" or "Canceled" should not spawn an agent.

**Solution:** Webhook handler checks for terminal states before forwarding (on both `create` and `update` actions):

```typescript
// api/src/webhooks.ts
const TERMINAL_STATES = ["Done", "Canceled", "Cancelled"];
const stateName = payload.data.state?.name ?? "";
const isTerminal = TERMINAL_STATES.includes(stateName);

const shouldTrigger =
  !isTerminal && (
    payload.action === "create" ||
    (payload.action === "update" && isAssignedToAgent)
  );

if (!shouldTrigger) {
  const reason = isTerminal
    ? `issue in terminal state: ${stateName}`
    : "action not relevant";
  return c.json({ ok: true, ignored: true, reason });
}
```

**Result:** Completed tickets don't trigger agent spawning. Terminal state check applies to both new and updated issues.

## Deployment Process

### Deploy

```bash
cd api
wrangler deploy
```

This:
- Updates Worker code instantly
- Builds new container images (orchestrator + agent)
- Brief Orchestrator container restart (1-2s Slack reconnect)
- Running TicketAgent containers may be gradually replaced

**Impact:** Active agents auto-resume mid-task by checking out their git branch and starting a new session with full git context.

### Observe

```bash
wrangler tail --name product-engineer
```

Watch for:
- `[Orchestrator] Container stopped` — Orchestrator restarting
- `[Orchestrator] Container started successfully` — Reconnected
- `[Agent] Auto-resuming from branch: ...` — Agent recovered from deploy
- `[Agent] auto_resume` — Successful branch-based resume
- `[Agent] heartbeat` — Active agents continuing work
- `[Orchestrator] Marking agent inactive` — Agents finishing work

### Step 3: Verify

```bash
# Check that the Orchestrator restarted successfully
curl https://product-engineer.<subdomain>.workers.dev/health

# List active tickets
curl -H "X-API-Key: YOUR_KEY" \
  https://product-engineer.<subdomain>.workers.dev/api/orchestrator/tickets

# Check a specific agent's status
curl -H "X-API-Key: YOUR_KEY" \
  https://product-engineer.<subdomain>.workers.dev/api/agent/LIN-123/status
```

## What Happens During Deployment

| Component | On Deploy | Recovery Time |
|-----------|-----------|---------------|
| **Worker** | Updates instantly | Immediate |
| **Orchestrator DO** | Continues (no reset) | N/A |
| **Orchestrator Container** | Stops and restarts | 1-2 seconds |
| **TicketAgent DOs** | Continue (no reset) | N/A |
| **TicketAgent Containers** | Gradual replacement, auto-resume from git branch | 10-15 seconds |

## Secrets Configuration

All secrets are set once on the single worker:

```bash
cd api
wrangler secret put WORKER_URL             # Deployed Worker URL (e.g., https://product-engineer.your-subdomain.workers.dev)
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put LINEAR_API_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put API_KEY
wrangler secret put SENTRY_DSN
# Product-specific secrets (e.g., GITHUB_TOKEN_PRODUCT_A)
```

## FAQ

### What if a ticket agent is mid-commit when I deploy?

Agent container may restart. On restart, the agent clones the repo, checks out the existing work branch, and starts a new session with git context (log, status, PR info). Any uncommitted changes are lost, but since agents commit and push frequently, the gap is minimal — the new session picks up from the latest pushed commit.

### What if someone @mentions the bot during deployment?

- If the Orchestrator is restarting: the Worker queues the event, Orchestrator processes it after restart (1-2 seconds)
- If the Orchestrator is running: event is processed immediately

### What if a webhook arrives during Orchestrator restart?

The Worker accepts the webhook, forwards it to the Orchestrator DO. If the container is restarting, the request waits for `ensureContainerRunning()` to finish, then processes normally.

### How do I force a container to use new code?

Deploy the worker: `cd api && wrangler deploy`. Cloudflare gradually replaces TicketAgent containers. The Orchestrator container restarts on next request.

### Can I deploy during a critical operation?

**Yes.** TicketAgent containers may restart, but agents auto-resume from their git branch with full context (git log, status, PR state).

### How do I know agents finished their work?

Check the tickets table:

```bash
curl -H "X-API-Key: YOUR_KEY" \
  https://product-engineer.<subdomain>.workers.dev/api/orchestrator/tickets \
  | jq '.tickets[] | {id, status, agent_active, updated_at}'
```

Tickets with `agent_active: 0` have finished.

### What if R2 is unavailable?

R2 is only used for transcript backup, not session persistence. If R2 is down, agents continue working normally — session resume uses git branches, not R2. Transcript uploads will fail silently and can be retried later.

## Testing Deployment Safety

### Manual Test: Orchestrator Deploy During Active Work

1. Create a test ticket in Linear (e.g., "Create a hello world file")
2. Watch the agent start work in Slack
3. While the agent is working, run `cd api && wrangler deploy`
4. Observe that the agent continues without interruption
5. Verify the agent completes the PR and reports success

### Manual Test: TicketAgent Deploy with Git-Branch Resume

1. Create a test ticket
2. Wait for the agent to start work and push at least one commit
3. Deploy: `cd api && wrangler deploy`
4. In `wrangler tail --name product-engineer`, look for `[Agent] Auto-resuming from branch: ...`
5. Verify the agent continues working on the same branch with context preserved
6. Check for `phoneHome("auto_resume")` in logs

### Manual Test: Terminal State Protection

1. Create a test ticket
2. Let the agent complete it (PR merged, status = "merged")
3. In Linear, move the ticket to "Done"
4. Verify in `wrangler tail` that no new agent spawns
5. Verify the Orchestrator logs: `Skipping inactive agent for LIN-123`

### Automated Tests

The deployment safety logic is tested via:
- `api/src/orchestrator.test.ts` — unit tests for `buildTicketEvent`, `resolveProductFromChannel`
- `api/src/linear-webhook.test.ts` — webhook handling including terminal state filtering (Done, Canceled, Cancelled), agent assignment triggers, and unknown project rejection
- `api/src/ticket-agent.test.ts` — `resolveAgentEnvVars` includes required env vars
- Manual smoke tests (above)

Full integration tests require a deployed Cloudflare environment and are beyond the scope of the test suite.

## Troubleshooting

### Agent stuck after deploy

**Symptom:** Agent stops responding after a deploy, no `auto_resume` in logs.

**Cause:** Auto-resume failed — likely a git clone or branch checkout error.

**Fix:**
1. Check container logs for errors: `wrangler tail --name product-engineer`
2. Look for `[Agent] Auto-resume failed:` messages
3. Verify the work branch exists on the remote: `git ls-remote --heads origin ticket/<id>` or `feedback/<id>`
4. Verify GitHub token is valid: check the product's `GITHUB_TOKEN_*` secret

### Secrets missing

**Symptom:** Agents fail to authenticate.

**Cause:** Secrets not set on the worker.

**Fix:** Run `cd api && wrangler secret list` to check, then `wrangler secret put <NAME>` for any missing secrets.
