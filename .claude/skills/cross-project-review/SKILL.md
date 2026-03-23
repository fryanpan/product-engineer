---
name: cross-project-review
description: Periodic review across all products to find patterns, share learnings, and improve the Product Engineer system. Run weekly or after a batch of agent tasks.
---

# Cross-Project Review

Review agent performance across all products to find patterns and improve the system.

## Steps

### Step 1: Gather Session Logs

Use `list_transcripts` and `fetch_transcript` MCP tools to access agent session transcripts from R2. Transcripts are JSONL files uploaded automatically by the agent server (on session end, every 5 min, and on shutdown). Look for:
- Which products had the most agent tasks
- Success/failure rates per product
- Average task duration
- Common failure reasons

### Step 2: Identify Patterns

Look across all products for:
- **Recurring failures** — same type of error across products? Fix in the generic agent or skill.
- **Slow tasks** — what makes some tasks take much longer? Missing context? Ambiguous requirements?
- **Successful patterns** — what types of tasks consistently succeed? Can we do more of these?
- **Skill gaps** — are agents frequently deferring tasks they should be able to handle? Update the ticket-agent skill.

### Step 3: Propose Improvements

For each pattern found, propose a specific change:
- **Skill update** — modify product-engineer, task-retro, or setup-product skills
- **Tool addition** — new MCP tools the agent needs
- **Prompt improvement** — better instructions in the prompt builder
- **Process change** — different trigger configuration or approval flow

### Step 4: Apply and Document

1. Make the approved changes
2. Add learnings to `docs/process/learnings.md`
3. Notify the team via Slack: "Cross-project review complete: [summary of changes]"

## Principles

- **Data over opinions.** Base improvements on actual session logs, not hypotheticals.
- **Small iterations.** One skill tweak per review, not a rewrite.
- **Share broadly.** Learnings from one product often help others.
