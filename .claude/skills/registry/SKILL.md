# Registry Management Skill

Agent skill for managing the Product Engineer registry (listing, verifying, updating, and removing products).

## When to Use This Skill

Use this skill when you need to:
- List all registered products
- Verify Slack/Linear configuration across products
- Remove products from the registry
- Configure Linear project names for products
- Check product configuration details

## How It Works

This skill provides CLI tools that interact with the deployed conductor's admin API to manage the product registry.

## Prerequisites

The following environment variables must be set:
- `WORKER_URL` - The deployed Worker URL (e.g., https://product-engineer.your-subdomain.workers.dev)
- `API_KEY` - Admin API key for authentication

These are already set in the agent environment by the conductor.

## Available Commands

### List All Products

```bash
bun run .claude/skills/registry/manage-registry.ts list
```

Shows all registered products with their configuration summary:
- Repos
- Slack channels
- Linear projects
- Trigger settings

### Verify Configuration

```bash
bun run .claude/skills/registry/manage-registry.ts verify
```

Checks all products for:
- ✅ Repos configured
- ✅ Slack channels configured
- ✅ Linear projects configured
- ✅ Required secrets present
- ⚠️ Trigger settings

Returns a detailed report with any configuration issues found.

### Get Product Details

```bash
bun run .claude/skills/registry/manage-registry.ts get <product-slug>
```

Returns the full JSON configuration for a specific product.

### Delete a Product

```bash
bun run .claude/skills/registry/manage-registry.ts delete <product-slug>
```

Removes a product from the registry. This will:
- Delete the product from the database
- Stop routing new events to it
- Not affect existing tickets (they remain in the database)

### Configure Linear Projects

```bash
bun run .claude/skills/registry/configure-linear.ts
```

Automatically configures Linear project names for all known products by mapping product slugs to Linear project names.

## Usage Examples

### Example 1: Remove a product and verify remaining ones

```bash
# Remove ai-project-support
bun run .claude/skills/registry/manage-registry.ts delete ai-project-support

# Verify all remaining products
bun run .claude/skills/registry/manage-registry.ts verify
```

### Example 2: Configure Linear for all products

```bash
# Run the Linear configuration script
bun run .claude/skills/registry/configure-linear.ts

# Verify the configuration was applied
bun run .claude/skills/registry/manage-registry.ts verify
```

### Example 3: Check specific product details

```bash
# Get full config for product-engineer
bun run .claude/skills/registry/manage-registry.ts get product-engineer
```

## Configuration Format

Products in the registry use this structure:

```typescript
{
  repos: string[];                   // GitHub repos
  slack_channel: string;             // Channel name for routing
  slack_channel_id?: string;         // Channel ID for notifications
  secrets: {                         // Cloudflare secret bindings
    GITHUB_TOKEN: string;
    ANTHROPIC_API_KEY: string;
    // ... other secrets
  };
  triggers: {
    linear?: {
      enabled: boolean;
      project_name: string;          // Linear project name for routing
    };
    slack?: {
      enabled: boolean;
    };
    feedback?: {
      enabled: boolean;
      callback_url?: string;
    };
  };
}
```

## Updating the Linear Project Mapping

To add or modify Linear project mappings, edit the `LINEAR_PROJECT_MAPPING` in `configure-linear.ts`:

```typescript
const LINEAR_PROJECT_MAPPING: Record<string, string> = {
  "product-slug": "Linear Project Name",
  "bike-tool": "Bike Tool",
  // ... add new mappings here
};
```

## Troubleshooting

### Authentication Error
If you see "Authentication failed: Invalid or missing API_KEY", ensure:
1. The `API_KEY` environment variable is set
2. The key matches the Worker's configured admin API key

### Product Not Found
The product slug doesn't exist in the registry. Use `list` to see all registered products.

### Linear Configuration Missing
The product is missing `triggers.linear.project_name`. Run `configure-linear.ts` or manually update the product configuration.

## Admin API Reference

The scripts interact with these endpoints:

- `GET /api/products` - List all products
- `GET /api/products/{slug}` - Get specific product
- `POST /api/products` - Create product
- `PUT /api/products/{slug}` - Update product
- `DELETE /api/products/{slug}` - Delete product

All endpoints require the `X-API-Key` header for authentication.
