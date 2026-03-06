# Registry Management

Guide for managing the Product Engineer registry (adding, removing, and verifying product configurations).

## Quick Reference

```bash
# Set your Worker URL (required)
export WORKER_URL="https://product-engineer.your-subdomain.workers.dev"

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
- ✅ Linear configuration (project ID or team key)
- ✅ Required secrets (GITHUB_TOKEN, ANTHROPIC_API_KEY)
- ⚠️  Trigger settings (Linear, GitHub, Slack)

### List All Products

```bash
bun run scripts/manage-registry.ts list
```

Output format:
```
📦 product-engineer
   Repos: fryanpan/product-engineer
   Slack: C0AJ3ETD0QN
   Linear: acd123...
   Triggers: Linear=true, GitHub=true, Slack=true

📦 bike-db
   Repos: fryanpan/bike-db
   Slack: C0BK2ETD0QM
   Linear: def456...
   Triggers: Linear=true, GitHub=true, Slack=true
```

### Get Detailed Product Config

```bash
bun run scripts/manage-registry.ts get product-engineer
```

Returns the full product configuration as JSON.

## Direct API Access

You can also interact with the registry using the admin API directly:

### List Products
```bash
curl "$WORKER_URL/api/products"
```

### Get a Specific Product
```bash
curl "$WORKER_URL/api/products/product-engineer"
```

### Delete a Product
```bash
curl -X DELETE "$WORKER_URL/api/products/ai-project-support"
```

### Update a Product
```bash
curl -X PUT "$WORKER_URL/api/products/bike-db" \
  -H "Content-Type: application/json" \
  -d '{
    "config": {
      "repos": ["fryanpan/bike-db"],
      "slack_channel_id": "C0BK2ETD0QM",
      "linear_project_id": "...",
      "secrets": { ... },
      "triggers": {
        "linear": true,
        "github": true,
        "slack": true
      }
    }
  }'
```

### Create a New Product
```bash
curl -X POST "$WORKER_URL/api/products" \
  -H "Content-Type: application/json" \
  -d '{
    "slug": "new-product",
    "config": {
      "repos": ["org/repo"],
      "slack_channel_id": "C...",
      "linear_project_id": "...",
      "secrets": { ... }
    }
  }'
```

## Configuration Fields

Each product in the registry has the following structure:

```typescript
{
  repos: string[];              // GitHub repos (e.g., ["owner/repo"])
  slack_channel?: string;       // Slack channel name (legacy)
  slack_channel_id?: string;    // Slack channel ID (preferred)
  linear_project_id?: string;   // Linear project UUID
  linear_team_key?: string;     // Linear team key (e.g., "PE")
  secrets: {                    // Maps logical names to Cloudflare secret bindings
    GITHUB_TOKEN: string;       // Binding name for GitHub token
    ANTHROPIC_API_KEY: string;  // Binding name for Anthropic API key
    // ... other secrets
  };
  triggers?: {                  // Which event sources to listen to
    linear?: boolean;           // Default: true
    github?: boolean;           // Default: true
    slack?: boolean;            // Default: true
  };
}
```

### Required Fields
- `repos`: At least one repo must be specified
- `secrets.GITHUB_TOKEN`: Required for Git operations
- `secrets.ANTHROPIC_API_KEY`: Required for LLM operations

### Slack Configuration
You must specify either:
- `slack_channel_id` (preferred) - The Slack channel ID (e.g., "C0AJ3ETD0QN")
- `slack_channel` (legacy) - The channel name (e.g., "product-engineer")

### Linear Configuration
You must specify at least one:
- `linear_project_id` - The Linear project UUID
- `linear_team_key` - The Linear team key (e.g., "PE")

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

# Update
curl -X PUT "$WORKER_URL/api/products/<product-slug>" \
  -H "Content-Type: application/json" \
  -d @config.json
```

### "Linear configuration missing" warning
The product is missing both `linear_project_id` and `linear_team_key`. Linear ticket events won't be routed to agents.

**Fix:** Same as Slack configuration above, but add `linear_project_id` or `linear_team_key`.

### No response from API
1. Check that `WORKER_URL` is set correctly
2. Verify the Worker is deployed: `cd orchestrator && npx wrangler deployments list`
3. Check Worker logs: `cd orchestrator && npx wrangler tail`

## See Also
- [Registry Migration Guide](./registry-migration-guide.md) - How the registry was migrated from JSON to SQLite
- [Architecture](../architecture/architecture.md) - Overall system architecture
- [Deployment Guide](./deploy.md) - Deployment instructions
