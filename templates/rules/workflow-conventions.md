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

## Diagrams

- Use mermaid for all diagrams (architecture, workflows, dependencies)
