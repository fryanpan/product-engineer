# Decisions

Architecture and product decisions log. Reference before proposing changes to previously-decided topics.

| Date | Decision | Rationale | Alternatives Considered |
|------|----------|-----------|------------------------|
| 2026-02-28 | Cloudflare Workers + Sandbox for agent runtime | Ephemeral containers, network isolation, scales via Queue. Strongest sandbox security of all options. | Self-hosted Docker, GitHub Actions, Cursor + Linear, Coder Tasks |
| 2026-02-28 | Claude Agent SDK with streaming input | Only solution that supports mid-task human feedback via Slack. Key differentiator vs. all competitors. | `claude -p` one-shot, Copilot, Cursor |
| 2026-02-28 | English skills (SKILL.md) for agent behavior | Changing agent behavior = editing markdown, not shipping code. Slim core (~130 lines). | TypeScript decision trees, prompt engineering in code |
| 2026-02-28 | Shared orchestrator (multi-product) | One Worker dispatches to any registered product. Registry maps products to repos/secrets/channels. | Per-repo Workers, GitHub Action per repo |
| 2026-02-28 | Slack Socket Mode for bidirectional communication | Agent pauses, asks question in product channel thread, waits for reply, resumes. Streaming input pattern. | HTTP Events API (one-directional), Linear comments only |
| 2026-02-28 | One Slack thread per ticket in product channels | Team visibility into agent work. Agent asks for feedback in-thread. History preserved. | Dedicated agent channel, DMs, Linear-only communication |
| 2026-03-01 | Persistent agent architecture (Durable Objects + Containers) | Agents stay alive through full ticket lifecycle. Respond to PR reviews, CI failures without restarting. Orchestrator maintains Slack Socket Mode. | Keep one-shot model (simpler but loses context between events) |
| 2026-03-01 | Context7 MCP for documentation lookup | Up-to-date library docs without hallucination. Agent should use it by default. | Web search only, bundled docs |
