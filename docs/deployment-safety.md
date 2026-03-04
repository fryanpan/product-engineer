# Deployment Safety

This document describes how Product Engineer handles deployments without disrupting in-progress work.

## Goals

1. Deploy updates many times per day
2. Never lose in-progress work
3. Allow ticket agents to complete their work naturally
4. No manual intervention required during deployment

## Architecture: Split Workers

To achieve zero-downtime deploys, Product Engineer uses **two separate workers**:

1. **Orchestrator Worker** (`orchestrator/`) — Worker entry point, Orchestrator DO, cron triggers, R2 bindings
2. **TicketAgent Worker** (`ticket-agent/`) — TicketAgent DO class only

The orchestrator references the ticket-agent worker via `script_name`:

```toml
# orchestrator/wrangler.toml
[durable_objects]
bindings = [
  { name = "ORCHESTRATOR", class_name = "Orchestrator" },
  { name = "TICKET_AGENT", class_name = "TicketAgent", script_name = "ticket-agent-worker" }
]
```

**Why this matters:**

- Deploying `orchestrator` worker doesn't reset TicketAgent DOs or containers
- Orchestrator updates (frequent — code changes, bug fixes) don't interrupt running agents
- TicketAgent updates (infrequent — container image changes) use gradual rollout

## How It Works

### TicketAgent Containers (4-day lifetime, R2 session persistence)

**Problem:** When you deploy the ticket-agent worker, container images update, and Cloudflare may replace running containers.

**Solution:** Agent SDK sessions persist to R2 via FUSE mount, enabling seamless resume:

- R2 bucket `product-engineer-sessions` is mounted at `~/.claude/projects/` in each container
- Agent SDK writes session files to this mount (conversation history, state)
- When a container restarts (deploy, DO reset, etc.), the agent checks for existing session files
- If found, the agent resumes the session instead of starting fresh — conversation context preserved

**Implementation:**

```typescript
// agent/src/server.ts
async function findExistingSession(): Promise<string | null> {
  const sessionDir = `${process.env.HOME}/.claude/projects`;
  const files = await listFiles(sessionDir);
  const sessionFiles = files.filter(f => f.startsWith(config.ticketId));
  return sessionFiles.length > 0 ? sessionFiles.sort().pop()! : null;
}

async function startSession(initialPrompt: string) {
  const existingSession = await findExistingSession();
  if (existingSession) {
    console.log(`[Agent] Resuming session from: ${existingSession}`);
    phoneHome("deploy_recovery", `resuming: ${existingSession}`);
  }
  // Agent SDK loads session files from ~/.claude/projects/ automatically
  const session = query({ prompt: messages, options: { ... } });
}
```

**R2 FUSE mount** (`agent/entrypoint.sh`):

```bash
s3fs "product-engineer-sessions" "$HOME/.claude/projects" \
  -o passwd_file="$HOME/.passwd-s3fs" \
  -o url="https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  -o use_path_request_style
```

**Result:** Container replacement doesn't lose work. Agent resumes mid-task with full context.

**Important limitation:** The R2 FUSE mount only persists **Agent SDK session files** (conversation history, internal state). It does NOT persist:
- Git changes (uncommitted work, branches)
- Cloned repos
- Working directory state (`/workspace`)

**Why this works:** Agents commit and push immediately after making changes. By the time a deploy happens, code is already on GitHub. If a container restarts mid-commit, the agent resumes and re-attempts the operation. This assumption is core to the design — agents must push work immediately, not accumulate uncommitted changes.

### Orchestrator Container (always-on, restarts gracefully)

**Problem:** The Orchestrator runs a Slack Socket Mode connection that must stay alive, but deployments update the container image.

**Solution:** The Orchestrator container restarts only when needed:
- Container is marked as stopped when it exits
- On next request, `ensureContainerRunning()` starts the new container
- Slack Socket Mode reconnects automatically
- SQLite state persists across restarts (tickets, status, thread_ts)

**Implementation:**

