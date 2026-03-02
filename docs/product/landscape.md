# Landscape Review

Comparative analysis of autonomous coding agent tools. Evaluated Feb 2026.

## Our Position

**Worker + Sandbox scores highest across 5 of 6 axes.** The one gap (agent spawning UX) is closed by building a coordinator Slack bot.

## Six-Axis Summary

| Tool | Cloud Compute | Team Collab | Claude Code Power | Multi-Repo | Secure Sandbox | Agent Spawning |
|------|--------------|-------------|-------------------|-----------|----------------|----------------|
| **Our Worker + Sandbox** | Cloudflare Sandbox | Bidirectional Slack (streaming input) | Full Agent SDK | Single-repo per sandbox | Strong (ephemeral) | Webhook-triggered (coordinator bot closes gap) |
| **Cursor + Linear** | Cursor cloud VMs | Linear comments only | None (not Claude Code) | Per-repo | Strong | One click (assign in Linear) |
| **Copilot Coding Agent** | GitHub Actions | PR comments only | None (Copilot) | Per-repo | Strong | One click (assign in GitHub) |
| **Claude Code GH Action** | GitHub runners | GitHub comments only | Good (CLAUDE.md, skills, MCP) | Per-repo | Strong | Easy (@claude mention) |
| **OpenClaw** | Limited (0.5 vCPU) | Best chat integration | Not Claude Code | Per-agent workspace | Weak (security issues) | Best (natural language coordinator) |
| **Claude Hub** | Self-hosted Docker | GitHub comments only | Partial (one-shot) | Multi-repo via bot | Good (depends on config) | Automatic (webhook) |

## Key Insights

1. **Streaming input is the differentiator** — no other tool supports mid-task pause/resume for human feedback
2. **CI is the ratchet** — if the PR passes tests, it ships
3. **Sandbox quality determines YOLO confidence** — ephemeral cloud containers are the only safe tier
4. **Multi-repo is unsolved everywhere** — our sandbox could clone multiple repos
5. **OpenClaw's coordinator UX is worth stealing** — natural language dispatch is the best ergonomics
6. **Linear has an Agent Protocol** — only Cursor has built against it; Claude Code integration requested (#12925, 57 upvotes)

## Sources

- [Cursor Linear Integration](https://cursor.com/blog/linear)
- [Claude Code GitHub Action](https://github.com/anthropics/claude-code-action)
- [Claude Agent SDK](https://code.claude.com/docs/en/headless)
- [GitHub Agentic Workflows (tech preview)](https://github.blog/changelog/2026-02-13-github-agentic-workflows-are-now-in-technical-preview/)
- [Coder Tasks](https://coder.com/blog/launch-dec-2025-coder-tasks)
- [OpenClaw](https://github.com/openclaw/openclaw)
- [Claude Hub](https://github.com/claude-did-this/claude-hub)
