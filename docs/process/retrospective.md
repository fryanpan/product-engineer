## 2026-03-18 - Agent plugin loading support (PR #94 + 7 cross-repo PRs)

### Time Breakdown
| Started | Phase | Hands-On Time | Agent Time | Problems |
|---------|-------|--------------|------------|----------|
| Mar 18 11:43am | Research & design (SDK investigation, approach) | ██████ 30m | ██ 15m | |
| Mar 18 11:56am | Implementation (plugins.ts, server.ts, docs) | ██ 10m | ████ 35m | |
| Mar 18 12:30pm | Plugin audit & cross-repo PRs | ██ 10m | ████ 40m | API 529 errors (2x) |
| Mar 18 2:20pm | URL-sourced plugin handling | █ 5m | █ 10m | Assumed superpowers was in marketplace dir |
| Mar 18 2:36pm | Merge PRs + staging deploy | █ 5m | ██████ 55m | Docker not running, premature merge to main |
| Mar 18 4:48pm | Staging verification | █ 5m | ████ 35m | Incomplete transcripts, stuck agent |

### Metrics
| Metric | Duration |
|--------|----------|
| Total wall-clock | ~8 hours |
| Hands-on | ~65 min (14%) |
| Automated agent time | ~190 min (40%) |
| Idle/away | ~225 min (47%) |
| Retro analysis time | ~10 min |

### Key Observations
- Research-first approach (8 turns of Q&A) was efficient — converged on design in ~15 min
- Parallel PR creation across 7 repos completed in ~1 min wall clock via background agents
- Staging verification was the biggest time sink (~2.5h) due to Docker startup, transcript gaps, and a stuck agent
- API 529 errors caused ~1.5h idle; agent didn't auto-retry, user had to re-prompt
- Merged to main before staging verification — should deploy from branch instead

### Feedback
**What worked:** Interactive research phase, parallel cross-repo PRs, clear plugin audit analysis
**What didn't:** Required multiple prompts to get plugin analysis started (529 errors + no auto-retry); premature merge to main before staging

### Actions Taken
| Issue | Action Type | Change |
|-------|-------------|--------|
| CLAUDE.md missing marketplace.json and URL-sourced plugin details | CLAUDE.md | Updated Plugin Loading section with two-phase resolution |
| learnings.md missing marketplace.json discovery detail | Docs | Added bullet about marketplace.json as plugin index |
| Merged to main before staging verification | Feedback memory | Saved: deploy to staging from branch, don't merge first |

---

## 2026-03-12 - BC-157: Deduplicate merge gate decisions (PR #80)

**Context:** Merge gate was generating repetitive, identical decisions for the same PR state. Multiple triggers (CI webhook, PR status update, supervisor, Copilot retries) all called `evaluateMergeGate()` without checking if the PR had actually changed since the last decision.

**What worked:**
- Simple state tracking: store PR head SHA after each decision, skip if unchanged
- SHA-based deduplication is deterministic and catches all duplicate triggers
- Change detection with explicit annotation (e.g., "changes: new commits abc123 → def456") provides clarity
- Migration pattern with duplicate column check is well-established

**Implementation:**
- **orchestrator/src/orchestrator.ts**: Add `last_merge_decision_sha` column migration, deduplication check before LLM call, SHA update after decision
- **orchestrator/src/context-assembler.ts**: Include `headSha` in merge gate context (was computed but not returned)
- **orchestrator/src/types.ts**: Add field to `TicketRecord` interface

**Key insight:**
The problem wasn't in any single trigger path - it was the lack of a shared deduplication layer. Multiple valid triggers all converged on `evaluateMergeGate()`, which had no memory of previous decisions. Adding state at the decision point (not the trigger points) fixes all paths at once.

**Test results:**
- 87 tests pass (same as baseline - no new test failures)
- Deduplication logic is straightforward: SHA match = skip, SHA diff = proceed

**What didn't:**
- Initially considered tracking multiple state dimensions (reviews, CI status, merge conflicts) but SHA is simpler and sufficient - any material change results in a new commit/rebase

**Action:**
- Monitor #product-engineer-decisions after deploy to verify:
  - Single decision per PR head SHA
  - Change annotations appear in subsequent decisions
  - Copilot review retries don't spam when SHA unchanged

---

## 2026-03-18 - BC-168: Improve decision feedback UI with prominent Slack buttons

