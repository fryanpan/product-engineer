#!/bin/bash
# Complete Dashboard Setup Script
# This script guides you through the remaining dashboard setup steps

set -e

WORKER_URL="${WORKER_URL:-}"
API_KEY="${API_KEY:-}"

echo "🚀 Product Engineer Dashboard Setup"
echo "===================================="
echo ""

# Check environment
if [ -z "$WORKER_URL" ]; then
    echo "⚠️  WORKER_URL not set. Please set it first:"
    echo "   export WORKER_URL=https://product-engineer.YOUR_SUBDOMAIN.workers.dev"
    echo ""
    read -p "Enter your Worker URL: " WORKER_URL
    export WORKER_URL
fi

if [ -z "$API_KEY" ]; then
    echo "⚠️  API_KEY not set. Get it from wrangler secret list or your secrets manager."
    echo ""
    read -sp "Enter your API_KEY: " API_KEY
    echo ""
    export API_KEY
fi

echo ""
echo "📋 Dashboard Setup Checklist"
echo "============================="
echo ""
echo "✅ KV namespace: Already configured (wrangler.toml)"
echo "✅ Dashboard code: Complete"
echo ""
echo "❓ Status check..."
echo ""

# Check current settings
echo "Checking current AI Gateway configuration..."
SETTINGS_RESPONSE=$(curl -s -H "X-API-Key: $API_KEY" "$WORKER_URL/api/settings")
echo "$SETTINGS_RESPONSE" | grep -q "cloudflare_ai_gateway" && echo "✅ AI Gateway configured" || echo "⚠️  AI Gateway not configured"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📝 MANUAL STEPS REQUIRED"
echo ""
echo "1️⃣  Google OAuth Setup"
echo "   ---------------------------------"
echo "   a) Go to: https://console.cloud.google.com/apis/credentials"
echo "   b) Create OAuth 2.0 Client ID (Web application)"
echo "   c) Add redirect URI: $WORKER_URL/api/auth/callback"
echo "   d) Save Client ID and Client Secret"
echo ""
echo "   Then run these commands:"
echo "   cd api"
echo "   wrangler secret put GOOGLE_CLIENT_ID"
echo "   wrangler secret put GOOGLE_CLIENT_SECRET"
echo "   wrangler secret put ALLOWED_EMAILS  # your@email.com,other@email.com"
echo ""

echo "2️⃣  Cloudflare AI Gateway Setup"
echo "   ---------------------------------"
echo "   a) Go to: https://dash.cloudflare.com/"
echo "   b) Navigate to: AI > AI Gateway"
echo "   c) Click 'Create Gateway'"
echo "   d) Name it: 'product-engineer' (or your choice)"
echo "   e) Note your Account ID and Gateway ID"
echo ""
echo "   Then configure via API:"
read -p "   Do you have your AI Gateway credentials ready? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    read -p "   Enter Cloudflare Account ID: " ACCOUNT_ID
    read -p "   Enter Gateway ID (slug): " GATEWAY_ID

    echo ""
    echo "   Configuring AI Gateway..."

    curl -X PUT "$WORKER_URL/api/settings/cloudflare_ai_gateway" \
        -H "X-API-Key: $API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"value\": {\"account_id\": \"$ACCOUNT_ID\", \"gateway_id\": \"$GATEWAY_ID\"}}" \
        && echo "✅ AI Gateway configured successfully" \
        || echo "❌ Failed to configure AI Gateway"
else
    echo ""
    echo "   ⏭️  Skipping AI Gateway configuration for now."
    echo "   You can configure it later with:"
    echo ""
    echo "   curl -X PUT $WORKER_URL/api/settings/cloudflare_ai_gateway \\"
    echo "     -H \"X-API-Key: \$API_KEY\" \\"
    echo "     -H \"Content-Type: application/json\" \\"
    echo "     -d '{\"value\": {\"account_id\": \"YOUR_ACCOUNT_ID\", \"gateway_id\": \"YOUR_GATEWAY_ID\"}}'"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "3️⃣  Deploy"
echo "   ---------------------------------"
read -p "   Ready to deploy? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    cd api
    echo "   Deploying..."
    wrangler deploy
    echo "✅ Deployed successfully"
else
    echo "   ⏭️  Skipping deployment. Deploy manually with:"
    echo "   cd api && wrangler deploy"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "4️⃣  Verify Setup"
echo "   ---------------------------------"
echo "   a) Dashboard: $WORKER_URL/dashboard"
echo "   b) Test login with Google"
echo "   c) Check AI Gateway: https://dash.cloudflare.com/ > AI > AI Gateway"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "✨ Setup script complete!"
echo ""
echo "📚 Documentation:"
echo "   - Dashboard: README-DASHBOARD.md"
echo "   - Detailed setup: docs/dashboard-setup.md"
echo "   - AI Gateway: docs/cloudflare-ai-gateway.md"
echo ""
