# Deployment Guide

Last updated: 2026-03-03

For deployment safety and zero-disruption updates, see [deployment-safety.md](./deployment-safety.md).

## Prerequisites

- Cloudflare account with Workers and Containers enabled
- Slack app with Socket Mode enabled
- Linear account with webhook access
- GitHub fine-grained PATs for each product repo
- Notion internal integration token (for Notion MCP)
- Sentry User Auth Token (for Sentry MCP)

## Step 1: Deploy

```bash
cd orchestrator
wrangler deploy
```

First deploy may take several minutes for container image builds.

## Step 2: Provision Secrets

### Deployment config

```bash
# The orchestrator container uses this to forward Slack events
cd orchestrator && wrangler secret put WORKER_URL   # e.g., https://product-engineer.your-subdomain.workers.dev
```

### Platform secrets

```bash
cd orchestrator

# Auth
wrangler secret put API_KEY              # Random string for internal API auth
wrangler secret put ANTHROPIC_API_KEY    # Anthropic API key for Agent SDK

# Slack
wrangler secret put SLACK_BOT_TOKEN      # xoxb-... (Bot User OAuth Token)
wrangler secret put SLACK_APP_TOKEN      # xapp-... (App-Level Token with connections:write)
wrangler secret put SLACK_SIGNING_SECRET # Slack signing secret

# Linear
wrangler secret put LINEAR_API_KEY       # Linear personal API key
wrangler secret put LINEAR_WEBHOOK_SECRET # Secret for webhook signature verification

# GitHub
wrangler secret put GITHUB_WEBHOOK_SECRET # Secret for webhook signature verification

# Observability (optional)
wrangler secret put SENTRY_DSN           # Sentry DSN for error tracking
```

### MCP server secrets (shared across products for now)

```bash
wrangler secret put NOTION_TOKEN          # Notion internal integration token (ntn_...)
wrangler secret put SENTRY_ACCESS_TOKEN   # Sentry User Auth Token (org:read, project:read/write scopes)
wrangler secret put CONTEXT7_API_KEY      # Context7 API key (optional — works without, lower rate limits)
```

### Per-organization GitHub tokens

Products from the same GitHub organization can share a single token. Use org-level tokens (e.g., `YOUR_ORG_GITHUB_TOKEN`) for all repos in that org.

```bash
# Example: if all your products are in the "your-org" GitHub org:
wrangler secret put YOUR_ORG_GITHUB_TOKEN    # Fine-grained PAT for all your-org/* repos

# Or use per-product tokens if you need different permissions:
wrangler secret put MY_APP_GITHUB_TOKEN      # Fine-grained PAT for your-org/my-app
wrangler secret put OTHER_TOOL_GITHUB_TOKEN  # Fine-grained PAT for your-org/other-tool
```

In the product config (via `PUT /api/products/:slug`), set `"GITHUB_TOKEN": "YOUR_ORG_GITHUB_TOKEN"` in the secrets object.

## Step 3: Populate Slack Channel IDs

The registry needs actual Slack channel IDs for Socket Mode event routing. Get them:

```bash
curl -s -H "Authorization: Bearer xoxb-YOUR-BOT-TOKEN" \
  "https://slack.com/api/conversations.list?types=public_channel" \
  | jq '.channels[] | select(.name | test("your-channel")) | {name, id}'
```

Then update each product via the admin API (`PUT /api/products/:slug`) — add `slack_channel_id`:

```typescript
"your-app": {
  slack_channel_id: "C06ABC123",  // actual ID from above
  // ...
}
```

Commit, push, and redeploy (`wrangler deploy`).

## Step 4: Configure Slack App