**Context:** Decision feedback required clicking on a message to add emoji reactions, which was fiddly especially on mobile. Small buttons made the feedback loop more cumbersome than necessary.

**What worked:**
- Slack Block Kit provides prominent, easy-to-tap buttons that are much more accessible
- Three-button layout: "✓ Correct Decision" (primary/green), "✗ Incorrect Decision" (danger/red), "💬 Give Details" (neutral)
- Modal form for detailed feedback combines radio button selection with optional text input
- Backward compatibility maintained: emoji reactions and thread replies still work
- Clean separation of concerns: `decision-engine.ts` builds blocks, `orchestrator.ts` handles interactions
- Test coverage for Block Kit generation ensures structure remains consistent

**Implementation:**
- **orchestrator/src/decision-engine.ts**: Added `buildDecisionBlocks()` to construct Block Kit layout, `postSlackBlocksWithResponse()` to post with blocks
- **orchestrator/src/orchestrator.ts**: Added `handleSlackInteractive()` to process button clicks and modal submissions, `getSlackBotToken()` helper
- **orchestrator/src/index.ts**: Added `/api/webhooks/slack/interactive` endpoint to receive Slack interactivity payloads
- **orchestrator/src/decision-engine.test.ts**: Added test validating Block Kit structure and button configuration

---

## 2026-03-19 - BC-177 Dashboard Setup Completion

**Context:** Dashboard code (auth, UI, API routes) and AI Gateway integration are already complete and deployed. Task asked to "finish dashboard setup" with API/Worker URL credentials available for automation, but said "don't ask questions."

**What worked:**
- Clear separation between "already complete" (code) and "needs configuration" (credentials) helped frame the task
- Creating both automated (script) and manual (docs) paths gives users flexibility
- Using existing API endpoints (`/api/settings/cloudflare_ai_gateway`) for programmatic configuration was the right choice
- Comprehensive documentation structure: status overview → quick start → detailed guide → troubleshooting
- Created `scripts/complete-dashboard-setup.sh` - interactive script that guides setup and can configure AI Gateway via API
- Created `docs/dashboard-completion-guide.md` - detailed manual setup guide with troubleshooting
- Created `DASHBOARD-STATUS.md` - single source of truth for "what's done, what's left"

**What didn't:**
- Initial task description said "don't ask questions" but didn't provide necessary credentials (Google OAuth, AI Gateway). This created an impossible situation where I could automate configuration via API but couldn't create the external resources (OAuth client, gateway) that generate those credentials.
- The line between "automation" and "manual steps" is clear: anything requiring interactive web UIs (Google Console, Cloudflare Dashboard) cannot be scripted without browser automation, which is out of scope.

**Action:**
- When dashboard/auth tasks come up in future, immediately identify which parts are code (can be fully automated) vs. external service setup (requires user action)
- For setup tasks, always create both an interactive script AND comprehensive documentation - users have different preferences
- Document the automation boundary clearly: "Here's what the script can do, here's what you must do manually"
- Status documents (`DASHBOARD-STATUS.md`) should be standard for complex multi-step setup tasks

**What I delivered:**
- Automated: Configuration via API, status checking, guided setup script
- Manual steps documented: Google OAuth setup, AI Gateway creation, secret management
- Verification: Commands to check current state and confirm successful setup

**Key insight:**
Using Block Kit action buttons instead of reactions moves the feedback mechanism from implicit (user must know about reactions) to explicit (buttons are right there). The modal pattern for detailed feedback keeps the simple case (just clicking correct/incorrect) one tap, while making the detailed case accessible without requiring knowledge of thread replies.

**Test results:**
- All 87 existing tests pass
- New test validates Block Kit block structure (3 blocks: section, actions with 3 buttons, context)
- TypeScript compilation successful

**Configuration required:**
- Slack app's Interactivity & Shortcuts settings must be updated to point to: `https://<worker-url>/api/webhooks/slack/interactive`

**Action:**
- Deploy to staging and verify button UI appears on decision messages
- Test all three interaction paths (correct button, incorrect button, details modal)
- Monitor feedback submission rates to see if the easier UI increases feedback volume

---

## 2026-03-12 - BC-157: Complete merge gate deduplication with composite fingerprint

**Context:** BC-157 branch had partial implementation that only tracked PR head SHA for deduplication. This missed cases where merge conditions changed without new commits (CI status changes, Copilot review completes, merge conflicts resolve, new reviews arrive).

