# Deployment Guide

## Prerequisites

- Cloudflare account with Workers, Queues, and Containers enabled
- Slack app with Socket Mode and Event Subscriptions
- Linear account with webhook access
- GitHub fine-grained PATs for each product repo

## Step 1: Deploy the Orchestrator Worker

```bash
cd orchestrator
wrangler deploy
```

## Step 2: Set Secrets

Shared secrets (set once):
```bash
cd orchestrator
wrangler secret put API_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_APP_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put LINEAR_API_KEY
wrangler secret put LINEAR_WEBHOOK_SECRET
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put ORCHESTRATOR_URL  # https://product-engineer.fryanpan.workers.dev
```

Per-product GitHub tokens:
```bash
wrangler secret put HEALTH_TOOL_GITHUB_TOKEN
wrangler secret put BIKE_TOOL_GITHUB_TOKEN
```

## Step 3: Configure Linear Webhooks

For each product's Linear team:
1. Go to Linear Settings → API → Webhooks
2. Add webhook:
   - URL: `https://product-engineer.fryanpan.workers.dev/api/webhooks/linear`
   - Events: Issue created, Issue updated
   - Secret: same as `LINEAR_WEBHOOK_SECRET`

## Step 4: Configure Slack

1. Ensure the bot is invited to `#health-tool` and `#bike-tool` channels
2. In Slack App settings → Event Subscriptions:
   - Request URL: `https://product-engineer.fryanpan.workers.dev/api/webhooks/slack/events`
   - Subscribe to bot events: `app_mention`
3. In Slack App settings → Socket Mode: Enable (for agent mid-task replies)

## Step 5: Configure GitHub Webhooks

For each product repo:
1. Go to repo Settings → Webhooks → Add webhook
2. Payload URL: `https://product-engineer.fryanpan.workers.dev/api/webhooks/github`
3. Content type: `application/json`
4. Secret: same as `GITHUB_WEBHOOK_SECRET`
5. Events: Pull requests

## Step 6: Test

### Test Linear trigger:
Create a test issue in the health-tool Linear team. The orchestrator should:
1. Receive the webhook
2. Post to `#health-tool`: "Agent picking up ticket: ..."
3. Launch a sandbox
4. Agent creates a PR

### Test Slack trigger:
In `#bike-tool`, type: `@PE create a hello world file`
The orchestrator should pick it up and launch an agent.

## Health-tool Feedback Integration

Health-tool's existing feedback pipeline still works independently:
- Feedback widget → health-tool worker → health-tool queue → health-tool sandbox

To optionally route through the orchestrator instead, health-tool's queue consumer
can POST to `https://product-engineer.fryanpan.workers.dev/api/dispatch` with:
```json
{
  "product": "health-tool",
  "type": "feedback",
  "data": { "id": "...", "text": "...", ... }
}
```
