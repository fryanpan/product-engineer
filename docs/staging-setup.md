# Staging Environment Setup

## Status: Complete

All components are provisioned and connected. See Testing section to verify end-to-end.

| Component | Status | Details |
|-----------|--------|---------|
| GitHub repo | Done | `fryanpan/staging-test-app` (private) |
| Linear team | Done | "PE Staging" (PES), ID: `ea3572c2-6bb2-4113-9076-3f7ce586768d` |
| Slack channel | Done | `#staging-product-engineer` (ID: `C0AKB6HUEPM`) |
| Slack decisions channel | Done | `#staging-pe-decisions` (ID: `C0AK24X4UJ3`) |
| Wrangler staging env | Done | `[env.staging]` in `orchestrator/wrangler.toml` |
| Test app code | Done | Hello world Node.js app with CI, pushed to GitHub |
| Cloudflare R2 bucket | Done | `product-engineer-staging-transcripts` |
| Cloudflare KV namespace | Done | `staging-SESSIONS` (ID: `52c44a6e0d144e53a51c9cb4e9bcbbe0`) |
| Staging deploy | Done | `https://product-engineer-stg.fryanpan.workers.dev` |
| GitHub token | Done | Fine-grained PAT stored as `STAGING_GITHUB_TOKEN` |
| Secrets | Done | All secrets set via `wrangler secret put --env staging` |
| Product registry | Done | Seeded via `POST /api/products/seed` |
| Linear webhook | Done | PE Staging team → staging worker |
| GitHub webhook | Done | `fryanpan/staging-test-app` → staging worker (12 events) |
| Slack app (staging) | Done | "Product Engineer (Staging)" App ID: `A0AKFUSK4R4` |
| Slack bot invite | Done | Staging bot invited to both staging channels |

## Architecture

Staging deploys from **development branches**, not main. This allows testing orchestrator and agent changes before promoting to production.

The **production orchestrator** acts as the control plane for staging access. A lock/lease mechanism (see [BC-134](https://linear.app/health-tool/issue/BC-134)) will allow agents to claim staging for testing, preventing contention when multiple agents work in parallel.

## Secrets

All secrets are set on the staging worker via `wrangler secret put --env staging`:

| Secret | Purpose | Notes |
|--------|---------|-------|
| `STAGING_GITHUB_TOKEN` | GitHub API access for staging-test-app | Fine-grained PAT, scoped to `fryanpan/staging-test-app` |
| `WORKER_URL` | Staging worker URL for Socket Mode forwarding | `https://product-engineer-stg.fryanpan.workers.dev` |
| `API_KEY` | Admin API authentication | Same as production |
| `SLACK_BOT_TOKEN` | Slack bot access | Staging-specific (separate Slack app) |
| `SLACK_APP_TOKEN` | Slack Socket Mode | Staging-specific (separate Slack app) |
| `LINEAR_APP_TOKEN` | Linear OAuth access token (actor=app) | Per-environment — obtained via OAuth flow |
| `LINEAR_APP_CLIENT_ID` | Linear OAuth client ID | Per-environment — from Linear app settings |
| `LINEAR_APP_CLIENT_SECRET` | Linear OAuth client secret | Per-environment — from Linear app settings |
| `LINEAR_WEBHOOK_SECRET` | HMAC verification for Linear webhooks | Staging-specific secret |
| `ANTHROPIC_API_KEY` | Claude API access | Shared with production |
| `GITHUB_WEBHOOK_SECRET` | Signature verification for GitHub webhooks | Staging-specific secret |

## GitHub Token Permissions

Fine-grained PAT scoped to `fryanpan/staging-test-app`:
- Actions: Read
- Commit statuses: Read
- Contents: Read and write
- Dependabot alerts: Read
- Code scanning alerts: Read
- Deployments: Read
- Issues: Read
- Pull requests: Read and write

## GitHub Webhook Events

The webhook on `fryanpan/staging-test-app` sends these events to `https://product-engineer-stg.fryanpan.workers.dev/api/webhooks/github`:

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
| `code_scanning_alert` | Security alerts | CodeQL findings on task branches |
| `dependabot_alert` | Dependency alerts | Vulnerable dependency notifications |
| `push` | Push events | Default GitHub webhook event |

## Linear Webhook

Configured in Linear (Settings → API → Webhooks):
- URL: `https://product-engineer-stg.fryanpan.workers.dev/api/webhooks/linear`
- Team: PE Staging only
- Events: Issue created, Issue updated, Comment created

## Product Registry

Seeded via admin API with:
- `linear_team_id`: `ea3572c2-6bb2-4113-9076-3f7ce586768d`
- `agent_linear_name`: `Product Engineer (Staging)`
- Product `staging-test-app` mapped to `fryanpan/staging-test-app`
- Slack channel: `#staging-product-engineer`
- GitHub token binding: `STAGING_GITHUB_TOKEN`

## Deploying to Staging

```bash
cd orchestrator
npx wrangler deploy --env staging
```

Deploy from a development branch to test changes before merging to main.

## Slack App Isolation

Staging uses a **separate Slack app** ("Product Engineer (Staging)", App ID: `A0AKFUSK4R4`) to prevent cross-contamination with production. Both apps connect via Socket Mode independently.

- Production app: "Product Engineer" (`A0AHVF6V02W`)
- Staging app: "Product Engineer (Staging)" (`A0AKFUSK4R4`)
- App manifests stored in `orchestrator/slack-app-manifest.{production,staging}.json` (no secrets)

## Testing

1. **Test Linear trigger**: Create an issue in PE Staging team (PES-1)
2. **Test Slack trigger**: `@product-engineer-staging` in `#staging-product-engineer`
3. **Verify**: Agent should post status updates to `#staging-product-engineer` and decision logs to `#staging-pe-decisions`

## Future: Staging Lock/Lease

[BC-134](https://linear.app/health-tool/issue/BC-134) — Production orchestrator will manage staging access via a lock/lease API, allowing agents to autonomously claim staging for testing without contention.
