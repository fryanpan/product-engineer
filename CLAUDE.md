# Product Engineer

Shared orchestrator and autonomous agent for processing tasks (feedback, Linear tickets, Slack commands) across multiple products.

## Design Philosophy

**Minimal, auditable, easy to customize.** Deliver the most possible value with the least custom code.

- **Slim core** — the orchestrator is ~600 lines. The agent entrypoint is ~130 lines. Decision-making lives in English skills, not code.
- **Depend on rapidly improving components** — Claude Code, Agent SDK, and Cloudflare Sandbox are evolving fast. Ride their improvements instead of reimplementing.
- **Avoid accumulating cruft** — every abstraction must earn its place. If a component can be deleted without breaking anything, delete it.
- **English over code** — agent behavior is defined in SKILL.md files, not TypeScript logic. Changing how the agent works means editing markdown.

## Architecture

```
Webhooks (Linear, GitHub)     Slack Socket Mode
         │                            │
         ▼                            ▼
Worker (stateless) ──→ Orchestrator DO (singleton, always-on)
                         │ SQLite: tickets, metadata
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   TicketAgent #1   TicketAgent #2   TicketAgent #3
   (4-day sleep)    (4-day sleep)    (4-day sleep)
   Agent SDK        Agent SDK        Agent SDK
```

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `orchestrator/` | Worker + Durable Object — webhook handling, event routing, ticket tracking |
| `agent/` | Generic Product Engineer agent — Agent SDK, tools, prompt construction |
| `containers/` | Dockerfiles and container-specific code (orchestrator Socket Mode, agent server) |
| `.claude/skills/` | English skills that define agent behavior |
| `docs/` | Process docs and learnings |

## How It Works

### Worker (`orchestrator/src/index.ts`)
Stateless Cloudflare Worker that receives webhooks and proxies them to the Orchestrator Durable Object:
- `POST /api/webhooks/linear` — Linear issue creation/update (HMAC-verified)
- `POST /api/webhooks/github` — PR review/merge events (signature-verified)

The Worker looks up product config from the registry, resolves the Orchestrator DO singleton, and forwards events.

### Orchestrator DO (`orchestrator/src/orchestrator.ts`)
Singleton Durable Object that owns all coordination:
- SQLite-backed ticket tracking (status, metadata, agent assignment)
- Routes events to the correct TicketAgent container
- Spawns new TicketAgent containers for new tickets
- Its companion container (`containers/orchestrator/`) maintains a persistent Slack Socket Mode WebSocket connection, forwarding `@product-engineer` mentions to the DO

### TicketAgent (`orchestrator/src/ticket-agent.ts`)
Container class — one instance per ticket, lives up to 4 days:
- Runs a persistent HTTP server that receives events from the Orchestrator DO
- Wraps the Agent SDK with `settingSources: ["project"]` to load product repo CLAUDE.md and skills
- Follows the `product-engineer` skill for decision-making (reversible actions = autonomous, irreversible = batch and ask)
- Communicates via Slack (`notify_slack`, `ask_question` tools)
- Handles full ticket lifecycle: creation, implementation, PR, review, revision, merge

### Product Registry (`orchestrator/src/registry.ts`)
Static config mapping products to their repos, secrets, Slack channels, and trigger configuration. See `/setup-product` skill for how to register new products.

## Conventions

### Adding a New Product
Use the `/setup-product` skill. It walks through registry entry, secret provisioning, trigger configuration, and testing.

### Modifying Agent Behavior
Agent decision-making is encoded in English skills (`.claude/skills/`), not TypeScript. To change how the agent works:
1. Edit the relevant skill (e.g., `product-engineer/SKILL.md` for decision logic)
2. The agent loads skills from this repo AND from the target product's repo

### Secrets
- Platform secrets (Slack, Linear, Anthropic) are shared across products
- GitHub tokens are per-product (different repo access)
- All secrets are in Cloudflare Secrets Store, injected as env vars into sandboxes
- The registry maps logical secret names to Cloudflare binding names

### Testing
- `cd orchestrator && bun test` for orchestrator tests (Worker, DO, TicketAgent, webhooks, registry)
- `cd agent && bun test` for agent tests (prompt construction, tools)
- End-to-end: create a test Linear ticket or Slack mention and watch the Slack channel

## Linear
- Team: Product Engineer (PE)

@docs/process/learnings.md
