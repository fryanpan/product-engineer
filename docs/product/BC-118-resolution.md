# BC-118: Agent Container Cleanup - Complete Resolution

## Problem Statement

**March 6, 22:44 PT:** 20 agent containers running, many stalled.
**March 7, 07:46 PT:** 13 agents still stuck after multiple fixes deployed.

Containers were not terminating when their work completed, causing resource waste and accumulation.

## Root Causes (Multiple)

### 1. Session Completion (PR #55)
Agents never called `process.exit(0)` when work completed. The Agent SDK session would finish, but the container process kept running.

**Fix:** Added `process.exit(0)` after session completion.

### 2. Waiting for User Input (PR #58)
Agents waiting for Slack replies would loop indefinitely in the message generator (`while (true)` pattern), never reaching the exit call.

**Fix:** Added session timeout watchdog:
- Hard timeout: 2 hours (exits unconditionally)
- Idle timeout: 30 minutes without messages AND status != "running"

### 3. Terminal State Transition (PR #61)
When tickets reached terminal states (merged/closed/deferred/failed), the DB was updated but the container kept running until natural timeout.

**Fix:** Added `/shutdown` endpoint to agent server that:
- Uploads transcripts
- Reports token usage
- Calls `process.exit(0)`

Updated `/mark-terminal` handler to call container's `/shutdown` endpoint.

### 4. Pre-Existing Stuck Agents (PR #63)
Fixes #1-3 prevented NEW stuck agents, but the 13 agents that became terminal BEFORE the fixes were deployed remained running.

**Fix:** Added `/cleanup-inactive` endpoint to Orchestrator that:
- Queries all tickets with `agent_active = 0`
- Calls `/mark-terminal` on each TicketAgent DO
- Forces shutdown of orphaned containers

### 5. Missing Worker Route (This PR #64)
The cleanup endpoint existed in the Orchestrator DO but wasn't exposed through the worker, making it unreachable via HTTP.

**Fix:** Added worker routes:
- `POST /api/orchestrator/cleanup-inactive` - Force shutdown all inactive agents
- `GET /api/orchestrator/status` - View active/stale/completed agents

## Complete Timeline

| Date/Time | Event | Action Taken |
|-----------|-------|--------------|
| March 6, 22:44 PT | 20 containers running (screenshot) | Investigation started |
| PR #55 | Session never exits | Added `process.exit(0)` on completion |
| PR #58 | Message loop never completes | Added 2h hard / 30m idle timeout watchdog |
| PR #61 | Terminal state doesn't stop container | Added `/shutdown` endpoint, `/mark-terminal` invokes it |
| March 7, 07:46 PT | 13 containers STILL running (screenshot) | Realized fix was forward-looking only |
| PR #63 | Need retroactive cleanup | Added `/cleanup-inactive` endpoint to DO |
| PR #64 | Cleanup endpoint unreachable | Added missing worker routes |

## Solution Architecture

### Forward-Looking Prevention
1. **Session Completion:** `process.exit(0)` after SDK session ends
2. **Timeout Watchdog:** Force exit after 2h or 30m idle
3. **Terminal State:** `/shutdown` endpoint called on terminal transition

### Retroactive Cleanup
4. **Cleanup Endpoint:** Force shutdown all inactive agents on demand

### External Access
5. **Worker Routes:** Expose cleanup and status via authenticated HTTP endpoints

## Usage

### Check System Status
```bash
curl https://product-engineer.<subdomain>.workers.dev/api/orchestrator/status \
  -H "X-API-Key: <key>"
```

Returns:
- Active agents (with health indicators)
- Stale agents (no heartbeat >30min)
- Recent completions (last 24h)

### Force Cleanup of Stuck Agents
```bash
curl -X POST https://product-engineer.<subdomain>.workers.dev/api/orchestrator/cleanup-inactive \
  -H "X-API-Key: <key>"
```

Returns:
- Total inactive tickets found
- Successful shutdown count
- Per-ticket results (success/error)

## Key Learnings

### 1. Lifecycle Fixes Need Both Forward and Retroactive Cleanup
When fixing a lifecycle bug:
- **Forward-looking:** Prevent the problem from happening again (PRs #55, #58, #61)
- **Retroactive:** Clean up existing broken instances (PR #63)
- **Verification:** Test both in production before closing

### 2. DO Endpoints Need Worker Routes
Every Orchestrator DO endpoint needs TWO registrations:
- **Internal:** Route in Orchestrator's `fetch()` switch statement
- **External:** Worker route in `index.ts` that proxies to the DO

Without the worker route, the endpoint exists but is unreachable.

### 3. Iterative Investigation Works
This issue required 5 separate PRs to fully resolve. Each PR addressed one aspect:
1. Session completion path
2. Infinite wait scenarios
3. Terminal state transitions
4. Pre-existing stuck instances
5. External accessibility

No single PR would have solved the entire problem. Systematic iteration and production monitoring were essential.

## Deployment Steps

1. **Merge and Deploy PRs #55, #58, #61** - Forward-looking prevention
2. **Verify:** New tickets complete and exit cleanly
3. **Merge and Deploy PRs #63, #64** - Retroactive cleanup + worker routes
4. **Run Cleanup:**
   ```bash
   curl -X POST .../api/orchestrator/cleanup-inactive -H "X-API-Key: ..."
   ```
5. **Monitor:** Check Cloudflare dashboard for container count drop
6. **Verify:** All 13 stuck agents shut down successfully
7. **Close BC-118**

## Related Documentation

- `docs/deployment-safety.md` - Container lifecycle and terminal state protection
- `docs/process/learnings.md` - Technical discoveries from this investigation
- `docs/process/retrospective.md` - Detailed retros for each PR
