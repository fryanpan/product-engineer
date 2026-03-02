# Vision

## Problem

Getting from "idea" to "shipped code" requires a developer to context-switch into a repo, understand the codebase, implement, test, create a PR, and communicate progress. For small teams, the bottleneck isn't the coding — it's the coordination overhead around it.

What if the team could just describe what they want — in Linear, Slack, or a feedback widget — and an autonomous agent handled the rest?

## Goal

A product engineer agent that turns tickets, feedback, and natural language requests into shipped code — with human involvement only at the moments when it matters.

- **Minutes** from request to delivered value for simple changes
- **< 1 hour** for complex multi-file features
- **Hands-on time** limited to moments requiring human judgment

## Key Outcomes

1. **Accessible to non-technical users** — Linear ticket, Slack message, or feedback widget triggers the agent. No CLI, no git, no infrastructure knowledge required.

2. **Streamlined value delivery** — Full Claude Code / Agent SDK power (web search, Context7, subagents, skills). Human feedback via Slack threads at exactly the moments it's needed. Streaming input collapses feedback cycles from hours to minutes.

3. **Scalable beyond one machine** — Cloudflare Queue + Sandbox runs dozens of agents in parallel. Each repo has its own agent config (CLAUDE.md + skills). Coordinator dispatches across repos via registry.

4. **Layered security** — Ephemeral containers destroyed after each task. Network isolation to explicitly bound MCP servers only. CI as ratchet. Streaming input for ambiguous requirements.

## Non-Goals

- Not a general-purpose AI platform — specifically for turning tickets into PRs
- Not replacing human code review — agent creates PRs, humans approve
- Cost optimization is not a priority at this stage ($100s/mo budget)

## Design Philosophy

- **Slim core** — the orchestrator is ~600 lines. The agent entrypoint is ~130 lines. Decision-making lives in English skills, not code.
- **Depend on rapidly improving components** — Claude Code, Agent SDK, and Cloudflare Sandbox evolve fast. Ride their improvements instead of reimplementing.
- **English over code** — agent behavior is defined in SKILL.md files, not TypeScript. Changing how the agent works means editing markdown.
- **Avoid cruft** — every abstraction earns its place. If a component can be deleted without breaking anything, delete it.

## Deep Dives

- [Example Workflows](workflows.md) — the 4 core workflows that define the product
- [Implementation Phases](implementation-phases.md) — phased rollout plan
- [Landscape Review](landscape.md) — comparison of 11 competing tools
- [Alternative Approaches](alternatives.md) — other paths and when they're better
- [Decisions](decisions.md) — architecture decision log
