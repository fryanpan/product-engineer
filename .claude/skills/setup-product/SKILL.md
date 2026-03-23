---
name: setup-product
description: Register a new product with the Product Engineer system. Walks through repo setup, secret provisioning, trigger configuration, and testing.
---

# Setup Product

Register a new product so the Product Engineer agent can work on it.

## Steps

### Step 1: Identify the Product

Gather:
- **Product name** — short identifier (e.g., `health-tool`, `bike-tool`)
- **Repos** — one or more GitHub repos that make up this product (e.g., `your-org/your-app` for a single repo, or `org/frontend` + `org/backend` for multi-repo)
- **Slack channel** — where the agent communicates (e.g., `#health-tool`)
- **Linear team ID** — if the product uses Linear for tickets

### Step 2: Add to Registry

Add the product to the orchestrator's registry in `api/src/registry.ts`:

```typescript
"product-name": {
  repos: ["org/repo-name"],
  slack_channel: "#product-channel",
  triggers: {
    feedback: { enabled: true, callback_url: "https://..." },  // if it has a feedback widget
    linear: { enabled: true, team_id: "..." },                  // if it uses Linear
    slack: { enabled: true },                                    // if it accepts Slack commands
  },
  secrets: {
    GITHUB_TOKEN: "PRODUCT_NAME_GITHUB_TOKEN",
    SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN",
    SLACK_APP_TOKEN: "SLACK_APP_TOKEN",
    LINEAR_API_KEY: "LINEAR_API_KEY",
    ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
  },
}
```

### Step 3: Provision Secrets

For each secret in the product's config:

1. Create a GitHub fine-grained PAT for the product's repo(s) with permissions: Contents (read/write), Pull requests (read/write), Issues (read)
2. Add it to Cloudflare secrets: `wrangler secret put PRODUCT_NAME_GITHUB_TOKEN`
3. Shared secrets (SLACK_BOT_TOKEN, ANTHROPIC_API_KEY, etc.) only need to be set once

### Step 4: Configure Triggers

**For Linear webhooks:**
1. Go to Linear Settings → API → Webhooks
2. Add webhook URL: `https://product-engineer.<your-subdomain>.workers.dev/api/webhooks/linear`
3. Select events: Issue created, Issue updated
4. Set the webhook secret to match `LINEAR_WEBHOOK_SECRET`

**For Slack commands:**
1. Ensure the Slack app is installed in the product's channel
2. The bot must be invited to the channel
3. Verify Bot Token Scopes (OAuth & Permissions) include: `chat:write`, `app_mentions:read`, `channels:history`
4. Subscribe to bot events (Event Subscriptions): `app_mention`, `message.channels`
   - `app_mention` enables @mentions to create new tickets
   - `message.channels` enables thread replies without @mentions to continue conversations

**For feedback widgets (web apps only):**
1. The product's worker dispatches to the orchestrator: `POST /api/dispatch`
2. Include `X-API-Key` header with the orchestrator's API key

**For GitHub PR merge detection:**
1. Add webhook to the repo: `https://product-engineer.<your-subdomain>.workers.dev/api/webhooks/github`
2. Select events: Pull requests
3. Set the webhook secret to match `GITHUB_WEBHOOK_SECRET`

### Step 5: Verify the Product's Claude Setup

The product repo should have:
- `CLAUDE.md` — project instructions the agent will follow
- `.claude/skills/` — any product-specific skills
- `.claude/rules/` — always-apply rules
- `.mcp.json` — MCP server configuration (Linear, context7, etc.)

If missing, use the metaproject's `/propagate` skill to push templates.

### Step 6: Set Up Agent Permissions

Copy `templates/claude-settings.json` to the product repo's `.claude/settings.json` if it doesn't already have one. This ensures the agent can work without permission prompts when running inside a sandbox container.

```bash
# From the product repo root
mkdir -p .claude
cp /path/to/product-engineer/templates/claude-settings.json .claude/settings.json
```

The template grants permissions for standard development operations (git, bun, npm, file I/O, etc.). Safety is enforced by the agent's decision framework (reversible vs irreversible), not the permission system.

If the product repo already has a `.claude/settings.json`, review it to ensure it includes the permissions the agent needs. Merge any missing entries from the template.

### Step 7: Test

1. Create a test Linear ticket in the product's team
2. Or mention the bot in the product's Slack channel: `@PE test: create a hello world file`
3. Watch the Slack channel for agent notifications
4. Verify the agent creates a PR
5. **Test thread replies:** Send a follow-up message in the ticket thread WITHOUT mentioning the bot — it should respond within a few minutes

### Troubleshooting

**Thread replies not working (agent doesn't respond to messages in ticket threads):**
- Verify the Slack app subscribes to `message.channels` event (not just `app_mention`)
- Verify Bot Token Scopes include `channels:history`
- The agent only responds to thread replies (messages with `thread_ts`), not top-level channel messages

## Principles

- **One product = one registry entry.** Even multi-repo products get a single entry with multiple repos.
- **Secrets are per-product for GitHub tokens** (different repo access), but shared for platform tokens (Slack, Linear, Anthropic).
- **Test before shipping.** Always verify end-to-end with a throwaway task before declaring the product ready.
