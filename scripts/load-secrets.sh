#!/usr/bin/env bash
# Load secrets from GCP Secret Manager into environment variables.
# Usage:
#   eval $(./scripts/load-secrets.sh staging)   # loads from product-engineer-staging
#   eval $(./scripts/load-secrets.sh prod)       # loads from product-engineer-prod
#   source <(./scripts/load-secrets.sh staging)  # alternative syntax
#
# For E2E tests:
#   eval $(./scripts/load-secrets.sh staging) && bun run scripts/e2e-staging-test.ts

set -euo pipefail

ENV="${1:-staging}"

case "$ENV" in
  staging)
    PROJECT="product-engineer-staging"
    SECRETS=(API_KEY SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_USER_TOKEN LINEAR_API_KEY STAGING_GITHUB_TOKEN ANTHROPIC_API_KEY LINEAR_WEBHOOK_SECRET GITHUB_WEBHOOK_SECRET WORKER_URL)
    ;;
  prod|production)
    PROJECT="product-engineer-prod"
    SECRETS=(API_KEY SLACK_BOT_TOKEN SLACK_APP_TOKEN LINEAR_API_KEY GITHUB_TOKEN ANTHROPIC_API_KEY GITHUB_WEBHOOK_SECRET WORKER_URL SENTRY_DSN NOTION_TOKEN CONTEXT7_TOKEN SENTRY_TOKEN CLOUDFLARE_READ_TOKEN)
    ;;
  *)
    echo "Usage: $0 [staging|prod]" >&2
    exit 1
    ;;
esac

for SECRET in "${SECRETS[@]}"; do
  VALUE=$(gcloud secrets versions access latest --secret="$SECRET" --project="$PROJECT" 2>/dev/null) || {
    echo "# WARNING: Failed to read $SECRET from $PROJECT" >&2
    continue
  }
  # Map STAGING_GITHUB_TOKEN → GITHUB_TOKEN for E2E compatibility
  if [ "$SECRET" = "STAGING_GITHUB_TOKEN" ]; then
    echo "export GITHUB_TOKEN='$VALUE'"
    echo "export STAGING_GITHUB_TOKEN='$VALUE'"
  else
    echo "export $SECRET='$VALUE'"
  fi
done
