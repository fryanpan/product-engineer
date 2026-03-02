# Persistent Agent Architecture — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace one-shot container agents with persistent orchestrator + per-ticket agents using Cloudflare Durable Objects and Containers.

**Architecture:** Stateless Worker proxies all events to a singleton Orchestrator DO (always-on, maintains Slack Socket Mode). Orchestrator routes events to per-ticket TicketAgent DOs via RPC. Each TicketAgent runs Claude Agent SDK in a long-lived container.

**Tech Stack:** Cloudflare Workers, Durable Objects, Containers (`@cloudflare/containers`), Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Hono, Bun, TypeScript.

**Design doc:** `docs/plans/2026-03-01-persistent-agent-architecture.md`

---

## Task 1: Scaffold container directories and Dockerfiles

**Files:**
- Create: `containers/orchestrator/Dockerfile`
- Create: `containers/orchestrator/package.json`
- Create: `containers/agent/Dockerfile`
- Delete: `Dockerfile` (root)

**Step 1: Create orchestrator container scaffold**

```
mkdir -p containers/orchestrator containers/agent
```

`containers/orchestrator/Dockerfile`:
```dockerfile
FROM oven/bun:latest
COPY containers/orchestrator/ /app/
WORKDIR /app
RUN bun install
CMD ["bun", "run", "index.ts"]
```

`containers/orchestrator/package.json`:
```json
{
  "name": "pe-orchestrator-container",
  "private": true,
  "type": "module",
  "dependencies": {
    "hono": "^4.0.0"
  }
}
```

**Step 2: Create agent container Dockerfile**

`containers/agent/Dockerfile` (adapted from root `Dockerfile`):
```dockerfile
FROM oven/bun:latest

RUN apt-get update && \
    apt-get install -y git curl && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY agent/ /app/agent/
WORKDIR /app/agent
RUN bun install

RUN mkdir -p /workspace
WORKDIR /app/agent
CMD ["bun", "run", "server.ts"]
```

**Step 3: Delete root Dockerfile**

```bash
rm Dockerfile
```

**Step 4: Commit**

```bash
git add containers/ && git rm Dockerfile
git commit -m "scaffold: container directories and Dockerfiles for orchestrator + agent"
```

---

## Task 2: Rewrite wrangler.toml — two containers, two DOs, no queue

**Files:**
- Modify: `orchestrator/wrangler.toml`
- Modify: `orchestrator/package.json` (swap `@cloudflare/sandbox` → `@cloudflare/containers`)

**Step 1: Update wrangler.toml**

Replace entire contents of `orchestrator/wrangler.toml`:
```toml
name = "product-engineer"
main = "src/index.ts"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

# Orchestrator — always-on, Slack Socket Mode, event routing
[[containers]]
class_name = "Orchestrator"
image = "../containers/orchestrator"
instance_type = "lite"
max_instances = 1

# Per-ticket agents — one per active ticket, runs Claude Agent SDK
[[containers]]
class_name = "TicketAgent"
image = "../containers/agent"
instance_type = "basic"
max_instances = 10

[durable_objects]
bindings = [
  { name = "ORCHESTRATOR", class_name = "Orchestrator" },
  { name = "TICKET_AGENT", class_name = "TicketAgent" }
]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["Orchestrator", "TicketAgent"]
```

**Step 2: Update orchestrator package.json**

Replace `@cloudflare/sandbox` with `@cloudflare/containers`:
```bash
cd orchestrator && bun remove @cloudflare/sandbox && bun add @cloudflare/containers
```

