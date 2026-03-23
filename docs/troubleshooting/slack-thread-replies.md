# Troubleshooting: Slack Thread Replies Not Working

## Problem

**Issue 1:** Agent doesn't respond to messages sent in per-ticket threads unless explicitly mentioned with `@product-engineer`.

**Issue 2:** Agent replies are posted to the main channel instead of the ticket thread.

## Expected Behavior

Once a ticket thread is created (via Linear ticket or initial @mention), subsequent messages in that thread should be queued and processed by the agent **without requiring additional @mentions**.

## Root Cause

The Slack app needs to be subscribed to the `message.channels` event to receive all channel messages (including thread replies) via Socket Mode.

## How It Works (When Configured Correctly)

1. **SlackSocket receives message** (`containers/orchestrator/slack-socket.ts:64-66`)
   - Filters for messages with `thread_ts` (thread replies)
   - Ignores bot messages and message edits

2. **Orchestrator looks up ticket** (`api/src/orchestrator.ts:258-277`)
   - Queries SQLite: `SELECT id, product FROM tickets WHERE slack_thread_ts = ?`
   - If found, routes event to TicketAgent with type `slack_reply`

3. **Agent processes message** (`agent/src/server.ts:270-272`, `agent/src/prompt.ts:120-121`)
   - Yields continuation prompt to running session
   - Processes and responds

## Diagnostic Checklist

### 1. Verify Slack App Configuration

Go to [api.slack.com/apps](https://api.slack.com/apps) → Your App:

**Event Subscriptions** → Subscribe to bot events:
- ✅ `app_mention` (enables initial ticket creation)
- ✅ `message.channels` ← **MUST BE ENABLED**

**OAuth & Permissions** → Bot Token Scopes:
- ✅ `chat:write` (allows bot to reply)
- ✅ `app_mentions:read` (allows reading @mentions)
- ✅ `channels:history` ← **MUST BE ENABLED** (allows reading thread messages)

**Socket Mode**:
- ✅ Enabled
- ✅ App-Level Token created with `connections:write` scope

### 2. Verify Container Logs

Check if messages are reaching the orchestrator:

```bash
wrangler tail --durable-object Orchestrator
```

Send a test message in a ticket thread (without @mention). You should see:
```
[Orchestrator Container] Slack event: message from U123456
```

If you DON'T see this log, the issue is with Slack app configuration (step 1).

If you DO see this log but the agent doesn't respond, check the next step.

### 3. Verify Ticket Lookup

In the same `wrangler tail` output, you should see the event being routed:
```
[Orchestrator] Event: slack_reply
```

If the message is received but NOT routed, the ticket might not exist or `thread_ts` doesn't match. Check:

```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  https://product-engineer.YOUR_SUBDOMAIN.workers.dev/api/orchestrator/tickets
```

Verify the ticket has a `slack_thread_ts` that matches the thread you're messaging in.

### 4. Verify Agent is Running

Check agent container status:

```bash
curl -H "X-API-Key: YOUR_API_KEY" \
  https://product-engineer.YOUR_SUBDOMAIN.workers.dev/api/agent/TICKET_ID/status
```

Expected response:
```json
{
  "service": "ticket-agent-container",
  "sessionActive": true,
  "sessionStatus": "running",
  "sessionMessageCount": 5
}
```

If `sessionActive: false`, the agent session ended. This is expected after completing work. Start a new conversation with another @mention.

## Quick Fix

If the issue is Slack configuration (step 1):

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Select your Product Engineer app
3. Event Subscriptions → Subscribe to bot events → Add `message.channels`
4. OAuth & Permissions → Bot Token Scopes → Add `channels:history` (if missing)
5. Save changes (Slack may require reinstalling the app)
6. Test by sending a message in an existing ticket thread without @mention

## Testing

After fixing configuration:

1. Create a new ticket with: `@product-engineer test thread replies`
2. Wait for agent's first response (creates the thread)
3. Send a follow-up message in the thread: `hello, can you hear me?` (NO @mention)
4. Agent should respond within 1-2 minutes

## Known Issues and Fixes

### Agent Replies Going to Main Channel (Fixed in BC-133)

**Symptom:** Agent posts replies to the main channel instead of in the ticket thread.

**Root cause:** The `slack_thread_ts` was not being passed from the orchestrator to the agent container on initialization. The agent would only learn the thread_ts when receiving subsequent events, but by then it had already posted its first message to the main channel.

**Fix:** The orchestrator now loads `slack_thread_ts` from the database when initializing the agent and passes it in the `TicketAgentConfig`. This ensures the agent knows the correct thread from the start.

**Related changes:**
- `api/src/types.ts`: Added `slackThreadTs` field to `TicketAgentConfig`
- `api/src/orchestrator.ts`: Load `slack_thread_ts` from DB when building agent config
- `api/src/ticket-agent.ts`: Use `config.slackThreadTs` when resolving env vars

## Related Files

- `containers/orchestrator/slack-socket.ts` — Socket Mode message filtering
- `api/src/orchestrator.ts` — Ticket lookup and routing
- `agent/src/prompt.ts` — Event prompt formatting
- `agent/src/tools.ts` — Slack posting logic (uses config.slackThreadTs)
- `scripts/slack-app-manifest.yaml` — Reference Slack app configuration
- `docs/deploy.md` — Deployment instructions with Slack setup
