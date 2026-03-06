# Registry Management

Guide for managing the Product Engineer registry (adding, removing, and verifying product configurations).

## Quick Reference

```bash
# Set your Worker URL and API key (both required)
export WORKER_URL="https://product-engineer.your-subdomain.workers.dev"
export API_KEY="your-admin-api-key"

# List all products
bun run scripts/manage-registry.ts list

# Verify Slack/Linear configuration for all products
bun run scripts/manage-registry.ts verify

# Delete a product
bun run scripts/manage-registry.ts delete ai-project-support

# Get detailed configuration for a specific product
bun run scripts/manage-registry.ts get product-engineer
```

## Common Tasks

### Remove a Product from Registry

To remove `ai-project-support` from the active projects:

```bash
export WORKER_URL="https://product-engineer.your-subdomain.workers.dev"
export API_KEY="your-admin-api-key"
bun run scripts/manage-registry.ts delete ai-project-support
```

This will:
- Delete the product from the registry database
- Stop routing new events to it
- Not affect existing tickets (they remain in the database)

### Verify Configuration

Check that all products have proper Slack and Linear configuration:

```bash
bun run scripts/manage-registry.ts verify
```

This will check each product for:
- ✅ Repos configured
- ✅ Slack channel configured (channel ID or name)
- ✅ Linear configuration (triggers.linear.project_name)
- ✅ Required secrets (GITHUB_TOKEN, ANTHROPIC_API_KEY)
- ⚠️  Trigger settings (Linear, Feedback, Slack)

### List All Products

```bash
bun run scripts/manage-registry.ts list
```

Output format:
```
📦 product-engineer
   Repos: fryanpan/product-engineer
   Slack: C0AJ3ETD0QN
   Linear: Product Engineer
   Triggers: Linear=true, Feedback=false, Slack=true

📦 bike-db
   Repos: fryanpan/bike-db
   Slack: C0BK2ETD0QM
   Linear: Bike DB
   Triggers: Linear=true, Feedback=false, Slack=true
```

### Get Detailed Product Config

```bash
bun run scripts/manage-registry.ts get product-engineer
```

Returns the full product configuration as JSON.

## Direct API Access

You can also interact with the registry using the admin API directly. All admin endpoints require the `X-API-Key` header:

### List Products
```bash
curl "$WORKER_URL/api/products" \
  -H "X-API-Key: $API_KEY"
```

### Get a Specific Product
```bash
curl "$WORKER_URL/api/products/product-engineer" \
  -H "X-API-Key: $API_KEY"
```

### Delete a Product
```bash
curl -X DELETE "$WORKER_URL/api/products/ai-project-support" \
  -H "X-API-Key: $API_KEY"
```

### Update a Product
```bash
curl -X PUT "$WORKER_URL/api/products/bike-db" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "config": {
      "repos": ["fryanpan/bike-db"],
      "slack_channel": "bike-db",
      "slack_channel_id": "C0BK2ETD0QM",
      "secrets": {
        "GITHUB_TOKEN": "BIKE_DB_GITHUB_TOKEN",
        "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY"
      },
      "triggers": {
        "linear": {
          "enabled": true,
          "project_name": "Bike DB"
        },
        "slack": {
          "enabled": true
        }
      }
    }
  }'
```

### Create a New Product
```bash
curl -X POST "$WORKER_URL/api/products" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "slug": "new-product",
    "config": {
      "repos": ["org/repo"],
      "slack_channel": "new-product",
      "slack_channel_id": "C...",
      "secrets": {
        "GITHUB_TOKEN": "NEW_PRODUCT_GITHUB_TOKEN",
        "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY"
      },
      "triggers": {
        "linear": {
          "enabled": true,
          "project_name": "New Product"
        },
        "slack": {
          "enabled": true
        }
      }
    }
  }'
```

## Configuration Fields

Each product in the registry has the following structure:

```typescript
{
  repos: string[];                   // GitHub repos (e.g., ["owner/repo"])
  slack_channel: string;             // Slack channel name (required for routing)
  slack_channel_id?: string;         // Slack channel ID (preferred for notifications)
  secrets: {                         // Maps logical names to Cloudflare secret bindings
    GITHUB_TOKEN: string;            // Binding name for GitHub token
    ANTHROPIC_API_KEY: string;       // Binding name for Anthropic API key
    // ... other secrets
  };
  triggers: {                        // Which event sources to listen to
    linear?: {                       // Linear trigger configuration
      enabled: boolean;              // Whether to handle Linear events
      project_name: string;          // Linear project name for routing
    };
    slack?: {                        // Slack trigger configuration
      enabled: boolean;              // Whether to handle Slack events
    };
    feedback?: {                     // Feedback trigger configuration
      enabled: boolean;              // Whether to handle feedback events
      callback_url?: string;         // Optional callback URL
    };
  };
}
```

### Required Fields
- `repos`: At least one repo must be specified
- `slack_channel`: Channel name for routing (required)
- `secrets.GITHUB_TOKEN`: Required for Git operations
- `secrets.ANTHROPIC_API_KEY`: Required for LLM operations

### Slack Configuration
- `slack_channel` (required) - Channel name used for routing Slack events to the correct product
- `slack_channel_id` (optional but recommended) - Channel ID for posting notifications (more reliable than name)
- `triggers.slack.enabled` - Set to `true` to handle Slack mentions

### Linear Configuration
- `triggers.linear.enabled` - Set to `true` to handle Linear events
- `triggers.linear.project_name` - Linear project name used for routing tickets to the correct product

## Troubleshooting

### "Product not found" error
The product slug doesn't exist in the registry. Use `list` to see all registered products.

### "Slack channel not configured" warning
The product is missing both `slack_channel` and `slack_channel_id`. Slack mentions in this product's channel won't be routed to agents.

**Fix:**
```bash
# Get current config
bun run scripts/manage-registry.ts get <product-slug> > config.json

# Edit config.json to add slack_channel_id

# Update (wrap config in top-level "config" property)
curl -X PUT "$WORKER_URL/api/products/<product-slug>" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d "{\"config\":$(cat config.json)}"
```

### "Linear configuration missing" warning
The product is missing `triggers.linear.project_name`. Linear ticket events won't be routed to agents.

**Fix:**
```bash
# Get current config
bun run scripts/manage-registry.ts get <product-slug> > config.json

# Edit config.json to add triggers.linear with enabled=true and project_name

# Update (wrap config in top-level "config" property)
curl -X PUT "$WORKER_URL/api/products/<product-slug>" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d "{\"config\":$(cat config.json)}"
```

### No response from API
1. Check that `WORKER_URL` is set correctly
2. Verify the Worker is deployed: `cd orchestrator && npx wrangler deployments list`
3. Check Worker logs: `cd orchestrator && npx wrangler tail`

## See Also
- [Registry Migration Guide](./registry-migration-guide.md) - How the registry was migrated from JSON to SQLite
- [Architecture](../architecture/architecture.md) - Overall system architecture
- [Deployment Guide](./deploy.md) - Deployment instructions
