#!/bin/bash
# Setup secrets for the product-engineer worker.
# Run from anywhere: bash scripts/setup-secrets.sh
#
# Already set: API_KEY, ORCHESTRATOR_URL, LINEAR_WEBHOOK_SECRET, GITHUB_WEBHOOK_SECRET

set -e
cd "$(dirname "$0")/../orchestrator"

set_secret() {
  local name="$1"
  echo -n "  Paste value: "
  read -r value
  if [ -z "$value" ] || [ "$value" = "skip" ]; then
    echo "  ⏭  Skipped $name"
    return
  fi
  echo "$value" | npx wrangler secret put "$name" 2>&1 | tail -1
  echo "  ✅ Set $name"
}

cat <<'HEADER'
╔══════════════════════════════════════════════════════════════╗
║          Product Engineer — Secret Setup                     ║
╚══════════════════════════════════════════════════════════════╝

Work through each section below. Paste the value when prompted.
Type 'skip' or press Enter to skip any secret.

HEADER

# ─── 1. Anthropic ────────────────────────────────────────────
cat <<'STEP'
━━━ 1. ANTHROPIC_API_KEY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Open: https://console.anthropic.com/settings/keys

  Steps:
  1. Click "Create Key"
  2. Name it "product-engineer"
  3. Copy the key (starts with sk-ant-)

STEP
set_secret "ANTHROPIC_API_KEY"
echo ""

# ─── 2. Slack App (NEW — "Product Engineer") ────────────────
cat <<'STEP'
━━━ 2. SLACK APP — Create "Product Engineer" app ━━━━━━━━━━━━

  Open: https://api.slack.com/apps?new_app=1
  Choose "From an app manifest" → pick your workspace → paste this YAML:

  ┌──────────────────────────────────────────────────────────┐
STEP

# Print the manifest (not inside a heredoc so it's easy to copy)
cat <<'MANIFEST'
  │  display_information:                                    │
  │    name: Product Engineer                                │
  │    description: Autonomous coding agent triggered by     │
  │      Linear, GitHub, and Slack                           │
  │    background_color: "#1a1a2e"                           │
  │                                                          │
  │  features:                                               │
  │    bot_user:                                             │
  │      display_name: product-engineer                      │
  │      always_online: true                                 │
  │    app_home:                                             │
  │      home_tab_enabled: false                             │
  │      messages_tab_enabled: false                         │
  │      messages_tab_read_only_enabled: false               │
  │                                                          │
  │  oauth_config:                                           │
  │    scopes:                                               │
  │      bot:                                                │
  │        - chat:write                                      │
  │        - app_mentions:read                               │
  │        - channels:history                                │
  │        - channels:read                                   │
  │                                                          │
  │  settings:                                               │
  │    event_subscriptions:                                  │
  │      bot_events:                                         │
  │        - app_mention                                     │
  │        - message.channels                                │
  │    socket_mode_enabled: true                             │
  │    org_deploy_enabled: false                             │
  │    token_rotation_enabled: false                         │
MANIFEST

cat <<'STEP'
  └──────────────────────────────────────────────────────────┘

  The plain YAML (for easy copying) is also at:
    scripts/slack-app-manifest.yaml

  Click "Next" → review → "Create"

  After creating:

  ── 2a. Generate App-Level Token ──
  You're now on the app's Basic Information page.
  Scroll to "App-Level Tokens" → "Generate Token and Scopes"
    • Token Name: "socket"
    • Add scope: connections:write
    • Click "Generate"
    • Copy the token (starts with xapp-)

  ── 2b. Install to Workspace ──
  Left sidebar → "Install App" → "Install to Workspace" → "Allow"
  Copy the "Bot User OAuth Token" (starts with xoxb-)

STEP

echo "━━━ 2b. SLACK_BOT_TOKEN ━━━"
echo "  (The xoxb- token from Install App → Bot User OAuth Token)"
set_secret "SLACK_BOT_TOKEN"
echo ""

echo "━━━ 2c. SLACK_APP_TOKEN ━━━"
echo "  (The xapp- token from step 2a above)"
set_secret "SLACK_APP_TOKEN"
echo ""

echo "━━━ 2d. SLACK_SIGNING_SECRET ━━━"
echo ""
echo "  On the app page → Basic Information → App Credentials → Signing Secret → 'Show'"
echo ""
set_secret "SLACK_SIGNING_SECRET"
echo ""

# ─── 3. Linear ──────────────────────────────────────────────
cat <<'STEP'
━━━ 3. LINEAR_API_KEY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Open: https://linear.app/settings/api

  Steps:
  1. Under "Personal API keys", click "Create key"
  2. Label: "product-engineer"
  3. Copy the key (starts with lin_api_)

STEP
set_secret "LINEAR_API_KEY"
echo ""

# ─── 4. GitHub PATs ──────────────────────────────────────────
cat <<'STEP'
━━━ 4. GitHub Personal Access Tokens ━━━━━━━━━━━━━━━━━━━━━━━━

  Open: https://github.com/settings/tokens?type=beta

  Create TWO fine-grained tokens (one per product repo):

  ── 4a. HEALTH_TOOL_GITHUB_TOKEN ──
  1. Click "Generate new token"
  2. Token name: "pe-health-tool"
  3. Expiration: 90 days (or custom)
  4. Repository access: "Only select repositories" → fryanpan/health-tool
  5. Permissions → Repository permissions:
     • Contents: Read and write
     • Pull requests: Read and write
     • Issues: Read and write
  6. Click "Generate token"
  7. Copy the token (starts with github_pat_)

STEP
set_secret "HEALTH_TOOL_GITHUB_TOKEN"
echo ""

cat <<'STEP'
  ── 4b. BIKE_TOOL_GITHUB_TOKEN ──
  Same steps as above, but:
  • Token name: "pe-bike-tool"
  • Repository: fryanpan/bike-tool

STEP
set_secret "BIKE_TOOL_GITHUB_TOKEN"
echo ""

# ─── 5. Invite bot to channels ──────────────────────────────
cat <<'STEP'
━━━ 5. Invite the bot to Slack channels ━━━━━━━━━━━━━━━━━━━━━

  In Slack, run these commands:
    /invite @Product Engineer    (in #health-tool)
    /invite @Product Engineer    (in #bike-tool)

━━━ Done! ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP

echo ""
echo "Verifying secrets..."
npx wrangler secret list 2>&1 | grep '"name"' | sed 's/.*"name": "/  ✓ /' | sed 's/".*//'
echo ""
echo "Next steps:"
echo "  1. Create Linear webhook:  bash scripts/setup-linear-webhook.sh"
echo "  2. Invite bot to Slack channels (see step 5 above)"
echo ""
