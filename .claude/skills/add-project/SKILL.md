---
name: add-project
description: Add an existing product to the Product Engineer registry. Use this to register repos that are already created and need to be connected to the conductor.
---

# Add Project to Registry

Add an existing product repository to the Product Engineer system so the agent can work on it.

## When to Use This

Use this skill when you have an existing GitHub repository that needs to be added to the Product Engineer registry. For creating new projects from scratch, use the `/create-project` skill instead.

## Steps

### Step 1: Gather Product Information

Collect the following information:
- **Product name** — short identifier (e.g., `health-tool`, `bike-tool`). Use kebab-case.
- **GitHub repo(s)** — one or more repos (e.g., `your-org/your-app`)
- **Slack channel** — where the agent will communicate (e.g., `#health-tool`)
- **Slack channel ID** (optional but recommended) — the channel ID from Slack
- **Linear project name** — the project name in Linear that will trigger this product

### Step 2: Add to Registry via API

Use the admin API to add the product to the registry:

```bash
curl -X POST https://your-worker.workers.dev/api/products \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "product-name",
    "config": {
      "repos": ["org/repo-name"],
      "slack_channel": "#product-channel",
      "slack_channel_id": "C000000APP1",
      "triggers": {
        "linear": {
          "enabled": true,
          "project_name": "Project Name"
        },
        "slack": { "enabled": true }
      },
      "secrets": {
        "GITHUB_TOKEN": "YOUR_ORG_GITHUB_TOKEN",
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

**Notes:**
- Most products use a shared org-wide GitHub token
- All other secrets are shared across products
- Only add `feedback` trigger if the product has a feedback widget
- The `slack_channel_id` field is optional but recommended for faster lookups

### Step 3: Create Slack Channel (if needed)

If the Slack channel doesn't exist:
1. Create the channel in Slack
2. Invite the `@PE` bot to the channel
3. Optionally, get the channel ID and add it to the registry as `slack_channel_id`

### Step 4: Create Linear Project (if needed)

If the Linear project doesn't exist:
1. Go to Linear → Projects
2. Create a new project with the name specified in the registry
3. Make sure it's in the correct team (check `linear_team_id` in registry root)

### Step 5: Verify Product Repo Setup

The product repo should have:
- `CLAUDE.md` — project instructions the agent will follow
- `.claude/skills/` — any product-specific skills (optional)
- `.claude/rules/` — always-apply rules (optional)
- `.claude/settings.json` — agent permissions (copy from `templates/claude-settings.json`)
- `.mcp.json` — MCP server configuration (Linear, context7, etc.)

If missing, check with the user whether they want to set these up.

### Step 6: Verify Secrets

Ensure all required secrets exist in Cloudflare:

```bash
# Check existing secrets
wrangler secret list

# The shared YOUR_ORG_GITHUB_TOKEN should already exist
# If it doesn't, you'll need to create a GitHub fine-grained PAT with:
# - Permissions: Contents (read/write), Pull requests (read/write), Issues (read)
# - Add it: wrangler secret put YOUR_ORG_GITHUB_TOKEN
```

### Step 7: Test

1. List products to verify it was added: `curl -H "X-API-Key: $API_KEY" https://your-worker.workers.dev/api/products`
2. Create a test Linear ticket in the product's project
3. Or mention the bot in Slack: `@bot test: create a hello world file`
4. Verify the agent responds and creates a PR

## Common Patterns

**Multi-repo product:**
```json
"repos": ["org/frontend", "org/backend", "org/shared"]
```

**Product without Linear (Slack-only):**
```json
"triggers": {
  "slack": { "enabled": true }
}
```

**Product with feedback widget:**
```json
"triggers": {
  "feedback": {
    "enabled": true,
    "callback_url": "https://product-api.example.workers.dev"
  },
  "linear": { "enabled": true, "project_name": "Product Name" },
  "slack": { "enabled": true }
}
```

## Troubleshooting

**Agent doesn't respond to Linear tickets:**
- Verify the Linear project name exactly matches the registry
- Check that the webhook is configured in Linear settings
- Verify the ticket is in the correct team (check `linear_team_id`)

**Agent doesn't respond in Slack:**
- Verify the bot is invited to the channel
- Check Bot Token Scopes include `chat:write`, `app_mentions:read`, `channels:history`
- Verify Event Subscriptions include `app_mention` and `message.channels`

**GitHub operations fail:**
- Verify the GitHub token has access to the repo
- Check token permissions: Contents (read/write), Pull requests (read/write)
