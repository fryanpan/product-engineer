#!/bin/bash
# Create Linear webhook for the product-engineer orchestrator.
# Requires: LINEAR_API_KEY set as environment variable or passed as argument.
#
# Usage: LINEAR_API_KEY=lin_api_xxx bash scripts/setup-linear-webhook.sh

set -e

API_KEY="${LINEAR_API_KEY:-$1}"
if [ -z "$API_KEY" ]; then
  echo "Error: LINEAR_API_KEY not set. Pass as env var or first argument."
  echo "Usage: LINEAR_API_KEY=lin_api_xxx bash scripts/setup-linear-webhook.sh"
  exit 1
fi

WEBHOOK_URL="https://product-engineer.fryanpan.workers.dev/api/webhooks/linear"
LINEAR_WEBHOOK_SECRET=$(cat /tmp/pe-linear-webhook-secret.txt 2>/dev/null || echo "")

if [ -z "$LINEAR_WEBHOOK_SECRET" ]; then
  echo "Warning: /tmp/pe-linear-webhook-secret.txt not found."
  echo "The LINEAR_WEBHOOK_SECRET was already set in Cloudflare. Enter it here to match:"
  echo -n "LINEAR_WEBHOOK_SECRET: "
  read -r LINEAR_WEBHOOK_SECRET
fi

echo "Creating Linear webhook..."
echo "URL: $WEBHOOK_URL"
echo ""

RESPONSE=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $API_KEY" \
  -d "{
    \"query\": \"mutation { webhookCreate(input: { url: \\\"$WEBHOOK_URL\\\", resourceTypes: [\\\"Issue\\\", \\\"Comment\\\"], secret: \\\"$LINEAR_WEBHOOK_SECRET\\\", enabled: true, label: \\\"Product Engineer Orchestrator\\\" }) { success webhook { id url enabled } } }\"
  }")

echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"

echo ""
echo "Done! The webhook will fire on issue create/update events."
echo "Verify at: linear.app → Settings → API → Webhooks"
