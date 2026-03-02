# Implementation Phases

Phased rollout from what we have today to a fully autonomous product engineer.

## What We Have Today

| Component | Implementation | Status |
|-----------|---------------|--------|
| Trigger | Feedback widget → Turso DB → Cloudflare Queue | Built |
| Isolation | Cloudflare Sandbox (ephemeral container) | Built |
| Agent | Claude Agent SDK with streaming input | Built |
| Communication | Slack Socket Mode (bidirectional) | Built |
| Tools | Custom MCP (update_status, notify_slack, ask_question) | Built |
| Context | CLAUDE.md + skills + Linear MCP + Context7 | Built |
| Linear webhook + shared orchestrator | Worker + Queue + registry dispatch | Built |
| GitHub PR merge detection | Webhook handler | Built |
| Deploy + secrets + webhook configuration | Cloudflare Workers | Done |

## Phase 1: End-to-End Pipeline (NOW)

**Goal:** Linear ticket → agent → PR → Slack updates. The basic pipeline works.

**What to do:**
- Verify the Linear webhook trigger works end-to-end
- Ensure agent posts to the correct product Slack channel (#health-tool, etc.)
- Ensure one thread per ticket in Slack
- Agent prompt handles "implement ticket" (not just "evaluate feedback")

**Effort:** Hours. 80% is already built.

**Key outcome:** Feedback → ticket → agent → PR pipeline works end-to-end.

## Phase 2: Coordinator Slack Bot (NEXT)

**Goal:** Non-technical users can trigger agents by messaging Slack.

**What to build:**
- A persistent Slack listener (coordinator) that parses natural language commands
- A dispatch layer that looks up repos in the registry and triggers the Worker
- Status dashboard (Slack channel with threads per agent)

**Effort:** Days.

**Key outcome:** "Fix the login bug in health-tool" on Slack → agent starts working.

## Phase 3: Persistent Agents (FUTURE)

**Goal:** Agents that stay alive through the full ticket lifecycle.

**When to build:** After Phase 1 and 2 are working and we understand the limitations of one-shot agents. The current one-shot model may be sufficient for most tasks — persistent agents add complexity and cost.

**What it enables:**
- Agent responds to PR review comments without restarting
- Agent tracks CI status and responds to failures
- Agent handles ticket lifecycle: creation → PR → review → revision → merge → deploy → close
- No context loss between events

**Architecture:** Cloudflare Durable Objects + Containers. See `fryanpan/product-engineer/docs/plans/2026-03-01-persistent-agent-architecture.md` for the design doc.

**Note:** This was designed in a previous session but should NOT be built before Phase 1 and 2 are working. The persistent agent architecture is weeks of work; Phases 1 and 2 are hours/days and deliver most of the value.

## Phase 4: GitHub Action Fallback (SCALE)

**Goal:** Every repo has an agent available. Simple tasks use GH Action; complex ones use Sandbox.

**What to do:**
- Add `.github/workflows/linear-agent.yml` per repo using `anthropics/claude-code-action`
- Triage step routes tickets to right agent based on complexity

**Effort:** Hours per repo.

## What to Watch

| Development | Impact |
|-------------|--------|
| Claude Code native Linear integration ([#12925](https://github.com/anthropics/claude-code/issues/12925), 57 upvotes) | Would eliminate custom webhook bridge |
| GitHub Agentic Workflows GA | Could simplify per-repo agent setup |
| Cloudflare Sandbox resource upgrades | More CPU/RAM eliminates self-hosted option |
| Linear Agent Protocol adoption | Only Cursor has built against it so far |