**What worked:**
- User identified the gap through question: "Does this account for no new commits but the merge gates changing?"
- Composite fingerprint approach captures all merge-relevant state changes, not just code changes
- Fingerprint format is simple pipe-delimited string: `sha:abc123|ci:true|copilot:false|mergeable:CONFLICTING|reviews:2`
- Change detection logic parses fingerprints and reports exactly what changed (e.g., "CI passed", "Copilot review complete", "mergeable state: CONFLICTING → MERGEABLE")
- Reused existing `last_merge_decision_sha` column (misnomer now, but avoids another migration)
- All 87 tests still pass

**Implementation:**
- **orchestrator/src/orchestrator.ts:1250-1295**: Replace SHA-only check with composite fingerprint
  - Track: head SHA, CI status, Copilot review status, mergeable state, review count, Copilot comment content
  - Copilot comments hashed to detect re-review with new comments (path + first 100 chars of each comment)
  - Parse last and current fingerprints to detect what changed
  - Include specific changes in decision log reason (e.g., "CI passed", "Copilot comments updated")
- **orchestrator/src/orchestrator.ts:517-520**: Update migration comment to reflect composite fingerprint purpose
- **orchestrator/src/orchestrator.ts:1151-1161**: Update doc comment to include all tracked dimensions

**Test results:**
- 87 tests pass, 4 pre-existing failures (missing hono/mustache dependencies)
- No test changes needed (fingerprint comparison is backwards-compatible with null/missing values)

**What didn't:**
- Initial implementation (5baef95) only considered code changes, not merge readiness changes
- Took user feedback to identify the gap

**Action:**
- Monitor merge gate behavior in production to verify fingerprint correctly triggers re-evaluation when CI/Copilot/mergeable state changes
- Consider more semantic column name in future schema refactor (e.g., `last_merge_state_fingerprint`)

---

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
## 2026-03-13 - BC-161: Dozen trigger merge eval decisions every half hour

**What worked:**
- Quick root cause identification by examining supervisor logic and webhook handlers
- Found the gap: PR closed without merging had no webhook handler
- Clean fix with proper test coverage (agent prompt test for pr_closed event)
- All 129 existing tests continued to pass

**What didn't:**
- Initial investigation took multiple rounds of grep/read to understand the full flow
- Had to trace through: supervisor → context-assembler → webhooks → agent prompt
- Could have been faster if I'd checked webhook handlers first (where the gap was)

**Technical Discovery:**
- GitHub PR webhooks have `action: "closed"` with `merged: true|false` flag
- Previous code only handled `closed && merged`, not `closed && !merged`
- Tickets with closed-but-not-merged PRs stay in `pr_open` status indefinitely
- Supervisor's stale PR query (`pr_url IS NOT NULL AND status = 'pr_open' AND updated_at > 4h`) picks them up every tick (5 min interval)
- This caused ~12 LLM merge gate evaluations every 30 minutes for dormant tickets

**Action:**
- Added this pattern to learnings.md under "GitHub Webhooks" section

---

## 2026-03-14 - BC-162: Agent Lifecycle Bugs (PR #82)

**Context:** Agents showing as active for 24+ hours with stale heartbeats. Supervisor repeatedly escalating for already-merged PRs.

**Root causes found:**
1. **Supervisor staleness detection using wrong timestamp:** `forSupervisor()` used `updated_at` for heartbeat age, but `updated_at` changes on any field update (status, PR URL). The actual heartbeat timestamp is `last_heartbeat`, set only by agent phone-home.

2. **Terminal webhook events silently dropped:** `pr_merged` and `pr_closed` events were routed through `sendEvent()` to agent containers, but `sendEvent()` requires `agent_active=1`. If agent had already exited (completed, timed out), the event was lost and ticket stayed in `pr_open` forever.

**What worked:**
- Systematic code tracing: supervisor → context-assembler → handleEvent → sendEvent → agent
- Reading agent server.ts to understand container lifecycle (process.exit on completion/timeout)
- Checking existing learnings.md for related patterns (found GitHub webhooks section already documented the action/merged flag)
- Targeted grep queries to understand data flow

**What didn't:**
- Initially read orchestrator.ts from line 1 — file is too large, should have jumped to specific sections via grep first
- Could have identified issue faster by checking the actual SQL queries first (where bug was obvious: SELECT missing `last_heartbeat`)

