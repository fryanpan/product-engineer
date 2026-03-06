# Cloudflare AI Gateway Setup Checklist

Use this checklist to complete the AI Gateway integration after the code is deployed.

## Prerequisites
- [x] Code changes committed and ready to deploy
- [ ] Cloudflare account access
- [ ] Access to update Cloudflare Secrets

## Step-by-Step Setup

### 1. Create AI Gateway in Cloudflare Dashboard

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your account
3. Navigate to **AI > AI Gateway**
4. Click **Create Gateway**
5. Choose a gateway name (suggested: `product-engineer` or `pe-gateway`)
6. Click **Create**

**Save these values:**
- Account ID: `_______________________________________________`
- Gateway ID (slug): `_______________________________________________`

### 2. Update Registry Configuration

Seed the AI Gateway config via the admin API:

```bash
curl -X POST https://your-worker.workers.dev/api/products/seed \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "cloudflare_ai_gateway": {
      "account_id": "YOUR_ACCOUNT_ID_HERE",
      "gateway_id": "YOUR_GATEWAY_ID_HERE"
    },
    "products": { ... }
  }'
```

Replace `YOUR_ACCOUNT_ID_HERE` and `YOUR_GATEWAY_ID_HERE` with the values from Step 1.

### 3. Deploy the Orchestrator

```bash
cd orchestrator
bun run deploy
```

This will:
- Deploy the updated code with AI Gateway support
- Inject `ANTHROPIC_BASE_URL` into all new agent containers
- Route all LLM traffic through the gateway

### 4. Verify the Integration

**Option A: Create a test ticket**
1. Create a new Linear ticket in the Product Engineer project
2. Wait for the agent to start processing
3. Check Cloudflare Dashboard > AI > AI Gateway > [your gateway]
4. You should see requests appearing within 1-2 minutes

**Option B: Trigger via Slack**
1. In #product-engineer, mention `@product-engineer test the AI gateway`
2. Watch for agent activity
3. Check the gateway dashboard for traffic

### 5. Capture Analytics Screenshot

Once traffic is flowing:
1. Go to Cloudflare Dashboard > AI > AI Gateway > [your gateway] > **Analytics**
2. Take a screenshot showing:
   - Request count graph
   - Token usage metrics
   - Cost tracking (if available)
   - Any other visible metrics
3. Post to the Linear ticket or Slack thread

### 6. Validate Analytics Features

Check that the dashboard shows:
- [x] Request count over time
- [x] Token usage (input/output)
- [x] Model breakdown (should show claude-sonnet-4-5-20250929)
- [x] Cost estimates
- [x] Error rate (should be 0% if working correctly)

## Troubleshooting

### No traffic appearing in dashboard

1. Check registry config was updated and deployed
2. Verify agent container logs show `ANTHROPIC_BASE_URL` being set:
   ```bash
   wrangler tail --format pretty
   ```
3. Look for log lines containing `ANTHROPIC_BASE_URL`
4. Confirm Account ID and Gateway ID are correct (case-sensitive)

### API errors after enabling gateway

1. Test the gateway endpoint manually:
   ```bash
   curl https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic/v1/messages \
     -H "x-api-key: $ANTHROPIC_API_KEY" \
     -H "anthropic-version: 2023-06-01" \
     -H "content-type: application/json" \
     -d '{"model":"claude-sonnet-4-5-20250929","max_tokens":100,"messages":[{"role":"user","content":"test"}]}'
   ```
2. Check for typos in Account ID or Gateway ID
3. Verify Anthropic API key is still valid

### Dashboard shows data but metrics are zero

- Wait 2-5 minutes for data to aggregate
- Refresh the dashboard page
- Check time range filter (default to "Last 24 hours")

## Completion Criteria

- [ ] Gateway created in Cloudflare dashboard
- [ ] Registry updated with Account ID and Gateway ID
- [ ] Changes committed to git
- [ ] Orchestrator deployed
- [ ] Test agent run completed successfully
- [ ] Dashboard shows request traffic
- [ ] Screenshot captured and posted
- [ ] Linear ticket closed

## Next Steps

After successful setup:
- Monitor daily/weekly token usage trends
- Set up cost alerts if needed (Cloudflare feature)
- Review error rates for API issues
- Consider enabling response caching for identical requests
