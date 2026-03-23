# BC-167: Setup 7 Repos with Slack and Linear Integration

## Overview

This document tracks the setup of 7 repositories with Product Engineer integration.

| Repo | Slack Channel | Linear Project | Status |
|------|---------------|----------------|--------|
| givewell-impact | #nonprofit-impact | Nonprofit Impact | Pending |
| blog-assistant | #blog-assistant | Blog Assistant | Pending |
| tasks | #tasks | Tasks | Pending |
| personal-crm | #personal-crm | personal-crm | Pending |
| research-notes | #research-notes | Research Notes | Pending |
| task-pilot | #task-pilot | Task Pilot | Pending |
| personal-finance | #personal-finance | Personal Finance | Pending |

## Prerequisites

Before running the setup script, ensure:

1. **Worker is deployed** and accessible at the production URL
2. **API_KEY** is set in Cloudflare secrets
3. **Shared GitHub token** exists (or individual tokens per repo)
4. **Slack and Linear** integrations are configured (webhooks, bot tokens)

## Setup Steps

### 1. Add Products to Registry

Run the automated setup script:

```bash
# Set environment variables
export WORKER_URL="https://product-engineer.example.workers.dev"
export API_KEY="your-api-key-here"
export GITHUB_ORG="fryanpan"  # or your org
export SHARED_GITHUB_TOKEN="FRYANPAN_GITHUB_TOKEN"

# Run setup
bash scripts/setup-repos.sh
```

Or manually add each product via the admin API:

```bash
curl -X POST "$WORKER_URL/api/products" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "givewell-impact",
    "config": {
      "repos": ["fryanpan/givewell-impact"],
      "slack_channel": "#nonprofit-impact",
      "triggers": {
        "linear": {
          "enabled": true,
          "project_name": "Nonprofit Impact"
        },
        "slack": { "enabled": true }
      },
      "secrets": {
        "GITHUB_TOKEN": "FRYANPAN_GITHUB_TOKEN",
        "SLACK_BOT_TOKEN": "SLACK_BOT_TOKEN",
        "LINEAR_API_KEY": "LINEAR_API_KEY",
        "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY",
        "NOTION_TOKEN": "NOTION_TOKEN",
        "SENTRY_ACCESS_TOKEN": "SENTRY_ACCESS_TOKEN",
        "CONTEXT7_API_KEY": "CONTEXT7_API_KEY"
      }
    }
  }'
```

### 2. Create Slack Channels

For each product, create the Slack channel if it doesn't exist:

1. In Slack, create channel (e.g., `#nonprofit-impact`)
2. Invite the Product Engineer bot: `/invite @product-engineer`
3. (Optional) Get the channel ID for faster lookups:
   - Right-click channel → View channel details
   - Scroll to bottom, copy channel ID
   - Add to registry: `"slack_channel_id": "C1234567890"`

### 3. Create Linear Projects

For each product, create the Linear project if it doesn't exist:

1. Go to Linear → Projects
2. Click "New Project"
3. Enter project name (must match registry exactly):
   - Nonprofit Impact
   - Blog Assistant
   - Tasks
   - personal-crm
   - Research Notes
   - Task Pilot
   - Personal Finance
4. Ensure it's in the correct team (check `linear_team_id` in registry)

### 4. Create or Verify GitHub Repos

For each repo:

1. **If repo exists**: Verify GitHub token has access
2. **If repo doesn't exist**: Create it on GitHub
   - Public or private as appropriate
   - Initialize with README (optional)
   - No template needed

Verify token permissions (fine-grained PAT):
- Repository access: Selected repositories → include all 7 repos
- Permissions:
  - Contents: Read and write
  - Pull requests: Read and write
  - Issues: Read and write
  - Commit statuses: Read and write

### 5. Set Up Each Repo with Claude Templates

For each repo, ensure it has the required Claude Code setup:

```bash
# Clone the repo
git clone git@github.com:fryanpan/<repo-name>.git
cd <repo-name>

# Copy templates from product-engineer repo
cp /path/to/product-engineer/templates/CLAUDE.md.tmpl CLAUDE.md
mkdir -p .claude
cp /path/to/product-engineer/templates/claude-settings.json .claude/settings.json
cp /path/to/product-engineer/templates/.mcp.json .mcp.json

# Edit CLAUDE.md to replace placeholders
# - Replace {{PRODUCT_NAME}} with actual product name
# - Replace {{PRODUCT_DESCRIPTION}} with actual description

# Commit and push
git add CLAUDE.md .claude/ .mcp.json
git commit -m "Add Claude Code setup"
git push
```

