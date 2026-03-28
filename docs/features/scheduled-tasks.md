# Scheduled Tasks

## Overview

The Product Engineer supports scheduling tasks to execute at a specific time in the future. When a Linear issue is assigned to the bot with a scheduled time in its description, the task will be queued and automatically spawned when the scheduled time arrives.

## How It Works

### 1. Creating a Scheduled Task

Add a schedule directive to the Linear issue description using one of these formats:

```
Scheduled for: 2024-03-28 14:30
```

or

```
Schedule: 2024-03-28 14:30
```

Supported formats:
- `YYYY-MM-DD HH:MM` - Interpreted as UTC
- `YYYY-MM-DD HH:MM:SS` - With seconds, interpreted as UTC
- `YYYY-MM-DDTHH:MM:SSZ` - ISO8601 format with explicit timezone
- `YYYY-MM-DD` - Date only (will execute at midnight UTC)

**Case-insensitive:** Both "Scheduled for:" and "SCHEDULED FOR:" work.

### 2. Task Lifecycle

When a Linear issue with a schedule is assigned to the bot:

1. **Webhook received** - Linear webhook triggers task creation
2. **Schedule parsed** - The `scheduled_for` timestamp is extracted from the description
3. **Task queued** - Task transitions to `queued` status (not spawned yet)
4. **Supervisor tick** - Every 5 minutes, the conductor checks for tasks ready to spawn
5. **Task spawned** - When `scheduled_for <= now`, task transitions to `reviewing` → `spawning` → `active`

### 3. Database Schema

The `tasks` table includes a `scheduled_for` column (TEXT, ISO8601 timestamp):

```sql
ALTER TABLE tasks ADD COLUMN scheduled_for TEXT;
```

### 4. State Machine

Scheduled tasks use the `queued` status:

- **created** → **queued** (if `scheduled_for` is in the future)
- **queued** → **reviewing** (when scheduled time arrives, via supervisor)
- **reviewing** → **spawning** → **active** (normal spawn flow)

## Implementation Details

### Components Modified

1. **`api/src/db.ts`**
   - Added `scheduled_for` column migration

2. **`api/src/types.ts`**
   - Added `scheduled_for: string | null` to `TaskRecord`

3. **`api/src/task-manager.ts`**
   - Added `scheduledFor` param to `CreateTaskParams`
   - Added `scheduled_for` to `StatusUpdate`
   - Added `getScheduledTasksReadyToSpawn()` method
   - Added `isScheduledForFuture()` helper

4. **`api/src/webhooks.ts`**
   - Added `extractScheduledFor()` function to parse schedule from Linear description
   - Linear webhook now extracts and forwards `scheduledFor` in payload

5. **`api/src/conductor.ts`**
   - `handleEvent()` passes `scheduledFor` to task creation
   - `handleTaskReview()` checks if task is scheduled for future → transitions to `queued`
   - `runSupervisorTick()` spawns tasks when `scheduled_for <= now`

### Supervisor Behavior

The conductor's alarm fires every 5 minutes (`conductor.ts:116`) and runs `runSupervisorTick()`, which now:

1. Detects stale agents (existing behavior)
2. Detects ghost agents (existing behavior)
3. **NEW:** Checks for scheduled tasks ready to spawn via `getScheduledTasksReadyToSpawn()`
4. **NEW:** For each ready task, transitions `queued` → `reviewing` and spawns the agent

**Timing precision:** Tasks will spawn within 5 minutes of their scheduled time (not real-time, but sufficient for most use cases).

## Testing

### Unit Tests

- `extract-schedule.test.ts` - Tests schedule extraction from Linear descriptions
- `scheduled-tasks-integration.test.ts` - Tests TaskManager methods for scheduled tasks

### Manual Testing

1. Create a Linear issue in the configured team
2. Assign it to the Product Engineer bot
3. Add to description: `Scheduled for: 2024-03-28 14:30`
4. Verify task is created with `status='queued'`
5. Wait for supervisor tick (or manually trigger alarm)
6. Verify task transitions to `reviewing` → `spawning` → `active` when time arrives

## Future Enhancements

- **Canceling scheduled tasks** - Allow updating `scheduled_for` to null or deleting the task before it spawns
- **Recurring schedules** - Support cron-like syntax for periodic tasks
- **Timezone support** - Parse timezone from schedule string instead of assuming UTC
- **Notification** - Post a Slack message when a task is scheduled (confirmation)
- **Precision improvement** - Use Durable Object alarms per task instead of polling every 5 minutes
