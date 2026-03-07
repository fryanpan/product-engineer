# Status Command

## Overview

The `/pe-status` command provides real-time visibility into the Product Engineer system, showing which agents are active, their health status, and recent completions.

## Usage

In any Slack channel where Product Engineer is active, mention the bot with:

```
@product-engineer /pe-status
```

## Response Format

The command returns a formatted status message with:

### Summary
- **Active agents**: Current count of running agents
- **Completed (24h)**: Tickets completed in the last 24 hours
- **Stale agents**: Agents with no heartbeat in >30 minutes (if any)

### Active Agents
For each active agent:
- **Health indicator**:
  - 💚 Fresh (<5 min since last heartbeat)
  - 💛 Recent (5-15 min)
  - 🧡 Getting stale (15-30 min)
  - ❤️ Stale (>30 min)
- **Status emoji**: ⏳ in_progress, 👀 pr_open/in_review, ✅ merged/closed, etc.
- **Ticket ID** and **product**
- **Current status** and **time since last update**
- **PR URL** (if available)
- **Slack thread link** (if available)

### Stale Agents Warning
If any agents haven't sent a heartbeat in >30 minutes, they're listed with:
- Ticket ID
- Product
- Minutes since last heartbeat

### Recent Completions
Last 5 completed tickets from the past 24 hours, showing:
- Ticket ID
- Product
- Time since completion
- PR URL (if available)

## Implementation

### Architecture

1. **Slack Socket Mode** (`containers/orchestrator/slack-socket.ts`)
   - Detects `/pe-status` in message text
   - Adds `slash_command: "pe-status"` field to event
   - Forwards to Orchestrator DO

2. **Orchestrator DO** (`orchestrator/src/orchestrator.ts`)
   - `handleSlackEvent()`: Routes slash commands
   - `getSystemStatus()`: Queries SQLite for agent data
   - `handleStatusCommand()`: Formats and posts Slack response

### Data Sources

All data comes from the `tickets` table in Orchestrator DO's SQLite database:

- **Active agents**: `agent_active = 1`
- **Health**: `last_heartbeat` timestamp (agents send heartbeat every 2 minutes)
- **Status**: Current workflow state (`in_progress`, `pr_open`, etc.)
- **Recent completions**: `agent_active = 0` + last 24 hours

### Health Indicators

Agents send heartbeats every 2 minutes while active. Health is calculated based on time since last heartbeat:

| Time Range | Emoji | Meaning |
|------------|-------|---------|
| <5 min | 💚 | Fresh - agent is actively working |
| 5-15 min | 💛 | Recent - agent may be idle or between turns |
| 15-30 min | 🧡 | Getting stale - agent may be stuck |
| >30 min | ❤��� | Stale - agent likely needs investigation |

Stale agents (>30 min) are also listed separately with a warning.

## Testing

Run tests:

```bash
cd orchestrator
bun test src/status-command.test.ts
```

Test in Slack:
1. Post `@product-engineer /pe-status` in a Product Engineer channel
2. Verify the response shows current agent status
3. Check that health indicators update as heartbeats arrive

## Related Files

- `containers/orchestrator/slack-socket.ts` - Slash command detection
- `orchestrator/src/orchestrator.ts` - Status query and response formatting
- `orchestrator/src/status-command.test.ts` - Unit tests
- `agent/src/server.ts` - Heartbeat sending (line 247-265)
