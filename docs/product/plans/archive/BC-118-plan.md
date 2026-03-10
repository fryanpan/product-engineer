# BC-118: Fix Agent Container Cleanup

## Problem

20 agent containers were running on March 6th, many appearing stalled. Containers should exit when work completes, but they were staying alive for the full 2-hour `sleepAfter` timeout.

## Root Causes

### 1. Agent never exits when session completes ✓ FIXED
**Location:** `agent/src/server.ts:576-582`

When `sessionStatus = "completed"`, the agent reports completion and token usage, but never calls `process.exit(0)`. The container sits idle responding to health checks until the 2h timeout naturally expires.

**Fix:** Added `process.exit(0)` in completion and error paths (commit c6c0531).

### 2. Infinite message queue loop - NEW ROOT CAUSE ✓ FIXED
**Location:** `agent/src/server.ts:333-342`

The message generator uses `while (true)` and never exits naturally. When agents wait for Slack replies, the `for await (const message of session)` loop continues indefinitely, so `process.exit()` is never reached.

**Fix:** Added session timeout watchdog (2h hard limit, 30m idle timeout).

### 3. sleepAfter isn't a hard stop
The Container SDK's `sleepAfter` marks containers as "sleep eligible" after the timeout, but doesn't forcefully stop them. It's designed for idle containers, not ones with active HTTP servers responding to health checks. Reduced from 2h to 15m as a reasonable safety net now that we have explicit exits.

## Solution

### Part 1: Exit agent container on completion ✓ DONE
**File:** `agent/src/server.ts`

Added `process.exit(0)` when session completes successfully:
```typescript
// After reporting token usage
console.log("[Agent] Exiting container after successful completion");
clearInterval(heartbeatInterval);
clearInterval(transcriptBackupInterval);
clearInterval(timeoutWatchdog);
process.exit(0);
```

### Part 2: Session timeout watchdog ✓ DONE
**File:** `agent/src/server.ts`

Added timeout watchdog that checks every minute:
- **Hard timeout:** 2 hours wall-clock time - exits unconditionally
- **Idle timeout:** 30 minutes without SDK messages AND status != "running"

This ensures containers exit even when:
- Agent is waiting indefinitely for Slack replies
- Session is stuck in some non-running state
- Message queue loop never completes naturally

```typescript
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const timeoutWatchdog = setInterval(() => {
  const sessionDuration = Date.now() - sessionStartTime;
  const idleDuration = Date.now() - lastMessageTime;

  if (sessionDuration > SESSION_TIMEOUT_MS) {
    // Hard timeout - always exit
    process.exit(0);
  }

  if (idleDuration > IDLE_TIMEOUT_MS && sessionStatus !== "running") {
    // Idle timeout - waiting for user input
    process.exit(0);
  }
}, 60_000);
```

## Implementation

1. �� Add `process.exit(0)` in agent server on completion (commit c6c0531)
2. ✓ Add similar exit in error path (commit c6c0531)
3. ✓ Add session timeout watchdog (this PR)
4. ✓ Add idle timeout for agents waiting on Slack replies (this PR)
5. ✓ Tests passing (agent: 26 pass, orchestrator: 46 pass)

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

- [x] Containers exit within 30 seconds of completing work (via process.exit)
- [x] Containers exit after 2 hours maximum (hard timeout)
- [x] Containers exit after 30 minutes of waiting for user input (idle timeout)
- [ ] Container count in dashboard matches active tickets in SQLite (manual verification needed)
