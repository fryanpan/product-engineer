# Product Engineer Metrics System

This document describes the metrics and observability system for the Product Engineer conductor.

## Overview

The metrics system tracks:
1. **Decision correctness** — how well the conductor makes decisions
2. **Time/cost efficiency** — how efficiently tasks are processed
3. **Feedback integration** — human feedback on conductor decisions

## Metrics Summary

### Decision Correctness Metrics

| Metric | Description | Target |
|--------|-------------|--------|
| **Automerge Rate** | % of tasks that complete with automerge (no human intervention) | > 80% |
| **Decision Accuracy** | % of decisions marked "good" by humans | > 90% (based on feedback received) |
| **Failure Rate** | % of tasks that end in `failed` status | < 5% |
| **Multi-PR Rate** | % of tasks requiring 2+ PRs to complete | < 15% |
| **Multi-Revision Rate** | % of tasks sent back for revision 2+ times | < 10% |

### Efficiency Metrics

| Metric | Description | Target |
|--------|-------------|--------|
| **Avg Cost/Task** | Average LLM cost per completed task | < $3 |
| **Daily Cost** | Total LLM spend per day | < $25 |
| **Avg Completion Time** | Time from task creation to merge | < 60 min (simple), < 4 hours (complex) |

### Per-Task Metrics

Each task tracks:
- `outcome` — final state (automerge_success, manual_merge, failed, deferred, closed)
- `pr_count` — number of PRs created
- `revision_count` — times sent back for revision
- `total_cost_usd` — LLM costs for this task
- `first_response_at` — when agent first started working
- `completed_at` — when task reached terminal state
- `hands_on_sessions` — manual tracking for human involvement
- `hands_on_notes` — notes on where human time was needed

## Data Collection

### Automatic Collection

The conductor automatically tracks:

1. **On task creation:**
   - Initialize `task_metrics` row
   - Record `identifier` and `title` from Linear payload

2. **On status updates:**
   - Update `first_response_at` when entering `in_progress`
   - Update `outcome` and `completed_at` on terminal status
   - Increment `pr_count` when `pr_url` is reported

3. **On merge gate decisions:**
   - Increment `revision_count` when `send_back` action taken

4. **On token usage reports:**
   - Update `total_cost_usd` from agent token usage

### Decision Feedback Collection

Decisions are logged with `slack_message_ts` for feedback correlation. Users can provide feedback via:

1. **Slack reactions** — React with:
   - 👍 / `:+1:` / ✅ → marks decision as "good"
   - 👎 / `:-1:` / ❌ → marks decision as "bad"

2. **Slack replies** — Reply to a decision message with details:
   - Include "bad" or "wrong" → automatically marks as bad
   - Include "good" or "correct" → automatically marks as good
   - Reply text is saved as feedback details

3. **Dashboard** — Use the metrics dashboard at `/dashboard` to:
   - View recent decisions
   - Click 👍/👎 buttons to provide feedback

4. **API** — POST to `/api/decision-feedback`:
   ```json
   {
     "decisionId": "uuid",
     "feedback": "good" | "bad",
     "details": "Optional explanation"
   }
   ```

### Manual Tracking

For hands-on time tracking, use the `/retro` skill after completing tasks. The retro:
- Analyzes transcript for time breakdown
- Records `hands_on_sessions` and `hands_on_notes`
- Identifies where human intervention was needed

## API Endpoints

### GET `/api/metrics`

Returns detailed per-task metrics.

Query params:
- `limit` — max results (default 50)
- `days` — time range in days (default 30)

Response:
```json
{
  "metrics": [
    {
      "task_id": "uuid",
      "identifier": "BC-137",
      "title": "Add metrics tracking",
      "product": "product-engineer",
      "outcome": "automerge_success",
      "pr_count": 1,
      "revision_count": 0,
      "total_cost_usd": 2.45,
      "first_response_at": "2026-03-10T10:00:00Z",
      "completed_at": "2026-03-10T10:45:00Z",
      "turns": 23,
      "total_input_tokens": 150000,
      "total_output_tokens": 12000
    }
  ]
}
```

