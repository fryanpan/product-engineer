## 2026-03-09 - BC-133: Fix agent replies going to main channel instead of thread (PR #69) - MERGED

**Context:** User reported that when replying in ticket threads, the agent responded in the main channel instead of the thread. This was confusing and broke conversation context.

**Root cause (session 1):**
- Linear webhook events don't include `slack_thread_ts` (it's only set after the agent posts its first message)
- After the agent's first post, `persistSlackThreadTs()` saves the thread_ts to the database
- But subsequent events routed through `orchestrator.ts:routeToAgent()` weren't being enriched with the stored thread_ts from the DB
- The agent received events with `slackThreadTs` undefined → defaulted to posting in channel
- **Fix:** Query and populate slack_thread_ts from DB in routeToAgent() before routing events

**Root cause (session 2 - additional issue found):**
- When users mentioned @product-engineer INSIDE an existing Slack thread, the orchestrator was using `slackEvent.ts` (the mention message timestamp) instead of `slackEvent.thread_ts` (the existing thread root)
- This caused the agent to create NEW threads instead of replying in the existing thread where the user mentioned it
- Example: User posts "Bug in feature X" → teammate replies "@product-engineer fix this" → agent creates new thread instead of replying in existing thread
- **Fix:** Use `slackEvent.thread_ts || slackEvent.ts` to respect existing threads when mentions occur inside them

**What worked:**
- Systematic code tracing through the full flow: Slack event → orchestrator → agent → Slack post
- Git history analysis revealed recent threading-related changes and their intent
- Writing out hypothetical scenarios helped identify the edge case (mention inside existing thread)
- All 68 orchestrator tests + 37 agent tests continued to pass
- Clear retrospective documentation helped when resuming after container restart

**What didn't:**
- Initially went down rabbit holes investigating Slack API behavior and race conditions before finding the simpler root cause
- Took multiple iterations to understand that there were TWO separate issues (DB enrichment + thread_ts selection)
- Could have more quickly identified the issue by manually testing the exact scenario the user described

**Merge session (session 3):**
- Container restarted after merge approval
- Resume flow worked smoothly: git state, PR status, and retrospective all preserved
- Tests passing, PR merged without issues
- Brief retro captured key insights for future threading work

**Technical notes:**
- `orchestrator/src/orchestrator.ts:494-513` — DB query enrichment for Linear tickets (session 1)
- `orchestrator/src/orchestrator.ts:1287` — Thread identifier selection logic (session 2): `slackEvent.thread_ts || slackEvent.ts`
- The fix preserves existing behavior for top-level mentions (agent creates own thread) while fixing mentions inside existing threads

**Files changed:**
- `orchestrator/src/orchestrator.ts`: Thread identifier logic and DB enrichment in routeToAgent()
- `docs/process/retrospective.md`: Comprehensive retro documentation
- `docs/troubleshooting/slack-thread-replies.md`: Updated troubleshooting guide

**Learning:**
- When debugging threading issues, consider all entry points: Linear webhooks (no thread), Slack mentions (new thread vs existing thread), thread replies
- Edge cases often involve scenarios where the same feature (mentions) behaves differently in different contexts (top-level vs in-thread)
- Git history and recent changes are valuable debugging clues - check what's been modified recently in the area of the bug
- Defense in depth for critical routing: enrich at multiple layers (event routing + initialization)

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

## 2026-03-09 - BC-133: Additional initialization fix (commit 9b014f6)

**Context:**
The issue was fixed earlier today with commit edf0236 (orchestrator enriches events from DB). This commit adds a complementary fix: passing thread_ts during agent initialization.

**What worked:**
- Two-layer defense: orchestrator enriches events + agent initialization includes thread_ts
- Systematic code tracing revealed the initialization gap
- Test-driven verification: added tests to confirm thread_ts flows through TicketAgentConfig

**Combined solution:**
1. **Orchestrator enrichment (edf0236)**: Query DB in `routeToAgent()`, populate `event.slackThreadTs`
2. **Initialization fix (9b014f6)**: Pass `slackThreadTs` in `TicketAgentConfig` during `/initialize`

**Why both fixes matter:**
- Orchestrator enrichment ensures subsequent events have thread_ts
- Initialization fix ensures agent knows thread_ts from the FIRST message (before any events arrive)
- Together they provide defense in depth: agent always has correct thread context

**Technical details:**
- Added `slackThreadTs` field to `TicketAgentConfig` interface
- Orchestrator loads thread_ts from DB when building agent config (lines 540-545)
- Agent receives thread_ts via env vars during container initialization
- Added tests to verify the full flow

**Key insight:** For critical routing data like thread_ts, pass it at BOTH initialization and per-event. Don't assume events will always arrive before the agent needs to post.
