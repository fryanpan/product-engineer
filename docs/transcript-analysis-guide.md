# Transcript Analysis Guide

## Overview

The Product Engineer system automatically captures all Claude Agent SDK JSONL transcripts to R2 storage. This enables:
- Daily/weekly retrospective analysis
- Pattern identification across multiple tickets
- Self-improvement feedback loops
- Debugging and troubleshooting

## How It Works

### Automatic Capture

Every agent session automatically uploads its transcript when complete:

1. **Agent completes work** → SessionEnd hook fires
2. **Transcript uploaded** → R2 bucket (`product-engineer-transcripts`)
3. **Database updated** → `tickets.transcript_r2_key` set
4. **Available for analysis** → Agents can query via MCP tools

### Storage Format

- **Location**: R2 bucket `product-engineer-transcripts`
- **Key format**: `{ticketId}-{timestamp}.jsonl`
- **Example**: `5518c4a9-4d3e-479b-9e76-0c7fbbefa9e3-2026-03-04T17-15-30-123Z.jsonl`
- **Content**: JSONL (newline-delimited JSON) with full SDK transcript

## Using the MCP Tools

Agents have two tools for transcript access:

### 1. `list_transcripts`

Query available transcripts with optional filters.

**Parameters:**
- `limit` (optional): Maximum results (default 50)
- `sinceHours` (optional): Only return transcripts from last N hours

**Example prompts:**
```
"List transcripts from the last 24 hours"
"Show me the 10 most recent agent transcripts"
"List all available transcripts"
```

**Returns:**
```
Found 15 transcripts:
- BC-123 (product-engineer, merged) — BC-123-2026-03-04T16-30-00-000Z.jsonl
- BC-124 (product-engineer, pr_open) — BC-124-2026-03-04T15-45-00-000Z.jsonl
...
```

### 2. `fetch_transcript`

Retrieve the full JSONL transcript for analysis.

**Parameters:**
- `r2Key` (required): The R2 key from `list_transcripts`

**Example prompts:**
```
"Fetch transcript BC-123-2026-03-04T16-30-00-000Z.jsonl"
"Show me the full transcript for BC-123"
```

**Returns:**
```
Transcript: BC-123-2026-03-04T16-30-00-000Z.jsonl
Lines: 487
Size: 125043 bytes

First 10 lines:
{"type":"user","message":{"role":"user","content":"Starting work on BC-123..."},...}
...
```

## Running Retrospective Analysis

### Daily Analysis Pattern

Create a Linear ticket or Slack command like:

```
Analyze agent transcripts from the last 24 hours.

For each transcript:
1. Identify the task and outcome (merged/failed/deferred)
2. Note what went well (efficient decisions, good tool usage)
3. Note what could improve (mistakes, inefficiencies, confusion)
4. Extract patterns across multiple tickets

Summarize:
- Common success patterns
- Common failure modes
- Specific learnings for docs/process/learnings.md
- Recommended process changes

Post findings to Slack as a thread.
```

### Weekly Deep Dive Pattern

```
Review all agent transcripts from the past week.

Analysis focus:
1. Success rate by task type (feature, bug, refactor)
2. Common bottlenecks or stuck points
3. Tool usage patterns (which tools are overused/underused)
4. Decision quality (autonomous vs asking for help)
5. Code quality trends (test coverage, security, simplicity)

Deliverable:
- Weekly retrospective report in docs/process/retrospective.md
- Proposed updates to learnings.md or skill files
- Metrics dashboard (success rate, avg completion time, etc)
```

### Debugging Specific Tickets

```
I need help understanding why BC-145 failed.

Fetch the transcript for BC-145 and analyze:
1. What was the agent trying to do?
2. Where did it get stuck?
3. What tools did it use?
4. What errors occurred?
5. How could this be prevented in the future?
```

## Transcript Structure

Each JSONL line represents a message in the agent session:

```jsonl
{"type":"user","message":{"role":"user","content":"..."},"session_id":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."},{"type":"tool_use","name":"Read","input":{...}}]},"session_id":"..."}
{"type":"tool_result","tool_use_id":"...","content":[{"type":"text","text":"..."}]}
...
```

### Key Fields to Analyze

- **user messages**: Task instructions, follow-up events
- **assistant text**: Reasoning, explanations, plans
- **tool_use**: Which tools the agent called and why
- **tool_result**: Outcomes of tool calls (success/failure)
- **errors**: Any exceptions or failures

## Best Practices

### For Analysis Tickets

1. **Be specific about goals**: "Analyze for X" works better than "analyze everything"
2. **Focus on actionable insights**: Prioritize findings that can improve future performance
3. **Look for patterns**: Single-ticket analysis is less valuable than cross-ticket trends
4. **Update documentation**: Capture learnings in `docs/process/learnings.md`

### For Self-Improvement Loops

1. **Run regularly**: Daily or weekly, not ad-hoc
2. **Track metrics over time**: Success rates, completion times, error types
3. **Close the loop**: Analysis → Learnings → Behavior Change → Verification
4. **Involve humans**: Share findings in Slack for team feedback

## API Access (for humans)

If you want to analyze transcripts outside the agent system:

### List transcripts
```bash
curl -H "X-API-Key: $API_KEY" \
  "https://your-worker.workers.dev/api/transcripts?limit=50&sinceHours=24"
```

### Fetch transcript
```bash
curl -H "X-API-Key: $API_KEY" \
  "https://your-worker.workers.dev/api/transcripts/BC-123-2026-03-04T16-30-00-000Z.jsonl"
```

## Troubleshooting

### "Transcript not found"

- Check the R2 bucket exists: `wrangler r2 bucket list`
- Verify uploads in logs: `wrangler tail` and look for "Transcript uploaded successfully"
- Confirm the ticket completed (transcripts only upload on SessionEnd)

### "Failed to list transcripts"

- Verify API_KEY is set correctly
- Check Worker logs: `wrangler tail`
- Confirm Orchestrator DO is healthy: `/health` endpoint

### Transcript is incomplete

- Agent may have crashed before SessionEnd
- Check agent container logs for errors
- The transcript up to the crash point should still be available in the agent's filesystem (`/tmp/transcript-*.jsonl`)

## Future Enhancements

Potential improvements to consider:

- **Automatic daily analysis**: Scheduled ticket creation for daily retros
- **Semantic search**: Index transcripts for keyword/concept search
- **Metrics dashboard**: Aggregate stats viewable in Linear or Slack
- **Retention policies**: Auto-delete old transcripts to control costs
- **Compression**: gzip transcripts before upload to reduce storage costs
