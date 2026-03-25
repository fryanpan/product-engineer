# AI Gateway Request Flow

This document illustrates how LLM requests flow through Cloudflare AI Gateway.

## Before AI Gateway

```
TaskAgent Container
  │
  │ ANTHROPIC_API_KEY=sk-ant-xxx
  │
  ▼
Agent SDK (query)
  │
  │ Direct HTTPS request
  │
  ▼
api.anthropic.com
  │
  ▼
Claude Sonnet 4.5
  │
  ▼
Response (no logging, no analytics)
```

**Problems:**
- No visibility into token usage
- No cost tracking
- No request logging
- No error monitoring
- No rate limiting or caching options

## After AI Gateway

```
TaskAgent Container
  │
  │ ANTHROPIC_API_KEY=sk-ant-xxx
  │ ANTHROPIC_BASE_URL=https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic
  │
  ▼
Agent SDK (query)
  │
  │ Reads ANTHROPIC_BASE_URL env var
  │ Routes to gateway instead of direct
  │
  ▼
Cloudflare AI Gateway
  │
  ├──► Analytics Dashboard
  │    ├─ Request count ✓
  │    ├─ Token usage ✓
  │    ├─ Cost tracking ✓
  │    ├─ Error rate ✓
  │    └─ Cache hits ✓
  │
  ├──► Request Logs
  │    ├─ Full request/response
  │    ├─ Timestamps
  │    ├─ Latency
  │    └─ Model used
  │
  ├──► Rate Limiting (optional)
  ├──► Response Caching (optional)
  └──► Cost Controls (optional)
  │
  │ Proxy request to Anthropic
  │
  ▼
api.anthropic.com
  │
  ▼
Claude Sonnet 4.5
  │
  ▼
Response
  │
  │ Flows back through gateway
  │ Logged and analyzed
  │
  ▼
Agent SDK
  │
  ▼
TaskAgent Container
```

**Benefits:**
- ✅ Full request/response logging
- ✅ Real-time token usage metrics
- ✅ Cost tracking by model
- ✅ Error monitoring and debugging
- ✅ GraphQL API for custom analytics
- ✅ Optional caching for cost savings
- ✅ Optional rate limiting for control

## Environment Variable Injection Flow

```
Product Registry (SQLite)
  {
    "cloudflare_ai_gateway": {
      "account_id": "abc123",
      "gateway_id": "pe-gateway"
    }
  }
  │
  ▼
api/src/registry.ts
  getAIGatewayConfig() → { account_id, gateway_id }
  │
  ▼
api/src/task-agent.ts
  resolveAgentEnvVars()
  │
  │ Constructs URL:
  │ `https://gateway.ai.cloudflare.com/v1/${account_id}/${gateway_id}/anthropic`
  │
  ▼
Container Environment Variables
  {
    ANTHROPIC_API_KEY: "sk-ant-xxx",
    ANTHROPIC_BASE_URL: "https://gateway.ai.cloudflare.com/v1/abc123/pe-gateway/anthropic"
  }
  │
  ▼
agent/src/server.ts
  Agent SDK query() automatically reads ANTHROPIC_BASE_URL
  │
  ▼
All requests route through gateway
```

## Zero Code Changes Required

The Agent SDK automatically respects `ANTHROPIC_BASE_URL` — no changes to the agent code needed!

```typescript
// agent/src/server.ts - NO CHANGES
const session = query({
  prompt: messages,
  options: {
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["project"],
    // ... other options
  },
});
```

The SDK internally:
1. Reads `process.env.ANTHROPIC_BASE_URL`
2. Uses it as the base URL for all API requests
3. Passes through `ANTHROPIC_API_KEY` in headers
4. Gateway proxies to Anthropic with full logging

## Analytics GraphQL API Example

Query usage data programmatically:

```graphql
query {
  viewer {
    accounts(accountTag: "abc123") {
      aiGatewayAnalytics(
        gatewayId: "pe-gateway"
        datetimeStart: "2026-03-01T00:00:00Z"
        datetimeEnd: "2026-03-04T23:59:59Z"
      ) {
        dimensions {
          model
          provider
          timestamp
        }
        sum {
          requests
          tokens
          cost
        }
      }
    }
  }
}
```

Returns:
```json
{
  "data": {
    "viewer": {
      "accounts": [{
        "aiGatewayAnalytics": {
          "dimensions": {
            "model": "claude-sonnet-4-5-20250929",
            "provider": "anthropic",
            "timestamp": "2026-03-04T15:00:00Z"
          },
          "sum": {
            "requests": 42,
            "tokens": 125630,
            "cost": 1.26
          }
        }
      }]
    }
  }
}
```

## Cost Tracking Example

The dashboard automatically calculates costs based on:

| Model | Input Cost | Output Cost |
|-------|------------|-------------|
| claude-sonnet-4-5-20250929 | $3/M tokens | $15/M tokens |

**Example calculation:**
- Request uses 10K input tokens + 2K output tokens
- Input cost: 10,000 × $3 / 1,000,000 = $0.03
- Output cost: 2,000 × $15 / 1,000,000 = $0.03
- Total: **$0.06 per request**

Dashboard aggregates across all requests for daily/weekly/monthly totals.

## Security Note

The `ANTHROPIC_API_KEY` remains secret — it never appears in logs or analytics. The gateway acts as a transparent proxy, logging metadata but not credentials.
