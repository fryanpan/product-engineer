# Alternative Approaches

Other implementation paths and when they're the right choice.

## Option B: Claude Code GitHub Action

**Best for:** Simple tasks, fire-and-forget, scaling to many repos.

- Each repo gets `.github/workflows/linear-agent.yml` using `anthropics/claude-code-action`
- CLAUDE.md + skills load. No streaming input, no Slack conversation.
- Good sandbox. Official Anthropic action.
- **Use as complement:** simple tickets via GH Action, complex ones via Sandbox.

## Option C: Self-Hosted Agent Service

**Best for:** Full control, large codebases that exceed Sandbox limits.

- Docker/K8s per ticket. You manage infra.
- No streaming input unless you build it.
- **Use when:** you outgrow Cloudflare Sandbox limits (0.5 vCPU, 4GB RAM).

## Option D: Cursor's Linear Integration

**Best for:** Zero custom code, repos where Claude Code power isn't needed.

- Native Linear integration. Assign issue to @Cursor.
- Not Claude Code — no CLAUDE.md, skills, MCP, or Slack.
- **Use alongside:** Cursor for simple issues, Sandbox for complex ones.

## Recommended Hybrid

| Task Type | Agent | Why |
|-----------|-------|-----|
| Complex / ambiguous | Worker + Sandbox | Streaming input, full MCP, Slack conversation |
| Simple / well-defined | Claude Code GitHub Action | No infrastructure, CLAUDE.md loads |
| Non-Claude-Code repos | Cursor + Linear | Zero setup, good sandbox |
