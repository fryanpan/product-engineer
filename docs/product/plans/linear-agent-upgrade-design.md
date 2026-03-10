# Linear Agent Upgrade: Official OAuth App Identity

**Status: Complete** (2026-03-10) — All code changes deployed, OAuth flow completed, end-to-end verified on staging.

## Context

The current Linear integration uses a personal API key (`LINEAR_API_KEY`) and matches the agent by name/email strings (`agent_linear_name`, `agent_linear_email`) in webhook payloads. This is fragile — the "Product Engineer (Staging)" user doesn't actually exist in Linear, so webhooks never trigger on assignment.

Linear's official [Agents API](https://linear.app/developers/agents) provides a proper identity model via OAuth Applications with `actor=app`. We adopt the identity mechanism but **not** Linear's Agent Sessions lifecycle — our long-running container model is a deliberate architectural choice that supports multi-hour, multi-event-source agent lifecycles that Linear's short-lived session model doesn't accommodate.

## Design

### 1. Linear Application Setup

Create two Linear Applications (one per environment):
- **Production**: "Product Engineer" — matches current display name
- **Staging**: "Product Engineer (Staging)"

Created at `https://linear.app/settings/api/applications/new`. The app's name and icon become the agent's identity across all Linear surfaces (mentions, assignments, comments, filters). Apps don't count as billable seats.

**Required scopes**: `read`, `write`, `app:assignable`, `app:mentionable`

**OAuth flow**: One-time admin authorization with `actor=app` parameter. Produces access token (24h TTL) + refresh token. This is a manual step performed once per environment.

### 2. Secrets & Configuration Changes

**Wrangler secrets (new):**
| Secret | Purpose |
| --- | --- |
| `LINEAR_APP_TOKEN` | OAuth access token (replaces `LINEAR_API_KEY`) |
| `LINEAR_APP_REFRESH_TOKEN` | For automatic token renewal |
| `LINEAR_APP_CLIENT_ID` | Needed for token refresh calls |
| `LINEAR_APP_CLIENT_SECRET` | Needed for token refresh calls |
| `LINEAR_WEBHOOK_SECRET` | Unchanged |

**Removed:**
| Secret/Setting | Reason |
| --- | --- |
| `LINEAR_API_KEY` | Replaced by `LINEAR_APP_TOKEN` |
| `agent_linear_email` (registry) | Identity comes from OAuth app |
| `agent_linear_name` (registry) | Identity comes from OAuth app |

**New registry setting:**
- `linear_app_user_id` — The app's Linear user ID (from `viewer { id }` query at setup time). Used for identity checks in webhook handler.

> **Q1: Should we keep \****`linear_team_id`**\*\* as a registry setting, or move it to a wrangler secret?** It's currently in SQLite settings, set via seed. I'd keep it as-is since it's not sensitive.

> **Q2: For the OAuth redirect URI during the one-time setup — should we build a small callback handler in the worker (e.g., \****`GET /api/auth/linear/callback`**\*\*), or just use a localhost redirect and do it manually?** A worker endpoint is cleaner for future re-auth but more code. Manual localhost is fine for a one-time operation.

### 3. Token Refresh

Access tokens expire after 24 hours. Strategy:

- Store `LINEAR_APP_TOKEN` and `LINEAR_APP_REFRESH_TOKEN` in the Orchestrator DO's SQLite settings table (not just wrangler secrets) so they can be updated at runtime.
- On any 401 from Linear API: refresh via `POST ``https://api.linear.app/oauth/token` with `grant_type=refresh_token`, update SQLite, retry the original request.
- Proactive refresh: The orchestrator's periodic alarm (already runs for health checks) refreshes the token if it's older than 12 hours.
- `LINEAR_APP_CLIENT_ID` and `LINEAR_APP_CLIENT_SECRET` remain as wrangler secrets (immutable, needed for refresh calls).

> **Q3: Should the initial \****`LINEAR_APP_TOKEN`**\*\* be set via wrangler secret (for first boot) AND stored in SQLite (for runtime refresh)? Or should we do the OAuth flow interactively and store directly in SQLite?** I lean toward wrangler secret for initial bootstrap + SQLite for runtime, with SQLite taking precedence if populated.

### 4. Webhook Handler Changes (`webhooks.ts`)

**Before:**
```typescript
const isAssignedToAgent =
  payload.data.assignee?.email === agent.linear_email ||
  payload.data.assignee?.name === agent.linear_name;
```

**After:**
```typescript
const isAssignedToAgent =
  payload.data.assignee?.id === registry.linear_app_user_id;
```

This is the core fix — reliable ID matching instead of fragile string matching.

