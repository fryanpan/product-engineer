# Product Engineer

Autonomous AI agent that processes Linear tickets, Slack mentions, and GitHub events across multiple product repos. Runs on Cloudflare Workers + Containers with the Claude Agent SDK.

## How It Works

```
Webhooks (Linear, GitHub)     Slack Socket Mode
         │                            │
         ▼                            ▼
Worker (stateless) ──→ Orchestrator DO (singleton, always-on)
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   TicketAgent #1   TicketAgent #2   TicketAgent #3
   (per-ticket)     (per-ticket)     (per-ticket)
```

1. **Triggers** arrive via Linear webhooks, GitHub webhooks, or Slack `@product-engineer` mentions
2. **Orchestrator** routes each event to a per-ticket agent container
3. **Agent** clones the product repo, reads its `CLAUDE.md` + skills, implements the task, and creates a PR
4. **Communication** happens via Slack threads — the agent posts progress and can ask clarifying questions

## Setup

All external service configuration is handled by the interactive setup script:

```bash
bash scripts/setup.sh
```

This walks through every step with direct links and prompts for credentials. It covers:

- Anthropic API key
- Slack app creation (from manifest), tokens, and channel invitations
- Linear API key and webhook
- GitHub fine-grained PATs (per-product repo)
- GitHub webhooks (per-product repo)
- Sentry DSN and access token
- Notion integration token
- Context7 API key
- Cloudflare Workers secrets provisioning
- GitHub Actions secrets for CI/CD

The script is idempotent — safe to re-run if you need to update or add secrets.

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

## Architecture

See `CLAUDE.md` for detailed architecture, conventions, and directory structure.
See `docs/product/security.md` for the security architecture and accepted risks.
See `docs/deploy.md` for deployment details and debugging.
