#!/bin/bash
# Script to clean up all active agents in the Product Engineer system

set -e

echo "🔍 Checking current system status..."

# Get current status (requires API key from environment or Cloudflare secrets)
# This script should be run with wrangler or with the API_KEY env var set

if [ -z "$API_KEY" ]; then
    echo "⚠️  API_KEY not set. Attempting to use wrangler to interact with the orchestrator..."

    # Use wrangler to directly interact with the DO
    echo ""
    echo "📊 Getting active agents from database..."

    # Since we can't easily run SQL commands directly via wrangler,
    # let's create a temporary endpoint approach or use the existing status endpoint

    echo ""
    echo "❌ This script requires API_KEY to be set or needs to be run via wrangler with DO access"
    echo ""
    echo "To clean up all agents manually:"
    echo "1. Get system status: curl -H 'X-API-Key: \$API_KEY' \$WORKER_URL/api/orchestrator/status"
    echo "2. Run cleanup: curl -X POST -H 'X-API-Key: \$API_KEY' \$WORKER_URL/api/orchestrator/cleanup-inactive"
    echo ""
    echo "To force-mark all agents as inactive (requires direct DO access):"
    echo "   wrangler d1 execute ... or similar Cloudflare tooling"

    exit 1
fi

# WORKER_URL should be set as an environment variable
if [ -z "$WORKER_URL" ]; then
    echo "⚠️  WORKER_URL not set. Please set it to your deployed worker URL."
    echo "   Example: export WORKER_URL=https://product-engineer.your-subdomain.workers.dev"
    exit 1
fi

echo ""
echo "📊 Current system status:"
curl -s -H "X-API-Key: $API_KEY" "$WORKER_URL/api/orchestrator/status" | jq .

echo ""
echo ""
echo "🧹 Running cleanup for inactive agents..."
curl -s -X POST -H "X-API-Key: $API_KEY" "$WORKER_URL/api/orchestrator/cleanup-inactive" | jq .

echo ""
echo "✅ Cleanup complete!"
