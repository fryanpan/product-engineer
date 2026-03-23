# Dashboard Setup Completion Guide

This guide helps you complete the dashboard setup based on BC-177.

## Status Overview

### ✅ Already Complete

- **KV Namespace**: Configured in `wrangler.toml`
  - Production: `5b4f4cc3f3b342c59eead588a5446ca8`
  - Staging: `52c44a6e0d144e53a51c9cb4e9bcbbe0`
- **Dashboard Code**: All auth, UI, and API routes implemented
- **AI Gateway Code**: Integration code complete in orchestrator

### ⚠️ Needs Manual Configuration

1. **Google OAuth Credentials**
2. **Cloudflare AI Gateway Configuration**
3. **Deployment**

## Quick Setup

### Option 1: Automated Script

```bash
cd /workspace/product-engineer
export WORKER_URL=https://product-engineer.YOUR_SUBDOMAIN.workers.dev
export API_KEY=your_api_key_here

./scripts/complete-dashboard-setup.sh
```

The script will guide you through the remaining steps.

### Option 2: Manual Step-by-Step

#### Step 1: Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a new project or select existing
3. Configure OAuth consent screen (if not done)
4. Create credentials → OAuth 2.0 Client ID
5. Application type: **Web application**
6. Add authorized redirect URI:
   ```
   https://product-engineer.YOUR_SUBDOMAIN.workers.dev/api/auth/callback
   ```
7. Copy the **Client ID** and **Client Secret**

8. Set Cloudflare secrets:
   ```bash
   cd api

   wrangler secret put GOOGLE_CLIENT_ID
   # Paste Client ID when prompted

   wrangler secret put GOOGLE_CLIENT_SECRET
   # Paste Client Secret when prompted

   wrangler secret put ALLOWED_EMAILS
   # Enter comma-separated email list: user1@example.com,user2@example.com
   ```

#### Step 2: Cloudflare AI Gateway Configuration

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your account
3. Navigate to **AI > AI Gateway**
4. Click **Create Gateway**
5. Name: `product-engineer` (or your choice)
6. Copy **Account ID** and **Gateway ID** (slug)

7. Configure via API:
   ```bash
   curl -X PUT https://product-engineer.YOUR_SUBDOMAIN.workers.dev/api/settings/cloudflare_ai_gateway \
     -H "X-API-Key: $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "value": {
         "account_id": "YOUR_ACCOUNT_ID_HERE",
         "gateway_id": "YOUR_GATEWAY_ID_HERE"
       }
     }'
   ```

   Or use the seed endpoint if setting up multiple products:
   ```bash
   curl -X POST https://product-engineer.YOUR_SUBDOMAIN.workers.dev/api/products/seed \
     -H "X-API-Key: $API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "cloudflare_ai_gateway": {
         "account_id": "YOUR_ACCOUNT_ID_HERE",
         "gateway_id": "YOUR_GATEWAY_ID_HERE"
       },
       "products": {
         "existing-product": { ... }
       }
     }'
   ```

#### Step 3: Deploy

```bash
cd api
wrangler deploy
```

#### Step 4: Verify

1. **Dashboard Access**:
   - Visit: `https://product-engineer.YOUR_SUBDOMAIN.workers.dev/dashboard`
   - You should be redirected to Google login
   - After authentication, dashboard should load

2. **AI Gateway Verification**:
   - Create a test ticket or trigger an agent
   - Check Cloudflare Dashboard > AI > AI Gateway > [your gateway]
   - Should see requests within 1-2 minutes

3. **Take Screenshots**:
   - Dashboard main view showing agents
   - AI Gateway analytics showing traffic
   - Post to BC-177 Linear ticket or Slack thread

## Verification Checklist

- [ ] Google OAuth configured
  - [ ] Client ID and Secret set as Cloudflare secrets
  - [ ] Redirect URI configured
  - [ ] `ALLOWED_EMAILS` set
- [ ] AI Gateway configured
  - [ ] Gateway created in Cloudflare dashboard
  - [ ] Account ID and Gateway ID saved to settings
  - [ ] Settings confirmed via API: `GET /api/settings`
- [ ] Deployed
  - [ ] `wrangler deploy` completed successfully
  - [ ] Worker URL accessible
- [ ] Dashboard verified
  - [ ] Can access `/dashboard` endpoint
  - [ ] Google login works
  - [ ] Can view agents (if any active)
  - [ ] Auth redirects work properly
- [ ] AI Gateway verified
  - [ ] Agent traffic appears in gateway analytics
  - [ ] Token usage tracked
  - [ ] No API errors in logs

## Troubleshooting

### "GOOGLE_CLIENT_ID not configured"

```bash
cd api
wrangler secret put GOOGLE_CLIENT_ID
```

### "Access denied" on dashboard

Check `ALLOWED_EMAILS`:
```bash
wrangler secret put ALLOWED_EMAILS
# Enter: your@email.com,teammate@email.com
```

### AI Gateway shows no traffic

1. Verify settings are saved:
   ```bash
   curl -H "X-API-Key: $API_KEY" \
     https://product-engineer.YOUR_SUBDOMAIN.workers.dev/api/settings \
     | jq .settings.cloudflare_ai_gateway
   ```

2. Check agent logs:
   ```bash
   wrangler tail --format pretty
   # Look for ANTHROPIC_BASE_URL in container startup logs
   ```

3. Verify Account ID and Gateway ID are correct (case-sensitive)

### "Session expired" on dashboard

Sessions last 24 hours. Just refresh and log in again. This is expected behavior.

### OAuth callback fails

1. Check redirect URI exactly matches in Google Console
2. Verify `GOOGLE_CLIENT_SECRET` is set correctly
3. Check browser network tab for error details

## API Endpoints Reference

### Settings Management

```bash
# List all settings
curl -H "X-API-Key: $API_KEY" \
  $WORKER_URL/api/settings

# Update a setting
curl -X PUT -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  $WORKER_URL/api/settings/cloudflare_ai_gateway \
  -d '{"value": {"account_id": "...", "gateway_id": "..."}}'

# Seed entire registry (products + settings)
curl -X POST -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  $WORKER_URL/api/products/seed \
  -d @registry.json
```

### Dashboard API

```bash
# Get active agents (requires auth cookie)
curl -b cookies.txt $WORKER_URL/api/dashboard/agents

# Kill an agent
curl -X POST -b cookies.txt \
  $WORKER_URL/api/dashboard/agents/TICKET_ID/kill

# Kill all agents
curl -X POST -b cookies.txt \
  $WORKER_URL/api/dashboard/agents/shutdown-all
```

## Next Steps After Setup

1. **Test the full flow**:
   - Create a test Linear ticket
   - Watch agent spawn and work
   - Verify dashboard shows the agent
   - Check AI Gateway for LLM traffic

2. **Monitor costs**:
   - Review AI Gateway analytics daily
   - Set up cost alerts in Cloudflare (if available)

3. **Add team members**:
   - Add emails to `ALLOWED_EMAILS`
   - Format: `email1@domain.com,email2@domain.com`
   - Redeploy after updating

4. **Document your setup**:
   - Save Account ID and Gateway ID in password manager
   - Document which Google Cloud project has the OAuth client
   - Share dashboard URL with team

## Related Documentation

- [Dashboard Setup (detailed)](./dashboard-setup.md)
- [AI Gateway Integration](./cloudflare-ai-gateway.md)
- [AI Gateway Setup Checklist](./cloudflare-ai-gateway-setup-checklist.md)
- [Dashboard README](../README-DASHBOARD.md)
- [Main README](../README.md)
