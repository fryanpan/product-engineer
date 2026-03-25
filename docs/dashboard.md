# Active Task Agent Dashboard

Web-based dashboard for monitoring and managing active Product Engineer task agents.

## Features

- **Real-time monitoring**: View all active task agents with their current status
- **Agent details**: See task ID, product, status, last update time, PR link, and Slack thread link
- **Health indicators**: Color-coded health status based on heartbeat freshness (💚 fresh, 💛 recent, 🧡 getting stale, ❤️ stale)
- **Priority alerts**: Agents needing help (asking/failed status) are shown at the top
- **Agent controls**: Kill individual agents or shutdown all active agents at once
- **Auto-refresh**: Dashboard updates every 30 seconds automatically
- **Google OAuth**: Secure authentication with optional domain restriction

## Setup

### 1. Create Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Navigate to "APIs & Services" → "Credentials"
4. Click "Create Credentials" → "OAuth 2.0 Client ID"
5. Configure OAuth consent screen if prompted
6. Application type: "Web application"
7. Add authorized redirect URI: `https://your-worker-url.workers.dev/dashboard/callback`
8. Save the Client ID and Client Secret

### 2. Configure Secrets

```bash
cd api

# Required
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET

# Optional: restrict access to specific domain (e.g., "anthropic.com")
wrangler secret put GOOGLE_ALLOWED_DOMAIN
```

### 3. Deploy

```bash
cd api
bun run deploy
```

## Usage

### Accessing the Dashboard

Navigate to: `https://your-worker-url.workers.dev/dashboard`

You'll be redirected to Google login. After authentication, you'll see the dashboard with:

**Summary Cards:**
- Active Agents: Total number of running agents
- Needs Help: Agents in "asking" or "failed" status
- Completed (24h): Recently completed tasks
- Stale (>30min): Agents with stale heartbeats

**Agent Cards:**

Each agent shows:
- Health indicator (💚/💛/🧡/❤️)
- Task ID
- Status badge
- Product name
- Last update time
- PR link (if available)
- Branch name (if available)
- Actions: "Open Thread" (Slack), "Kill Agent"

### Killing Agents

**Individual agent:**
Click "Kill Agent" on any agent card. This:
- Marks the agent as terminal
- Shuts down the container immediately
- Updates task status to "deferred"

**All agents:**
Click "Shutdown All Agents" in the header. This:
- Marks all agents as inactive
- Shuts down all containers
- Use for emergency stops or maintenance

## Security

- **Authentication**: Google OAuth only
- **Domain restriction**: Optional `GOOGLE_ALLOWED_DOMAIN` limits access to specific organization
- **Session management**: 24-hour sessions stored in memory
- **API authorization**: Dashboard requests use authenticated sessions instead of raw API keys

## Implementation Details

### Routes

- `GET /dashboard` - Main dashboard page (protected)
- `GET /dashboard/login` - OAuth login flow
- `GET /dashboard/callback` - OAuth callback handler
- `GET /dashboard/logout` - Logout and clear session
- `GET /dashboard/user` - Current user info (protected)
- `POST /dashboard/kill-agent/:taskId` - Kill specific agent (protected)

### Architecture

- **Stateless sessions**: Stored in Worker memory (Map), not persisted
- **Auto-refresh**: Client-side polling every 30 seconds
- **Status API**: Reuses `/api/conductor/status` endpoint with session auth
- **Shutdown API**: Reuses `/api/conductor/shutdown-all` with session auth

### Session Lifecycle

1. User visits `/dashboard`
2. No session → redirect to `/dashboard/login`
3. OAuth flow → Google auth → callback
4. Create session, set HTTP-only cookie
5. Redirect to `/dashboard`
6. Session valid for 24 hours
7. Auto-redirect to login on expiry

## Troubleshooting

**"Configuration Error" on login page:**
- Missing Google OAuth credentials
- Run `wrangler secret put GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`

**"Access Denied" after login:**
- Domain restriction enabled but user email doesn't match
- Check `GOOGLE_ALLOWED_DOMAIN` setting

**Dashboard shows "Unauthorized":**
- Session expired
- Refresh page to re-authenticate

**"Failed to load agent status":**
- Conductor DO not responding
- Check Worker health: `curl https://your-worker-url.workers.dev/health`