**Comment filtering** (skip our own comments) changes similarly:
```typescript
// Before
if (commentData.user.email === agent.linear_email)
// After
if (commentData.user.id === registry.linear_app_user_id)
```

**Everything else in the webhook handler stays the same**: HMAC verification, team filtering, project mapping, event routing, terminal state guards.

> **Q4: The webhook payload's \****`assignee`***\* object — does it include \****`id`**\*\*?** The current type definition has `{ id: string; name: string; email?: string }` so `id` is already there. But I want to confirm the Linear webhook payload actually sends the app's user ID when an app is the assignee, not some different identifier.

### 5. GraphQL API Changes

All GraphQL calls swap `LINEAR_API_KEY` → the app's OAuth token. Affected locations:

| Location | Function | Change |
| --- | --- | --- |
| `webhooks.ts` | `assignTicketToAgent()` | Use app token; assign to self (app's user ID) |
| `decision-engine.ts` | `postLinearComment()` | Use app token — comments appear as the app |
| `context-assembler.ts` | `fetchLinearComments()` | Use app token for reads |
| `agent/src/tools.ts` | `update_task_status()` | Use app token for status transitions |
| `agent/src/mcp.ts` | Linear MCP server | Use app token as bearer |

The `assignTicketToAgent()` function simplifies — no need to look up user by email, we just assign using the app's known user ID.

> **Q5: The agent container gets \****`LINEAR_API_KEY`**\*\* via env vars from the orchestrator. With the new model, should we pass the current (possibly refreshed) OAuth token to the agent container at start time?** The orchestrator already passes env vars via `startAndWaitForPorts`. We'd pass the latest token from SQLite.

### 6. Registry Changes

**Remove from \****`AgentIdentity`**\*\* interface:**
```typescript
// Delete
linear_email: string;
linear_name: string;
```

**Remove from registry settings:**
- `agent_linear_email`
- `agent_linear_name`

**Add to registry settings:**
- `linear_app_user_id: string`

**Remove \****`getAgentIdentity()`**\*\* function** — replaced by reading `linear_app_user_id` from settings directly.

**Product config unchanged** — `triggers.linear.project_name` mapping stays as-is.

### 7. Seed/Setup Flow

The `POST /api/products/seed` endpoint currently accepts `agent_linear_email` and `agent_linear_name`. Update to accept `linear_app_user_id` instead. The setup skill (`.claude/skills/registry/`) also needs updating.

### 8. Test Changes

`orchestrator/src/linear-webhook.test.ts` — Update mock payloads to use `assignee.id` matching instead of email/name matching. Remove tests for `getAgentIdentity()`. Add tests for token refresh logic.

`orchestrator/src/registry.test.ts` — Remove `getAgentIdentity` tests, update registry type expectations.

### 9. Files Changed

| File | Change Type |
| --- | --- |
| `orchestrator/src/webhooks.ts` | Modify — identity check, remove `assignTicketToAgent` email lookup |
| `orchestrator/src/registry.ts` | Modify — remove `AgentIdentity`, `getAgentIdentity`, add `linear_app_user_id` |
| `orchestrator/src/orchestrator.ts` | Modify — token refresh logic, updated seed, schema migration |
| `orchestrator/src/decision-engine.ts` | Modify — use app token for comments |
| `orchestrator/src/context-assembler.ts` | Modify — use app token for reads |
| `orchestrator/src/types.ts` | Modify — `LINEAR_APP_TOKEN` replaces `LINEAR_API_KEY`, add new secrets |
| `agent/src/tools.ts` | Modify — use app token for status updates |
| `agent/src/mcp.ts` | Modify — use app token for Linear MCP |
| `orchestrator/src/linear-webhook.test.ts` | Modify — update identity matching tests |
| `orchestrator/src/registry.test.ts` | Modify — remove identity tests |
| `docs/staging-setup.md` | Modify — update secrets table |
| `.claude/skills/registry/` | Modify — update setup instructions |

### 10. Migration Path

1. Create Linear Applications (production + staging) in UI
2. Run OAuth flow with `actor=app` for each environment
3. Store tokens via `wrangler secret put`
4. Deploy updated orchestrator code
5. Seed `linear_app_user_id` via admin API
6. Verify: assign a ticket to the app in Linear → webhook triggers → agent spawns

Production and staging can be migrated independently. Staging first as validation.

## Architectural Note

We deliberately chose **not** to adopt Linear's Agent Sessions model. Their model assumes short-lived, request-response interactions (delegation → think → respond → complete). Our agents are long-running containers that handle multi-hour ticket lifecycles across multiple event sources (Linear, GitHub, Slack). Container time is cheap; the flexibility to experiment with longer-lived session architectures is valuable. We may revisit Agent Sessions for the UI benefits (progress visualization in Linear) once our lifecycle model stabilizes.
