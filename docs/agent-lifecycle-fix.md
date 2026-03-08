# BC-118: Agent Lifecycle Fix

## Problem

Agents continue running in Cloudflare even after their work is complete or they've timed out.

### Root Cause

**Database-Container State Mismatch:**

1. The `agent_active` flag in SQLite tracks whether an agent should receive new events
2. This flag was only set to `0` for terminal *statuses*: `merged`, `closed`, `deferred`, `failed`
3. But containers shut down for many other reasons:
   - Session timeout (2 hours)
   - Idle timeout (30 minutes)
   - Manual shutdown requests
   - Session errors
   - Container crashes

4. When containers exit via `process.exit(0)` in these scenarios, they phone home with lifecycle statuses like:
   - `agent:session_timeout`
   - `agent:idle_timeout`
   - `agent:container_shutdown`
   - `agent:shutdown_requested`
   - `agent:session_error`

5. These lifecycle statuses update the `status` column but don't set `agent_active = 0`

6. **Result:** Cloudflare shows containers as "Running" because the DO exists and has the container image, even though the process has exited

### Why Previous Fixes Didn't Work

- **PR #61** (5f2eee7): Added `/shutdown` endpoint to agent containers
- **PR #63** (a219bed): Added `/cleanup-inactive` endpoint to orchestrator

These fixed the shutdown *mechanism* but didn't fix the root cause: `agent_active` was never set to `0` for container lifecycle events, so the cleanup endpoint had nothing to clean up (it only processes tickets with `agent_active = 0`).

## Solution

### Part 1: Forward-Looking Fix

Update `handleStatusUpdate` in `orchestrator/src/orchestrator.ts` to mark agents as inactive when they report container shutdown states:

```typescript
const containerShutdownStates = [
  "agent:session_timeout",
  "agent:idle_timeout",
  "agent:container_shutdown",
  "agent:shutdown_requested",
  "agent:session_error"
];

if (terminalStates.includes(status) || containerShutdownStates.includes(status)) {
  updates.push("agent_active = 0");
  // Call /mark-terminal on TicketAgent DO to stop container
}
```

This ensures future container shutdowns properly mark agents as inactive.

### Part 2: Retroactive Cleanup

For existing zombie agents (containers already stopped but `agent_active = 1` in DB), we need to:

1. Identify tickets with lifecycle shutdown statuses but `agent_active = 1`
2. Set their `agent_active = 0`
3. Call `/mark-terminal` to ensure containers are stopped

## Deployment Steps

### 1. Deploy the Fix

```bash
cd orchestrator
wrangler deploy
```

### 2. Clean Up Existing Zombies

```bash
# Call the cleanup endpoint via curl
curl -X POST \
  -H "X-API-Key: YOUR_API_KEY" \
  "https://product-engineer.YOUR_SUBDOMAIN.workers.dev/api/orchestrator/cleanup-inactive"
```

This will:
- Find all tickets with `agent_active = 0`
- Call `/mark-terminal` on each TicketAgent DO
- Containers will receive `/shutdown` and exit cleanly

### 3. Verify

```bash
# Check system status
curl -H "X-API-Key: YOUR_API_KEY" \
  "https://product-engineer.YOUR_SUBDOMAIN.workers.dev/api/orchestrator/status"
```

Look for:
- `activeAgents` array should only contain truly active work
- `staleAgents` should be empty or minimal

## Expected Behavior After Fix

1. **Container completes work successfully:**
   - Reports `merged` or `closed` → `agent_active = 0` → Container stops

2. **Container times out (2 hour session timeout):**
   - Reports `agent:session_timeout` → `agent_active = 0` → Container stops

3. **Container idles (30 min no activity):**
   - Reports `agent:idle_timeout` → `agent_active = 0` → Container stops

4. **Container shutdown requested:**
   - Reports `agent:shutdown_requested` → `agent_active = 0` → Container stops

5. **Session error:**
   - Reports `agent:session_error` → `agent_active = 0` → Container stops

In all cases, the Cloudflare dashboard will show the container as "Inactive" after the process exits.

## Monitoring

After deployment, watch for:

```bash
wrangler tail --name product-engineer
```

**Good signs:**
- `[Orchestrator] Marking agent inactive for terminal/shutdown state: agent:session_timeout`
- `[TicketAgent] Container shutdown requested`
- `[Agent] phoneHome: shutdown_requested`

**Bad signs:**
- Agents with last_heartbeat > 30 minutes ago
- Many containers in "Running" state with no recent heartbeat

Use `/agent-status` Slack command to monitor:
```
@product-engineer /agent-status
```

## Files Changed

- `orchestrator/src/orchestrator.ts` (handleStatusUpdate method)
- `docs/agent-lifecycle-fix.md` (this document)
