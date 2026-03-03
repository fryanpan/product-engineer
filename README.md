# Product Engineer

Autonomous agent that turns tickets into shipped code.

## The Problem

For small teams, the bottleneck isn't coding — it's the coordination overhead around it. Every ticket requires context-switching into a repo, understanding the codebase, implementing, testing, creating a PR, and communicating progress. Most of that loop doesn't require human judgment.

## What This Does

- **Linear ticket, Slack mention, or feedback** triggers an autonomous agent
- **Agent** clones the repo, reads its `CLAUDE.md` + skills, implements the change, and opens a PR
- **Minutes** for simple changes, **under an hour** for complex features — human involvement only when it matters

Built on [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-sdk) + [Cloudflare Workers & Containers](https://developers.cloudflare.com/containers/).

## How It Works

```
Webhooks (Linear, GitHub)     Slack Socket Mode
         |                            |
         v                            v
Worker (stateless) --> Orchestrator DO (singleton, always-on)
                         | SQLite: tickets, metadata
                         |
         +---------------------------------+
         |               |               |
         v               v               v
   TicketAgent #1   TicketAgent #2   TicketAgent #3
   (per-ticket)     (per-ticket)     (per-ticket)
```

1. **Triggers** arrive via Linear webhooks, GitHub webhooks, or Slack `@product-engineer` mentions
2. **Orchestrator** (Durable Object) routes each event to a per-ticket agent container
3. **Agent** clones the product repo, loads its `CLAUDE.md` + skill files, implements the task, and creates a PR
4. **Communication** happens in Slack threads — the agent posts progress and asks clarifying questions when needed

## Design Philosophy

The pitch: this is a small, understandable repo that does something ambitious.

- **Slim core** — ~600-line orchestrator, ~130-line agent entrypoint. That's it.
- **English over code** — agent behavior is defined in `SKILL.md` files, not TypeScript logic. Changing how the agent works means editing markdown.
- **Ride rapidly improving components** — Claude Agent SDK, Cloudflare Containers, and Claude itself are evolving fast. Depend on them instead of reimplementing.
- **No cruft** — every abstraction earns its place. If a component can be deleted without breaking anything, delete it.

## Getting Started

**Prerequisites:** [Cloudflare account](https://dash.cloudflare.com/sign-up), [Anthropic API key](https://console.anthropic.com/), Slack workspace, Linear workspace.

1. Fork/clone the repo
2. Edit `orchestrator/src/registry.json` with your product config (see `registry.template.json` for a clean starting point)
3. Run the interactive setup script — it walks through every external service with direct links and prompts:
   ```bash
   bash scripts/setup.sh
   ```
   Covers: Anthropic, Slack app, Linear, GitHub PATs + webhooks, Sentry, Cloudflare secrets, and CI/CD secrets. Idempotent — safe to re-run.

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `orchestrator/` | Worker + Durable Object — webhook handling, event routing, ticket tracking |
| `agent/` | Agent entrypoint — Agent SDK, tools, prompt construction |
| `containers/` | Dockerfiles and container code (orchestrator Slack Socket Mode, agent server) |
| `.claude/skills/` | English skill files that define agent behavior |
| `docs/` | Architecture docs, deployment guide, process notes |

## Deploy

Merging to `main` triggers automatic deployment via GitHub Actions (`.github/workflows/deploy.yml`).

For manual deployment:

```bash
cd orchestrator && npx wrangler deploy
```

## Development

```bash
# Run orchestrator tests
cd orchestrator && bun test

# Run agent tests
cd agent && bun test
```

End-to-end: create a test Linear ticket or Slack mention and watch the Slack channel.

## Further Reading

- [`CLAUDE.md`](CLAUDE.md) — detailed architecture and conventions
- [`docs/product/security.md`](docs/product/security.md) — security architecture and accepted risks
- [`docs/deploy.md`](docs/deploy.md) — deployment details and debugging

## Future Work

- **Runtime registry** — move product config from a build-time JSON file to a runtime store (Cloudflare KV or D1) so the registry can be updated without redeploying, and personal config doesn't need to live in the repo. `registry.template.json` would become the sole checked-in reference.

## License

[Unlicense](LICENSE) (public domain)
