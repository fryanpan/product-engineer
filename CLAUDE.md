# Product Engineer

Shared orchestrator and autonomous agent for processing tasks (feedback, Linear tickets, Slack commands) across multiple products.

## What is this?

Product Engineer is an autonomous agent that turns Linear tickets, Slack messages, and feedback into shipped code — PRs that are ready for human review. For small teams, the bottleneck isn't coding; it's the coordination overhead of context-switching into a repo, understanding the codebase, implementing, testing, and communicating progress. This agent handles that entire loop: minutes for simple changes, under an hour for complex features, with human involvement only at the moments it matters.

The core is intentionally tiny (~600-line orchestrator, ~130-line agent entrypoint). All decision-making lives in English skill files, not TypeScript, so changing how the agent behaves means editing markdown. It runs on Cloudflare Workers + Containers, scaling to dozens of parallel agents across multiple repos.

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
- Tracks `agent_active` per ticket — set to `0` on terminal states (`merged`, `closed`, `deferred`, `failed`) so deployment-triggered webhook events do not re-spawn completed agents (see `docs/deployment-safety.md`)

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
- `[vars]` in `wrangler.toml` (e.g., `WORKER_URL`) are plaintext config — update them for each new deployment subdomain. They are not Cloudflare secrets and will not appear in `wrangler secret list`

### LLM Monitoring
- All Anthropic API traffic routes through Cloudflare AI Gateway for monitoring
- Configure gateway in `registry.json` under `cloudflare_ai_gateway` (account ID + gateway ID)
- Dashboard shows: requests, tokens, costs, errors, cache hit rates
- See `docs/cloudflare-ai-gateway.md` for setup and analytics details

### Testing
- `cd orchestrator && bun test` for orchestrator tests (Worker, DO, TicketAgent, webhooks, registry)
- `cd agent && bun test` for agent tests (prompt construction, tools)
- End-to-end: create a test Linear ticket or Slack mention and watch the Slack channel
- Deployment safety behavior (terminal state protection, container liveness, re-spawn prevention) is documented in `docs/deployment-safety.md` — when changing `orchestrator.ts` or `ticket-agent.ts`, check whether the doc needs updating (it contains embedded code snippets that drift)

## Linear
- Team: Product Engineer (PE)

@docs/process/learnings.md
