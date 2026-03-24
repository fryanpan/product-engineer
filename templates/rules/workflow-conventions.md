---
alwaysApply: true
---

# Workflow Conventions

## Planning

- Plans MUST be written to `docs/product/plans/<prefix>-plan.md`
  - `<prefix>` is the ticket number (e.g., `BIK-12`) or sprint number (e.g., `sprint-3`)

## Implementation

- Read relevant existing files before writing anything
- Write tests alongside code, not after
- Coverage target: ~80% of new code
- Test key interfaces, nontrivial logic, and data transformations
- Do NOT test: simple pass-throughs, configuration/constants, third-party library behavior
- Run ALL tests (new + existing) before declaring done
- Stay focused on the task — do not refactor unrelated code

## Commit Discipline

Commit early and often. Key checkpoints:
- **After planning**: commit the plan
- **After implementation**: organize into logical commits — one coherent change per commit
- **After review fixes**: commit as separate commit(s)

Use descriptive commit messages that explain *why*, not just *what*.

## Verification

- After implementing changes, verify the result before reporting done
- State what verification you performed and what you could not verify

## Code Review

- After tests pass, run a code review before presenting results to the user
- Fix issues found by the reviewer before handoff

### Review Criteria

Every code review (whether reviewing your own work or someone else's) must evaluate:

1. **Goal completeness** — Does the change fully achieve its intended goal or use case? Are there edge cases, error paths, or user flows that aren't handled? A partial solution that looks clean is still incomplete.

2. **Simplicity** — Is this the simplest change that achieves the goal? Look for: unnecessary abstractions, premature generalization, features not requested, over-engineering. If the same result could be achieved with less code or fewer moving parts, flag it.

3. **Testing sufficiency** — Has enough testing been done? Key interfaces, non-trivial logic, and data transformations should be tested. Integration paths that could break should be covered. "It works on my machine" is not sufficient — what evidence exists that it works?

4. **Coupling and cohesion** — Does each module/class/function have a single clear responsibility (high cohesion)? Are dependencies between modules minimal and well-defined (low coupling)? If a change touches many unrelated files, or a single file handles many unrelated concerns, flag the opportunity to restructure. This applies to both new code AND existing code touched by the change.

## Post-Implementation Automation

When implementation is complete and tests pass, automatically execute this pipeline without asking. Use background agents for parallelizable steps.

### Step 1: Code Review (automatic, parallel)

Dispatch **two reviewers in parallel** as background agents:
1. Claude code review against the Review Criteria above (spec compliance + code quality)
2. `codex review -c 'model="gpt-5.4"' --base <base-branch>` (Codex CLI review)

Fix any issues found. Re-run reviewers if fixes were non-trivial.

### Step 2: Definition of Done Check

Before creating the PR, verify every item in `.claude/definition-of-done.md` (if present):
- All existing tests pass
- New code has test coverage
- Self-reviewed diff for bugs, security issues, unintended changes
- No secrets or personal references in committed code
- Changes match what was requested — no scope creep

If any item fails, stop and inform the user. Do not create the PR.

### Step 3: Create PR (automatic)

Push the branch and create a PR using `gh pr create`. Include:
- Clear title (under 70 chars)
- Summary (2-3 bullets of what changed and why)
- Definition of Done checklist with evidence
- Test plan

### Step 4: Monitor CI (automatic, background)

After PR creation, launch a background agent to monitor CI:
1. Wait 60 seconds, then check CI status via `gh pr checks <pr-url>`
2. If **pending**: re-check every 60 seconds (max 10 retries)
3. If **failing**: read failure output, diagnose, fix, push, restart monitoring (max 3 fix attempts)
4. If **passing**: report success and proceed to Copilot review check
5. If **no CI**: proceed immediately

### Step 5: Monitor Copilot Review (automatic, background)

After CI passes (or if no CI), check for GitHub Copilot review:
1. Check PR reviews via `gh pr view <pr-url> --json reviews`
2. If Copilot review is pending: re-check every 90 seconds (max 5 retries)
3. If Copilot requests changes: read feedback, address it, push fixes, restart monitoring
4. If Copilot approves or no Copilot review appears: done

### Step 6: Report Completion

Once CI passes and Copilot review (if any) is addressed:
- Report the PR URL and status to the user
- Offer to merge if the change is low-risk and reversible (small bug fixes, copy changes, test additions, config tweaks)
- For risky changes (DB migrations, API contract changes, security-sensitive code, multi-system changes), request human review before merge

### Guiding Principles

- **Don't ask, just do**: The entire pipeline runs automatically once implementation is complete. Only stop for failures or items requiring human judgment.
- **Use background agents**: CI monitoring and Copilot review checking should run in the background so the user isn't blocked.
- **Fix forward**: When CI or Copilot review finds issues, fix them automatically rather than asking the user what to do. Only escalate after 3 failed fix attempts.
- **Batch notifications**: Don't send incremental "CI still pending" updates. Report once when the pipeline completes (success or failure).

## Diagrams

- Use mermaid for all diagrams (architecture, workflows, dependencies)
