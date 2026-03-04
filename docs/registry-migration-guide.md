# Registry Migration Guide

## Overview

The product registry has been migrated from a static `registry.json` file to a DO SQLite database with an admin API. This change:

1. **Removes private data from source control** — registry lives in the DO at runtime
2. **Enables agent self-service** — `/setup-product` and `/add-project` skills can now modify the registry via API
3. **Makes the schema easy to evolve** — product config stored as a JSON column with TypeScript validation

## For Existing Users

### Step 1: Seed Your Database

If you have an existing `registry.json` with real data (not checked in), use the seed endpoint:

```bash
curl -X POST https://your-worker.workers.dev/api/products/seed \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d @registry.json
```

This will populate the DO database with all your products and global settings.

### Step 2: Verify the Migration

```bash
# List all products
curl -H "X-API-Key: $API_KEY" https://your-worker.workers.dev/api/products

# Check global settings
curl -H "X-API-Key: $API_KEY" https://your-worker.workers.dev/api/settings
```

### Step 3: Set WORKER_URL

Set `WORKER_URL` as a Cloudflare secret:

```bash
cd orchestrator && wrangler secret put WORKER_URL   # e.g., https://product-engineer.your-subdomain.workers.dev
```

### Step 4: Test

Create a test Linear ticket or Slack mention to verify webhooks still work.

## Admin API Reference

All endpoints require `X-API-Key` authentication.

### Products

| Method | Path | Description |
| -- | -- | -- |
| `GET` | `/api/products` | List all products |
| `GET` | `/api/products/:slug` | Get single product |
| `POST` | `/api/products` | Create product (slug in body) |
| `PUT` | `/api/products/:slug` | Update product config |
| `DELETE` | `/api/products/:slug` | Remove product |

### Settings

| Method | Path | Description |
| -- | -- | -- |
| `GET` | `/api/settings` | Get all global settings |
| `PUT` | `/api/settings/:key` | Update a global setting |

### Examples

**Create a product:**
```bash
curl -X POST https://your-worker.workers.dev/api/products \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "my-app",
    "config": {
      "repos": ["my-org/my-app"],
      "slack_channel": "#my-app",
      "slack_channel_id": "C000000APP1",
      "triggers": {
        "linear": { "enabled": true, "project_name": "My App" },
        "slack": { "enabled": true }
      },
      "secrets": {
        "GITHUB_TOKEN": "MY_ORG_GITHUB_TOKEN",
        "SLACK_BOT_TOKEN": "SLACK_BOT_TOKEN",
        "LINEAR_API_KEY": "LINEAR_API_KEY",
        "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY"
      }
    }
  }'
```

**Update a product:**
```bash
curl -X PUT https://your-worker.workers.dev/api/products/my-app \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "repos": ["my-org/my-app", "my-org/my-app-api"],
      "slack_channel": "#my-app",
      "triggers": {
        "linear": { "enabled": true, "project_name": "My App" },
        "slack": { "enabled": true }
      },
      "secrets": { ... }
    }
  }'
```

**Update a global setting:**
```bash
curl -X PUT https://your-worker.workers.dev/api/settings/agent_linear_email \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "value": "newagent@example.com" }'
```

## For New Users

New users should:

1. Deploy the orchestrator
2. Use the admin API to add products (see `/add-project` skill)
3. Keep `registry.json` as the template (checked in) for documentation only

## Architecture Changes

### Before

- `registry.ts` imported `registry.json` at build time
- Registry functions were synchronous
- All lookups used the static JSON object

### After

- `registry.ts` loads from the DO on first request per isolate
- Registry functions are async and require an `orchestratorStub` parameter
- Lookups are cached in-memory for the life of the Worker isolate

### Caching Behavior

The Worker caches the full registry on first request. Since registry changes are rare, stale-for-one-isolate is acceptable. If you update the registry via API, you may need to wait for Worker isolates to restart (happens automatically on new requests after a period of inactivity).

## Testing

Tests now need to mock the Orchestrator DO and seed test data. See updated test files for patterns.

## Troubleshooting

**Webhooks not routing to products:**
- Check that products exist: `curl -H "X-API-Key: $API_KEY" https://your-worker.workers.dev/api/products`
- Verify Linear project names match exactly (case-insensitive)
- Check `wrangler tail` for errors

**Worker can't find products after deployment:**
- Verify the DO database was seeded
- Check that `WORKER_URL` is set as a secret: `wrangler secret list`
- Restart the Worker (create a new request to trigger isolate restart)
