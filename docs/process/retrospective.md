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
