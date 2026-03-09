# Agent Dashboard Setup

The agent dashboard provides real-time monitoring and control of active ticket agents through a web interface with Google OAuth authentication.

## Features

- **Real-time monitoring**: View all active agents, their status, and latest activity
- **Agents needing help**: Separate section for agents in "asking" status or with stale heartbeats
- **Slack thread links**: Direct links to agent communication threads
- **Agent control**: Kill individual agents or shut down all agents at once
- **Auto-refresh**: Dashboard updates every 30 seconds automatically
- **Secure access**: Google OAuth authentication with session management

## Architecture

### Components

1. **Dashboard UI** (`src/dashboard.html`): Single-page HTML/JS interface
2. **Auth module** (`src/auth.ts`): Google OAuth flow and session management
3. **Worker routes** (`src/index.ts`): Dashboard API endpoints
4. **KV namespace**: Session storage (24-hour TTL)

### Security Model

- **OAuth CSRF protection**: State parameter validated via KV storage (5 min TTL)
- **Session cookies**: HttpOnly, Secure, SameSite=Lax, 24h expiration
- **Session IDs**: 32-byte cryptographically secure random values
- **No client-side secrets**: Only Google Client ID exposed to browser
- **Authenticated endpoints**: All dashboard routes require valid session

## Deployment

### 1. Create KV Namespace

```bash
cd orchestrator
wrangler kv namespace create SESSIONS
```

Copy the namespace ID from the output and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "<YOUR_NAMESPACE_ID>"
```

### 2. Configure Google OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Configure the OAuth consent screen if prompted
4. Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client ID"
5. Application type: **Web application**
6. Add authorized redirect URI:
   ```
   https://product-engineer.<your-subdomain>.workers.dev/api/auth/callback
   ```
7. Copy the Client ID and Client Secret

### 3. Set Secrets

```bash
cd orchestrator

# Google OAuth credentials
wrangler secret put GOOGLE_CLIENT_ID
# Paste your Client ID when prompted

wrangler secret put GOOGLE_CLIENT_SECRET
# Paste your Client Secret when prompted
```

### 4. Deploy

```bash
wrangler deploy
```

### 5. Access Dashboard

Visit: `https://product-engineer.<your-subdomain>.workers.dev/dashboard`

You'll be redirected to Google login. After authentication, the dashboard loads.

## API Endpoints

All dashboard endpoints require authentication (session cookie).

### Authentication

- `GET /api/auth/login` - Initiate Google OAuth flow
- `GET /api/auth/callback` - OAuth callback handler
- `GET /api/auth/user` - Get current user info
- `POST /api/auth/logout` - Destroy session

### Dashboard Data

- `GET /api/dashboard/agents` - List all active agents

  Response:
  ```json
  {
    "agents": [
      {
        "id": "ticket-123",
        "product": "health-tool",
        "status": "in_progress",
        "last_heartbeat": "2024-03-08T10:30:00Z",
        "updated_at": "2024-03-08T10:29:45Z",
        "slack_thread_ts": "1234567890.123456",
        "slack_channel": "C01234567",
        "pr_url": "https://github.com/org/repo/pull/123",
        "branch_name": "ticket/123"
      }
    ]
  }
  ```

### Agent Control

- `POST /api/dashboard/agents/:ticketId/kill` - Kill a specific agent

  Marks the agent as inactive and requests container shutdown.

  Response:
  ```json
  {
    "ok": true,
    "ticketId": "ticket-123"
  }
  ```

- `POST /api/dashboard/agents/shutdown-all` - Kill all active agents

  Emergency shutdown of all agents. Use with caution.

  Response:
  ```json
  {
    "ok": true,
    "total": 5,
    "successful": 5,
    "results": [...]
  }
  ```

## Dashboard UI

### Sections

1. **Agents Needing Help** (top)
   - Agents with status `asking` (waiting for user input)
   - Agents with stale heartbeats (>30 minutes)

2. **Active Agents** (bottom)
   - All other active agents
   - Sorted by most recent activity

### Displayed Information

