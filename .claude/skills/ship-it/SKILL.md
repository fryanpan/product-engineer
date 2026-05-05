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

### 4. Monitor CI (channel-driven, no polling)

The `github-claude-channel` plugin pushes GitHub events to your session as `<channel source="github" ...>` notifications. **Do NOT poll `gh pr checks` in a loop** — wait for the channel event instead.

If `watch_repo("auto")` hasn't been called for this repo yet, call it once now. (Idempotent — safe to re-call.)

Then await channel events for this PR:
- **✅ CI pass event** → proceed to step 5
- **❌ CI fail event** → read failure output via one `gh pr checks <pr-url>` call (not a loop), diagnose, fix, push, await the next CI event
- After 3 fix attempts: report to user, stop

**Timeout fallback:** if no CI event arrives after 30 minutes, fall back to a single `gh pr checks <pr-url>` to confirm state (channel could miss occasionally; one explicit check is cheap).

**No CI configured** (no event ever arrives, no checks configured) → proceed to step 5 after the timeout fallback confirms there are no checks.

### 5. Monitor Copilot Review (channel-driven, no polling)

Same channel — wait for **👀 Review-requested events** on this PR. Copilot / github-advanced-security reviews surface as channel events from `github-claude-channel`.

- 👀 Review event from copilot/github-advanced-security → read via `gh pr view <pr-url> --json reviews --jq '.reviews[]'`
- If approved → proceed to step 6
- If changes requested → address comments, push, await the next review event (1 retry max)

**Timeout fallback:** if no review event arrives after 5 minutes, treat as "no Copilot review configured for this repo" and proceed to step 6.

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
- **Channel events over polling.** GitHub events (CI, reviews, merges, deploys) arrive as `<channel source="github" ...>` notifications via the `github-claude-channel` plugin. Don't write polling loops; await events. Polling wastes turns and stays expensive even when nothing's happening.
- **Fix forward.** When CI or Copilot finds issues, fix them rather than asking the user. Escalate only after 3 failed fix attempts.
- **Batch notifications.** Don't report "still pending." Report once when the pipeline completes or fails.