Or use the `/add-project` skill from the product-engineer repo to automate this.

### 6. Configure GitHub Webhooks

For each repo, add the GitHub webhook:

1. Go to `https://github.com/fryanpan/<repo-name>/settings/hooks/new`
2. Payload URL: `https://product-engineer.example.workers.dev/api/webhooks/github`
3. Content type: `application/json`
4. Secret: The `GITHUB_WEBHOOK_SECRET` from Cloudflare secrets
5. Events: Select individual events
   - ✓ Pull requests
   - ✓ Pull request reviews
6. Active: ✓
7. Click "Add webhook"

### 7. Test Each Integration

For each product:

**Test via Linear:**
1. Create a test ticket in the Linear project
2. Watch the Slack channel for agent notification
3. Verify agent creates a branch and PR

**Test via Slack:**
1. In the Slack channel, mention the bot: `@product-engineer test: create a hello world file`
2. Verify agent responds in a thread
3. Verify agent creates a PR

**Test thread replies:**
1. Reply to the ticket thread WITHOUT mentioning the bot
2. Agent should respond within a few minutes

## Verification Checklist

For each repo, verify:

- [ ] Registry entry exists (check via `GET /api/products/<slug>`)
- [ ] Slack channel exists and bot is invited
- [ ] Linear project exists with correct name
- [ ] GitHub repo exists and token has access
- [ ] CLAUDE.md exists in repo
- [ ] .claude/settings.json exists in repo
- [ ] .mcp.json exists in repo
- [ ] GitHub webhook is configured
- [ ] Linear ticket triggers agent (test)
- [ ] Slack mention triggers agent (test)
- [ ] Thread reply works without @mention (test)

## Troubleshooting

### Agent doesn't respond to Linear tickets

- Verify Linear project name exactly matches registry
- Check Linear webhook is configured with correct URL and secret
- Verify ticket is in the correct team (check `linear_team_id`)
- Check orchestrator logs: `cd api && npx wrangler tail`

### Agent doesn't respond in Slack

- Verify bot is invited to the channel
- Check Bot Token Scopes: `chat:write`, `app_mentions:read`, `channels:history`
- Verify Event Subscriptions: `app_mention`, `message.channels`
- Check Socket Mode is enabled and `SLACK_APP_TOKEN` is set

### GitHub operations fail

- Verify GitHub token has access to the repo
- Check token permissions: Contents (R/W), Pull requests (R/W), Issues (R/W)
- Verify webhook secret matches `GITHUB_WEBHOOK_SECRET`
- Check webhook delivery logs in GitHub repo settings

### Agent creates PR but doesn't merge

- Verify GitHub webhook is configured for "Pull requests" events
- Check that CI is configured (or merge gate is disabled for repos without CI)
- Verify `checks_passed` webhook is firing (check orchestrator logs)

## Automation Script

The `scripts/setup-repos.sh` script automates registry setup for all 7 repos.

**Usage:**

```bash
WORKER_URL="https://product-engineer.example.workers.dev" \
API_KEY="your-api-key" \
GITHUB_ORG="fryanpan" \
SHARED_GITHUB_TOKEN="FRYANPAN_GITHUB_TOKEN" \
bash scripts/setup-repos.sh
```

**What it does:**
1. Adds all 7 products to the registry via admin API
2. Verifies each product was added successfully
3. Prints next steps for manual setup (Slack channels, Linear projects, etc.)

**What it doesn't do:**
- Create Slack channels (manual)
- Create Linear projects (manual)
- Create GitHub repos (manual or via `/create-project` skill)
- Set up Claude templates in repos (manual or via `/add-project` skill)
- Configure GitHub webhooks (manual)

## Post-Setup

After all 7 repos are set up:

1. **Update this document** with actual status and any repo-specific notes
2. **Test each integration** and mark verification checklist complete
3. **Document any deviations** from standard setup (custom configs, special permissions, etc.)
4. **Share setup completion** in the Product Engineer Slack channel

## Notes

- All repos use shared secrets for platform tokens (Slack, Linear, Anthropic)
- GitHub token can be shared across repos if they're in the same org
- Slack channel IDs are optional but recommended for performance
- Linear project names are case-sensitive and must match exactly
- GitHub webhooks require `GITHUB_WEBHOOK_SECRET` to match across all repos
