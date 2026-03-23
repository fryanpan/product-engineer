# Product Engineer

Autonomous agent that turns tickets into shipped code.

## What This Is

Product Engineer is an **autonomous agent system** powered by Claude and the Agent SDK that handles engineering tasks from request to deployment. Instead of rule-based decision engines, it uses **persistent agent sessions** that accumulate context over time, making decisions in natural language based on SKILL.md files.

The core insight: most engineering work requires accumulated context. This system gives each product a long-lived ProjectAgent that builds understanding of the codebase, conventions, and patterns — like a human engineer who's been on the team for months.

### v3 Architecture (Current)

v3 replaced TypeScript decision logic with **persistent Claude agent sessions**:

- **ProjectAgent per product** — Accumulates context over time, decides how to handle events
- **Self-managing TicketAgents** — Own full lifecycle including CI monitoring and merge decisions
- **Conductor** (planned) — Cross-product assistant for DMs and system-wide queries
- **4-layer security** — HMAC → injection detection → prompt delimiter → content limits

All decision-making lives in English SKILL.md files, not code.

### Agent Roles

| Role | Scope | Lifetime | Purpose |
|------|-------|----------|---------|
| **ProjectAgent** | Per product | Persistent (indefinite) | Triages events, accumulates product context, spawns ticket agents |
| **TicketAgent** | Per ticket | Ephemeral (2-4h) | Implements one ticket end-to-end: code → PR → CI → merge |
| **Conductor** | Cross-product | Persistent | Routes unmatched events, answers system queries (planned) |

## Design Philosophy

This is a small, understandable repo that does something ambitious.

- **Slim core** — ~1.5k-line orchestrator, ~600-line agent server. Decision-making lives in English skills, not TypeScript.
- **English over code** — Agent behavior is defined in SKILL.md files. Changing how agents work means editing markdown, not deploying code.
- **Persistent context** — ProjectAgents accumulate knowledge like long-tenured engineers. TicketAgents benefit from this when spawned.
- **Self-management** — TicketAgents own their full lifecycle. No orchestrator polling for CI or merge gates.
- **Ride rapidly improving components** — Claude Agent SDK, Cloudflare Containers, and Claude itself evolve fast. Depend on them instead of reimplementing.
- **No cruft** — Every abstraction earns its place. If a component can be deleted without breaking anything, delete it.

## Goals

**Faster delivery with minimal hands-on time**
- **Minutes** for simple changes (bug fixes, small features)
- **< 1 hour** for complex multi-file features
- Discuss via Slack threads — manage progress from anywhere

