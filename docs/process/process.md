# How We Work

## Development Workflow

```mermaid
flowchart LR
    Plan --> Implement --> Review[Code Review] --> Retro
```

| Step | Powered By | Modulated By |
|------|-----------|-------------|
| **Plan** | `superpowers` plugin (writing-plans, brainstorming) | `workflow-conventions` rule (plan file location, plan structure) |
| **Implement** | `superpowers` plugin (executing-plans, test-driven-development, subagent-driven-development) | `workflow-conventions` rule (testing standards, code review) |
| **Code Review** | `superpowers` plugin (requesting-code-review, verification-before-completion) + `code-review` plugin | `workflow-conventions` rule |
| **Retro** | Custom `/retro` skill | `feedback-loop` rule (triggers). Retro invokes `claude-md-management` plugin (claude-md-improver) |

## Dependencies

Everything this workflow relies on — plugins must be enabled in `.claude/settings.json`, custom skills/rules must exist in `.claude/`.

| Dependency | Type | Required For |
|-----------|------|-------------|
| `superpowers` | Plugin | Plan, Implement, Code Review |
| `code-review` | Plugin | Code Review |
| `claude-md-management` | Plugin | Retro (CLAUDE.md improvement step) |
| `commit-commands` | Plugin | PR creation (triggers retro offer) |
| `/retro` | Custom skill | Retrospective |
| `/persist-plan` | Custom skill | Saving plans from plan mode to repo |
| `workflow-conventions` | Custom rule | Project-specific conventions for superpowers |
| `feedback-loop` | Custom rule | Retro triggers, learning capture |

## When Adding Features

1. Discuss scope and approach (use plan mode or ask Claude to plan for non-trivial changes)
2. Plan gets written to `docs/product/plans/` (via superpowers planning or `/persist-plan`)
3. Implement with superpowers skills (executing-plans, test-driven-development)
4. Code review before handoff
5. Open PR, verify CI passes, merge
6. Log any non-obvious decisions in `docs/product/decisions.md`

## Session Continuity

- Reference `docs/product/decisions.md` before proposing alternatives to past decisions
- Reference `CLAUDE.md` for project conventions
- Read `docs/process/learnings.md` for technical gotchas
- Read `docs/process/retrospective.md` for process improvements

## Feedback Loops

- After completing a feature: Ask "Does this work? Anything to improve?"
- After creating a PR or addressing code review: Offer `/retro` (if one hasn't happened yet)
- After ~2-3 hours or a major feature: Run `/retro`
- Log insights in `docs/process/retrospective.md` and `docs/process/learnings.md`
