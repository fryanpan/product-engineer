---
name: task-retro
description: Per-task retrospective that the Product Engineer runs after completing each task. Captures learnings and implements actions before PR merge.
---

# Task Retro

**When to run:** After implementation is complete and tests pass, BEFORE creating the PR.

This ensures learnings are captured and acted on before the code goes out for review.

## Steps

### Step 1: Reflect

Answer these questions (2-3 sentences total, not a full essay):

1. **What happened?** — One sentence summary of the task and outcome.
2. **What was surprising?** — Anything unexpected about the codebase, the task, or the tools?
3. **What should change?** — Identify issues that should trigger actions (not just observations).

### Step 2: Propose Actions

For each issue identified in Step 1, propose a concrete action. Each action must be one of these types:

| Action Type | When to use | What to do |
|-------------|-------------|------------|
| **Update a skill** | A skill's behavior caused the issue, or a skill should enforce a new practice | Read the skill's SKILL.md, propose the specific edit |
| **Update CLAUDE.md** | A new rule or convention should be followed in all future sessions | Propose the specific addition to the relevant section |
| **Update docs/process/learnings.md** | Technical gotcha, API quirk, pattern discovery | Propose the specific addition |
| **Create a ticket** | The fix requires implementation work beyond a doc/config change | Draft the ticket title + description |
| **No action needed** | The issue was a one-off or already resolved | Explain why no systemic fix is needed |

For each proposed action:
1. Read the file you'd change (if applicable)
2. Identify the specific section to edit
3. Draft the exact change (not a vague suggestion)
4. Present to the user via Slack using `ask_question` tool

**Format for Slack question:**
```
📝 *Retro*

**What happened:** [One sentence]
**What was surprising:** [One sentence]

**Proposed actions:**
1. [Action type]: [Specific change]
2. [Action type]: [Specific change]

Which actions should I take before creating the PR?
Options: All / None / [specific numbers]
```

### Step 3: Execute Approved Actions

After getting approval via Slack:
1. Make the approved changes (edit skills, update CLAUDE.md, update learnings.md, create tickets)
2. Commit the changes: `docs: retro actions for [ticket-id]`
3. Continue with PR creation

### Step 4: Post Retro Summary to Slack

After actions are complete (or if none were approved), post a summary:

```
✅ *Retro complete*
Actions taken:
• [Action 1]
• [Action 2]

Ready to create PR.
```

## Principles

- **Run BEFORE PR creation** — learnings must be implemented before the code goes out
- **Propose concrete actions** — "Update learnings.md with X" not "we should remember X"
- **Brevity over completeness** — 3 sentences, not 3 paragraphs
- **Specific over generic** — "The test runner needs `--no-cache` after dependency changes" is useful. "Testing is important" is not
- **Honest over positive** — If the task went poorly, say so. That's the most valuable learning
- **Only propose actions worth taking** — Don't create busywork. If there's nothing systemic to fix, that's fine