```typescript
// orchestrator/src/orchestrator.ts
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

### Terminal State Protection

**Problem:** After an agent finishes (PR merged, ticket closed), webhook events could spawn a new agent for the same ticket.

**Solution:** Mark agents as inactive when they reach terminal states:
- `agent_active` column tracks whether an agent should receive events
- Set to `0` when status is `merged`, `closed`, `deferred`, or `failed`
- `routeToAgent()` checks this before spawning

**Implementation:**

```typescript
// orchestrator/src/orchestrator.ts
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
// orchestrator/src/webhooks.ts
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

### Orchestrator Deploy (frequent — code changes, bug fixes)

```bash
cd orchestrator
wrangler deploy
```

This:
- Updates Worker code instantly
- Builds new orchestrator container image
- **Does NOT** touch TicketAgent DOs or containers
- Brief Orchestrator container restart (1-2s Slack reconnect)

**Impact:** Active agents continue work uninterrupted.

### TicketAgent Deploy (infrequent — container image changes)

```bash
cd ticket-agent
wrangler versions upload    # Upload new version
wrangler versions deploy    # Gradual rollout (10% → 100%)
```

This:
- Builds new agent container image
- Cloudflare gradually replaces containers using new image
- Containers restart and resume sessions from R2

**Impact:** Agents resume mid-task with full conversation context preserved.

### Step 2: Observe

```bash
wrangler tail --name product-engineer
```

Watch for:
- `[Orchestrator] Container stopped` — Orchestrator restarting
- `[Orchestrator] Container started successfully` — Reconnected
- `[Agent] Resuming session from: ...` — Agent recovered from deploy
- `[Agent] deploy_recovery` — Successful session resume
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

| Component | Orchestrator Deploy | TicketAgent Deploy | Recovery Time |
|-----------|---------------------|-------------------|---------------|
| **Worker** | Updates instantly | No change | Immediate |
| **Orchestrator DO** | Continues (no reset) | No change | N/A |
| **Orchestrator Container** | Stops and restarts | No change | 1-2 seconds |
| **TicketAgent DOs** | No change | Continue (no reset) | N/A |
| **TicketAgent Containers** | No change | Gradual replacement, resume from R2 | 5-10 seconds per container |

## Secrets Configuration

Both workers need access to the same secrets, but they're separate workers:

**Orchestrator secrets** (set once):
```bash
cd orchestrator
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put LINEAR_API_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put API_KEY
wrangler secret put SENTRY_DSN
# Product-specific secrets (e.g., GITHUB_TOKEN_PRODUCT_A)
```

**TicketAgent secrets** (same values as orchestrator):
```bash
cd ticket-agent
wrangler secret put SLACK_BOT_TOKEN        # Same as orchestrator
wrangler secret put LINEAR_API_KEY         # Same as orchestrator
wrangler secret put ANTHROPIC_API_KEY      # Same as orchestrator
wrangler secret put API_KEY                # Same as orchestrator
wrangler secret put SENTRY_DSN             # Same as orchestrator
# Product-specific secrets (same as orchestrator)
# R2 FUSE mount secrets (new)
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put CF_ACCOUNT_ID
```

**Why duplicate secrets?** Workers don't share secrets. Each worker must have its own bindings.

## FAQ

### What if a ticket agent is mid-commit when I deploy?

**Orchestrator deploy:** Agent keeps running. No interruption.

**TicketAgent deploy:** Agent container may restart. The agent resumes the session from R2, preserving the conversation. The commit continues naturally.

### What if someone @mentions the bot during deployment?

- If the Orchestrator is restarting: the Worker queues the event, Orchestrator processes it after restart (1-2 seconds)
- If the Orchestrator is running: event is processed immediately

### What if a webhook arrives during Orchestrator restart?

The Worker accepts the webhook, forwards it to the Orchestrator DO. If the container is restarting, the request waits for `ensureContainerRunning()` to finish, then processes normally.

### How do I force a container to use new code?

**For TicketAgent:** Deploy the ticket-agent worker with `wrangler versions upload && wrangler versions deploy`. Cloudflare gradually replaces containers.

