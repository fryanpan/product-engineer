---
name: task-retro
description: Per-task retrospective that the Product Engineer runs after completing each task. Captures learnings and posts to Slack.
---

# Task Retro

After completing any task (implemented, deferred, or failed), do a brief retro.

## Steps

### Step 1: Reflect

Answer these questions (2-3 sentences total, not a full essay):

1. **What happened?** — One sentence summary of the task and outcome.
2. **What was surprising?** — Anything unexpected about the codebase, the task, or the tools?
3. **Gotchas for next time?** — Anything a future agent working on this product should know?

### Step 2: Post to Slack

Post your retro as a thread reply in the task's Slack thread. Format:

```
📝 *Retro*
• [What happened]
• [What was surprising]
• [Gotchas]
```

Keep it short. The team reads these quickly.

### Step 3: Log for Cross-Project Review

If you discovered something that would help across ALL products (not just this one), note it in your final output. The orchestrator aggregates these for the cross-project review cycle.

Examples of cross-product learnings:
- A tool or MCP server that behaves unexpectedly
- A pattern that works well for a certain type of task
- A common mistake to avoid

## Principles

- **Brevity over completeness.** 3 sentences, not 3 paragraphs.
- **Specific over generic.** "The test runner needs `--no-cache` after dependency changes" is useful. "Testing is important" is not.
- **Honest over positive.** If the task went poorly, say so. That's the most valuable learning.
