# Deployment Notes: Transcript Logging (BC-71)

## Pre-Deployment Steps

Before deploying the transcript logging feature, the R2 bucket must be created:

```bash
wrangler r2 bucket create product-engineer-transcripts
```

Verify the bucket exists:

```bash
wrangler r2 bucket list
```

## What This Feature Does

Automatically captures and stores all Claude Agent SDK JSONL transcripts for:
- Retrospectives and self-improvement analysis
- Understanding agent decision-making patterns
- Debugging stuck agents or failed tasks

## Architecture

```
Agent Container (SessionEnd hook)
  ↓ transcript_path from hook input
  ↓ Upload JSONL to /api/internal/upload-transcript
Worker
  ↓ Store in R2: TRANSCRIPTS.put(r2Key, transcript)
  ↓ Update DB: tickets.transcript_r2_key
Orchestrator DO
  ↓ SQLite updated
Agents can access via MCP tools:
  - list_transcripts(limit?, sinceHours?)
  - fetch_transcript(r2Key)
```

## Database Changes

Added column to `tickets` table:
- `transcript_r2_key TEXT` - R2 object key for the uploaded transcript

Migration is automatic via ALTER TABLE with duplicate column handling.

## Testing After Deployment

1. **Trigger a test ticket** to generate a transcript:
   ```bash
   # Create a simple test ticket in Linear or Slack
   # Wait for agent to complete
   ```

2. **Verify upload** via logs:
   ```bash
   wrangler tail
   # Look for: "[Agent] Transcript uploaded successfully: {r2Key}"
   # Look for: "[Worker] Transcript uploaded: ticket=..."
   ```

3. **Query the database**:
   ```bash
   # Via API
   curl -H "X-API-Key: $API_KEY" https://your-worker.workers.dev/api/transcripts
   ```

4. **Test MCP tools** (from another agent):
   ```
   User: List recent transcripts
   Agent: [calls list_transcripts tool]

   User: Fetch transcript {r2Key}
   Agent: [calls fetch_transcript tool]
   ```

## Rollback Plan

If issues occur:

1. **Revert the commit**:
   ```bash
   git revert 75c92a1
   git push origin main
   wrangler deploy
   ```

2. **Database** - no action needed:
   - The `transcript_r2_key` column can remain (will be NULL)
   - No data loss risk

3. **R2 bucket** - leave as-is:
   - Already-uploaded transcripts remain accessible
   - No cost impact (pay per storage/access)

## Future Improvements

- Automatic retention policy (delete transcripts older than N days)
- Transcript compression before upload
- Transcript parsing/indexing for semantic search
- Integration with existing `/retro` skill to analyze transcripts automatically
