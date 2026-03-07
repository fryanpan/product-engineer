## 2026-03-07 - Feedback: Rename /status to /pe-status

**What worked:**
- User clearly identified the conflict with existing Slack commands
- Quick fix: rename all occurrences from `/status` to `/pe-status`
- Comprehensive search found all references in code, docs, and tests
- Tests validated the change worked correctly
- Single PR captured all related changes

**What didn't:**
- Original implementation didn't consider naming conflicts with Slack
- Could have chosen a more specific name from the start

**Action:**
- When implementing Slack commands, check for conflicts with:
  - Built-in Slack commands
  - Workspace-specific slash commands
  - Common conventions
- Prefer product-specific prefixes for clarity (e.g., `/pe-*` pattern)

**Technical notes:**
- Changed regex pattern: `/(^|\s)\/status(\s|$)/` → `/(^|\s)\/pe-status(\s|$)/`
- Updated `slash_command` field value: `"status"` → `"pe-status"`
- All tests passing after rename
- No functional changes, purely cosmetic

**Files changed:**
- `containers/orchestrator/slack-socket.ts` (detection)
- `orchestrator/src/orchestrator.ts` (handler)
- `docs/status-command.md` (documentation)
- `orchestrator/src/status-command.test.ts` (tests)
- `docs/process/retrospective.md` (historical entries)
