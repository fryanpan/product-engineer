# Per-Product Agent Configuration

This document describes how to configure per-product agent permissions and custom prompt instructions.

## Overview

Products can now specify additional secrets and prompt content that are only exposed to ticket agents working on that specific product. This allows:

1. **Scoped permissions** — agents for product A get access to tools/APIs that agents for product B don't have
2. **Custom instructions** — each product can add specific guidance relevant to its codebase

## Use Case: Admin Access for product-engineer

Ticket agents working on the `product-engineer` repo itself need admin access to test and modify the orchestrator, but agents working on other products should NOT have this access (to keep the blast radius low).

## Schema Changes

### ProductConfig (registry.ts)

Two new optional fields:

```typescript
export interface ProductConfig {
  // ... existing fields ...
  agent_secrets?: Record<string, string>; // Additional secrets exposed only to this product's agents
  agent_prompt?: string; // Additional instructions added to agent prompt for this product
}
```

### TicketAgentConfig (types.ts)

```typescript
export interface TicketAgentConfig {
  // ... existing fields ...
  additionalPrompt?: string; // Product-specific instructions added to agent prompt
}
```

## How It Works

1. **Registry**: Product config includes `agent_secrets` (logical name → binding name) and `agent_prompt` (markdown string)
2. **Agent spawning**: When spawning an agent, the orchestrator:
   - Merges `agent_secrets` into the base `secrets` map
   - Passes `agent_prompt` as `additionalPrompt` to the TicketAgent config
3. **Environment variables**: TicketAgent DO sets `ADDITIONAL_PROMPT` env var from config
4. **Prompt construction**: Agent server passes `additionalPrompt` to prompt builder
5. **Prompt template**: Mustache template renders `additionalPrompt` in an "Additional Context" section

## Example: product-engineer Config

```json
{
  "repos": ["fryanpan/product-engineer"],
  "slack_channel": "#product-engineer",
  "triggers": {
    "linear": { "enabled": true, "project_name": "Product Engineer" },
    "slack": { "enabled": true }
  },
  "secrets": {
    "GITHUB_TOKEN": "PRODUCT_ENGINEER_GITHUB_TOKEN",
    "SLACK_BOT_TOKEN": "SLACK_BOT_TOKEN",
    "LINEAR_APP_TOKEN": "LINEAR_APP_TOKEN",
    "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY"
  },
  "agent_secrets": {
    "WORKER_URL": "WORKER_URL",
    "API_KEY": "API_KEY"
  },
  "agent_prompt": "## Admin Access\n\nYou have admin access to the Product Engineer orchestrator...\n\n**Available endpoints:**\n- GET /api/products\n- POST /api/products\n..."
}
```

## Setup Script

Use `scripts/update-product-engineer-config.sh` to add admin access to the product-engineer registry entry:

```bash
bash scripts/update-product-engineer-config.sh
```

The script will:
1. Fetch the current product-engineer config
2. Add `agent_secrets` mapping WORKER_URL and API_KEY
3. Add `agent_prompt` with admin API documentation
4. Update the registry via the admin API

## Manual Update via API

```bash
# Fetch current config
curl -H "X-API-Key: $API_KEY" \
  https://your-worker.workers.dev/api/products/product-engineer

# Update with agent_secrets and agent_prompt
curl -X PUT \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      ... existing config ...,
      "agent_secrets": {
        "WORKER_URL": "WORKER_URL",
        "API_KEY": "API_KEY"
      },
      "agent_prompt": "## Admin Access\n\nYou have admin access..."
    }
  }' \
  https://your-worker.workers.dev/api/products/product-engineer
```

## Security Considerations

1. **Blast radius**: `agent_secrets` are only exposed to agents for that specific product
2. **Secret names**: `agent_secrets` values are Cloudflare secret binding names (e.g., `"WORKER_URL"`), not the actual secret values
3. **Environment isolation**: Each TicketAgent container runs with only the secrets for its product
4. **Prompt visibility**: `agent_prompt` content is visible in agent transcripts — don't include actual secrets, only env var names

## Adding to Other Products

To give agents for another product custom permissions:

1. Identify which secrets/APIs they need
2. Add those bindings to `agent_secrets` in the product config
3. Document the available tools in `agent_prompt`
4. Update via the admin API or `scripts/update-product-engineer-config.sh` (adapt for other products)

Example for a product that needs Sentry admin access:

```json
{
  "agent_secrets": {
    "SENTRY_ORG_TOKEN": "SENTRY_ORG_TOKEN"
  },
  "agent_prompt": "## Sentry Admin Access\n\nYou have access to Sentry org admin API via SENTRY_ORG_TOKEN env var.\n\nUse this to create projects, manage alerts, etc."
}
```