In [api.slack.com/apps](https://api.slack.com/apps):

1. **Socket Mode:** Settings → Socket Mode → Enable
2. **App-Level Token:** Settings → Basic Information → App-Level Tokens → Generate with `connections:write` scope
3. **Bot Token Scopes:** OAuth & Permissions → add the following scopes:
   - `channels:join` - Join public channels
   - `channels:manage` - Manage and create public channels
   - `channels:read` - View public channel info
   - `channels:write.invites` - Invite members to public channels
   - `channels:write.topic` - Set public channel descriptions
   - `chat:write` - Send messages
   - `chat:write.public` - Send messages to channels the bot isn't in
   - `files:read` - View files in channels
   - `files:write` - Upload/edit files
   - `groups:history` - View private channel messages
   - `groups:read` - View private channel info
   - `groups:write` - Manage and create private channels
   - `groups:write.invites` - Invite members to private channels
   - `groups:write.topic` - Set private channel descriptions
   - `im:history` - View DM messages
   - `im:read` - View DM info
   - `im:write` - Start DMs
   - `im:write.topic` - Set DM descriptions
4. **Event Subscriptions:** Event Subscriptions → Subscribe to bot events: `app_mention`, `message.channels`
5. **Reinstall app** after adding scopes (yellow banner will prompt you)
6. **Invite bot** to each product's Slack channel (e.g., `#your-app`) - or the bot can join automatically with `channels:join`

## Step 5: Configure Linear Settings

### Set Linear Team ID

The orchestrator needs to know which Linear team to accept webhooks from. Get your team ID from Linear:

```bash
# Using Linear GraphQL API
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: YOUR_LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ teams { nodes { id name } } }"}' \
  | jq '.data.teams.nodes[] | {name, id}'
```

Or use the Linear MCP tool if already configured:

```bash
curl -H "X-API-Key: $API_KEY" \
  "$WORKER_URL/api/settings/linear_team_id" \
  -X PUT \
  -H "Content-Type: application/json" \
  -d '{"value": "YOUR_TEAM_ID"}'
```

Also configure the agent's Linear identity:

```bash
curl -H "X-API-Key: $API_KEY" \
  "$WORKER_URL/api/settings/agent_linear_email" \
  -X PUT -H "Content-Type: application/json" \
  -d '{"value": "agent@example.com"}'

curl -H "X-API-Key: $API_KEY" \
  "$WORKER_URL/api/settings/agent_linear_name" \
  -X PUT -H "Content-Type: application/json" \
  -d '{"value": "Your Agent Name"}'
```

### Configure Linear Webhook

1. Linear Settings → API → Webhooks
2. Add webhook:
   - URL: `https://product-engineer.<your-subdomain>.workers.dev/api/webhooks/linear`
   - Events: Issue created, Issue updated
   - Secret: same value as `LINEAR_WEBHOOK_SECRET`

## Step 6: Configure GitHub Webhooks

For each product repo (e.g., `your-org/your-app`):

1. Repo Settings → Webhooks → Add webhook
2. Payload URL: `https://product-engineer.<your-subdomain>.workers.dev/api/webhooks/github`
3. Content type: `application/json`
4. Secret: same value as `GITHUB_WEBHOOK_SECRET`
5. Events:
   - Pull requests (for merge, update, reopen, label changes)
   - Pull request reviews (for review feedback)
   - Pull request review comments (for inline comments)
   - Issue comments (for PR discussion)
   - Check runs (for individual CI check failures)
   - Check suites (for overall check status)
   - Workflow runs (for GitHub Actions failures)
   - Statuses (for external CI like Vercel, Netlify)
   - Deployment status (for deployment failures)

## Step 7: Configure Notion Integration

1. Go to [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
2. Create an internal integration (or use existing)
3. Share relevant Notion pages/databases with the integration
4. The integration token is what you set as `NOTION_TOKEN`

## Step 8: Test

### Verify health

```bash
curl https://product-engineer.<your-subdomain>.workers.dev/health
# → {"ok":true,"service":"product-engineer-worker"}
```

### Test API dispatch (quickest test)

```bash
curl -X POST https://product-engineer.<your-subdomain>.workers.dev/api/dispatch \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "product": "your-app",
    "type": "ticket",
    "data": {
      "id": "test-1",
      "title": "Test ticket",
      "description": "Create a hello world file",
      "priority": 2,
      "labels": []
    }
  }'
```

Watch `#your-app` in Slack for agent activity.

### Test Linear trigger

Create a test issue in your product's Linear project. The system should:
1. Receive the webhook (verify HMAC signature)
2. Route to Orchestrator DO → spawn TicketAgent
3. Agent posts to the product's Slack channel
4. Agent clones repo, implements, creates PR

### Test Slack round-trip

1. In your product's channel, type: `@product-engineer create a hello world file`
2. Agent starts and posts progress as thread replies
3. Reply in the thread — agent should receive your reply and continue

### Verify MCP servers

In the agent container logs (`wrangler tail`), look for:
- `[Agent] Tool: linear.*` — Linear MCP connected
- `[Agent] Tool: context7.*` — Context7 MCP connected
- `[Agent] Tool: notion.*` — Notion MCP connected (if NOTION_TOKEN set)
- `[Agent] Tool: sentry.*` — Sentry MCP connected (if SENTRY_ACCESS_TOKEN set)

### Verify gh CLI

The agent should be able to create PRs via `gh pr create`. Check for `[Agent] Tool: Bash` calls using `gh`. If `GH_TOKEN` is correctly injected, no auth errors should appear.

## Debugging

| Issue | How to check |
|-------|-------------|
| Worker not receiving webhooks | `wrangler tail` — look for incoming requests |
| Socket Mode not connecting | Container logs — look for `[SlackSocket] Connected` |
| Agent container not starting | `wrangler tail` — look for `[Orchestrator] Agent container not ready` retries |
| MCP server not connecting | Agent logs — MCP connection errors appear at session start |
| `@mention` ignored | Check `slack_channel_id` in registry matches actual channel ID |
| Auth failures | Check secrets are provisioned: `wrangler secret list` |

## Architecture Reference

See `docs/product/security.md` for the security architecture diagram and controls.
