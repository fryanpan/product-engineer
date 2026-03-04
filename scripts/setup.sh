#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Product Engineer — Unified Setup
#
# Walks through ALL manual setup: external services, secrets,
# webhooks, and GitHub Actions. Idempotent — safe to re-run.
#
# Usage:
#   bash scripts/setup.sh
# ══════════════════════════════════════════════════════════════

set -e
cd "$(dirname "$0")/.."
ORCHESTRATOR_DIR="$(pwd)/orchestrator"

# ─── Helpers ──────────────────────────────────────────────────

set_secret() {
  local name="$1"
  local hint="$2"
  echo ""
  [ -n "$hint" ] && echo "  $hint"
  echo -n "  Paste value (or press Enter to skip): "
  read -r value
  if [ -z "$value" ] || [ "$value" = "skip" ]; then
    echo "  ⏭  Skipped $name"
    return
  fi
  echo "$value" | (cd "$ORCHESTRATOR_DIR" && npx wrangler secret put "$name" 2>&1 | tail -1)
  echo "  ✅ $name set"
}

auto_secret() {
  local name="$1"
  local value
  value=$(openssl rand -hex 32)
  echo "$value" | (cd "$ORCHESTRATOR_DIR" && npx wrangler secret put "$name" 2>&1 | tail -1)
  echo "  ✅ $name auto-generated"
  # Return the value so callers can use it
  eval "GENERATED_${name}='$value'"
}

section() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

pause() {
  echo ""
  echo -n "  Press Enter when ready to continue..."
  read -r
}

cat <<'BANNER'

  ╔══════════════════════════════════════════════════════════╗
  ║         Product Engineer — Setup                        ║
  ╠══════════════════════════════════════════════════════════╣
  ║  This script walks through all external service setup   ║
  ║  and secret provisioning. Safe to re-run at any time.   ║
  ║                                                         ║
  ║  Type 'skip' or press Enter to skip any prompt.         ║
  ╚══════════════════════════════════════════════════════════╝

BANNER

# ══════════════════════════════════════════════════════════════
# 1. AUTO-GENERATED SECRETS
# ══════════════════════════════════════════════════════════════

section "1. Auto-Generated Secrets"
echo ""
echo "  These are random strings used for internal auth."
echo "  They'll be auto-generated if you continue."
echo ""
echo -n "  Generate API_KEY, LINEAR_WEBHOOK_SECRET, GITHUB_WEBHOOK_SECRET? [Y/n]: "
read -r confirm
if [ "$confirm" != "n" ] && [ "$confirm" != "N" ]; then
  auto_secret "API_KEY"
  auto_secret "LINEAR_WEBHOOK_SECRET"
  auto_secret "GITHUB_WEBHOOK_SECRET"
else
  echo "  ⏭  Skipped auto-generation"
fi

# ══════════════════════════════════════════════════════════════
# 2. ANTHROPIC
# ══════════════════════════════════════════════════════════════

section "2. Anthropic API Key"
cat <<'STEP'

  1. Open: https://console.anthropic.com/settings/keys
  2. Click "Create Key"
  3. Name: "product-engineer"
  4. Copy the key (starts with sk-ant-)

STEP
set_secret "ANTHROPIC_API_KEY"

# ══════════════════════════════════════════════════════════════
# 3. SLACK APP
# ══════════════════════════════════════════════════════════════

section "3. Slack App"
cat <<'STEP'

  1. Open: https://api.slack.com/apps?new_app=1
  2. Choose "From an app manifest"
  3. Pick your workspace
  4. Paste the YAML from scripts/slack-app-manifest.yaml
     (or copy from below)
  5. Click "Next" → review → "Create"

STEP
echo "  ── Manifest ──"
cat scripts/slack-app-manifest.yaml | sed 's/^/  │ /'
echo ""

echo "  ── 3a. App-Level Token ──"
cat <<'STEP'

  1. You're on the app's Basic Information page
  2. Scroll to "App-Level Tokens" → "Generate Token and Scopes"
  3. Token Name: "socket"
  4. Add scope: connections:write
  5. Click "Generate"
  6. Copy the token (starts with xapp-)

STEP
set_secret "SLACK_APP_TOKEN" "Paste the xapp-... token"

echo ""
echo "  ── 3b. Bot Token ──"
cat <<'STEP'

  1. Left sidebar → "Install App"
  2. Click "Install to Workspace" → "Allow"
  3. Copy the "Bot User OAuth Token" (starts with xoxb-)

STEP
set_secret "SLACK_BOT_TOKEN" "Paste the xoxb-... token"

echo ""
echo "  ── 3c. Signing Secret ──"
cat <<'STEP'

  1. Left sidebar → "Basic Information"
  2. Under "App Credentials" → "Signing Secret" → click "Show"
  3. Copy the secret

STEP
set_secret "SLACK_SIGNING_SECRET"

