## 2026-03-07 - Fix /agent-status command recognition (Slack command)

**Context:** User tried `@product-engineer /agent-status` but the command didn't trigger. Found the code was still looking for `/pe-status` instead of `/agent-status`.

**What worked:**
- Grep to find all references to the old command name
- Unit tests passed after updating regex patterns
- Clear separation: Slack Socket Mode detection → Orchestrator routing → handler

**What didn't:**
- Inconsistency between retrospective documentation and actual code
- PR #59's final decision (`/agent-status`) wasn't reflected in the implementation

**Learnings:**
- When renaming user-facing commands, search for ALL references (code, tests, docs)
- Regex patterns in multiple files need coordinated updates:
  - `containers/orchestrator/slack-socket.ts` - detection layer
  - `orchestrator/src/orchestrator.ts` - routing layer
  - Documentation
- Retrospectives document decisions but don't guarantee implementation - verify the code matches the decision

**Changes:**
- Updated `/(^|\s)\/pe-status(\s|$)/` → `/(^|\s)\/agent-status(\s|$)/` in both files
- Updated `slash_command === "pe-status"` → `slash_command === "agent-status"`
- Updated docs/status-command.md

**Action:** Added to docs/process/retrospective.md

---

## 2026-03-07 - Immediate container shutdown on terminal state (BC-118, PR #61)

**Context:** Copilot review identified 4 issues in the immediate shutdown implementation that could cause containers to hang indefinitely - exactly what the PR was trying to prevent.

**What worked:**
- Copilot caught real bugs: intervals racing with shutdown, missing timeouts, no error handling
- All 4 issues fixed in a single commit with comprehensive error handling:
  1. Clear intervals immediately (before async work) to prevent concurrent operations
  2. 15s timeout on shutdown work (transcript upload + token reporting) using Promise.race
  3. 5s timeout on container shutdown request using AbortController
  4. Response validation with proper error logging for non-2xx responses
- Tests still passing after fixes (agent: 26/30, orchestrator: 11/11)

**What didn't:**
- Initial implementation missed edge cases around hanging network calls and race conditions
- Didn't consider that shutdown work itself could hang and prevent process.exit from running
- No timeout on the orchestrator → container shutdown request could block status updates

**Action:**
- Always add timeouts to network operations, especially in cleanup/shutdown paths
- Clear background work (intervals, timers) before starting async cleanup
- Validate response status for internal service calls - don't assume success
- Use `finally` blocks to guarantee critical cleanup runs (like process.exit scheduling)

**Technical notes:**
- `Promise.race([work, timeout])` pattern ensures bounded-time async operations
- AbortController on fetch prevents hung requests from blocking callers
- Moving clearInterval before await prevents intervals from firing during async cleanup
- Response validation catches auth failures and other non-2xx responses that would silently fail

---

## 2026-03-07 - Add session timeout watchdog (BC-118, PR #58)

**Context:** After the initial `process.exit(0)` fix in #55, 13 agents were still running 6 hours later. The fix only ran when sessions completed naturally, but agents waiting for Slack replies never completed.

**What worked:**
- Identified root cause: message generator uses `while (true)` (line 334) and never exits on its own
- Agents waiting for Slack replies would loop indefinitely in `for await (const message of session)`
- Added session timeout watchdog with two conditions:
  - Hard timeout: 2 hours wall-clock time (exits unconditionally)
  - Idle timeout: 30 minutes without SDK messages AND status != "running"
- Tracked sessionStartTime and lastMessageTime to enable timeout detection
- All exit paths (completion, error, signals) clear the watchdog interval
- Tests passing (agent: 26/30, orchestrator: 46/47)

**What didn't:**
- Initial fix in #55 only added `process.exit()` in the session completion path
- Didn't consider that the message queue loop might never complete naturally
- Took 6 hours in production to discover agents were still stuck

**Action:**
- When adding explicit cleanup/exit logic, consider all code paths
- Message queue patterns with `while (true)` need timeout protection
- Always add hard timeouts for long-running operations that might wait for external input
- Monitor production metrics (container count) after deploying lifecycle fixes