**Step 3: Verify typecheck still works (will have errors — that's expected at this stage)**

```bash
cd orchestrator && bun run typecheck 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add orchestrator/wrangler.toml orchestrator/package.json orchestrator/bun.lockb
git commit -m "config: two containers, two DOs, swap sandbox for containers package"
```

---

## Task 3: Write Orchestrator DO class

**Files:**
- Create: `orchestrator/src/orchestrator.ts`
- Create: `orchestrator/src/types.ts` (shared types)

**Step 1: Create shared types**

`orchestrator/src/types.ts`:
```typescript
export interface TicketEvent {
  type: string;       // "ticket_created", "pr_review", "pr_merged", "slack_mention", "slack_reply", etc.
  source: string;     // "linear", "github", "slack", "api"
  ticketId: string;
  product: string;
  payload: unknown;
  slackThreadTs?: string;
}

export interface Bindings {
  ORCHESTRATOR: DurableObjectNamespace;
  TICKET_AGENT: DurableObjectNamespace;

  // Secrets
  API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_APP_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  LINEAR_API_KEY: string;
  LINEAR_WEBHOOK_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  ORCHESTRATOR_URL: string;

  // Per-product GitHub tokens
  HEALTH_TOOL_GITHUB_TOKEN: string;
  BIKE_TOOL_GITHUB_TOKEN: string;

  [key: string]: unknown;
}
```

**Step 2: Write Orchestrator DO**

`orchestrator/src/orchestrator.ts`:

The Orchestrator extends `Container` from `@cloudflare/containers`. It:
- Initializes SQLite tables on first access
- Exposes `fetch()` to handle proxied webhooks from the Worker
- Routes events to TicketAgent DOs via `env.TICKET_AGENT.get(id).handleEvent()`
- Tracks tickets in SQLite
- Exposes `updateTicketStatus()` as an RPC method for agents to call back

Key methods:
- `fetch(request)` — routes `/linear`, `/github`, `/slack`, `/health`, `/api/dispatch`
- `routeToAgent(ticketId, event)` — gets or creates TicketAgent DO stub, calls `handleEvent()`
- `findOrCreateTicket(ticketId, product, source)` — SQLite upsert
- `updateTicketStatus(ticketId, status, details)` — called by agents via RPC
- `initDb()` — creates `tickets` and `events` tables if not exist

Container config:
- `defaultPort = 3000`
- No `sleepAfter` (always on)
- `envVars` returns `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`

**Step 3: Write test for Orchestrator event routing**

`orchestrator/src/orchestrator.test.ts` — test that:
- `findOrCreateTicket` creates a new ticket in SQLite
- `findOrCreateTicket` returns existing ticket on second call
- Event routing resolves correct product from registry

**Step 4: Run tests**

```bash
cd orchestrator && bun test orchestrator.test.ts
```

**Step 5: Commit**

```bash
git add orchestrator/src/orchestrator.ts orchestrator/src/types.ts orchestrator/src/orchestrator.test.ts
git commit -m "feat: Orchestrator DO class with SQLite state and event routing"
```

---

## Task 4: Write TicketAgent DO class

**Files:**
- Create: `orchestrator/src/ticket-agent.ts`

**Step 1: Write TicketAgent DO**

`orchestrator/src/ticket-agent.ts`:

The TicketAgent extends `Container`. It:
- Initializes SQLite tables (`ticket`, `conversation`, `events`) on first access
- Exposes `handleEvent(event)` RPC method — stores event in SQLite, forwards to container via `getTcpPort()`
- Exposes `initialize(config)` RPC method — stores ticket config in SQLite (product, repos, secrets mapping, slack channel)
- `updateStatus(status, details)` — updates own SQLite, calls back to Orchestrator DO
- `getTicketConfig()` — reads from SQLite, used by `envVars` getter

Container config:
- `defaultPort = 3000`
- `sleepAfter = "4h"`
- `envVars` dynamically resolves product-specific secrets from `this.env` based on ticket config stored in SQLite

**Step 2: Write test for TicketAgent**

`orchestrator/src/ticket-agent.test.ts` — test that:
- `initialize()` stores config in SQLite
- `handleEvent()` stores event in SQLite
- `getTicketConfig()` returns stored config

**Step 3: Run tests**

```bash
cd orchestrator && bun test ticket-agent.test.ts
```

**Step 4: Commit**

```bash
git add orchestrator/src/ticket-agent.ts orchestrator/src/ticket-agent.test.ts
git commit -m "feat: TicketAgent DO class with SQLite state and event handling"
```

---

## Task 5: Rewrite Worker entry point (index.ts)

**Files:**
- Rewrite: `orchestrator/src/index.ts`
- Delete: `orchestrator/src/dispatch.ts`
- Delete: `orchestrator/src/sandbox.ts`
- Delete: `orchestrator/src/slack-commands.ts`

**Step 1: Rewrite index.ts**

The new `index.ts` is a thin stateless Worker that:
- Exports the Orchestrator and TicketAgent DO classes
- Handles `fetch` by verifying webhook signatures (reusing existing logic from `linear-webhook.ts` and `github-webhook.ts`)
- Proxies all verified events to the Orchestrator DO singleton: `env.ORCHESTRATOR.get(env.ORCHESTRATOR.idFromName("main"))`
- Health check at `/health` stays in the Worker (no need to proxy)
- No queue consumer — removed entirely

Key routes:
- `GET /health` — Worker-level health check
- `POST /api/webhooks/linear` — verify Linear HMAC, parse payload, proxy to Orchestrator
- `POST /api/webhooks/github` — verify GitHub HMAC, parse payload, proxy to Orchestrator
- `POST /api/dispatch` — verify API key, proxy to Orchestrator

**Step 2: Adapt linear-webhook.ts**

Keep the HMAC verification and payload parsing. Change the dispatch from `queue.send()` to returning a typed `TicketEvent` object. The Worker calls `orchestrator.fetch()` with the event.

**Step 3: Adapt github-webhook.ts**

Same pattern — keep verification, return typed event. The Worker proxies to Orchestrator.

**Step 4: Delete old files**

```bash
git rm orchestrator/src/dispatch.ts orchestrator/src/sandbox.ts orchestrator/src/slack-commands.ts
```

**Step 5: Run tests**

```bash
cd orchestrator && bun test
```

**Step 6: Commit**

```bash
git add orchestrator/src/index.ts orchestrator/src/linear-webhook.ts orchestrator/src/github-webhook.ts
git commit -m "feat: rewrite Worker entry point to proxy events to Orchestrator DO"
```

---

## Task 6: Orchestrator container — Slack Socket Mode listener

**Files:**
- Create: `containers/orchestrator/index.ts`
- Create: `containers/orchestrator/slack-socket.ts`

**Step 1: Write Slack Socket Mode client**

`containers/orchestrator/slack-socket.ts`:

A class that:
- Calls `apps.connections.open` with the `SLACK_APP_TOKEN` to get a WebSocket URL
- Opens a WebSocket to Slack
- Handles `app_mention` and `message` events
- On event, POSTs to `http://localhost:3000/slack/event` (the orchestrator DO)
- Auto-reconnects on close/error with exponential backoff
- Acknowledges envelopes by sending `{ envelope_id }` back

**Step 2: Write HTTP server**

`containers/orchestrator/index.ts`:

Bun HTTP server on port 3000 that:
- `POST /slack/event` — receives events from the Socket Mode client, forwards to DO's fetch
- `GET /health` — container health check
- On startup, creates a SlackSocket instance and connects

Wait — the container process and the DO are on the same port. The DO's `fetch()` receives external requests (from the Worker). The container listens on `defaultPort` and the DO communicates with it via `getTcpPort()`. But in this case, the container IS the one that needs to communicate with the DO, not the other way around.

Actually, for the orchestrator: the container maintains the Slack WebSocket and receives events. It needs to send those events to the DO for routing. The DO's `fetch()` is called by the Worker for webhooks. The container can also call the DO's fetch via the internal URL.

Revised approach: The container calls the DO's fetch with Slack events at the same path structure (`/slack/event`). The DO's `fetch()` handler processes both external webhooks (from Worker) and internal Slack events (from container).

**Step 3: Install dependencies**

```bash
cd containers/orchestrator && bun install
```

**Step 4: Commit**

```bash
git add containers/orchestrator/
git commit -m "feat: orchestrator container with Slack Socket Mode listener"
```

---

## Task 7: Agent container — long-lived HTTP server wrapping Agent SDK

**Files:**
- Create: `agent/src/server.ts`
- Rewrite: `agent/src/index.ts` (becomes re-export of server)
- Modify: `agent/src/config.ts` (env vars come from container, not sandbox injection)
- Modify: `agent/src/tools.ts` (update_status calls DO via localhost instead of orchestrator HTTP API)
- Delete: `agent/src/slack-listener.ts`

**Step 1: Write server.ts**

`agent/src/server.ts`:

Bun HTTP server on port 3000 that:
- `POST /event` — receives events from the TicketAgent DO
- `GET /health` — container health check
- `POST /status` — receives status update confirmations from DO

On first `/event`, the server:
1. Reads env vars (PRODUCT, REPOS, GITHUB_TOKEN, etc.)
2. Clones repos into `/workspace/`
3. Sets up git auth (`.netrc`)
4. Creates a Claude Agent SDK `query()` session with an async generator
5. Yields the initial prompt as the first user message

On subsequent `/event`, the server:
1. Parses the event (PR review, CI status, Slack reply, etc.)
2. Formats it as a user message
3. Yields it into the generator (the Agent SDK session continues)

The async generator pattern is already used in the current `agent/src/index.ts` (lines 52-88). Adapt it to be event-driven instead of one-shot.

**Step 2: Adapt tools.ts**

Change `update_task_status` tool to POST to `http://localhost:3000/status-callback` (the DO's container port) instead of the orchestrator HTTP API. The DO handles the status update and notifies the orchestrator.

Remove `SLACK_APP_TOKEN` from config since Socket Mode is now in the orchestrator.

**Step 3: Adapt config.ts**

Remove `slackAppToken` field. Add `ticketId` field (passed by DO as env var).

**Step 4: Delete slack-listener.ts**

```bash
git rm agent/src/slack-listener.ts
```

**Step 5: Run tests**

```bash
cd agent && bun test
```

**Step 6: Commit**

```bash
git add agent/src/
git commit -m "feat: agent HTTP server wrapping Claude Agent SDK for long-lived sessions"
```

---

## Task 8: Integration test — deploy and verify

**Step 1: Install all dependencies**

```bash
cd orchestrator && bun install
cd ../containers/orchestrator && bun install
cd ../../agent && bun install
```

**Step 2: Run all tests**

```bash
cd orchestrator && bun test
cd ../agent && bun test
```

**Step 3: Deploy**

```bash
cd orchestrator && npx wrangler deploy
```

If two container classes hit quota issues, fallback: merge into single container class (see design doc).

**Step 4: Verify health**

```bash
curl https://product-engineer.fryanpan.workers.dev/health
```

**Step 5: Verify Slack Socket Mode connects**

```bash
cd orchestrator && npx wrangler tail --format pretty
```

Look for orchestrator container startup logs and Slack WebSocket connection.

**Step 6: End-to-end test — create a Linear issue**

Create a test issue in Linear → verify webhook fires → orchestrator creates TicketAgent → agent posts to Slack.

**Step 7: Commit any fixes**

```bash
git add -A && git commit -m "fix: integration fixes from end-to-end testing"
```

---

## Task 9: Update CI workflow and setup scripts

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `scripts/setup-secrets.sh` (remove queue-related notes, add container notes)
- Modify: `CLAUDE.md` (update architecture description)

**Step 1: Update deploy workflow**

The CI needs Docker to build two container images. Update `.github/workflows/deploy.yml` to ensure Docker is available and both containers build.

**Step 2: Update setup scripts**

Remove references to `pe-tasks` queue. Update architecture notes.

**Step 3: Update CLAUDE.md**

Update the architecture description to reflect persistent agents.

**Step 4: Commit**

```bash
git add .github/ scripts/ CLAUDE.md
git commit -m "docs: update CI, setup scripts, and CLAUDE.md for persistent agent architecture"
```

---

## Task Order and Dependencies

```
Task 1 (scaffold) ──→ Task 2 (wrangler) ──→ Task 3 (Orchestrator DO) ──┐
                                             Task 4 (TicketAgent DO) ───┤
                                                                        ├──→ Task 5 (Worker entry) ──→ Task 8 (integration)
Task 6 (orchestrator container) ────────────────────────────────────────┤
Task 7 (agent container) ──────────────────────────────────────────────┘
                                                                        Task 9 (CI/docs) after Task 8
```

**Parallelizable:** Tasks 3+4 (both DOs), Tasks 6+7 (both containers) can run in parallel once Tasks 1+2 are done.
