## 2026-03-09 - BC-133: Fix agent replies going to main channel instead of thread (PR #69)

**Context:** User reported that when replying in ticket threads, the agent responded in the main channel instead of the thread. This was confusing and broke conversation context.

**Root cause:**
- Linear webhook events don't include `slack_thread_ts` (it's only set after the agent posts its first message)
- After the agent's first post, `persistSlackThreadTs()` saves the thread_ts to the database
- But subsequent events routed through `orchestrator.ts:routeToAgent()` weren't being enriched with the stored thread_ts from the DB
- The agent received events with `slackThreadTs` undefined → defaulted to posting in channel

**What worked:**
- Quick diagnosis using code search (Grep for "notify_slack", "thread_ts")
- Clear data flow tracing: webhook → orchestrator → event → agent → Slack post
- Simple fix: query `slack_thread_ts` from tickets table in `routeToAgent()` and populate event before routing
- All existing tests continued to pass (no breaking changes)

**What didn't:**
- Initially searched too narrowly (just agent code) before finding the orchestrator routing gap
- Could have written a specific test case for this scenario (thread enrichment from DB)

**Technical notes:**
- `orchestrator/src/orchestrator.ts:494-513` — Added DB query for slack_thread_ts and slack_channel, populate event before routing
- The fix handles both Linear tickets (no thread_ts in webhook) and Slack mentions (thread_ts already in event)
- Existing code in `agent/src/server.ts:715-716` already handles event.slackThreadTs → config update

**Files changed:**
- `orchestrator/src/orchestrator.ts`: Query and populate slack_thread_ts from DB in routeToAgent()

**Learning:**
When events flow through multiple layers (webhook → orchestrator → agent), ensure enrichment happens at the orchestrator layer where you have access to persistent state (DB). Don't rely on the original webhook payload to have all the context needed for downstream processing.

---

## 2026-03-09 - PR #67 Copilot Review Feedback

**What worked:**
- Comprehensive Copilot review caught 15 real issues (security, correctness, docs)
- Systematic addressing: security first, then correctness, then docs/quality
- DOM manipulation pattern eliminated XSS risk entirely vs trying to sanitize innerHTML

**What didn't:**
- Original PR missed several security fundamentals: email verification check, fail-closed allowlist, cookie parsing edge cases
- Dashboard kill endpoint didn't verify orchestrator DB update succeeded before shutting down container
- Documentation had several inaccuracies (threat model, deprecated API references)

**Action:**
- Security checklist for future OAuth/auth PRs: verify email flags, fail-closed configs, proper cookie parsing, KV consistency notes
- Always validate orchestrator/DB state changes before proceeding with side effects (container shutdown, notifications)
- Keep threat model docs in sync with implementation - audit on every security change

---

## 2026-03-09 - BC-125: Active Ticket Agent Dashboard

**What worked:**
- Embedded HTML as TypeScript string to avoid complex build configuration
- Reused existing `/api/orchestrator/status` endpoint for data fetching
- Google OAuth integration was straightforward with Hono cookie helpers
- Dark theme UI matches GitHub aesthetic
- In-memory session storage simple and sufficient for MVP

**What didn't:**
- Initial attempt to import HTML file directly required rethinking (Cloudflare Workers don't support fs module)
- TypeScript generics for Hono context required explicit typing for session variables

**Technical decisions:**
- Session storage in-memory (Map) rather than Durable Object storage - simpler for MVP, sufficient for dashboard use case
- 24-hour session duration strikes balance between convenience and security
- Optional domain restriction via `GOOGLE_ALLOWED_DOMAIN` for org-level access control
- Auto-refresh every 30 seconds (client-side) instead of WebSocket - simpler, sufficient for monitoring dashboard
- Dashboard HTML as TypeScript template string instead of separate file - avoids build complexity

**Action:**
- Future: Consider Durable Object session storage if multiple dashboard instances needed
- Future: Add agent logs/transcript preview directly in dashboard
- Future: Add filtering/search for large agent lists

---

## 2026-03-08 - Add emergency shutdown-all endpoint (PR #66)

**Context:** User requested "clean up all agents…there should be no work active" during a Slack session. The existing `/cleanup-inactive` endpoint only handles agents already marked inactive, not active agents.

**What worked:**
- Comprehensive Copilot review caught 15 real issues (security, correctness, docs)
- Systematic addressing: security first, then correctness, then docs/quality
- DOM manipulation pattern eliminated XSS risk entirely vs trying to sanitize innerHTML

**What didn't:**
- Original PR missed several security fundamentals: email verification check, fail-closed allowlist, cookie parsing edge cases
- Dashboard kill endpoint didn't verify orchestrator DB update succeeded before shutting down container
- Documentation had several inaccuracies (threat model, deprecated API references)

**Action:**
- Security checklist for future OAuth/auth PRs: verify email flags, fail-closed configs, proper cookie parsing, KV consistency notes
- Always validate orchestrator/DB state changes before proceeding with side effects (container shutdown, notifications)
- Keep threat model docs in sync with implementation - audit on every security change

## 2026-03-08 - BC-125: Agent Dashboard with Google OAuth

**What worked:**
- Reusing existing orchestrator `/status` endpoint instead of creating new data layer
- Single-page HTML approach (no build step, no framework dependencies)
- Leveraging Cloudflare KV for session storage (automatic TTL, distributed)
- Security-first design from the start (OAuth CSRF, HttpOnly cookies, email allowlist)
- Comprehensive documentation (setup guide + user guide + inline comments)
- TypeScript type safety caught issues early (cookie header types, query param nullability)

**What didn't:**
- Initial HTML import type declaration didn't work (`export default` vs `export =`)
- Had to add `@ts-ignore` for HTML import (wrangler handles it but TypeScript doesn't understand)
- User requested security review mid-implementation - should have proactively documented security considerations first
- Git identity not configured in container - minor delay on commit

**Action:**
- Template: When adding authentication to a Cloudflare Worker, use KV + OAuth + session cookies pattern (proven secure + simple)
- Documentation: Always include security section in implementation docs before asking for review
- Agent containers: Consider pre-configuring git identity to avoid commit delays
