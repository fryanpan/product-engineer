# Example Workflows

These workflows define what the product does. Everything else is infrastructure in service of these.

## Workflow 1: Feedback to Fix (streamlined)

A user reports an issue. No developer triage needed.

1. User reports "The BMI chart doesn't show recent entries" via feedback widget
2. Feedback widget auto-creates ticket HT-58 in Linear
3. Linear webhook fires on ticket creation
4. Worker reads ticket, launches sandbox, clones repo, starts Agent SDK
5. Agent reads CLAUDE.md/skills, analyzes codebase, identifies root cause
6. Agent posts to **#health-tool** thread: "Found the issue — date filter excludes today's entries. Implementing fix now."
7. Agent creates PR with fix + test
8. Agent updates HT-58 in Linear: "PR ready for review"
9. Agent posts completion + PR link to Slack thread

**Hands-on time: ~30 seconds** (glance at Slack, approve PR). **Total: ~5 minutes.**

Compare to today: developer sees feedback → triages → opens repo → investigates → fixes → tests → creates PR → updates ticket. **30-60 minutes minimum.**

## Workflow 2: Ambiguous Request with Mid-Task Feedback

Not every task is clear-cut. Streaming input handles ambiguity without blocking.

1. PM creates ticket: "Add export to CSV for patient list"
2. Webhook fires, agent launches
3. Agent analyzes codebase, finds patient list component
4. Agent posts to **#health-tool** thread: "Two questions: 1. Include all columns or just visible ones? 2. Should it respect current filters?"
5. Agent **pauses** (streaming input awaits reply)
6. Developer replies in thread: "Visible columns only. Yes, respect filters."
7. Agent **resumes** with clarified requirements
8. Agent implements, creates PR
9. Agent posts: "PR ready. Exports visible columns, respects filters. Tests added."

**Hands-on time: ~2 minutes.** **Total: ~15 minutes.**

The agent only interrupts when human judgment is needed.

## Workflow 3: Non-Technical User Spins Up a Project

A team member wants a new project. No CLI, no git.

1. Team member on Slack: "Hey, I need a new project for tracking our team's OKRs. Call it okr-tracker."
2. Coordinator bot parses intent, checks registry — okr-tracker doesn't exist
3. Coordinator triggers /new-project: {name: okr-tracker, description: "Team OKR tracking"}
4. Creates GitHub repo, Linear project, scaffolds .claude/
5. Adds to registry, configures Worker binding
6. Coordinator posts: "Done! GitHub: github.com/org/okr-tracker, Linear: OKR Tracker. Try: 'Set up a Next.js app with dashboard for okr-tracker'"
7. Team member: "Set up a Next.js app with a dashboard page for okr-tracker"
8. Coordinator dispatches to Worker, agent starts working

**Hands-on time: ~1 minute** (two Slack messages). No CLI, no git, no config files.

## Workflow 4: Self-Improvement Cycle

Agents get better over time. Three loops, each feeding the next:

1. **Per-task retro** — every agent runs a structured retro after completing work. Captures what worked, what didn't, friction points. Stored per-project.
2. **Cross-project review** — a scheduled agent reads all session logs, finds patterns (e.g., "agents in 3 projects struggled with the same test setup"), updates shared knowledge base. Team sees findings on Notion.
3. **Propagation** — improvements (better skills, updated templates, new CLAUDE.md rules) flow back to all projects automatically.

## Slack Communication Model

Each product has a dedicated Slack channel (e.g., #health-tool, #bike-tool). Agents post in these channels, creating **one thread per ticket**. This gives the team:

- Visibility into what the agent is doing
- A place to provide feedback (the agent monitors thread replies)
- A history of all agent work on that product

The agent should:
- Post a message when it starts working on a ticket (creates the thread)
- Post updates as it progresses
- Ask questions in the thread when it needs human input
- Post completion with PR link
- Post a brief retro as a final thread reply
