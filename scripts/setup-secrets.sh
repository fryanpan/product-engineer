#!/bin/bash
# Setup remaining secrets for the product-engineer worker.
# Run from orchestrator/ directory: cd orchestrator && bash ../scripts/setup-secrets.sh
#
# Secrets already set: API_KEY, ORCHESTRATOR_URL, LINEAR_WEBHOOK_SECRET, GITHUB_WEBHOOK_SECRET
# This script sets the remaining 7 secrets.

set -e
cd "$(dirname "$0")/../orchestrator"

echo "=== Product Engineer — Secret Setup ==="
echo ""
echo "This will set secrets for the product-engineer Cloudflare Worker."
echo "You can find most of these in your existing health-tool worker or service dashboards."
echo ""

# Helper function
set_secret() {
  local name="$1"
  local hint="$2"
  echo "---"
  echo "Secret: $name"
  echo "Hint: $hint"
  echo -n "Value (or 'skip' to skip): "
  read -r value
  if [ "$value" = "skip" ]; then
    echo "Skipped $name"
    return
  fi
  echo "$value" | npx wrangler secret put "$name"
  echo "✅ Set $name"
}

set_secret "ANTHROPIC_API_KEY" "Same as health-tool. Find at console.anthropic.com → API Keys"
set_secret "SLACK_BOT_TOKEN" "Starts with xoxb-. Same as health-tool. Find at api.slack.com → Your App → OAuth"
set_secret "SLACK_APP_TOKEN" "Starts with xapp-. Same as health-tool. Find at api.slack.com → Your App → Basic Info → App-Level Tokens"
set_secret "SLACK_SIGNING_SECRET" "Find at api.slack.com → Your App → Basic Info → Signing Secret"
set_secret "LINEAR_API_KEY" "Find at linear.app → Settings → API → Personal API Keys"
set_secret "HEALTH_TOOL_GITHUB_TOKEN" "GitHub PAT with repo access to fryanpan/health-tool"
set_secret "BIKE_TOOL_GITHUB_TOKEN" "GitHub PAT with repo access to fryanpan/bike-tool"

echo ""
echo "=== Done! ==="
echo "Run 'npx wrangler secret list' to verify."
