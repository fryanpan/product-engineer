# Cloudflare AI Gateway Integration

## Overview

All LLM traffic (via Claude Agent SDK) is routed through Cloudflare AI Gateway for monitoring, analytics, and cost tracking.

## Architecture

```
TicketAgent Container
  ↓ ANTHROPIC_BASE_URL env var
  ↓
Claude Agent SDK
  ↓ query() calls
  ↓
Cloudflare AI Gateway
  ↓ proxies to
  ↓
Anthropic API (api.anthropic.com)
```

## Configuration

### Environment Variables

The agent container requires two environment variables:

1. **`ANTHROPIC_API_KEY`** — Your Anthropic API key (unchanged)
2. **`ANTHROPIC_BASE_URL`** — Gateway endpoint (NEW)

Format: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic`

### Registry Configuration

The AI Gateway settings are stored in the Orchestrator DO's SQLite database (managed via admin API). The root config includes:

```json
{
  "cloudflare_ai_gateway": {
    "account_id": "YOUR_ACCOUNT_ID",
    "gateway_id": "YOUR_GATEWAY_ID"
  }
}
```

All products automatically use the shared gateway unless they override it.

### Secret Management

The `ANTHROPIC_BASE_URL` is constructed from registry values, not stored as a Cloudflare secret. This allows changing the gateway without re-deploying secrets.

## Setup Steps

### 1. Create AI Gateway

In the Cloudflare dashboard:
1. Navigate to **AI > AI Gateway**
2. Click **Create Gateway**
3. Choose a name (e.g., `product-engineer`, `pe-gateway`)
4. Note your **Account ID** and **Gateway ID** (slug)

### 2. Update Registry

Seed or update the AI Gateway config via the admin API. If seeding from a JSON file:

```json
{
  "cloudflare_ai_gateway": {
    "account_id": "abc123...",
    "gateway_id": "pe-gateway"
  },
  ...
}
```

### 3. Deploy

```bash
cd api
bun run deploy
```

The orchestrator will automatically inject `ANTHROPIC_BASE_URL` into agent containers.

### 4. Verify

After an agent runs:
1. Go to **Cloudflare Dashboard > AI > AI Gateway > [your gateway]**
2. Check the **Analytics** tab for:
   - Request count
   - Token usage
   - Cost tracking
   - Error rate
   - Cache hit rate (if caching enabled)

## Analytics Features

Cloudflare AI Gateway provides:

### Dashboard Metrics
- **Requests** — Total request count over time
- **Tokens** — Input/output token consumption
- **Costs** — Spend by model/provider
- **Errors** — Failed requests for troubleshooting
- **Cache Rate** — Percentage served from cache (if enabled)

### Filtering
- Time range selection (hour, day, week, month)
- Model breakdown
- Provider comparison

### GraphQL API
Query usage data programmatically:
```graphql
query {
  aiGatewayAnalytics(accountId: "...", gatewayId: "...") {
    requests
    tokens { input, output }
    cost
    errors
  }
}
```

### Log Details
Each request log includes:
- Full request/response bodies
- Timestamps and latency
- Token counts
- Model used
- Error messages (if any)

## Rate Limiting & Caching

AI Gateway supports (optional, not configured by default):
- **Rate limiting** — Control request throughput
- **Response caching** — Cache identical requests
- **Cost controls** — Set spending caps

See: [AI Gateway Features](https://developers.cloudflare.com/ai-gateway/features/)

## Troubleshooting

### Traffic Not Appearing

1. Check `ANTHROPIC_BASE_URL` is set correctly in agent logs
2. Verify Account ID and Gateway ID match dashboard
3. Ensure gateway name has no typos (case-sensitive)

### API Errors

If requests fail after adding gateway:
- Test the endpoint manually:
  ```bash
  curl https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":100,"messages":[{"role":"user","content":"Hi"}]}'
  ```
- Check Cloudflare dashboard for error details

### Dashboard Shows No Data

- Allow 1-2 minutes for data to appear after first request
- Refresh the page
- Check filters (time range, model selection)

## Cost Tracking

AI Gateway automatically calculates costs based on:
- Model pricing (Anthropic's rates)
- Input/output tokens per request
- Aggregated by hour/day/month

This provides visibility into:
- Per-product LLM spend
- High-traffic tickets/features
- Cost optimization opportunities

## References

- [Cloudflare AI Gateway Docs](https://developers.cloudflare.com/ai-gateway/)
- [Anthropic Integration](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)
- [Analytics Dashboard](https://developers.cloudflare.com/ai-gateway/observability/analytics/)
- [Agent SDK Environment Variables](https://github.com/anthropics/claude-code/issues/5577)
