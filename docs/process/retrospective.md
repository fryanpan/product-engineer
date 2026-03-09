<<<<<<< HEAD
## 2026-03-09 - PR #67 Copilot Review Feedback
=======
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
>>>>>>> 2834545 (Add active ticket agent dashboard with Google OAuth (BC-125))

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
