---
name: debug-agent-issues
description: Use when investigating unexpected agent behavior — session drops, history loss, missing output, wrong behavior. Requires reviewing all data sources before forming hypotheses or making code changes.
---

# Debugging Agent Issues

When something goes wrong with an agent session (ended too soon, lost history, didn't complete a task, wrong output), follow this investigation process before touching any code.

## Rule: Evidence Before Hypotheses

**Do not look at code first.** Reading code without evidence leads to guessing. Evidence tells you what actually happened. Code tells you what was supposed to happen. Start with evidence.

## Step 1: Gather Temporal Context

Establish a timeline before investigating:
- When did the problem occur? (Slack thread timestamp, Linear ticket updated_at)
- When were the most recent Product Engineer deploys? Check GitHub:
  ```bash
  gh run list --repo fryanpan/product-engineer --limit 10
  ```
- Were there deploys close to when the issue occurred? Deploy timing is a primary cause of container restarts, which causes session loss and context drops.

## Step 2: Read the Transcript

Use `list_transcripts` and `fetch_transcript` MCP tools to find and read the relevant session transcript.

Look for:
- Session start/end times — how long did it run?
- Last tool call before termination — did it exit cleanly or mid-task?
- Phone-home messages (`auto_resume_skipped`, `auto_resume_failed`, `session_running`, etc.)
- Resume vs. fresh start indicators (`Resuming session:` vs no resume log)
- Any error messages in the transcript

If multiple transcripts exist for the same task, read them all to understand the full lifecycle.

## Step 3: Check Slack History

Read the Slack thread for the task. Look for:
- What the agent reported it was doing at each stage
- Any "Container restarted" messages (indicates a restart mid-task)
- Whether conversation history was preserved after a restart
- Response gaps suggesting the container was restarting

## Step 4: Check Cloudflare Logs (if available)

`wrangler tail` output can show:
- Container start/stop events
- Alarm fires and their outcomes
- Error messages from the DO or container
- Whether `agent_active` was 0 when events were delivered

Look for patterns: did events arrive during a restart? Did the alarm fire and mark the task terminal prematurely?

## Step 5: Check Cloudflare AI Gateway Logs (if relevant)

If the issue is about model behavior, costs, or API errors:
- Review the AI Gateway dashboard for the relevant time window
- Look for error rates, latency spikes, or unexpected token counts
- Cache hit rate changes can indicate new session starts (cold cache = fresh context)

## Step 6: Check Linear History

For ticket-driven tasks:
- Review the Linear ticket's history/comments
- Was the ticket status updated correctly?
- Did the agent post updates at the right lifecycle stages?

## Step 7: Form a Hypothesis

After reviewing all relevant sources, write down:

1. **What happened**: concrete description of the observed behavior
2. **When it happened**: timestamp and surrounding events (especially deploys)
3. **Why it happened**: causal chain based on evidence
4. **Contributing factors**: secondary causes (config values, timing, race conditions)

Example hypothesis format:
> "The agent session for BC-XXX ended at 14:32 UTC. A Product Engineer deploy completed at 14:28 UTC, which replaced the container. The conductor DB had agent_active=1 so needsRespawn=false in slack-handler.ts, meaning no resumeTranscriptR2Key was sent with subsequent events. The event handler had no fallback to the conductor DB, so the new container started a fresh session without history."

## Step 8: Validate Before Fixing

Before writing code:
- Can the hypothesis explain ALL the observed symptoms?
- Is there any evidence that contradicts the hypothesis?
- Is there a simpler explanation?

Only proceed to code changes when the hypothesis is solid and validated against the evidence.

## Common Patterns

| Symptom | Likely cause | Where to look |
|---------|-------------|---------------|
| Agent started fresh (no history) | Deploy restarted container mid-task | Deploy timing, resumeTranscriptR2Key in event payload |
| Agent ended too soon | sleepAfter too short, or idle timeout fired during slow SDK init | task-agent.ts sleepAfter, role-config.ts idleTimeoutMs |
| Task stuck in pr_open forever | Repo has no CI, merge gate never triggered | merge_gate_retries table, CI status check logic |
| Events silently dropped | agent_active=0, terminal state guard | Conductor DB task status |
| Agent re-spawned after completion | Alarm fired and restarted terminal task | task-agent.ts alarm(), terminal flag logic |
| Blog/draft task didn't push to Notion | Agent lacked skills from target repo | Plugin loading logs, .claude/settings.json in target repo |