- **Ticket ID**: Primary identifier
- **Product**: Which product repo the agent is working on
- **Status**: Current agent state (in_progress, pr_open, asking, etc.)
- **Slack Thread**: Link to the agent's communication thread
- **Latest Message**: Time since last status update
- **Last Heartbeat**: Time since last health check
- **Actions**: View PR (if available), Kill agent

### Controls

- **Refresh**: Manual refresh (also auto-refreshes every 30s)
- **Kill All Agents**: Emergency shutdown button

## Security Considerations

### Authentication Flow

1. User visits `/dashboard` without session → redirect to `/api/auth/login`
2. Worker generates random state, stores in KV (5 min TTL)
3. Redirect to Google OAuth with state parameter
4. Google redirects back to `/api/auth/callback?code=...&state=...`
5. Worker validates state matches KV, exchanges code for tokens
6. Fetch user info from Google
7. Create session (random 32-byte ID), store in KV (24h TTL)
8. Set HttpOnly cookie, redirect to `/dashboard`

### Session Management

- **Storage**: Cloudflare KV (distributed, fast reads)
- **Lifetime**: 24 hours (configurable)
- **Cookie flags**: HttpOnly (no JS access), Secure (HTTPS only), SameSite=Lax (CSRF protection)
- **Cleanup**: Automatic via KV TTL

### Threat Model

✅ **Protected against:**
- CSRF (state parameter + SameSite cookie)
- Session fixation (secure random IDs)
- Token leakage (secrets never reach client)

⚠️ **Considerations:**
- XSS: Dashboard HTML uses standard defenses (output encoding, avoiding dangerous sinks like unescaped innerHTML). HttpOnly cookies help protect session cookies from theft but do not prevent XSS.
- Rate limiting: Relies on Cloudflare's built-in protection
- User authorization: Email allowlist via `ALLOWED_EMAILS` env var (if unset, authentication will fail)
- Session hijacking: Standard HTTPS/cookie protections apply
- KV eventual consistency: Sessions and OAuth state use Cloudflare KV, which is eventually consistent across edge locations. In rare cases, callback or dashboard requests routed to different colos may see stale data briefly.

### Future Enhancements

1. **Authorization hardening**: Stricter management of `ALLOWED_EMAILS` and potentially per-user roles
2. **Audit logging**: Track who killed which agents and when
3. **Rate limiting**: Explicit limits on kill operations
4. **Multi-factor**: Optional MFA requirement
5. **Role-based access**: Read-only vs admin permissions

## Troubleshooting

### "GOOGLE_CLIENT_ID not configured"

Set the secret:
```bash
wrangler secret put GOOGLE_CLIENT_ID
```

### "Invalid or expired state"

The OAuth state expired (5 min TTL). Try logging in again.

### "Session expired"

Sessions last 24 hours. Log in again to create a new session.

### "Unauthorized" on API calls

Your session cookie is missing or invalid. Check:
1. Cookies are enabled in your browser
2. You're accessing via HTTPS
3. You're on the same domain as the login

### Dashboard shows no agents but agents are running

Check:
1. Agents are marked `agent_active = 1` in the database
2. The orchestrator's `/status` endpoint returns data
3. Browser console for JavaScript errors

## Monitoring

### Session Stats

View KV namespace metrics in Cloudflare dashboard:
- Total sessions
- Read/write operations
- Storage usage

### Agent Dashboard Usage

No built-in analytics yet. Consider adding:
- Login events to Sentry
- Dashboard page views
- Kill operation audit log

## Development

### Local Testing

Wrangler dev mode works with auth, but you need to:

1. Use a public tunnel (ngrok, cloudflared) for OAuth redirect
2. Update Google OAuth redirect URI to tunnel URL
3. Set secrets in `.dev.vars`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```

### Adding New Features

Dashboard is a single-page app. To add features:

1. Update `dashboard.html` with new UI elements
2. Add API routes in `index.ts` (with `requireAuth` middleware)
3. Update this doc with new endpoints

### Security Review Checklist

Before deploying dashboard changes:

- [ ] All new routes use `requireAuth` middleware
- [ ] No secrets logged or exposed to client
- [ ] Input validation on all parameters
- [ ] CSRF protection for state-changing operations
- [ ] Rate limiting considered for expensive operations
- [ ] Audit logging for sensitive actions (kills, shutdowns)
