# Product Engineer

Autonomous agent that turns tickets into shipped code.

## Goals

Product Engineer is a testbed that let us explore new ways of working with agent support:
- **Explore more automated workflows**
  - What if we hand off more short-term decision making to LLMs to speed up workflows?
  - Can we turn feedback into deployed update in a few minutes (for simple fix)
  - Or < 1 hour (for moderately complex update) with less than 5 minutes of hands-on time
  - Do this by automating decisions for whether we need human review
(e.g. before starting ticket, review the plan before implementation, review the work before merge)
  - Keep LLM transcripts and cost logs to enable longer-term more careful human + robot review cycle
- **Explore different interaction styles**
  - How does it feel to be able to work collaboratively with a long-running, always available assistant?
  - How do we make it easier to work from anywhere, with brief hands-on interactions?
- **Full Claude Code power via Agent SDK**
  - Codebase exploration, testing, PR creation
  - Plugin support (load from target repo's `.claude/settings.json`)
  - Context7 for up-to-date framework docs
- **Customizable per product**
  - Each repo has its own SKILL.md + plugins + MCP servers
  - Project Lead accumulates product-specific knowledge
  - `/propagate` pushes template updates to registered products
- **Scalable architecture**
  - Can run many parallel agents via Cloudflare Containers
  - Project Leads stay alive indefinitely, accumulating context
  - Task Agents spawn on-demand for parallel work
- **Layered security**
  - HMAC webhook verification
  - Prompt injection detection (vard scan)
  - Secret delimiter wrapping untrusted input
  - Content limits (1MB worker, 100KB fields)
  - See [security-layers.md](./docs/architecture/security-layers.md) for details

Built on [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-sdk) + [Cloudflare Workers & Containers](https://developers.cloudflare.com/containers/).

### What's In the Future?
I fully expect that within 2-8 weeks of anything happening on this repo, Claude Code will also gain that feature, if it's generally useful enough.

Since this project started, Claude has already picked up the following new features in research preview:
- Remote control (from mobile phone / laptop)
- Dispatch (a "lead" agent that helps you coordinate Cowork and Code tasks)
- PR management agent

And so while this repo provides a more cohesive workflow, with E2E testing of that workflow, Anthropic is clearly building all the same pieces and going in the same direction.  And they've said as much early in 2026 in their predictions for what to expect this year.

So the point of this project is to keep taking an hour every week or two to explore new ways of working for personal entertainment and productivity.

### v3 Architecture (Current)
v3 replaced TypeScript decision logic that was triggered when events happen with **persistent Claude agent sessions**, so that all conversations get smarter:
- **Project Lead**
  - Manages all work in a "project" and acts as the lead on the associated Slack channel or Linear project
  - Accumulates context over time, decides how to handle events
  - May pick up tasks directly, if they're easy.  Or spin up parallel "Task Agents" if needed
 
- **Task Agent**
  - Spawned by the project lead, if needed, on more complex tasks.
  - Own full lifecycle including CI monitoring and merge decisions

- **Conductor**
  - Cross-project assistant that can help check status and which projects need manual review
  - Helps manage projects (spin up new projects, review for cross-project learnings)
  - Has it's own dedicated Slack channel
  - Was inspired by Claude's research preview of "Dispatch", but I made it more powerful...

### Agent Roles
| Role | Scope | Lifetime | Purpose |
| --- | --- | --- | --- |
| **Project Lead** | Per product | Persistent (indefinite) | Triages events, accumulates product context, spawns task agents |
| **Task Agent** | Per ticket | Ephemeral (2-4h) | Implements one ticket end-to-end: code → PR → CI → merge |
| **Conductor** | Cross-product | Persistent | Routes unmatched events, answers system queries |

## Design Philosophy

This is a small, understandable repo that does something ambitious.

- **Slim core** — ~1.5k-line orchestrator, ~600-line agent server. Decision-making lives in English skills, not TypeScript.
- **English over code** — Agent behavior is defined in SKILL.md files. Changing how agents work means editing markdown, not deploying code.
- **Persistent context** — Project Leads accumulate knowledge like long-tenured engineers. Task Agents benefit from this when spawned.
- **Self-management** — Task Agents own their full lifecycle. No orchestrator polling for CI or merge gates.
- **Ride rapidly improving components** — Claude Agent SDK, Cloudflare Containers, and Claude itself evolve fast. Depend on them instead of reimplementing.
- **No cruft** — Every abstraction earns its place. If a component can be deleted without breaking anything, delete it.

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
    ┌───────┼───────────────────────┐
    ▼       ▼                       ▼
Conductor  Project Lead DO         Project Lead DO
(cross-    (staging-test-app)      (product-engineer)
 product)  Persistent session      Persistent session
               │                       │
               └─► Task Agent DO #1    └─► Task Agent DO #2
                   Ephemeral (2-4h)        Ephemeral (2-4h)
                   Self-managing           Self-managing
```

See [architecture.md](./docs/architecture/architecture.md) for detailed component diagrams and event flows.

## Key Directories

| Directory | Purpose |
| --- | --- |
| `orchestrator/` | Worker + Durable Objects — webhook handling, routing, state management (formerly `api/`) |
| `agent/` | Agent container server — wraps Agent SDK, MCP tools, runs for Project Lead, Task Agent, and Conductor |
| `containers/` | Dockerfiles for orchestrator (Socket Mode) and agent (SDK wrapper) |
| `agent/src/skills/` | Agent behavior skills — loaded by all agent roles via settingSources |
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
- `POST /api/conductor/heartbeat` — Agent heartbeat phone-home
- `GET/POST/PUT/DELETE /api/products` — Product registry management

### Conductor DO (`api/src/conductor.ts`)
Singleton Durable Object. Thin state store and event router — **no decision logic**.

**What it does:**
- Product registry (SQLite): repos, channels, secrets, triggers per product
- Task tracking: status, slack_thread_ts, agent_active, last_heartbeat
- Channel → product lookup (deterministic, no LLM)
- Routes events to the Project Lead DO for the product
- Spawns Task Agent DOs when a Project Lead requests (via `/project-lead/spawn-task`)

**What it doesn't do:**
- No merge gates (agents self-manage via `check_ci_status` + `merge_pr` tools)
- No CI monitoring (agents do this)
- No decision-making (that's in Project Lead/Task Agent/Conductor SKILL.md files)

### Project Lead (`api/src/project-lead.ts`)
One Durable Object per registered product. Runs a **persistent Agent SDK session** that accumulates context over time.

**Lifetime:** Indefinite (no timeouts). Only replaced on deploy.

**What it does:**
- Receives all events for its product (Linear tickets, Slack mentions, GitHub webhooks)
- Builds understanding of the codebase, conventions, patterns over time
- Decides how to handle each event (implement directly or spawn a Task Agent)
- Uses `coding-project-lead` or `research-agent` SKILL.md depending on product mode

**Recovery:** `alarm()` every 5 min health-checks the container. If dead, restarts from SQLite-persisted config. Events that arrived while dead are buffered and drained on restart.

### Task Agent (`api/src/task-agent.ts`)
One Durable Object per task. Ephemeral container (2-4h) that implements a single task end-to-end.

**Lifetime:** 2 hours (coding) or 4 hours (research), exits on completion (merged/closed/failed)

**What it does:**
- Clones repos, loads plugins from target `.claude/settings.json`
- Implements: reads code, makes changes, writes tests, commits
- Creates PR and posts to Slack
- **Self-manages CI:** Monitors via `check_ci_status` tool, fixes failures, retries
- **Self-manages merge:** Calls `merge_pr` tool when CI passes
- Responds to PR review feedback (events injected via messageYielder)

Uses `ticket-agent` or `research-agent` SKILL.md depending on mode.

### Conductor (`api/src/project-lead.ts`, role=conductor)
A specialized Project Lead that coordinates across all registered products. Runs in its own dedicated Slack channel.

**Lifetime:** Persistent (same as Project Lead).

**What it does:**
- Receives all messages in its channel (no @-mention required)
- Provides cross-product status: active tickets, stale agents, failed tasks
- Routes work to the right Project Lead via `spawn_task` and `send_message_to_task`
- Answers system-level queries (costs, performance, recent failures)

### Plugin Loading (`agent/src/plugins.ts`)
After cloning target repo, reads `.claude/settings.json` → `enabledPlugins`. Shallow-clones marketplace repos in parallel, resolves plugin paths from `marketplace.json`, passes to Agent SDK as `plugins: [{ type: "local", path }]`.

**Important:** `settingSources: ["project"]` loads CLAUDE.md + skills + rules, but NOT plugins. Plugins must be passed explicitly.

### Product Registry
Managed via admin API (`/api/products`). Each product defines:
- Repos, Slack channels, secrets, triggers
- Mode (`coding`, `research`, or `flexible`)
- Model (`sonnet`, `opus`, `haiku`)

See `/setup-product` or `/add-project` skills.

### Agent Modes

Each product is configured with a **mode** that determines the agent's personality and skill set:

| Mode | Project Lead Skill | Task Agent Skill | Use Case |
| --- | --- | --- | --- |
| `coding` | `coding-project-lead` | `ticket-agent` | Software development — reads code, implements features, writes tests, creates PRs, monitors CI, merges |
| `research` | `research-agent` | `research-agent` | Non-coding tasks — planning, research, scheduling, information gathering. Longer timeouts (4h), uses Notion/Calendar/Asana tools |
| `flexible` | `coding-project-lead` | Per-task (coding or research) | Mixed workloads — Project Lead triages events and can spawn either coding or research Task Agents |

**Coding mode** is the default. The Task Agent owns its full lifecycle: clone → implement → test → PR → CI → merge. It uses `check_ci_status` and `merge_pr` tools to self-manage without orchestrator involvement.

**Research mode** extends timeouts (4h session, 1h idle vs 2h/5min for coding) and persists the session after completion for follow-up questions. Research agents use web search, Notion, Google Calendar, and Asana to gather and synthesize information.

## Conventions

### Adding a New Product
- **Existing repos**: Use `/add-project` skill to register the repo
- **New projects**: Use `/create-project` to scaffold and register
- **Manual setup**: Use `/setup-product` for step-by-step guidance

### Modifying Agent Behavior
Decision-making lives in English skills, not TypeScript.

**Agent skills** (`agent/src/skills/`): Define autonomous agent behavior. Loaded via `settingSources: ["project"]`.
- `ticket-agent` — Task Agent for coding work (implement → PR → CI → merge)
- `coding-project-lead` — Project Lead for coding products (event triage, context accumulation)
- `research-agent` — Project Lead or Task Agent for non-coding tasks
- `conductor` — Conductor for cross-product coordination (status, routing, system queries)
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
