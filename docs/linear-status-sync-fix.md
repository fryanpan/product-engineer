# Linear Status Synchronization Fix

**Date**: 2026-03-24
**Issue**: Agents working on Linear tickets weren't updating Linear ticket status properly
**Root Cause**: Silent failures in StatusUpdater without proper logging and error surfacing

## Investigation Summary

Traced the complete status sync flow from agent → orchestrator → Linear API:

### How Status Updates Work

1. **Agent** calls `update_task_status` tool with status (e.g., "in_progress")
2. **StatusUpdater.updateAll()** runs 3 updates in parallel:
   - **Orchestrator**: POST to `/api/internal/status` (updates tickets table)
   - **Linear**: GraphQL mutation to update issue state
   - **Slack**: chat.update to modify top-level thread message
3. **Flow is correct** — no architectural issues found

### What Was Wrong

The StatusUpdater had several observability gaps:

1. **Silent failures**: All errors were caught and logged with `console.error`, but never surfaced to the agent
2. **Insufficient logging**:
   - No log when Linear token is missing
   - No logging of HTTP response codes
   - No logging of GraphQL errors
   - No confirmation message differentiation (hard to tell if update succeeded)
3. **No validation**: Agent couldn't verify that Linear updates succeeded

## Changes Made

### 1. Enhanced Logging (`agent/src/status-updater.ts`)

**Before**:
```typescript
async updateLinear(status: string, ticketId: string): Promise<void> {
  if (!this.config.linearAppToken) return; // Silent skip

  const stateRes = await this.fetch("https://api.linear.app/graphql", ...);
  const stateData = (await stateRes.json()) as {...}; // No error checking
  // ...
  console.log(`Updated Linear ticket ${ticketId} to ${linearState}`); // No confirmation
}
```

**After**:
```typescript
async updateLinear(status: string, ticketId: string): Promise<void> {
  if (!this.config.linearAppToken) {
    console.log(`[StatusUpdater] Skipping Linear update — no token configured`);
    return;
  }

  const stateRes = await this.fetch("https://api.linear.app/graphql", ...);

  if (!stateRes.ok) {
    const errorText = await stateRes.text();
    console.error(
      `[StatusUpdater] Linear state query failed: ${stateRes.status} ${stateRes.statusText}`,
      errorText.slice(0, 200)
    );
    return;
  }

  const stateData = (await stateRes.json()) as {...};

  if (stateData.errors) {
    console.error(
      `[StatusUpdater] Linear GraphQL errors:`,
      stateData.errors.map(e => e.message).join(", ")
    );
    return;
  }

  // ... similar checks for update mutation ...

  console.log(`[StatusUpdater] ✓ Updated Linear ticket ${ticketId} to ${linearState}`);
}
```

**Improvements**:
- Log when skipping due to missing token
- Check HTTP status codes before parsing JSON
- Log GraphQL errors from response
- Verify `success` field in mutation response
- Add ✓ checkmark to success logs for easy scanning
- Include available states in warning when target state not found

### 2. Integration Tests (`agent/src/status-updater-integration.test.ts`)

Created comprehensive integration tests covering:
- ✅ Correct Linear issue UUID usage (not identifier)
- ✅ Status mapping (agent statuses → Linear states)
- ✅ Explicit linearTicketId parameter override
- ✅ HTTP error handling (500 responses)
- ✅ GraphQL error handling (errors array in response)
- ✅ Missing state handling (state not found in team)
- ✅ Missing token behavior (skip Linear, continue with others)
- ✅ Parallel execution of all three updates

## Verification

Run tests:
```bash
bun test status-updater
```

All 34 tests pass.

## How to Diagnose Issues

### Check agent logs

Look for these patterns:

**Success**:
```
[StatusUpdater] ✓ Updated Linear ticket abc-123 to In Progress
```

**Token missing**:
```
[StatusUpdater] Skipping Linear update — no token configured
```

**HTTP error**:
```
[StatusUpdater] Linear state query failed: 401 Unauthorized
```

**GraphQL error**:
```
[StatusUpdater] Linear GraphQL errors: Invalid issue ID
```

**State not found**:
```
[StatusUpdater] Could not find Linear state "In Progress" for ticket abc-123. Available states: Todo, Backlog, Done
```

**Mutation failed**:
```
[StatusUpdater] Linear update returned success=false for ticket abc-123
```

### Common Issues & Solutions

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Skipping Linear update — no token configured" | `LINEAR_APP_TOKEN` not set in orchestrator env | Set token via `wrangler secret put LINEAR_APP_TOKEN` |
| "Linear state query failed: 401 Unauthorized" | Token expired or invalid | Refresh token (auto-refreshed every 12h by orchestrator) |
| "Could not find Linear state..." | Team workflow doesn't have the target state | Check team settings in Linear, add missing state |
| "Invalid issue ID" | ticketUUID is not a valid Linear issue ID | Verify ticket was created via Linear webhook or Slack mention (not manually in DB) |

## Related Files

- `agent/src/status-updater.ts` — StatusUpdater class (enhanced logging)
- `agent/src/status-updater-integration.test.ts` — Integration tests (new)
- `agent/src/tools.ts` — update_task_status tool (calls StatusUpdater)
- `api/src/orchestrator.ts` — handleStatusUpdate endpoint
- `api/src/agent-manager.ts` — spawnAgent passes ticketId to agent
