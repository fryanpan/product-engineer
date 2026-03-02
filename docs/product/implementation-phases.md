# Implementation Phases

## Unified System

All capabilities are built as a single persistent agent architecture. There are no separate phases — this is one coherent system.

### What We Built

| Component | Implementation | Status |
|-----------|---------------|--------|
| Trigger: Linear webhooks | Worker verifies HMAC, proxies to Orchestrator DO | Built |
| Trigger: GitHub webhooks | Worker verifies signature, proxies PR review/merge events | Built |
| Trigger: Slack Socket Mode | Orchestrator container maintains persistent WebSocket | Built |
| Orchestrator | Durable Object (singleton), SQLite ticket tracking, event routing | Built |
| TicketAgent | Container class per ticket, 4-day sleep timeout, Agent SDK | Built |
| Agent decision framework | product-engineer skill: reversible=autonomous, irreversible=batch+ask | Built |
| Communication | Slack (notify_slack, ask_question tools) | Built |
| Observability | Sentry across Worker, Orchestrator, and Agent containers | Built |
| Permission engineering | .claude/settings.json template for product repos | Built |

### Architecture

See `docs/product/plans/2026-03-01-unified-persistent-agent-design.md` for the full design.

```
Webhooks (Linear, GitHub)     Slack Socket Mode
         |                            |
         v                            v
Worker (stateless) ──> Orchestrator DO (singleton, always-on)
                         | SQLite: tickets, metadata
                         |
         ┌───────────────┼───────────────┐
         v               v               v
   TicketAgent #1   TicketAgent #2   TicketAgent #3
   (4-day sleep)    (4-day sleep)    (4-day sleep)
   Agent SDK        Agent SDK        Agent SDK
```

### Capabilities

1. **Linear ticket -> agent -> PR** — Linear issue creation triggers agent via webhook. Agent implements, creates PR, posts to Slack.

2. **Slack mention -> agent** — `@product-engineer fix the login bug in health-tool` triggers agent via Socket Mode. Agent works in a Slack thread.

3. **Persistent lifecycle** — Agent stays alive for 4 days. Responds to PR reviews, CI failures, and Slack replies without context loss. Full ticket lifecycle: creation -> implementation -> PR -> review -> revision -> merge.

## What to Watch

| Development | Impact |
|-------------|--------|
| Claude Code native Linear integration | Would eliminate custom webhook bridge |
| Cloudflare Containers GA + resource upgrades | More CPU/RAM, better stability |
| Agent SDK improvements | Better streaming, tool handling |