echo ""
echo "  ── 3d. Invite bot to channels ──"
cat <<'STEP'

  In Slack, invite the bot to each product channel:
    /invite @product-engineer   (in #<your-channel>)

  Repeat for each product you've registered.

STEP
pause

# ══════════════════════════════════════════════════════════════
# 4. LINEAR
# ══════════════════════════════════════════════════════════════

section "4. Linear"

echo ""
echo "  ── 4a. Personal API Key ──"
cat <<'STEP'

  1. Open: https://linear.app/settings/account/security
  2. Scroll to "API keys" → click "Create key"
  3. Label: "product-engineer"
  4. Copy the key (starts with lin_api_)

STEP
set_secret "LINEAR_API_KEY"

echo ""
echo "  ── 4b. Linear Webhook ──"
cat <<'STEP'

  1. Open: https://linear.app/settings/api
  2. Scroll to "Webhooks" → "New webhook"
  3. Label: "Product Engineer"
  4. URL: https://product-engineer.<your-subdomain>.workers.dev/api/webhooks/linear
  5. Events: check "Issues" (creates, updates)
  6. Secret: use the LINEAR_WEBHOOK_SECRET generated in step 1
     (run: cd orchestrator && npx wrangler secret list  to verify it's set)
  7. Click "Create webhook"

STEP
pause

# ══════════════════════════════════════════════════════════════
# 5. GITHUB PATS (per-product)
# ══════════════════════════════════════════════════════════════

section "5. GitHub Personal Access Tokens"
cat <<'STEP'

  Each product in your registry needs a fine-grained GitHub PAT.
  The secret name convention is <PRODUCT>_GITHUB_TOKEN, where
  <PRODUCT> is the uppercased, underscored product key from the
  registry (e.g., product "my-app" → MY_APP_GITHUB_TOKEN).

  Repeat the steps below for EACH product:

  1. Open: https://github.com/settings/tokens?type=beta
  2. Click "Generate new token"
  3. Token name: "pe-<your-product>"
  4. Expiration: 90 days (or custom)
  5. Resource owner: <your-org>
  6. Repository access → "Only select repositories" → <your-org>/<your-repo>
  7. Permissions → Repository permissions:
     - Contents: Read and write
     - Pull requests: Read and write
     - Issues: Read and write
  8. Click "Generate token"
  9. Copy the token (starts with github_pat_)

  Then set the secret:
    cd orchestrator && npx wrangler secret put <PRODUCT>_GITHUB_TOKEN

STEP
echo ""
echo -n "  How many product PATs to set up? [0 to skip]: "
read -r pat_count
pat_count=${pat_count:-0}
for i in $(seq 1 "$pat_count"); do
  echo ""
  echo -n "  Product secret name (e.g., MY_APP_GITHUB_TOKEN): "
  read -r pat_name
  if [ -n "$pat_name" ]; then
    set_secret "$pat_name"
  fi
done

# ══════════════════════════════════════════════════════════════
# 6. GITHUB WEBHOOKS (per-product repo)
# ══════════════════════════════════════════════════════════════

section "6. GitHub Webhooks"
cat <<'STEP'

  For EACH product repo:

  1. Open: https://github.com/<your-org>/<your-repo>/settings/hooks/new

  2. Payload URL: https://product-engineer.<your-subdomain>.workers.dev/api/webhooks/github
  3. Content type: application/json
  4. Secret: the GITHUB_WEBHOOK_SECRET generated in step 1
     (if you need the value, re-generate and update with:
      openssl rand -hex 32 | tee /dev/stderr | cd orchestrator && npx wrangler secret put GITHUB_WEBHOOK_SECRET)
  5. Which events? → "Let me select individual events":
     - Pull requests
     - Pull request reviews
  6. Click "Add webhook"

  Repeat for each product repo in your registry.

STEP
pause

# ══════════════════════════════════════════════════════════════
# 7. SENTRY
# ══════════════════════════════════════════════════════════════

section "7. Sentry"

echo ""
echo "  ── 7a. Create Project & Get DSN ──"
cat <<'STEP'

  1. Open: https://sentry.io/organizations/new/
     (or use existing org)
  2. Create a Node.js project named "product-engineer"
     Open: https://sentry.io/settings/ → Projects → "Create Project"
  3. Select "Node.js" as platform
  4. Copy the DSN from the setup page
     (looks like: https://xxxxx@oNNNN.ingest.us.sentry.io/NNNNN)

STEP
set_secret "SENTRY_DSN" "(optional — skip if you don't want error tracking)"

echo ""
echo "  ── 7b. User Auth Token (for Sentry MCP) ──"
cat <<'STEP'

  1. Open: https://sentry.io/settings/account/api/auth-tokens/new-token/
  2. Scopes needed: org:read, project:read, project:write
  3. Click "Create Token"
  4. Copy the token (starts with sntrys_)

STEP
set_secret "SENTRY_ACCESS_TOKEN" "(optional — skip if you don't need Sentry MCP)"

# ══════════════════════════════════════════════════════════════
# 8. NOTION
# ══════════════════════════════════════════════════════════════

section "8. Notion Integration"
cat <<'STEP'

  1. Open: https://www.notion.so/profile/integrations
  2. Click "New integration" (or use existing)
  3. Name: "Product Engineer"
  4. Select your workspace
  5. Capabilities: Read content, Update content, Insert content,
     Read comments, Create comments
  6. Click "Submit"
  7. Copy the "Internal Integration Secret" (starts with ntn_)

  IMPORTANT: After creating, share relevant Notion pages/databases
  with the integration:
    - Open the page → "..." menu → "Connections" → add "Product Engineer"

STEP
set_secret "NOTION_TOKEN" "(optional — skip if you don't need Notion MCP)"

# ══════════════════════════════════════════════════════════════
# 9. CONTEXT7
# ══════════════════════════════════════════════════════════════

section "9. Context7 API Key"
cat <<'STEP'

  1. Open: https://context7.com
  2. Sign up / log in
  3. Go to API Keys → "Create API Key"
  4. Copy the key (starts with ctx7sk-)

  Note: Context7 works without a key (lower rate limits).
  This is optional but recommended.

STEP
set_secret "CONTEXT7_API_KEY" "(optional — works without, lower rate limits)"

# ══════════════════════════════════════════════════════════════
# 10. GITHUB ACTIONS SECRETS
# ══════════════════════════════════════════════════════════════

section "10. GitHub Actions Secrets (for CI/CD)"
cat <<'STEP'

  The deploy pipeline needs two secrets in the GitHub repo.

  ── 10a. Cloudflare Account ID ──

  1. Open: https://dash.cloudflare.com
  2. Click "Workers & Pages" in the left sidebar
  3. Your Account ID is shown on the right side
  4. Copy it

  ── 10b. Cloudflare API Token ──

  1. Open: https://dash.cloudflare.com/profile/api-tokens
  2. Click "Create Token"
  3. Use "Custom token" template
  4. Permissions:
     - Account → Cloudflare Workers → Edit
  5. Account Resources: your account
  6. Click "Continue to summary" → "Create Token"
  7. Copy the token

  ── 10c. Add both to GitHub ──

  1. Open: https://github.com/<your-org>/product-engineer/settings/secrets/actions
  2. "New repository secret" → Name: CLOUDFLARE_ACCOUNT_ID → paste value
  3. "New repository secret" → Name: CLOUDFLARE_API_TOKEN → paste value

STEP
pause

# ══════════════════════════════════════════════════════════════
# 11. WORKER URL (deployment-specific)
# ══════════════════════════════════════════════════════════════

section "11. Worker URL"
cat <<'STEP'

  The orchestrator container needs WORKER_URL set to the deployed
  Worker URL. This is how it forwards Slack events back to the Worker.

  The URL is typically: https://product-engineer.<your-subdomain>.workers.dev

STEP

echo -n "  Enter your Worker URL (e.g., https://product-engineer.example.workers.dev): "
read -r worker_url
if [ -n "$worker_url" ] && [ "$worker_url" != "skip" ]; then
  echo "$worker_url" | (cd "$ORCHESTRATOR_DIR" && npx wrangler secret put WORKER_URL 2>&1 | tail -1)
  echo "  ✅ WORKER_URL set on orchestrator"
else
  echo "  ⏭  Skipped WORKER_URL (set it before deploying!)"
fi

# ══════════════════════════════════════════════════════════════
# VERIFICATION
# ══════════════════════════════════════════════════════════════

section "Verification"
echo ""
echo "  Checking Cloudflare Workers secrets..."
echo ""
(cd "$ORCHESTRATOR_DIR" && npx wrangler secret list 2>&1) | grep '"name"' | sed 's/.*"name": "/  ✓ /' | sed 's/".*//'

echo ""
echo "  Expected secrets (core + per-product):"
echo "    API_KEY, ANTHROPIC_API_KEY"
echo "    SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET"
echo "    LINEAR_API_KEY, LINEAR_WEBHOOK_SECRET"
echo "    GITHUB_WEBHOOK_SECRET"
echo "    WORKER_URL"
echo "    <PRODUCT>_GITHUB_TOKEN (one per product)"
echo "    SENTRY_DSN, SENTRY_ACCESS_TOKEN (optional)"
echo "    NOTION_TOKEN (optional)"
echo "    CONTEXT7_API_KEY (optional)"

echo ""
echo "  Checking GitHub Actions secrets..."
echo ""
GITHUB_REPO=$(git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]||' | sed 's|\.git$||')
if [ -n "$GITHUB_REPO" ]; then
  gh secret list --repo "$GITHUB_REPO" 2>&1 | head -10 || echo "  (install gh CLI or check manually)"
else
  echo "  (could not detect GitHub repo from git remote — check manually)"
fi

cat <<'DONE'

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Setup complete!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Next steps:
    1. Deploy:
       cd orchestrator && npx wrangler deploy
    2. Test:
       curl https://product-engineer.<your-subdomain>.workers.dev/health

  Debugging:
    cd orchestrator && npx wrangler tail

DONE