**Technical notes:**
- Session timeout runs every 60 seconds via `setInterval`
- Timeouts call `process.exit(0)` after uploading transcripts
- No false positives: idle timeout only fires when status != "running" (won't kill active work)
- `lastMessageTime` updated on every SDK message (line 519), not on Slack events
- Chose 2h hard timeout to match expected ticket completion time
- Chose 30m idle timeout as balance between responsiveness and patience

**Files changed:**
- `agent/src/server.ts`: Added timeout watchdog, tracking variables
- `docs/product/plans/BC-118-plan.md`: Updated root cause analysis

## 2026-03-07 - Rename /status to /agent-status (PR #59)

**Context:** User reported `/status` conflicts with existing Slack slash commands. Needed to rename to avoid collision.

**What worked:**
- User clearly identified the conflict with existing Slack commands
- Final decision: `/agent-status` (clearer than `/pe-status`, avoids all conflicts)
- Addressed Copilot review feedback on tests:
  - Extracted shared regex constant for maintainability
  - Added realistic Slack mention format tests (`<@USERID>`)
  - Added edge case tests for partial word matching
  - Updated test descriptions to match implementation
- Comprehensive search found all references in code, docs, and tests
- Tests validated the change worked correctly
- Single PR captured all related changes

**What didn't:**
- Original implementation didn't consider naming conflicts with Slack
- Could have chosen a more specific name from the start
- Initial PR iteration used `/pe-status` which was less clear than `/agent-status`

**Action:**
- When implementing Slack commands, check for conflicts with:
  - Built-in Slack commands
  - Workspace-specific slash commands
  - Common conventions
- Prefer descriptive names that make intent clear (`/agent-status` > `/pe-status`)

**Technical notes:**
- Changed regex pattern: `/(^|\s)\/status(\s|$)/` → `/(^|\s)\/agent-status(\s|$)/`
- Updated `slash_command` field value: `"status"` → `"agent-status"`
- Improved test coverage based on review feedback
- All tests passing after rename
- No functional changes to status reporting logic

**Files changed:**
- `containers/orchestrator/slack-socket.ts` (detection)
- `orchestrator/src/orchestrator.ts` (handler)
- `docs/status-command.md` (documentation)
- `orchestrator/src/status-command.test.ts` (tests)

## 2026-03-07 - BC-118 Third Attempt: Immediate Container Shutdown (PR #61)

**Context:** After PR #55 (added process.exit on completion) and PR #58 (added timeout watchdog), 13 containers were still running 6 hours later. Root cause: containers marked "terminal" didn't actually shut down.

**What worked:**
- Screenshot evidence made the issue concrete - could see containers in terminal states still running
- Reading lifecycle code revealed the gap: `/mark-terminal` set a flag but didn't stop the process
- Simple fix: add `/shutdown` endpoint and call it from `/mark-terminal`

**What didn't:**
- Previous fixes addressed session completion and timeout scenarios, but not the terminal state path
- When orchestrator marks a ticket terminal (merged/closed/deferred/failed), it called `/mark-terminal` which only set a SQLite flag to prevent alarm restarts
- The actual container process kept running until SDK session completed or hit 2-hour timeout
- This is why containers stayed alive 6+ hours after terminal state

**Action:**
- Added `/shutdown` endpoint to agent server (uploads transcripts, reports tokens, exits)
- Updated `/mark-terminal` to call container's `/shutdown` before returning
- Now containers exit within seconds of terminal state instead of waiting hours

**Pattern learned:**
- Lifecycle features need exhaustive edge case enumeration (this is the third fix for the same symptom)
- "Mark as done" vs "actually stop" are different operations - both are needed
- The learnings.md note about multi-agent edge cases was exactly right - should have applied it here

**Files changed:**
- `agent/src/server.ts`: Added `/shutdown` endpoint
- `orchestrator/src/ticket-agent.ts`: Updated `/mark-terminal` to call shutdown

---

## 2026-03-07 - BC-118: Investigation - "Fix did not work"

**Context:** User reported 13 agents still stuck open 6 hours after the fix. "Fix did not work" was added to the ticket description.

**Investigation findings:**
- The `/shutdown` fix WAS correctly implemented on `ticket/BC-118` branch (commits d3b5728, 857f3d4)
- PR #61 exists with the complete, reviewed fix
- BUT: The fix was **never merged to main and deployed to production**
- Production was still running code without the `/shutdown` endpoint
- That's why containers kept running - the fix literally wasn't deployed

**Root cause of "fix not working":**
- **The fix was implemented but not deployed**
- Branch vs main confusion - fix on branch ≠ fix in production
- PR sat open without merge for multiple days
- No verification that deployed code matched expected state

**What worked:**
- Quick branch comparison revealed the issue immediately
- `git show main:agent/src/server.ts | grep shutdown` → no results
- Current branch has fix, main doesn't → deployment gap identified
- All the code is correct and ready to merge

**What didn't:**
- Multiple people implementing the fix but not ensuring deployment
- No deployment verification after "fixing"
- Critical PR left unmerged while issue persisted in production

**Critical learning:**
**IMPLEMENTING A FIX ≠ DEPLOYING A FIX**

The full chain must complete:
1. ✅ Implement fix
2. ✅ Test fix
3. ✅ Create PR
4. ❌ **Merge PR** ← MISSED THIS STEP
5. ❌ **Deploy to production** ← AND THIS
6. ❌ **Verify in production** ← AND THIS

**Action:**
- PR #61 ready to merge immediately
- After merge: `cd orchestrator && wrangler deploy`
- After deploy: Monitor Cloudflare dashboard for container count drop
- Added process rule: Critical fixes must be merged and deployed same day, not left as open PRs
- Document deployment status in ticket comments ("fix implemented" vs "fix deployed")
