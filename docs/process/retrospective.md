## 2026-03-07 - BC-118: Agent Container Cleanup (Fourth Attempt)

**Context:** 13 agents remained running 6 hours after being marked terminal, despite previous fix attempts. The fix had actually been implemented in commits d3b5728 and 857f3d4, but was never merged to main.

**What worked:**
- Git forensics revealed the root cause: `git branch -a --contains d3b5728` showed fix only on `origin/ticket/BC-118`
- Used `git log --graph --all` to visualize branch divergence
- Cherry-picked working solution (commit 1b22ebd) to new clean branch from main
- Tests confirmed implementation works (26 agent + 46 orchestrator tests pass)

**What didn't:**
- Previous three attempts created fixes in a branch that never got merged to main
- No verification that fixes were actually deployed (merged and in production)
- Wasted time debugging code that was already written but not shipped
- Branch divergence made direct push impossible

**Lessons:**
- **Always verify fix deployment state before investigating further** - a fix isn't deployed until merged to main
- Use `git branch -a --contains <commit>` to check which branches contain a commit
- Check `git log --graph --all --decorate` to visualize branch relationships
- Previous attempts d3b5728 ("Add /shutdown endpoint") and 857f3d4 ("Add timeouts") had the correct solution

**Changes:**
- Created new branch `fix/BC-118-container-shutdown` from main
- Cherry-picked commit 1b22ebd with `/shutdown` endpoint implementation
- PR #62: https://github.com/fryanpan/product-engineer/pull/62

**Action:** After merge and deploy, containers should exit within 30s of reaching terminal state instead of staying alive 2+ hours.

---

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
