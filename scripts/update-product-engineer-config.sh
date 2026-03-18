#!/bin/bash
# Update the product-engineer registry entry to include admin access for ticket agents
# This script adds agent_secrets and agent_prompt to the product-engineer config

set -e
cd "$(dirname "$0")/.."

# Check if required tools are available
if ! command -v curl &> /dev/null; then
    echo "Error: curl is required but not installed"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    echo "Error: jq is required but not installed"
    exit 1
fi

# Get configuration
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Update product-engineer Registry Config"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Get WORKER_URL and API_KEY from wrangler
cd orchestrator
WORKER_URL=$(npx wrangler secret list 2>/dev/null | grep WORKER_URL | awk '{print $1}')
API_KEY=$(npx wrangler secret list 2>/dev/null | grep API_KEY | awk '{print $1}')
cd ..

if [ -z "$WORKER_URL" ]; then
    echo "Error: WORKER_URL secret not found. Run: cd orchestrator && npx wrangler secret put WORKER_URL"
    exit 1
fi

if [ -z "$API_KEY" ]; then
    echo "Error: API_KEY secret not found. Run: cd orchestrator && npx wrangler secret put API_KEY"
    exit 1
fi

# Prompt for WORKER_URL value (needed in config, not just as secret name)
echo "Enter the deployed WORKER_URL (e.g., https://product-engineer.your-subdomain.workers.dev):"
read -r WORKER_URL_VALUE

if [ -z "$WORKER_URL_VALUE" ]; then
    echo "Error: WORKER_URL value is required"
    exit 1
fi

# Prompt for API_KEY
echo ""
echo "Enter the API_KEY value:"
read -r -s API_KEY_VALUE
echo ""

if [ -z "$API_KEY_VALUE" ]; then
    echo "Error: API_KEY value is required"
    exit 1
fi

# Fetch current product config
echo "Fetching current product-engineer config..."
CURRENT_CONFIG=$(curl -s -H "X-API-Key: $API_KEY_VALUE" "$WORKER_URL_VALUE/api/products/product-engineer")

if echo "$CURRENT_CONFIG" | grep -q "error"; then
    echo "Error fetching current config: $CURRENT_CONFIG"
    echo ""
    echo "Note: If the product doesn't exist yet, you need to create it first."
    exit 1
fi

# Extract the product config
PRODUCT_CONFIG=$(echo "$CURRENT_CONFIG" | jq -r '.product')

# Add agent_secrets and agent_prompt
UPDATED_CONFIG=$(echo "$PRODUCT_CONFIG" | jq \
    --arg worker_url "$WORKER_URL_VALUE" \
    --arg api_key "$API_KEY_VALUE" \
    '. + {
        "agent_secrets": {
            "WORKER_URL": "WORKER_URL",
            "API_KEY": "API_KEY"
        },
        "agent_prompt": "## Admin Access\n\nYou have admin access to the Product Engineer orchestrator. Use this for managing products, settings, and viewing system status.\n\n**Available endpoints:**\n- `GET '"$worker_url"'/api/products` - List all products\n- `GET '"$worker_url"'/api/products/:slug` - Get product config\n- `POST '"$worker_url"'/api/products` - Create product\n- `PUT '"$worker_url"'/api/products/:slug` - Update product\n- `DELETE '"$worker_url"'/api/products/:slug` - Delete product\n- `GET '"$worker_url"'/api/settings` - List settings\n- `PUT '"$worker_url"'/api/settings/:key` - Update setting\n- `GET '"$worker_url"'/api/tickets` - List tickets\n- `GET '"$worker_url"'/api/status` - System status\n\n**Authentication:**\nAll requests require `X-API-Key` header. Use the API_KEY env var: `'"$api_key"'`\n\n**Example:**\n```bash\ncurl -H \"X-API-Key: $API_KEY\" '"$worker_url"'/api/products\n```"
    }')

# Show the diff
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Changes to be applied:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Adding agent_secrets:"
echo "  - WORKER_URL: $WORKER_URL_VALUE"
echo "  - API_KEY: [redacted]"
echo ""
echo "Adding agent_prompt with admin API documentation"
echo ""

# Confirm
echo -n "Apply these changes? (y/n): "
read -r CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted."
    exit 0
fi

# Update via API
echo ""
echo "Updating product-engineer config..."
RESULT=$(curl -s -X PUT \
    -H "X-API-Key: $API_KEY_VALUE" \
    -H "Content-Type: application/json" \
    -d "{\"config\": $UPDATED_CONFIG}" \
    "$WORKER_URL_VALUE/api/products/product-engineer")

if echo "$RESULT" | grep -q "\"ok\":true"; then
    echo "✅ Successfully updated product-engineer config"
    echo ""
    echo "Ticket agents working on product-engineer will now have:"
    echo "  - Access to WORKER_URL and API_KEY environment variables"
    echo "  - Documentation on admin API endpoints in their prompt"
else
    echo "❌ Failed to update config:"
    echo "$RESULT"
    exit 1
fi