### GET `/api/metrics/summary`

Returns aggregate metrics and daily costs.

Response:
```json
{
  "summary": {
    "totalTasks": 45,
    "completed": 40,
    "automergeRate": "82.5%",
    "failureRate": "5.0%",
    "multiPrRate": "12.5%",
    "multiRevisionRate": "7.5%",
    "avgCompletionMinutes": "42.3"
  },
  "outcomes": [
    { "outcome": "automerge_success", "count": 33 },
    { "outcome": "failed", "count": 2 }
  ],
  "costs": {
    "total": "112.45",
    "average": "2.81",
    "max": "8.50",
    "daily": [
      { "day": "2026-03-10", "cost": 15.20, "tasks": 6 }
    ]
  },
  "decisions": {
    "total": 120,
    "withFeedback": 45,
    "withoutFeedback": 75,
    "accuracy": "91.1%",
    "goodCount": 41,
    "badCount": 4
  }
}
```

### POST `/api/decision-feedback`

Submit feedback on a decision.

Request:
```json
{
  "decisionId": "uuid",
  "feedback": "good" | "bad",
  "details": "Optional explanation",
  "givenBy": "U123ABC"
}
```

Or by Slack message:
```json
{
  "slackMessageTs": "1234567890.123456",
  "feedback": "bad",
  "details": "Should have sent back for review"
}
```

## Dashboard

Access the dashboard at `/dashboard` (requires auth).

The dashboard shows:
1. **Active agents** — currently running agents with status
2. **Metrics summary** — key metrics at a glance
3. **Daily costs** — cost trend over last 7 days
4. **Recent decisions** — with ability to provide feedback

## Reporting Recommendations

For more sophisticated reporting, consider:

### Option 1: SQLite + Dashboard Enhancements

Current approach. Extend the dashboard with:
- Historical charts (line graphs for trends)
- Filters by product, time range
- Export to CSV

**Pros:** No additional infrastructure
**Cons:** Limited querying flexibility

### Option 2: Metabase on SQLite

Deploy Metabase pointing to the DO's SQLite database.

**Pros:** Rich SQL querying, customizable dashboards
**Cons:** Requires accessing DO storage externally (complex)

### Option 3: Export to External DB

Periodically export metrics to an external database (Postgres, BigQuery).

**Pros:** Full SQL power, integrates with existing BI tools
**Cons:** Additional infrastructure and sync logic

### Option 4: AI-Powered Analysis

Use the `/aggregate` skill to periodically analyze metrics and generate insights.

**Pros:** Leverages LLM for pattern recognition
**Cons:** Non-real-time

### Recommendation

Start with **Option 1** (dashboard enhancements) for operational metrics. Consider **Option 4** for weekly/monthly analysis and learning extraction. Only invest in **Option 3** if query flexibility becomes a bottleneck.

## Database Schema

### task_metrics

```sql
CREATE TABLE task_metrics (
  task_id TEXT PRIMARY KEY,
  outcome TEXT,                    -- automerge_success, manual_merge, failed, etc.
  pr_count INTEGER DEFAULT 0,
  revision_count INTEGER DEFAULT 0,
  total_agent_time_ms INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0.0,
  hands_on_sessions INTEGER DEFAULT 0,
  hands_on_notes TEXT,
  first_response_at TEXT,
  completed_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

### decision_feedback

```sql
CREATE TABLE decision_feedback (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,
  feedback TEXT NOT NULL,          -- 'good' or 'bad'
  details TEXT,
  given_by TEXT,                   -- Slack user ID
  given_at TEXT NOT NULL,
  slack_message_ts TEXT
);
```

### decision_log (extended)

Added column:
- `slack_message_ts TEXT` — for feedback correlation
