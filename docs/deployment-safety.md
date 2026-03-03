# Deployment Safety

This document describes how Product Engineer handles deployments without disrupting in-progress work.

## Goals

1. Deploy updates many times per day
2. Never lose in-progress work
3. Allow ticket agents to complete their work naturally
4. No manual intervention required during deployment

## How It Works

### TicketAgent Containers (4-day lifetime)

**Problem:** When you deploy, container images update, but running containers keep using old code.

**Solution:** TicketAgent containers are long-lived (96 hours) and naturally complete their work:
- When a ticket agent is working, it runs until the PR is merged and the agent reports completion
- After reporting a terminal state (`merged`, `closed`, `failed`, `deferred`), the agent stops accepting new events
- The container sleeps after 96 hours of inactivity, at which point it's naturally cleaned up

**Implementation:**
```typescript
// orchestrator/src/ticket-agent.ts
export class TicketAgent extends Container<Bindings> {
  sleepAfter = "96h"; // 4 days - plenty of time for any ticket
  // ...
}
```

**Result:** Deploying new code doesn't kill running agents. They finish their work on the old code, then naturally shut down.

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

### Step 1: Deploy
```bash
cd orchestrator
wrangler deploy
```

This:
- Updates Worker code instantly
- Builds new container images (orchestrator + agent)
- Does NOT restart running containers

### Step 2: Observe
```bash
wrangler tail
```

Watch for:
- `[Orchestrator] Container stopped` — Orchestrator restarting
- `[Orchestrator] Container started successfully` — Reconnected
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

| Component | Behavior | Impact | Recovery Time |
|-----------|----------|--------|---------------|
| **Worker** | Updates instantly | None — stateless | Immediate |
| **Orchestrator DO** | Continues running old code until next invocation | None — restarts on next request | 1-2 seconds |
| **Orchestrator Container** | Stops when DO restarts | Slack disconnects briefly | 1-2 seconds |
| **TicketAgent DOs** | Continue running old code | None — complete work naturally | Until ticket done (hours) |
| **TicketAgent Containers** | Keep running old code for up to 96h | None — finish current work | Until ticket done (hours) |

## FAQ

### What if a ticket agent is mid-commit when I deploy?

The agent keeps running. Deployment doesn't interrupt running containers. The agent finishes the commit, pushes the PR, and marks the ticket as complete.

### What if someone @mentions the bot during deployment?

- If the Orchestrator is restarting: the Worker queues the event, Orchestrator processes it after restart (1-2 seconds)
- If the Orchestrator is running: event is processed immediately

### What if a webhook arrives during Orchestrator restart?

The Worker accepts the webhook, forwards it to the Orchestrator DO. If the container is restarting, the request waits for `ensureContainerRunning()` to finish, then processes normally.

### How do I force a container to use new code?

For TicketAgent containers, wait for the ticket to complete naturally. The agent will report a terminal state and stop accepting events.

If you need to force it (debugging only):
1. The agent will naturally shut down after 96 hours of inactivity
2. Or, the agent completes its work and stops accepting events when it reaches a terminal state

For the Orchestrator container:
- It restarts automatically on the next request after deployment

### Can I deploy during a critical operation?

Yes. Deployments don't interrupt running agents. If an agent is mid-PR-creation, it continues on the old code until done.

### How do I know agents finished their work?

Check the tickets table:
```bash
curl -H "X-API-Key: YOUR_KEY" \
  https://product-engineer.<subdomain>.workers.dev/api/orchestrator/tickets \
  | jq '.tickets[] | {id, status, agent_active, updated_at}'
```

Tickets with `agent_active: 0` have finished.

## Testing Deployment Safety

### Manual Test: Deploy During Active Work

1. Create a test ticket in Linear (e.g., "Create a hello world file")
2. Watch the agent start work in Slack
3. While the agent is working, run `wrangler deploy`
4. Observe that the agent continues without interruption
5. Verify the agent completes the PR and reports success

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
- Manual smoke tests (above)

Full integration tests require a deployed Cloudflare environment and are beyond the scope of the test suite.
