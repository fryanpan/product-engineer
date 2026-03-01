#!/bin/bash
# Create Linear webhook for the product-engineer orchestrator.
#
# This script:
# 1. Generates a new webhook secret
# 2. Updates the Cloudflare Worker secret to match
# 3. Creates the webhook in Linear via GraphQL API
#
# Usage:
#   LINEAR_API_KEY=lin_api_xxx bash scripts/setup-linear-webhook.sh
#   (or paste the key when prompted)

set -e
cd "$(dirname "$0")/../orchestrator"

API_KEY="${LINEAR_API_KEY:-$1}"
if [ -z "$API_KEY" ]; then
  echo "━━━ Linear Webhook Setup ━━━"
  echo ""
  echo "  This creates a webhook so Linear issue changes trigger the PE agent."
  echo ""
  echo "  Open: https://linear.app/health-tool/settings/account/security"
  echo "  Copy your Personal API key"
  echo ""
  echo -n "  Paste LINEAR_API_KEY: "
  read -r API_KEY
  if [ -z "$API_KEY" ]; then
    echo "  No key provided. Exiting."
    exit 1
  fi
fi

WEBHOOK_URL="https://product-engineer.fryanpan.workers.dev/api/webhooks/linear"

# Generate a fresh webhook secret and set it in Cloudflare
echo ""
echo "Generating webhook secret..."
LINEAR_WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "$LINEAR_WEBHOOK_SECRET" | npx wrangler secret put LINEAR_WEBHOOK_SECRET 2>&1 | tail -1
echo "  ✅ LINEAR_WEBHOOK_SECRET set in Cloudflare"

echo ""
echo "Creating Linear webhook..."
echo "  URL: $WEBHOOK_URL"
echo "  Events: Issue, Comment"
echo ""

RESPONSE=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $API_KEY" \
  -d "{
    \"query\": \"mutation { webhookCreate(input: { url: \\\"$WEBHOOK_URL\\\", resourceTypes: [\\\"Issue\\\", \\\"Comment\\\"], secret: \\\"$LINEAR_WEBHOOK_SECRET\\\", allPublicTeams: true, enabled: true, label: \\\"Product Engineer Orchestrator\\\" }) { success webhook { id url enabled } } }\"
  }")

echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

echo ""
echo "✅ Done! Webhook secret is synced between Linear and Cloudflare."
echo ""
echo "Verify at: https://linear.app/health-tool/settings/api → Webhooks"
echo ""
