# BC-118: Fix Agent Container Cleanup

## Problem

20 agent containers were running on March 6th, many appearing stalled. Containers should exit when work completes, but they stay alive for the full 2-hour `sleepAfter` timeout.

## Root Causes

### 1. Agent never exits when session completes
**Location:** `agent/src/server.ts:576-582`

When `sessionStatus = "completed"`, the agent reports completion and token usage, but never calls `process.exit(0)`. The container sits idle responding to health checks until the 2h timeout naturally expires.

### 2. TicketAgent alarm doesn't stop completed containers
**Location:** `orchestrator/src/ticket-agent.ts:139-161`

The `alarm()` override checks session status and marks terminal state in SQLite, but doesn't stop the container process. It just returns to `super.alarm()` which keeps the container alive.

### 3. sleepAfter isn't a hard stop
The Container SDK's `sleepAfter = "2h"` marks containers as "sleep eligible" after 2 hours, but doesn't forcefully stop them. It's designed for idle containers, not ones with active HTTP servers responding to health checks.

## Solution

### Part 1: Exit agent container on completion ✓
**File:** `agent/src/server.ts`

Added `process.exit(0)` when session completes successfully:
```typescript
// After reporting token usage
console.log("[Agent] Exiting container after successful completion");
clearInterval(heartbeatInterval);
clearInterval(transcriptBackupInterval);
process.exit(0);
```

### Part 2: Improve container lifecycle observability
**File:** `orchestrator/src/ticket-agent.ts`

The `alarm()` method already marks terminal state, but we should verify containers actually stop. Add logging to track:
- When containers are marked terminal
- How long containers stay alive after terminal state
- Whether `sleepAfter` is respected

## Implementation

1. ✓ Add `process.exit(0)` in agent server on completion
2. Add similar exit in error path (after transcript upload)
3. Update tests
4. Add monitoring to track container lifespans
5. Document expected behavior

## Testing

### Manual verification:
1. Create a simple test ticket (e.g., "create a hello.txt file")
2. Watch container lifecycle in `wrangler tail`
3. Verify agent exits immediately after PR creation/merge
4. Check Cloudflare dashboard - container should disappear within ~30s

### Automated tests:
- Verify `process.exit` is called on completion path
- Verify cleanup happens on error path
- Verify intervals are cleared before exit

## Success Criteria

- [ ] Containers exit within 30 seconds of completing work
- [ ] No more than 2-3 containers running at any time (one per active ticket)
- [ ] Container count in dashboard matches active tickets in SQLite