**Implementation:**
- `context-assembler.ts`: Added `last_heartbeat` to SQL SELECT, use it for heartbeat age calculation with fallback to `updated_at`
- `orchestrator.ts`: Handle `pr_merged` and `pr_closed` directly in `handleEvent()` — update status, clean up merge_gate_retries, stop agent

**Learning:**
- For lifecycle management, always trace "what happens when the container is gone but the webhook still arrives?"
- State machine transitions must handle both: (1) agent reports completion, (2) external system reports completion
- Staleness detection must use the field that's ONLY updated by the thing you're detecting (not a general "updated_at")

---

## 2026-03-17 - BC-165: Feedback - Asking Unnecessary Questions and Stalling (PR #86)

**Context:** User provided feedback about the agent asking unnecessary questions that could be answered by reading the codebase/links, then stalling after the user responded. Specific complaint: "please don't ask stupid questions and then stall on requests like this one where you can easily look up the answers yourself."

**Root cause:**
The orchestrator's ticket review decision engine (`orchestrator/src/prompts/ticket-review.mustache`) allows the LLM to choose `ask_questions` instead of `start_agent`. The guidance for Slack-originated requests was too weak, leading to unnecessary question-asking for requests where the user had already expressed clear intent.

**What worked:**
- User provided direct, specific feedback about the problem behavior
- Clear examples in the codebase showed the pattern (ticket-review.mustache guidance)
- Strengthened prompt with explicit decision criteria and concrete examples
- Batched all work in minimal turns: branch creation + analysis + fix + commit + PR in 3 turns

**What didn't:**
- Original prompt guidance was too permissive: "Prefer `start_agent` unless genuinely ambiguous"
- Didn't emphasize that agents can ask questions during implementation via `ask_question` tool
- Lacked concrete examples showing the boundary between "ask questions" vs "start agent"
- Couldn't access the Slack thread link provided (got JavaScript infrastructure code, not conversation)

**Implementation:**
- **orchestrator/src/prompts/ticket-review.mustache:59-81**: Strengthened Slack request guidance
  - Added CRITICAL marker for visibility
  - Added explicit decision criteria: only ask if BOTH (a) genuinely ambiguous about WHAT and (b) cannot be determined from code/comments/links
  - Added 5 concrete examples showing when to start_agent vs ask_questions
  - Emphasized that agents can ask questions during implementation, so don't block at ticket creation
- **docs/process/learnings.md**: Added "Ticket Review Decision Engine" section
- **docs/process/retrospective.md**: Added this retro entry

**Learning:**
- **Autonomous agents should default to action, not questions.** The orchestrator's job is to route tickets to agents, not to gather perfect requirements. Agents have tools (`ask_question`, codebase exploration) to gather details during implementation.
- **Prompt guidance must be specific and concrete.** "Prefer X unless Y" is too vague. Use explicit criteria + examples.
- **For Slack requests, the bar for asking questions should be VERY high.** The user already took action to mention the bot — they expect work to start, not a questionnaire.
- **User frustration is valuable signal.** Direct feedback like "don't ask stupid questions" points to a fundamental misalignment in agent behavior that needs fixing at the prompt level.

**Action:**
- Monitor ticket review decisions in #product-engineer-decisions after deploy
- If agents still ask unnecessary questions during implementation (via `ask_question` tool), add similar strengthening to the product-engineer skill
- Consider adding metrics tracking question-asking rate to measure improvement

---

## 2026-03-18 - BC-174: Incorrect merge gate decision on BC-172 (PR #93)

**Context:** The merge gate incorrectly reported "0 files changed, 0 additions, 0 deletions" for PR #91 (BC-172), which actually had 5 files changed, 38 additions, 4 deletions. The LLM decided to send the PR back with "The PR contains no changes whatsoever", blocking legitimate work.

**Root cause:**
`fetchPRDetails` in `context-assembler.ts` returned `null` (likely transient GitHub API error, rate limit, or permission issue), and the code proceeded with default values of 0 for all PR stats. The LLM then made a decision based on bogus data.

**What worked:**
- Quick root cause identification by examining the PR via GitHub API (confirmed it had real changes)
- Traced through context assembly → merge gate evaluation flow
- Simple fix: return error indicator when PR fetch fails instead of proceeding with 0 values
- Updated test to verify error response behavior
- All 87 tests still pass (4 pre-existing failures unrelated)

**What didn't:**
- Original code had no error handling for `fetchPRDetails` failure — silently proceeded with bad data
- No retry logic for transient API failures
- Test was making real GitHub API calls with invalid token, which was brittle

