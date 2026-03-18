#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Setup Multiple Repos for Product Engineer
#
# Adds multiple products to the registry via the admin API.
# BC-167: Setup 7 repos with Slack and Linear integration
# ══════════════════════════════════════════════════════════════

set -e

# ─── Configuration ────────────────────────────────────────────

WORKER_URL="${WORKER_URL:-}"
API_KEY="${API_KEY:-}"
GITHUB_ORG="${GITHUB_ORG:-fryanpan}"
SHARED_GITHUB_TOKEN="${SHARED_GITHUB_TOKEN:-FRYANPAN_GITHUB_TOKEN}"

# ─── Product Definitions ──────────────────────────────────────

declare -A PRODUCTS=(
  ["givewell-impact"]="nonprofit-impact|Nonprofit Impact"
  ["blog-assistant"]="blog-assistant|Blog Assistant"
  ["tasks"]="tasks|Tasks"
  ["personal-crm"]="personal-crm|personal-crm"
  ["research-notes"]="research-notes|Research Notes"
  ["task-pilot"]="task-pilot|Task Pilot"
  ["personal-finance"]="personal-finance|Personal Finance"
)

# ─── Helpers ──────────────────────────────────────────────────

add_product() {
  local slug="$1"
  local slack_channel="$2"
  local linear_project="$3"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Adding: $slug"
  echo "  Slack: #$slack_channel"
  echo "  Linear: $linear_project"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "$WORKER_URL/api/products" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"slug\": \"$slug\",
      \"config\": {
        \"repos\": [\"$GITHUB_ORG/$slug\"],
        \"slack_channel\": \"#$slack_channel\",
        \"triggers\": {
          \"linear\": {
            \"enabled\": true,
            \"project_name\": \"$linear_project\"
          },
          \"slack\": { \"enabled\": true }
        },
        \"secrets\": {
          \"GITHUB_TOKEN\": \"$SHARED_GITHUB_TOKEN\",
          \"SLACK_BOT_TOKEN\": \"SLACK_BOT_TOKEN\",
          \"LINEAR_API_KEY\": \"LINEAR_API_KEY\",
          \"ANTHROPIC_API_KEY\": \"ANTHROPIC_API_KEY\",
          \"NOTION_TOKEN\": \"NOTION_TOKEN\",
          \"SENTRY_ACCESS_TOKEN\": \"SENTRY_ACCESS_TOKEN\",
          \"CONTEXT7_API_KEY\": \"CONTEXT7_API_KEY\"
        }
      }
    }")

  local body=$(echo "$response" | head -n -1)
  local http_code=$(echo "$response" | tail -n 1)

  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    echo "  ✅ Added $slug to registry"
  else
    echo "  ❌ Failed to add $slug (HTTP $http_code)"
    echo "  Response: $body"
    return 1
  fi
}

verify_product() {
  local slug="$1"

  local response
  response=$(curl -s -w "\n%{http_code}" "$WORKER_URL/api/products/$slug" \
    -H "X-API-Key: $API_KEY")

  local body=$(echo "$response" | head -n -1)
  local http_code=$(echo "$response" | tail -n 1)

  if [ "$http_code" = "200" ]; then
    echo "  ✓ $slug"
  else
    echo "  ✗ $slug (not found)"
  fi
}

# ─── Preflight ────────────────────────────────────────────────

if [ -z "$WORKER_URL" ]; then
  echo "Error: WORKER_URL not set"
  echo "Usage: WORKER_URL=https://... API_KEY=... bash scripts/setup-repos.sh"
  exit 1
fi

if [ -z "$API_KEY" ]; then
  echo "Error: API_KEY not set"
  echo "Usage: WORKER_URL=https://... API_KEY=... bash scripts/setup-repos.sh"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║         Setup 7 Repos — BC-167                          ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Worker: $(printf '%-46s' "$WORKER_URL")║"
echo "║  GitHub Org: $(printf '%-42s' "$GITHUB_ORG")║"
echo "║  Shared Token: $(printf '%-40s' "$SHARED_GITHUB_TOKEN")║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─── Add Products ─────────────────────────────────────────────

for slug in "${!PRODUCTS[@]}"; do
  IFS='|' read -r slack_channel linear_project <<< "${PRODUCTS[$slug]}"
  add_product "$slug" "$slack_channel" "$linear_project" || true
done

# ─── Verify ───────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

for slug in "${!PRODUCTS[@]}"; do
  verify_product "$slug"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Next Steps"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  1. Create Slack channels (if they don't exist):"
for slug in "${!PRODUCTS[@]}"; do
  IFS='|' read -r slack_channel linear_project <<< "${PRODUCTS[$slug]}"
  echo "     - #$slack_channel"
done
echo ""
echo "  2. Invite @PE bot to each channel:"
echo "     /invite @product-engineer"
echo ""
echo "  3. Create Linear projects (if they don't exist):"
for slug in "${!PRODUCTS[@]}"; do
  IFS='|' read -r slack_channel linear_project <<< "${PRODUCTS[$slug]}"
  echo "     - $linear_project"
done
echo ""
echo "  4. Verify GitHub repos exist (or create them):"
for slug in "${!PRODUCTS[@]}"; do
  echo "     - $GITHUB_ORG/$slug"
done
echo ""
echo "  5. Set up each repo with Claude templates:"
echo "     - Use /add-project or /propagate skill"
echo "     - Ensure CLAUDE.md, .claude/settings.json, .mcp.json exist"
echo ""
echo "  6. Test each integration:"
echo "     - Create a test Linear ticket in each project"
echo "     - Or mention @PE in each Slack channel"
echo ""
