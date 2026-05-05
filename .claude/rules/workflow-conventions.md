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

## Execution Strategy

After planning, choose an execution approach. Present these options to the user:

| Approach | When to use | How it works |
|----------|-------------|--------------|
| **Executing Plans** (default) | Most tasks. You want human checkpoints at the end. | `superpowers:executing-plans` — creates a worktree, executes all tasks in a single pass, then reports for review. Do NOT batch into groups of 3 — execute everything, then pause. |
| **Subagent-Driven Development** | Tasks are independent. You want fast iteration with automated review. | `superpowers:subagent-driven-development` — stays in current session, dispatches a fresh subagent per task with two-stage review (spec compliance, then code quality). |
| **Agent Team** (experimental) | Highly parallel work where 3+ tasks can run simultaneously with no shared state. | `TeamCreate` + spawn teammates — named agents coordinate via task list and messages, work in true parallel. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var. |

**Decision flow:**
1. Are tasks mostly independent with no shared state? If no → **Executing Plans**
2. Can 3+ tasks genuinely run in parallel? If yes → **Agent Team**
3. Otherwise → **Subagent-Driven Development** (sequential but automated)

If unsure, default to **Executing Plans** — it's the most predictable.

## Output Destination

Each project should define where standalone deliverables (docs, plans, research, reviews) are written. Check the project's CLAUDE.md for a `docs_destination` convention. If none is set, ask the user on first encounter and record it.

Common destinations:
- **Local file** (`docs/` directory in repo)
- **Notion** (specific workspace/section)
- **Other** (WordPress, Google Docs, etc.)

If a Notion URL appeared earlier in the session, default to writing there unless the project convention says otherwise.

## Decision Framework

When facing a decision during planning or implementation, use this framework to decide whether to act autonomously or ask for human input:

**Reversible — decide autonomously, log to `docs/product/decisions.md`:**
- File structure, naming conventions, code organization
- Implementation approach selection
- Package and dependency choices
- Test strategy and error handling patterns
- DB schema changes (for non-public APIs)
- API contract changes (for non-public APIs)

**Hard to reverse — batch all questions and present together:**
- Data deletion or loss scenarios
- Force pushes or destructive git operations
- Architectural decisions affecting multiple systems
- External service integrations with billing or security implications

**Rule of thumb:** If it's easy to change later and low-risk, make your best call and document it in `decisions.md`. If it's hard to reverse or high-risk, batch all pending questions and present them together in a single message.

**Project override:** Projects with public APIs or mature schemas where users depend on specific contracts should move DB schema and API contract changes to the "hard to reverse" category. Add a note in the project's `workflow-conventions.md` to override this default.

## Autonomy

- When the user has approved a plan, execute all phases without pausing for checkpoint approval. Only stop when you've discovered something that changes the scope or risk of the original request.
- When multiple clarifying questions are needed, batch them into a single message. Do not ask one question at a time.
- Do not re-research information the user has already provided in the current session.
- Apply the Decision Framework above at every decision point — during brainstorming, planning, implementation, and review. Default to autonomous action for reversible decisions.

## Superpowers Overrides

These conventions modify how superpowers plugin skills behave in this project:

### Brainstorming
- Present all clarifying questions together in a single message, not one at a time.
- For reversible design decisions, make the call autonomously and document it in `decisions.md`. Only pause for human input on decisions that are hard to reverse.
- Present the full design in one pass for approval, not section by section.
- When the user has already described the problem space clearly, fast-track to proposing a design after 1-2 targeted questions.

### Executing Plans
- Do NOT pause for feedback between batches. Execute all tasks in a single pass, then report results.
- Only stop mid-execution if blocked or facing a decision that is hard to reverse per the Decision Framework.
- Verification gates (tests must pass, verification-before-completion) are still enforced — these are quality checks, not human checkpoints.

### Finishing a Development Branch
- Default to creating a PR without asking — this is the most reversible completion option.
- Only prompt the user if tests are failing or the target branch is ambiguous.

### Retro
- In human-led sessions: ask for feedback in one prompt (not multiple rounds), then propose and execute approved actions.
- In autonomous sessions (no human present): analyze the transcript, log findings, and execute low-risk improvements (doc updates, learnings) without asking. Skip actions that would change skill behavior or CLAUDE.md without human review.

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

## Commit Discipline

Commit early and often to create an incremental record. Key checkpoints:

- **After planning**: Once the plan is written to `docs/product/plans/`, commit it
- **After implementation**: Before requesting review, organize work into logical, digestible commits — each commit should represent one coherent change (a feature, a test suite, a refactor). Don't lump everything into one giant commit
- **After code review**: Commit review fixes as separate commit(s) so the review trail is visible
- **After retro/learnings updates**: Commit changes to `docs/process/` files

Use descriptive commit messages that explain *why*, not just *what*.

## Post-Implementation

When all implementation tasks are complete and tests pass, invoke the `ship-it` skill **before** handing control back to the user. This runs code review, creates the PR, and monitors CI/Copilot feedback automatically.

## Notifying the Conductor

After completing a task (PR merged, research delivered, or work otherwise done), notify the conductor session via claude-hive:

1. Call `mcp__claude-hive__list_peers` with `scope: "machine"` to find the conductor.
2. Identify the conductor by its summary containing "Conductor" (peers set their role via `set_summary` on startup).
3. Call `mcp__claude-hive__send_message` with `to_stable_id` (preferred over `to_id` — stable IDs survive session restarts) and a brief completion summary:
   > "Task complete: [one-line description of what was done]. PR: [url if applicable]"

If no conductor peer is found, skip silently — don't block on it.

## Diagrams

- Use mermaid for all diagrams (architecture, workflows, dependencies)
