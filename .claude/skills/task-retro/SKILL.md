---
name: task-retro
description: Per-task retrospective that the Product Engineer runs after completing each task. Captures learnings and posts to Slack.
---

# Task Retro

After completing any task (implemented, deferred, or failed), do a brief retro.

## Steps

### Step 1: Reflect

Answer these questions following the project's retrospective format:

1. **What worked?** — What went smoothly? What patterns or tools were effective?
2. **What didn't?** — What was frustrating, surprising, or slower than expected? Any blockers or gotchas?
3. **Actions** — What specific changes should be made? This is the most important part.

### Step 2: Take Actions BEFORE Posting

Actions are the most critical output of a retro. Before posting to Slack, take the actions you identified:

**Common action types:**
- **learnings.md update** — Add technical gotchas or discoveries to `docs/process/learnings.md`
- **Code fixes** — Fix issues discovered during implementation
- **Documentation** — Update CLAUDE.md, skills, or process docs
- **Tickets** — Create Linear tickets for larger improvements

**DO NOT just list actions as things to do later — actually do them before moving to step 3.**

### Step 3: Post to Slack

Post your retro as a thread reply in the task's Slack thread. Use the project's retrospective format:

```
📝 *Retro*

**What worked:**
• [Successes]

**What didn't:**
• [Issues or surprises]

**Actions taken:**
• [Specific changes made, with links to commits/docs/tickets]
```

Be specific about actions. "Updated learnings.md with X" is better than "Learned something."

### Step 4: Log for Cross-Project Review

If you discovered something that would help across ALL products (not just this one), note it in your final output. The orchestrator aggregates these for the cross-project review cycle.

Examples of cross-product learnings:
- A tool or MCP server that behaves unexpectedly
- A pattern that works well for a certain type of task
- A common mistake to avoid

## Principles

- **Actions are mandatory.** Every retro must identify and execute at least one concrete action. "No learnings" is not acceptable — there's always something to improve or document.
- **Take actions before posting.** Don't just list what should be done — do it, then report what was done.
- **Specific over generic.** "The test runner needs `--no-cache` after dependency changes" is useful. "Testing is important" is not.
- **Honest over positive.** If the task went poorly, say so. That's the most valuable learning.
- **Keep it focused.** Aim for clarity, not length. The team should understand what happened and what changed.
