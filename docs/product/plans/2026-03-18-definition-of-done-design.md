# Definition of Done — Design

**Date:** 2026-03-18
**Approach:** B — File Convention + Orchestrator Fetch

## Problem

PRs are getting merged that don't follow repo conventions:
1. Agent makes the wrong *kind* of change (e.g., writing code for administrative tasks that should use the API)
2. Buggy code gets merged without sufficient verification
3. No per-repo acceptance criteria — the merge gate applies universal hard gates only

## Design

### 1. Definition-of-Done File

Each target repo gets `.claude/definition-of-done.md` — a checklist the agent must satisfy before creating a PR.

**Format:**

```markdown
# Definition of Done

Checklist items the agent MUST satisfy before creating a PR.
If any item cannot be satisfied, ask for help via Slack instead of creating the PR.

## Always
- [ ] All existing tests pass
- [ ] New code has test coverage for key logic
- [ ] No secrets, API keys, or personal project references in committed code

## When: workflow or orchestration changes
- [ ] Integration tested in staging (happy path + key edge cases)
- [ ] Demonstrated that the change works with real data (paste output or screenshot)

## When: API endpoints or data handling
- [ ] Security review: no open/unauthenticated endpoints, no PII leakage
- [ ] Input validation on all external-facing parameters
```

- `## Always` applies to every PR
- `## When: <condition>` sections apply only when the change matches the condition
- Each repo customizes its own checklist
- Agent determines which conditional sections apply based on the nature of the change

### 2. Agent Behavior (Skill Changes)

Update `product-engineer` skill (SKILL.md) — no code changes to agent server.

**Before creating a PR (between current steps 6 and 7):**
1. Read `.claude/definition-of-done.md` from the repo
2. Evaluate each `## Always` item and any matching `## When:` sections
3. For each item: satisfy it (run tests, do the review, etc.) or confirm it's already satisfied
4. If any item can't be satisfied → `ask_question` via Slack, do NOT create PR
5. If all items pass → create PR

**In the PR description:**
- Add a `## Definition of Done` section
- Each applicable checklist item with ✅ marker and brief evidence
- e.g., "✅ All tests pass — `bun test` output: 47 passed, 0 failed"

### 3. Merge Gate Changes

Two changes to the orchestrator:

**Fetch the file:** Before calling the merge gate LLM, fetch `.claude/definition-of-done.md` from the repo via GitHub API (`GET /repos/:owner/:repo/contents/.claude/definition-of-done.md`). If the file doesn't exist, skip (backwards compatible).

**Add to the prompt:** New section in `merge-gate.mustache`:

```mustache
{{#definitionOfDone}}
## Definition of Done
The repo defines these acceptance criteria:

{{{definitionOfDone}}}

Verify the PR description addresses every applicable checklist item.
If items are missing or clearly unsatisfied, use "send_back" with details of what's missing.
{{/definitionOfDone}}
```

The merge gate LLM cross-references checklist items against the PR description — trust but verify format (checking completeness, not re-running tests).

### 4. Template & Propagation

- Add `templates/definition-of-done.md` with sensible defaults (the `## Always` section)
- `/propagate` pushes this to new repos; each repo customizes conditional sections
- Product-engineer repo gets its own definition-of-done emphasizing staging integration tests

### 5. Project-Specific Claude Rules

Separate from definition-of-done, repos use `.claude/rules/` files for behavioral guidance. Example for product-engineer repo:

```markdown
# Administrative Operations

- Adding products, updating registry config, or changing orchestrator settings
  must be done via the admin API (POST/PUT /api/products), not by writing new code files
- Never commit project-specific configuration (repo URLs, channel IDs, secret names)
  into source code — these belong in the runtime registry
```

Already supported by `settingSources: ["project"]` — no new mechanism needed.

## Out of Scope (Future)

- Automated feedback loop: Slack feedback → definition-of-done updates (decision feedback is already logged in `decision_feedback` table for future review)
- Structured YAML schema for verification types
- Independent verification by merge gate (re-running tests, not just checking PR description)

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Evidence format | Inline in PR description | Simplest, visible to humans, merge gate already reads it |
| Agent can't satisfy item | Block PR, ask for help via Slack | Agent should only fail if it truly can't find a way |
| Merge gate enforcement | Trust but verify format | Keep simple until that doesn't work |
| Feedback → behavior loop | Out of scope for now | Solve definition-of-done first |
| Wrong-kind-of-change prevention | Project-specific `.claude/rules/` | Already supported, just needs rules written |
