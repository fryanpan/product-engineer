---
name: task-retro
description: Per-task retrospective that the Product Engineer runs after completing each task. Captures learnings and posts to Slack.
---

# Task Retro

After completing any task (implemented, deferred, or failed), do a brief retro. Keep it to 1-2 LLM turns total.

## Steps

### 1. Reflect and Act (one turn)

Answer briefly:
1. **What worked?** — Effective patterns or tools
2. **What didn't?** — Gotchas, blockers, surprises
3. **One concrete action** — Update learnings.md, fix a doc, or create a ticket. Do it now.

### 2. Post to Slack (combine with other work)

Post the retro as a Slack thread reply. Combine this `notify_slack` call with your status update or merge action — never use a turn just for the retro post.

Format:
```
Retro: [1-2 sentence summary]
- Worked: [key success]
- Learned: [specific gotcha or insight]
- Action: [what you changed, with link]
```

### 3. Cross-Project Learnings

If you discovered something useful across ALL products, note it in your final output for the orchestrator to aggregate.

## Principles

- **One action minimum.** Every retro must produce at least one concrete change.
- **Specific over generic.** "Test runner needs `--no-cache` after dep changes" not "testing is important."
- **Brief.** The retro should take 1-2 turns, not 5.
