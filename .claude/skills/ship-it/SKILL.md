---
name: ship-it
description: Post-implementation pipeline — code review, PR creation, CI monitoring, Copilot review. Invoke automatically when all implementation tasks are complete and tests pass, before handing control back to the user.
---

# Ship It

Automated post-implementation pipeline. Run this when implementation is done and tests pass — do NOT hand control back to the user until this pipeline completes or hits a blocker.

## Pipeline

### 1. Code Review (parallel background agents)

Dispatch **both** as background agents simultaneously:

**Agent A — Claude review:**
- Review the full diff (`git diff <base-branch>...HEAD`) against the Review Criteria in workflow-conventions
- Check: goal completeness, simplicity, testing sufficiency, coupling/cohesion
- Return a list of issues (blocking vs. advisory)

**Agent B — Codex review:**
- Run: `codex review -c 'model="gpt-5.4"' --base <base-branch>`
- Capture output

Wait for both to complete. Merge findings. Fix **blocking** issues. Re-run reviewers only if fixes were non-trivial (>10 lines changed).

### 2. Definition of Done

If `.claude/definition-of-done.md` exists, verify every item:
- All existing tests pass
- New code has test coverage for key logic
- Self-reviewed diff — no bugs, security issues, or unintended changes
- No secrets or personal references in committed code
- Changes match the request — no scope creep

**If any item fails:** stop and tell the user what failed. Do not create the PR.

**If all pass:** continue.

### 3. Create PR

```bash
git push -u origin <branch>
gh pr create --title "<concise title>" --body "$(cat <<'PREOF'
## Summary
- <what changed and why — 2-3 bullets>

## Definition of Done
- [x] All tests pass
- [x] New code has test coverage
- [x] Self-reviewed diff
- [x] No secrets in code
- [x] Changes match request

## Test Plan
- [ ] <how to verify this works>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PREOF
)"
```

Capture the PR URL.

### 4. Monitor CI (background agent)

Launch a **background agent** to poll CI status:

```
Loop (max 10 iterations, 60s apart):
  1. Run: gh pr checks <pr-url>
  2. If all checks pass → done, return "ci_passed"
  3. If any check fails → read failure output, return "ci_failed" with details
  4. If checks still pending → wait 60s, retry
```

**On CI failure:**
- Read the failure details
- Attempt to fix (max 3 attempts)
- Push fix, restart CI monitoring
- After 3 failed attempts: report to user, stop

**On CI pass:** proceed to step 5.

**No CI configured:** proceed to step 5 immediately.

### 5. Monitor Copilot Review (background agent)

Launch a **background agent** to check for Copilot review:

```
Loop (max 5 iterations, 90s apart):
  1. Run: gh pr view <pr-url> --json reviews --jq '.reviews[]'
  2. Look for reviews from "copilot" or "github-advanced-security"
  3. If approved or no Copilot review after all retries → done
  4. If changes requested → return review comments
  5. If pending → wait 90s, retry
```

**On Copilot change request:**
- Read the feedback
- Address the comments
- Push fixes
- Restart Copilot monitoring (1 retry)

**On approval or timeout:** proceed to step 6.

### 6. Report & Merge Decision

Tell the user the PR is ready. Include the PR URL and status.

**Auto-merge candidates** (offer to merge without asking):
- Small bug fixes, typo/copy changes
- Test additions with no production code changes
- Config or documentation changes
- Additive changes to a single file/module

**Require human review** (do not offer to merge):
- Database schema changes or migrations
- API contract changes (endpoints, request/response shapes)
- Security-sensitive code (auth, permissions, secrets, input validation)
- Changes spanning multiple systems or shared infrastructure
- Deleting or significantly refactoring existing functionality
- Dependency upgrades

## Principles

- **Don't ask, just do.** The pipeline runs end-to-end automatically. Only stop for failures or items needing human judgment.
- **Background agents for waiting.** CI and Copilot monitoring run in the background. Don't block the user.
- **Fix forward.** When CI or Copilot finds issues, fix them rather than asking the user. Escalate only after 3 failed fix attempts.
- **Batch notifications.** Don't report "still pending." Report once when the pipeline completes or fails.