**Full Claude Code power via Agent SDK**
- Codebase exploration, testing, PR creation
- Plugin support (load from target repo's `.claude/settings.json`)
- Context7 for up-to-date framework docs

**Customizable per product**
- Each repo has its own SKILL.md + plugins + MCP servers
- ProjectAgent accumulates product-specific knowledge
- `/propagate` pushes template updates to registered products

**Scalable architecture**
- Dozens of parallel agents via Cloudflare Containers
- ProjectAgents stay alive indefinitely, accumulating context
- TicketAgents spawn on-demand for parallel work

**Layered security**
- HMAC webhook verification
- Prompt injection detection (vard scan)
- Secret delimiter wrapping untrusted input
- Content limits (1MB worker, 100KB fields)
- See [security.md](docs/architecture/security-layers.md) for details

Built on [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-sdk) + [Cloudflare Workers & Containers](https://developers.cloudflare.com/containers/).

## Architecture

```
Event Sources:
  Linear Webhooks, GitHub Webhooks, Slack Socket Mode
            │
            ▼
Worker (stateless, security layer)
  ├─ HMAC/signature verification
  ├─ Injection detection (vard scan)
  └─ Prompt delimiter wrapping
            │
            ▼
Orchestrator DO (singleton, SQLite state)
  ├─ Product registry, ticket tracking
  └─ Channel → product routing
            │
    ┌───────┴───────────────┐
    ▼                       ▼
ProjectAgent DO         ProjectAgent DO
(staging-test-app)      (product-engineer)
Persistent session      Persistent session
    │                       │
    └─► TicketAgent DO #1   └─► TicketAgent DO #2
        Ephemeral (2h)          Ephemeral (2h)
        Self-managing           Self-managing
```

See [docs/architecture/architecture.md](docs/architecture/architecture.md) for detailed component diagrams and event flows.

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `orchestrator/` | Worker + Durable Objects — webhook handling, routing, state management (formerly `api/`) |
| `agent/` | Agent container server — wraps Agent SDK, MCP tools, runs for both ProjectAgent and TicketAgent |
| `containers/` | Dockerfiles for orchestrator (Socket Mode) and agent (SDK wrapper) |
| `agent/src/skills/` | Agent behavior skills — loaded by ProjectAgent/TicketAgent via settingSources |
| `.claude/skills/` | Management skills for human operators — registry, propagation, retros, project setup |
| `templates/` | Baseline `.claude/rules/` and `CLAUDE.md.tmpl` for target repos — pushed via `/propagate` |
| `docs/` | Architecture docs, plans, process docs, learnings |

## How It Works

### Worker (`orchestrator/src/index.ts`)
Stateless Cloudflare Worker. All inbound traffic goes through security validation:
1. **HMAC/signature verification** — Webhooks must be signed by the source
2. **Injection detection** — `vard` pattern scan on all free-text fields
3. **Prompt delimiter wrapping** — Secret delimiter protects prompts from escape attacks

Then forwards verified events to Orchestrator DO.

**Key routes:**
- `POST /api/webhooks/linear` — Linear issue webhooks (HMAC-verified)
- `POST /api/webhooks/github` — GitHub PR/CI webhooks (signature-verified)
- `POST /api/internal/slack-event` — From Socket Mode container (API key auth)
- `POST /api/internal/status` — Agent status updates
- `POST /api/orchestrator/heartbeat` — Agent heartbeat phone-home
- `GET/POST/PUT/DELETE /api/products` — Product registry management

### Orchestrator DO (`orchestrator/src/orchestrator.ts`)
Singleton Durable Object. Thin state store and event router — **no decision logic**.

**What it does:**
- Product registry (SQLite): repos, channels, secrets, triggers per product
- Ticket tracking: status, slack_thread_ts, agent_active, last_heartbeat
- Channel → product lookup (deterministic, no LLM)
- Routes events to ProjectAgent DO for the product
- Spawns TicketAgent DOs when ProjectAgent requests (via `/project-agent/spawn-task`)

**What it doesn't do:**
- No merge gates (agents self-manage via `check_ci_status` + `merge_pr` tools)
- No CI monitoring (agents do this)
- No decision-making (that's in ProjectAgent/TicketAgent SKILL.md files)

### ProjectAgent DO (`orchestrator/src/project-agent.ts`) — NEW in v3
One Durable Object per registered product. Runs a **persistent Agent SDK session** that accumulates context over time.

**Lifetime:** Indefinite (no timeouts). Only replaced on deploy.

**What it does:**
- Receives all events for its product (Linear tickets, Slack mentions, GitHub webhooks)
- Builds understanding of the codebase, conventions, patterns over time
- Decides how to handle each event (implement directly OR spawn TicketAgent)
- Uses `coding-project-lead` or `research-agent` SKILL.md depending on product mode

**Recovery:** `alarm()` every 5 min health-checks the container. If dead, restarts from SQLite-persisted config. Events that arrived while dead are buffered and drained on restart.

### TicketAgent DO (`orchestrator/src/ticket-agent.ts`)
One Durable Object per ticket. Ephemeral container (≤2h) that implements a single ticket end-to-end.

**Lifetime:** 2 hours max, exits on completion (merged/closed/failed)

**What it does:**
- Clones repos, loads plugins from target `.claude/settings.json`
- Implements: reads code, makes changes, writes tests, commits
- Creates PR and posts to Slack
- **Self-manages CI:** Monitors via `check_ci_status` tool, fixes failures, retries
- **Self-manages merge:** Calls `merge_pr` tool when CI passes
- Responds to PR review feedback (events injected via messageYielder)

**Uses `ticket-agent-coding` or `research-agent` SKILL.md** depending on mode.

### Plugin Loading (`agent/src/plugins.ts`)
After cloning target repo, reads `.claude/settings.json` → `enabledPlugins`. Shallow-clones marketplace repos in parallel, resolves plugin paths from `marketplace.json`, passes to Agent SDK as `plugins: [{ type: "local", path }]`.

**Important:** `settingSources: ["project"]` loads CLAUDE.md + skills + rules, but NOT plugins. Plugins must be passed explicitly.

### Product Registry
Managed via admin API (`/api/products`). Each product defines:
- Repos, Slack channels, secrets, triggers
- Mode (`coding` or `research`)
- Model (`sonnet`, `opus`, `haiku`)

See `/setup-product` or `/add-project` skills.

## Conventions

### Adding a New Product
- **Existing repos**: Use `/add-project` skill to register the repo
- **New projects**: Use `/create-project` to scaffold and register
- **Manual setup**: Use `/setup-product` for step-by-step guidance

### Modifying Agent Behavior
Decision-making lives in English skills, not TypeScript.

**Agent skills** (`agent/src/skills/`): Define autonomous agent behavior. Loaded via `settingSources: ["project"]`.
- `ticket-agent-coding` — Self-managing ticket agent (implement → PR → CI → merge)
- `coding-project-lead` — ProjectAgent for coding products (event triage, context accumulation)
- `research-agent` — ProjectAgent/TicketAgent for non-coding tasks
- `conductor` — Cross-product assistant (DMs, system queries) — planned, not yet implemented
- `task-retro` — Per-task retrospective

**Management skills** (`.claude/skills/`): For human operators in this repo. Not loaded into agent containers.
- `/setup-product`, `/add-project`, `/create-project` — Product registry management
- `/propagate` — Push template updates to registered products
- `/aggregate`, `/cross-project-review` — System-wide learnings

**To change agent behavior:** Edit skills in `agent/src/skills/` and redeploy containers.
**To change target repo config:** Edit `templates/` and use `/propagate`.

### Secrets
- Platform secrets (Slack, Linear, Anthropic) are shared across products
- GitHub tokens are per-product (different repo access)
- All secrets in Cloudflare Secrets Store, injected as env vars into sandboxes
- The registry maps logical secret names to Cloudflare binding names
- `WORKER_URL` is a deployment-specific secret (not checked in) — set via `cd orchestrator && wrangler secret put WORKER_URL`

### LLM Monitoring
- All Anthropic API traffic routes through Cloudflare AI Gateway for monitoring
- Configure gateway via the admin API (`PUT /api/settings/cloudflare_ai_gateway`) or by seeding via `POST /api/products/seed`
- Dashboard shows: requests, tokens, costs, errors, cache hit rates
- See `docs/cloudflare-ai-gateway.md` for setup and analytics details

### Testing
- `cd orchestrator && bun test` for orchestrator tests (Worker, DO, webhooks, registry)
- `cd agent && bun test` for agent tests (prompt construction, tools)
- End-to-end: create a test Linear ticket or Slack mention and watch the Slack channel
- Deployment safety behavior (terminal state protection, container liveness, re-spawn prevention) is documented in `docs/deployment-safety.md`

## Getting Started

**Prerequisites:** [Cloudflare account](https://dash.cloudflare.com/sign-up), [Anthropic API key](https://console.anthropic.com/), Slack workspace, Linear workspace.

1. Fork/clone the repo
2. Register your products via the admin API (`POST /api/products`) or seed from `registry.template.json`
3. Run the interactive setup script:
   ```bash
   bash scripts/setup.sh
   ```
   Covers: Anthropic, Slack app, Linear, GitHub PATs + webhooks, Sentry, Cloudflare secrets, and CI/CD secrets. Idempotent — safe to re-run.

## Deploy

Merging to `main` triggers automatic deployment via GitHub Actions (`.github/workflows/deploy.yml`).

**One-time setup:** Create the R2 bucket for transcript storage:

```bash
npx wrangler r2 bucket create product-engineer-transcripts
```

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

## Linear

- Team: Product Engineer (PE)
