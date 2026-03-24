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

## Post-Implementation

When all implementation tasks are complete and tests pass, invoke the `ship-it` skill **before** handing control back to the user. This runs code review, creates the PR, and monitors CI/Copilot feedback automatically.

## Diagrams

- Use mermaid for all diagrams (architecture, workflows, dependencies)
