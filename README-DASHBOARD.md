# Agent Dashboard

Web-based monitoring and control interface for Product Engineer agents.

## Quick Start

Visit: `https://product-engineer.<your-subdomain>.workers.dev/dashboard`

Login with your Google account (must be on the allowlist).

## What You Can Do

### Monitor Agents
- View all active agents in real-time
- See ticket IDs, products, status, and latest activity
- Agents needing help (asking status or stale heartbeats) shown at top
- Direct links to Slack threads and GitHub PRs
- Auto-refreshes every 30 seconds

### Control Agents
- **Kill individual agent**: Stop a specific agent immediately
- **Kill all agents**: Emergency shutdown of all active work

## Security

- **Google OAuth**: Secure authentication flow
- **Email allowlist**: Only authorized users can access (configured via `ALLOWED_EMAILS` secret)
- **Session cookies**: 24-hour lifetime, HttpOnly, Secure
- **CSRF protection**: State parameter validation

## Setup Instructions

See [docs/dashboard-setup.md](docs/dashboard-setup.md) for complete deployment guide.

### Quick Deploy

```bash
# 1. Create KV namespace
cd api
wrangler kv namespace create SESSIONS

# 2. Update wrangler.toml with namespace ID

# 3. Configure Google OAuth in Cloud Console

# 4. Set secrets
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put ALLOWED_EMAILS  # Comma-separated: user1@example.com,user2@example.com

# 5. Deploy
wrangler deploy
```

## API Reference

All endpoints require authentication.

### Get Agents
```http
GET /api/dashboard/agents
```

Returns list of active agents with status, heartbeats, and thread info.

### Kill Agent
```http
POST /api/dashboard/agents/:ticketId/kill
```

Marks agent inactive and requests container shutdown.

### Kill All
```http
POST /api/dashboard/agents/shutdown-all
```

Emergency shutdown of all active agents.

## UI Overview

```
┌─────────────────────────────────────────────┐
│ 🤖 Agent Dashboard        👤 user@email.com │
├─────────────────────────────────────────────┤
│ [🔄 Refresh] [🛑 Kill All]  Auto-refresh: 30s│
├─────────────────────────────────────────────┤
│ ⚠️ Agents Needing Help (2)                  │
│ ┌─────────────────────────────────────────┐ │
│ │ Ticket  Product  Status  Thread  Heartbeat│
│ │ BC-123  bike     asking  [Link]  5m ago  │ │
│ │ HT-45   health   in_prog [Link]  35m ago │ │
│ └─────────────────────────────────────────┘ │
├─────────────────────────────────────────────┤
│ ✅ Active Agents (5)                         │
│ ┌─────────────────────────────────────────┐ │
│ │ Ticket  Product  Status   Thread  Updated│
│ │ BC-124  bike     pr_open  [Link]  2m ago │ │
│ │ HT-46   health   in_prog  [Link]  1m ago │ │
│ │ ...                                      │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## Troubleshooting

**"Access denied"** → Your email is not on the allowlist. Contact admin to add you.

**"Session expired"** → Sessions last 24h. Just refresh to log in again.

**Dashboard shows no agents** → Agents may be inactive. Check orchestrator status API.

**Kill doesn't work** → Check orchestrator and agent logs. Container may already be stopped.

## Development

Dashboard is a single-page app (`src/dashboard.html`). No build step needed.

Auth logic in `src/auth.ts`. Routes in `src/index.ts`.

Local dev requires public tunnel for OAuth redirect (ngrok, cloudflared).

## Monitoring Use Cases

### Daily Operations
- Check agent health at start of day
- Identify stuck agents (stale heartbeats)
- Monitor asking agents (need user input)

### Incident Response
- Kill runaway agents consuming resources
- Emergency shutdown during deployment issues
- Verify agents stopped after maintenance

### Capacity Planning
- Track typical agent count
- Identify busy times
- Plan container limits

## Future Enhancements

- [ ] Email allowlist UI (admin can add/remove users via dashboard)
- [ ] Audit log for kill operations
- [ ] Agent logs viewer (tail agent container output)
- [ ] Historical stats (agents per day, success rate)
- [ ] Slack notifications for dashboard kills
- [ ] Agent resource usage (CPU, memory, duration)
- [ ] Batch operations (kill multiple selected agents)
- [ ] Search/filter agents (by product, status, time range)
