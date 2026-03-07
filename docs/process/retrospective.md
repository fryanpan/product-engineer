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
