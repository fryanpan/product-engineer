# Staging Environment Setup

## Overview

Staging deploys from **development branches**, not main. This allows testing conductor and agent changes before promoting to production.

## Architecture

The **production conductor** acts as the control plane for staging access. A lock/lease mechanism can allow agents to claim staging for testing, preventing contention when multiple agents work in parallel.

## Components

| Component | Notes |
|-----------|-------|
| GitHub repo | Private repo for staging tests |
| Linear team | Separate Linear team for staging |
| Slack channels | Separate channels for staging communication and decisions |
| Wrangler staging env | `[env.staging]` in `api/wrangler.toml` |
| Cloudflare R2 bucket | Separate bucket for staging transcripts |
| Cloudflare KV namespace | Separate namespace for staging sessions |

## Secrets

Set secrets on the staging worker via `wrangler secret put --env staging`:

| Secret | Purpose |
|--------|---------|
| `STAGING_GITHUB_TOKEN` | GitHub API access for staging repo (fine-grained PAT) |
| `WORKER_URL` | Staging worker URL for Socket Mode forwarding |
| `API_KEY` | Admin API authentication |
| `SLACK_BOT_TOKEN` | Slack bot access (staging-specific app) |
| `SLACK_APP_TOKEN` | Slack Socket Mode (staging-specific app) |
| `LINEAR_APP_TOKEN` | Linear OAuth access token |
| `LINEAR_APP_CLIENT_ID` | Linear OAuth client ID |
| `LINEAR_APP_CLIENT_SECRET` | Linear OAuth client secret |
| `LINEAR_WEBHOOK_SECRET` | HMAC verification for Linear webhooks |
| `ANTHROPIC_API_KEY` | Claude API access |
| `GITHUB_WEBHOOK_SECRET` | Signature verification for GitHub webhooks |

## GitHub Token Permissions

Fine-grained PAT scoped to staging repo:
- Actions: Read
- Commit statuses: Read
- Contents: Read and write
- Pull requests: Read and write

## GitHub Webhook Events

Configure the webhook to send these events to `${WORKER_URL}/api/webhooks/github`:

| Event | Handler | Description |
|-------|---------|-------------|
| `pull_request` | PR lifecycle | Merged, updated, reopened, labeled |
| `pull_request_review` | Review submitted | Routes review feedback to agent |
| `pull_request_review_comment` | Inline comments | Routes code comments to agent |
| `issue_comment` | PR comments | General PR discussion |
| `check_run` | CI failure | Failed check runs on task branches |
| `check_suite` | CI completion | Triggers merge gate on success |
| `workflow_run` | Workflow failure | Failed GitHub Actions workflows |
| `status` | Commit status | Failed commit statuses |
| `deployment_status` | Deploy failure | Failed deployments |

## Linear Webhook

Configure in Linear (Settings → API → Webhooks):
- URL: `${WORKER_URL}/api/webhooks/linear`
- Team: Staging team only
- Events: Issue created, Issue updated, Comment created

## Deploying to Staging

```bash
cd api
npx wrangler deploy --env staging
```

Deploy from a development branch to test changes before merging to main.

## Slack App Isolation

Use a **separate Slack app** for staging to prevent cross-contamination with production. Both apps connect via Socket Mode independently.

## Infra Channel

Configure a staging-specific infra channel to keep lifecycle events separate from product channels:

1. Create `#staging-pe-infra` in Slack and invite the staging bot.
2. Get the channel ID and set it:
   ```bash
   curl -H "X-API-Key: $API_KEY" \
     "$WORKER_URL/api/settings/infra_channel_id" \
     -X PUT -H "Content-Type: application/json" \
     -d '{"value": "C_STAGING_INFRA_CHANNEL_ID"}'
   ```

If not set, infra messages are silently dropped — they do not fall back to product channels.

## Testing

1. **Test Linear trigger**: Create an issue in your staging Linear team
2. **Test Slack trigger**: `@your-staging-bot` in the staging channel
3. **Verify**: Agent should post status updates to the staging channel
