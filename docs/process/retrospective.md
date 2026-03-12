## 2026-03-12 - BC-156: Use human-readable identifiers in all messages (PR #79)

**Context:** Decision messages in Slack were showing UUIDs instead of human-readable ticket identifiers (e.g., "1513bdac-12ea-46b1-9f7f-85c7ad1c8450" instead of "BC-156"). This made messages harder to parse and reduced usability.

**What worked:**
- Systematic audit of all message paths: decision logs, Slack notifications, Linear comments, transcript lists
- Reused existing `identifier` field in tickets table (already being set by Linear webhooks)
- Context assembler already had the pattern for ticket review and merge gate - extended to supervisor
- Two-field approach for supervisor: `ticketId` (human-readable, for display) + `internalId` (UUID, for database operations)

**Implementation:**
- **orchestrator/src/orchestrator.ts**: Merge gate and supervisor logging now use `ticket.identifier || ticketId` fallback
- **orchestrator/src/context-assembler.ts**: `forSupervisor()` returns both fields for all ticket lists
- **orchestrator/src/prompts/supervisor.mustache**: Updated to clarify using `internalId` for action targets
- **Transcript API**: Query uses `COALESCE(identifier, id)` to prefer human IDs in list results

**Test results:**
- 87 tests pass, 4 unrelated failures (pre-existing missing dependencies)
- No test updates needed - changes are backwards-compatible (UUIDs work as fallback)

**What didn't:**
- Initially missed that supervisor returns `target` field which needs identifier lookup - caught during implementation
- Context assembler test didn't verify the actual field values - only checked types

**Action:**
- Monitor decision messages in #product-engineer-decisions after deploy to verify identifiers appear
- Consider adding identifier column to all database queries for consistency
- Future: make identifier field NOT NULL in schema (requires migration for old tickets)

---

## 2026-03-12 - BC-152: Merge gate Copilot retry optimization (PR #77)

**Context:** Repos without Copilot review enabled waited through 5 retries × 90s = 7.5 minutes before proceeding. This was unnecessarily slow.

**What worked:**
- Simple heuristic approach (single retry) effectively solves the problem without requiring config changes or GitHub API calls
- Code change was minimal and localized to one function in `orchestrator.ts:1194-1225`
- Clear impact: 83% reduction in wait time for non-Copilot repos (7.5min → 90s)
- Logic is clean: retry once to give Copilot time, then assume not enabled if still no review

**Implementation:**
- Changed retry logic from "retry up to 5 times" to "retry once (retryCount === 0), then assume Copilot not enabled"
- Removed `MAX_MERGE_GATE_RETRIES` constant (no longer needed)
- Updated log messages to reflect new behavior and include "(likely not enabled)" for clarity

**Test results:**
- 87 tests pass, 4 unrelated failures in test environment (missing hono/mustache dependencies - pre-existing)
- No existing tests needed updating (constant wasn't referenced in tests)

**Action:**
- Monitor merge gate behavior in production after deploy to verify the heuristic works as expected
- Consider adding explicit logging for "Copilot detected" vs "Copilot not detected" cases for better observability

---

## 2026-03-11 - BC-136: E2E Test Scripts for Orchestrator (PR #72)

**Context:** Create scripted E2E tests that exercise the full orchestrator lifecycle against staging to catch bugs like those found in Mar 9-10: supervisor spam loop, merge gate race condition, duplicate webhook dedup, stale token refresh, thread routing.

**What worked:**
- Built two complementary test scripts: quick smoke test (~5s) and full lifecycle test (~15min)
- Smoke test verifies all integrations (Worker, Orchestrator DO, Slack, Linear, GitHub, decision log, registry)
- Full E2E test exercises complete flow: Slack mention → Linear ticket → agent spawn → PR → CI failure/fix → merge
- Designed to intentionally trigger CI failure to test automated fix workflow
- Both scripts have `--help` and dry-run modes

**Implementation decisions:**
- Used `parseArgs` from `util` for CLI argument parsing (standard library, no deps)
- Polling-based verification with configurable timeouts rather than event-driven
- Context object tracks test state across steps for debugging failed tests
- Both staging and production environments supported via env var overrides

**Files created:**
- `scripts/e2e-smoke-test.ts` — Quick connectivity check
- `scripts/e2e-staging-test.ts` — Full lifecycle test
- `docs/e2e-testing.md` — Usage guide and troubleshooting

**Action:**
- Run smoke test before deploying orchestrator changes
- Run full E2E test after risky changes (creates real artifacts in staging)
- Consider CI integration for smoke test (doesn't require real credentials for basic checks)

---

## 2026-03-11 - BC-139: Security Audit and Improvement Plan (PR #73)

**Context:** Comprehensive security audit of the Product Engineer system following a 7-layer security model (trust classification, privilege separation, action classification, context hygiene, output validation, audit logging, rate limiting).

**What worked:**
- Using parallel exploration agents to research the codebase and health-tool simultaneously — faster context gathering
- Structured layer-by-layer analysis made gaps easy to identify and prioritize
- Referencing Anthropic's Claude Code Security documentation provided industry best practices
- The existing security.md doc was accurate and up-to-date — reduced research time

**What didn't:**
- Initial search didn't find health-tool repo in workspace — it's only cloned by agents into isolated containers, not part of this workspace. Should have checked registry config first.
- Web search returned some 404 pages on Anthropic docs — had to use WebFetch for the main security page

**Key findings:**
- Strong foundational security already implemented (platform isolation, HMAC verification, timing-safe auth, input delimiters, per-product secrets)
- Remaining gaps are defense-in-depth controls, not critical vulnerabilities
- Priority 1 recommendations: admin audit logging, secret binding validation, security documentation

**Technical decisions:**
- Recommend building simple controls (rate limiting, audit logging) internally rather than adding dependencies
- Rely on Cloudflare Containers, AI Gateway, and Secrets Store rather than custom isolation/proxy

**Action:**
- Document security model in target repo CLAUDE.md files (propagate via /propagate skill)
- Add admin audit logging to SQLite (simple, low effort, high value)
- Consider per-product rate limiting for abuse prevention

---

## 2026-03-09 - BC-133: Fix agent replies going to main channel instead of thread (PR #69)

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

**What didn't:**
- Initially went down rabbit holes investigating Slack API behavior and race conditions before finding the simpler root cause
- Took multiple iterations to understand that there were TWO separate issues (DB enrichment + thread_ts selection)
- Could have more quickly identified the issue by manually testing the exact scenario the user described

**Technical notes:**
- `orchestrator/src/orchestrator.ts:494-513` — DB query enrichment for Linear tickets (session 1)
- `orchestrator/src/orchestrator.ts:1287` — Thread identifier selection logic (session 2): `slackEvent.thread_ts || slackEvent.ts`
- The fix preserves existing behavior for top-level mentions (agent creates own thread) while fixing mentions inside existing threads

**Files changed:**
- `orchestrator/src/orchestrator.ts`: Thread identifier logic and DB enrichment in routeToAgent()

**Learning:**
- When debugging threading issues, consider all entry points: Linear webhooks (no thread), Slack mentions (new thread vs existing thread), thread replies
- Edge cases often involve scenarios where the same feature (mentions) behaves differently in different contexts (top-level vs in-thread)
- Git history and recent changes are valuable debugging clues - check what's been modified recently in the area of the bug

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
