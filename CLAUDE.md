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
Triggers (Linear, Slack, Feedback Widget, GitHub)
        │
        ▼
Orchestrator (Cloudflare Worker)
  - Receives triggers
  - Looks up product config in registry
  - Resolves secrets
  - Launches sandboxes via Queue
        │
        ▼
Sandbox (Cloudflare Container)
  - Clones product repo(s)
  - Runs generic PE agent (Claude Agent SDK)
  - Agent reads repo's CLAUDE.md + skills
  - Communicates via Slack, creates PRs
```

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `orchestrator/` | Shared Cloudflare Worker — dispatch, webhooks, queue consumer |
| `agent/` | Generic Product Engineer agent — runs inside sandbox containers |
| `.claude/skills/` | English skills that define agent behavior |
| `docs/` | Process docs and learnings |

## How It Works

### Orchestrator (`orchestrator/`)
The Worker receives triggers and dispatches tasks:
- `POST /api/dispatch` — programmatic dispatch from per-product workers
- `POST /api/webhooks/linear` — Linear issue creation/update
- `POST /api/webhooks/slack/events` — Slack app mentions
- `POST /api/webhooks/github` — PR merge detection

Tasks are enqueued to `TASK_QUEUE` and processed by the queue consumer, which launches Cloudflare Sandbox containers.

### Product Engineer Agent (`agent/`)
The generic agent runs inside sandbox containers:
1. Reads `TASK_PAYLOAD` from env (injected by orchestrator)
2. Clones the product's repo(s) (already done by sandbox launcher)
3. Loads the repo's CLAUDE.md, skills, and MCP servers via `settingSources: ["project"]`
4. Follows the `product-engineer` skill to assess, implement, and deliver
5. Communicates via Slack and updates task status via orchestrator API

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
- `cd orchestrator && bun test` for orchestrator tests
- `cd agent && bun test` for agent tests
- End-to-end: create a test Linear ticket or Slack mention and watch the Slack channel

## Linear
- Team: Product Engineer (PE)

@docs/process/learnings.md
