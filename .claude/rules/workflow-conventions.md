---
alwaysApply: true
---

# Workflow Conventions

Project-specific conventions that guide how superpowers plugin skills behave in this project.

## Planning

- Plans MUST be written to `docs/product/plans/<prefix>-plan.md`
  - `<prefix>` is the ticket number (e.g., `BIK-12`) or sprint number (e.g., `sprint-3`)
  - Ask the user which prefix to use if unclear
- If a plan exists in `.claude/plans/` but not in `docs/product/plans/`, persist it using `/persist-plan`
- Plans should include:
  - Measurable outcomes (concrete yes/no statements)
  - Key workflows (mermaid flowcharts)
  - Alternatives evaluation (table: Effort, Risk, Usability, Impact) — propose 2-3 fundamentally different approaches, not variations
  - System design with component diagram (mermaid) and interfaces table
  - Execution strategy: chunking, sequencing vs parallelism, risk notes
  - Testing & deployment strategy
- For **multi-agent and lifecycle features** (conductor, TaskAgent, container management): plans MUST include an explicit edge case matrix — enumerate what happens at each lifecycle boundary (container restart, deploy, alarm fire, terminal state transition, session complete). Two separate bugs (investigation cascade, alarm restart) had the same root cause: not considering "what happens when the container restarts for a task that's already done?"

## Execution Strategy

**Default: Subagent-Driven Development.** Always use this unless a specific reason requires a different approach.

| Approach | When to use | How it works |
|----------|-------------|--------------|
| **Subagent-Driven Development** (default) | Most tasks. Fast iteration with automated review. | `superpowers:subagent-driven-development` — stays in current session, dispatches a fresh subagent per task with two-stage review (spec compliance, then code quality). |
| **Agent Team** | Highly parallel work where 3+ tasks can run simultaneously with no shared state. | `TeamCreate` + spawn teammates — named agents coordinate via task list and messages, work in true parallel. |
| **Executing Plans** | Only when subagent-driven won't work (e.g., tasks require deep shared state across steps). | `superpowers:executing-plans` — creates a worktree, executes all tasks in a single pass, then reports for review. |

Do NOT ask which approach to use. Use Subagent-Driven Development.

## Output Destination

Each project should define where standalone deliverables (docs, plans, research, reviews) are written. Check the project's CLAUDE.md for a `docs_destination` convention. If none is set, ask the user on first encounter and record it.

Common destinations:
- **Local file** (`docs/` directory in repo)
- **Notion** (specific workspace/section)
- **Other** (WordPress, Google Docs, etc.)

If a Notion URL appeared earlier in the session, default to writing there unless the project convention says otherwise.

## Autonomy

- When the user has approved a plan, execute all phases without pausing for checkpoint approval. Only stop when you've discovered something that changes the scope or risk of the original request.
- When multiple clarifying questions are needed, batch them into a single message. Do not ask one question at a time.
- Do not re-research information the user has already provided in the current session.

## Tool & Technology Choices

- Prefer current best practices for the task at hand (e.g., `uv` over `pip` for Python dependency management).
- When choosing between viable approaches with meaningful tradeoffs, surface the choice and reasoning before implementing — especially for anything involving external risk (rate limits, bans, third-party services).

## Verification

- After implementing UI changes or bug fixes, verify the result before reporting done. Never mark a UI task complete based solely on code being written — state what verification you performed and what you could not verify.
- At the start of any worktree session involving commits, check whether the worktree is current with its base branch. Report the result before beginning implementation.

## Implementation

- Read relevant existing files before writing anything
- Write tests alongside code, not after
- Coverage target: ~80% of new code
- Test all key interfaces, nontrivial logic, and data transformations
- Do NOT test: simple pass-throughs, configuration/constants, third-party library behavior
- Run ALL tests (new + existing) before requesting user help
- Stay focused on the plan — do not refactor unrelated code
- If stuck, say so — don't brute-force

## Code Review

- After tests pass, run a code review before presenting results to the user
- Fix issues found by the reviewer before handoff
- **When the user requests a code review** (e.g., `/code-review`, "review this PR"), always run **both** in parallel:
  1. Claude code review (`/code-review:code-review` or the superpowers review skill)
  2. Codex CLI review: `codex review -c 'model="gpt-5.4"' --base <base-branch>` (run via Bash tool in background)
- Combine findings from both reviewers before presenting results

### Review Criteria

Every code review (whether reviewing your own work or someone else's) must evaluate:

1. **Goal completeness** — Does the change fully achieve its intended goal or use case? Are there edge cases, error paths, or user flows that aren't handled? A partial solution that looks clean is still incomplete.

2. **Simplicity** — Is this the simplest change that achieves the goal? Look for: unnecessary abstractions, premature generalization, features not requested, over-engineering. If the same result could be achieved with less code or fewer moving parts, flag it.

3. **Testing sufficiency** — Has enough testing been done? Key interfaces, non-trivial logic, and data transformations should be tested. Integration paths that could break should be covered. "It works on my machine" is not sufficient — what evidence exists that it works?

4. **Coupling and cohesion** — Does each module/class/function have a single clear responsibility (high cohesion)? Are dependencies between modules minimal and well-defined (low coupling)? If a change touches many unrelated files, or a single file handles many unrelated concerns, flag the opportunity to restructure. This applies to both new code AND existing code touched by the change.

## Commit Discipline

Commit early and often to create an incremental record. Key checkpoints:

- **After planning**: Once the plan is written to `docs/product/plans/`, commit it
- **After implementation**: Before requesting review, organize work into logical, digestible commits — each commit should represent one coherent change (a feature, a test suite, a refactor). Don't lump everything into one giant commit
- **After code review**: Commit review fixes as separate commit(s) so the review trail is visible
- **After retro/learnings updates**: Commit changes to `docs/process/` files

Use descriptive commit messages that explain *why*, not just *what*.

## Post-Implementation

When all implementation tasks are complete and tests pass, invoke the `ship-it` skill **before** handing control back to the user. This runs code review, creates the PR, and monitors CI/Copilot feedback automatically.

## Diagrams

- Use mermaid for all diagrams (architecture, workflows, dependencies)
