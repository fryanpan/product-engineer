#!/bin/bash
# Create Linear webhook for the product-engineer orchestrator.
#
# Usage:
#   LINEAR_API_KEY=lin_api_xxx bash scripts/setup-linear-webhook.sh
#
# Or if LINEAR_API_KEY was already set via 'wrangler secret', paste it when prompted.

set -e

API_KEY="${LINEAR_API_KEY:-$1}"
if [ -z "$API_KEY" ]; then
  echo "━━━ Linear Webhook Setup ━━━"
  echo ""
  echo "  This creates a webhook so Linear issue changes trigger the PE agent."
  echo ""
  echo "  Open: https://linear.app/settings/api"
  echo "  Copy your Personal API key (the one you just created in setup-secrets.sh)"
  echo ""
  echo -n "  Paste LINEAR_API_KEY: "
  read -r API_KEY
  if [ -z "$API_KEY" ]; then
    echo "  No key provided. Exiting."
    exit 1
  fi
fi

WEBHOOK_URL="https://product-engineer.fryanpan.workers.dev/api/webhooks/linear"

# Read the webhook secret that was already set in Cloudflare
# (It was generated and set during initial deployment)
echo ""
echo "  The LINEAR_WEBHOOK_SECRET was set in Cloudflare during initial setup."
echo "  If you don't remember it, you can find it in Cloudflare dashboard:"
echo "  https://dash.cloudflare.com → Workers & Pages → product-engineer → Settings → Variables"
echo ""
echo -n "  Paste LINEAR_WEBHOOK_SECRET: "
read -r LINEAR_WEBHOOK_SECRET

if [ -z "$LINEAR_WEBHOOK_SECRET" ]; then
  echo "  No secret provided. Creating webhook WITHOUT secret verification."
  echo "  (You can add it later in Linear → Settings → API → Webhooks)"
  SECRET_PART=""
else
  SECRET_PART=", secret: \\\"$LINEAR_WEBHOOK_SECRET\\\""
fi

echo ""
echo "Creating Linear webhook..."
echo "  URL: $WEBHOOK_URL"
echo "  Events: Issue, Comment"
echo ""

RESPONSE=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $API_KEY" \
  -d "{
    \"query\": \"mutation { webhookCreate(input: { url: \\\"$WEBHOOK_URL\\\", resourceTypes: [\\\"Issue\\\", \\\"Comment\\\"]${SECRET_PART}, enabled: true, label: \\\"Product Engineer Orchestrator\\\" }) { success webhook { id url enabled } } }\"
  }")

echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

echo ""
echo "✅ Done!"
echo ""
echo "Verify at: https://linear.app/settings/api → Webhooks"
echo ""