**Implementation:**
- **context-assembler.ts:63-119**: When `fetchPRDetails` returns `null`, immediately return `{ error: "pr_fetch_failed", errorMessage: "...", pr_url: "..." }`
- **orchestrator.ts:1297-1325**: Check for `context.error === "pr_fetch_failed"` before LLM call, post Slack message explaining the issue, return early
- **context-assembler.test.ts:63-84**: Updated test to expect error response when GitHub API fails

**Key insight:**
When gathering context for LLM decisions, failing with clear error is better than proceeding with default/bogus values. The LLM can't know that 0 files changed is wrong — it trusts the data. Better to escalate to humans when data is unavailable than to make decisions on lies.

**Future improvements:**
- Add retry logic for transient GitHub API failures (exponential backoff)
- Consider caching PR details to survive brief API outages
- Add metrics for GitHub API error rates to detect patterns

**Action:**
- Monitor #product-engineer-decisions after deploy to verify Slack error messages appear when GitHub API fails
- Consider adding GitHub API health check to dashboard

---

## 2026-03-12 - BC-157 Session Retro

**What worked:**
- User's question exposed the gap immediately: "Does this account for no new commits but the merge gates changing?"
- Composite fingerprint approach was straightforward to implement on top of existing partial implementation
- User feedback during implementation ("fingerprint the PR review commentary") caught a blind spot before merge
- Simple pipe-delimited format makes fingerprints human-readable in logs
- Change detection logic provides clear audit trail (exactly what changed between decisions)

**What didn't:**
- Original PR author (5baef95) only considered code changes, not merge readiness changes
- Took external review to identify the limitation

**Action taken:**
- Extended fingerprint to track: SHA, CI status, Copilot review status, Copilot comment content, mergeable state, review count
- Added change detection with specific annotations in decision logs
- Updated all documentation (code comments, migration comment, retro)

**Learnings:**
- When building deduplication logic, enumerate all state dimensions that should trigger re-evaluation, not just the obvious one
- User questions during code review are often more valuable than autonomous review
- For merge/deploy automation, explicitly consider: "what happens when X changes but Y stays the same?"

## 2026-03-18 - BC-173: Fix Linear bugs and dashboard

**What worked:**
- Systematic code exploration found all three root causes quickly
- Reading actual Linear webhook payload structure revealed missing comments
- Combining multiple related fixes in one PR for coherent review

**What didn't:**
- Initial ticket had no title/description, illustrating the bug we were fixing
- Couldn't access Linear API during investigation (token not in env)
- WebFetch failed on Linear (SPA rendering)

**Learnings:**
- Linear webhook only sends basic issue fields by default - comments must be fetched via separate GraphQL query
- Agent prompt construction happens in agent/src/prompt.ts formatTicket() - this is where ticket data becomes visible to the agent
- ask_question tool needs orchestrator state update to prevent rapid-fire duplicate calls
- Title truncation at 80 chars was too aggressive, especially with punctuation-based sentence splitting

**Action:**
- Consider adding Linear comment sync as a recurring check (not just on webhook)
- Add integration test that verifies agent receives ticket comments
- Document the ticket data flow: Linear webhook → orchestrator → agent event → prompt builder

---

## 2026-03-24 - Linear Status Synchronization Fix

**Context**: Fixed agents not updating Linear ticket status properly

**What worked:**
- Systematic investigation: traced complete flow from agent → orchestrator → Linear API
- Found root cause quickly: silent failures in StatusUpdater with inadequate logging
- Comprehensive testing: created 7 integration tests covering all error scenarios
- Clear documentation: wrote diagnostic guide for operators

**What didn't:**
- Pre-existing typecheck errors in main branch blocked CI
- Should have checked CI status on main before starting work
- Could have committed skill files separately (they were added automatically)

**Action:**
- Enhanced StatusUpdater with detailed error logging for all failure paths
- Created integration tests to prevent regression
- Documented diagnostic patterns in `docs/linear-status-sync-fix.md`
- PR ready for review despite CI typecheck failures (unrelated to changes)

**Learnings:**
- Always check CI status on target branch before starting
- StatusUpdater pattern is solid: parallel updates with graceful error handling
- Linear GraphQL API requires issue ID (UUID), not identifier (e.g., "PE-42")
- Silent failures are debugging nightmares - log everything with context