**For Orchestrator:** Deploy the orchestrator worker. The container restarts on next request.

### Can I deploy during a critical operation?

**Yes.** Orchestrator deploys don't interrupt agents. TicketAgent deploys may restart containers, but agents resume from R2 with full context preserved.

### How do I know agents finished their work?

Check the tickets table:

```bash
curl -H "X-API-Key: YOUR_KEY" \
  https://product-engineer.<subdomain>.workers.dev/api/orchestrator/tickets \
  | jq '.tickets[] | {id, status, agent_active, updated_at}'
```

Tickets with `agent_active: 0` have finished.

### What if R2 mount fails?

The entrypoint script logs the failure and starts the agent server anyway. Session resume won't work, but the agent can still complete the ticket (starting fresh). The agent logs `R2 credentials not provided — session persistence disabled`.

Check `wrangler tail` for mount errors.

## Testing Deployment Safety

### Manual Test: Orchestrator Deploy During Active Work

1. Create a test ticket in Linear (e.g., "Create a hello world file")
2. Watch the agent start work in Slack
3. While the agent is working, run `cd orchestrator && wrangler deploy`
4. Observe that the agent continues without interruption
5. Verify the agent completes the PR and reports success

### Manual Test: TicketAgent Deploy with Session Resume

1. Create a test ticket
2. Wait for the agent to start work and produce a few messages
3. Deploy the ticket-agent worker: `cd ticket-agent && wrangler versions upload && wrangler versions deploy`
4. In `wrangler tail --name ticket-agent-worker`, look for `[Agent] Resuming session from: ...`
5. Verify the agent continues the conversation with context preserved
6. Check for `phoneHome("deploy_recovery")` in logs

### Manual Test: R2 FUSE Mount Verification

1. Deploy with R2 secrets configured
2. SSH into a running container (if possible) or check logs
3. Look for `[Entrypoint] R2 bucket mounted at ~/.claude/projects`
4. Agent logs should show session files being found: `[Agent] Found existing session file: ...`

### Manual Test: Terminal State Protection

1. Create a test ticket
2. Let the agent complete it (PR merged, status = "merged")
3. In Linear, move the ticket to "Done"
4. Verify in `wrangler tail` that no new agent spawns
5. Verify the Orchestrator logs: `Skipping inactive agent for LIN-123`

### Automated Tests

The deployment safety logic is tested via:
- `orchestrator/src/orchestrator.test.ts` — unit tests for `buildTicketEvent`, `resolveProductFromChannel`
- `orchestrator/src/linear-webhook.test.ts` — webhook handling including terminal state filtering (Done, Canceled, Cancelled), agent assignment triggers, and unknown project rejection
- `orchestrator/src/ticket-agent.test.ts` — `resolveAgentEnvVars` includes R2 credentials
- Manual smoke tests (above)

Full integration tests require a deployed Cloudflare environment and are beyond the scope of the test suite.

## Troubleshooting

### Agent stuck after deploy

**Symptom:** Agent stops responding after a deploy, no `deploy_recovery` in logs.

**Cause:** R2 mount failed or session files not found.

**Fix:**
1. Check R2 secrets are set: `wrangler secret list --name ticket-agent-worker`
2. Check container logs for mount errors: `wrangler tail --name ticket-agent-worker`
3. Verify R2 bucket exists: `wrangler r2 bucket list`

### Container fails to start after adding FUSE

**Symptom:** Container exits immediately, logs show FUSE errors.

**Cause:** FUSE requires elevated privileges. Cloudflare Containers may not support FUSE.

**Fallback:** If FUSE doesn't work in production, remove R2 mount from entrypoint.sh. Agents will start fresh after deploys (no session resume), but will still complete tickets.

### Secrets out of sync between workers

**Symptom:** Agents fail to authenticate after split workers change.

**Cause:** Secrets set in orchestrator but not in ticket-agent worker.

**Fix:** Run the same `wrangler secret put` commands in both `orchestrator/` and `ticket-agent/` directories.
