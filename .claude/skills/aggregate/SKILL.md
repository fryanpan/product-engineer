---
name: aggregate
description: Pull learnings from all registered products and agent session transcripts into cross-project knowledge. Run periodically or after a batch of agent tasks.
user-invocable: true
---

# Aggregate Cross-Project Learnings

Pull learnings from all registered products and agent session transcripts (R2) into `docs/process/aggregation-log.md`.

## Steps

1. **Load the product registry** via the admin API (`GET /api/products`) to get the list of products with their repos.

2. **For each product**, clone or update the repo, then read:
   - `docs/process/learnings.md`
   - `docs/process/retrospective.md`

3. **Read agent session transcripts** from R2 using the MCP tools:
   - Use `list_transcripts` to get available transcripts (filter by `sinceHours` for recent ones)
   - Use `fetch_transcript` with the `r2Key` to download specific JSONL transcripts
   - Transcripts are uploaded automatically by the agent server (on session end, every 5 min, and on shutdown)
   - Analyze for: tool usage patterns, turn counts, failure modes, which task types take the most turns

4. **Compare against `docs/process/aggregation-log.md`** to identify new entries.

5. **Add a new section** `## YYYY-MM-DD` with new entries tagged by source project and category.

6. **Identify cross-cutting patterns** — learnings that appear across products or would benefit all:
   - The pattern description
   - Which products it was observed in
   - Whether it should be propagated (and how — template update, skill update, etc.)

   Before marking as needing propagation, check:
   - Is it already in `templates/`?
   - Was it already pushed via `/propagate`?
   - Is it covered by the product-engineer skill?

7. **Commit** the updated aggregation log.

8. **Summarize**: entries per project, patterns identified, recommended `/propagate` actions.
