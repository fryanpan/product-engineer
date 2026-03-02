# Persistent Agent Architecture — Design Plan

## Context

The current Product Engineer system uses one-shot containers: webhook arrives → queue → fresh container → agent runs → container destroyed. This doesn't support:
- Slack listening (no always-on process to maintain Socket Mode WebSocket)
- Ticket lifecycle tracking (agent can't respond to review comments, CI status, or deploy events)
- Agent continuity (each invocation starts from scratch with no memory)

The redesign makes two components long-lived:
1. **Orchestrator** — always-on singleton DO + container. Maintains Slack Socket Mode, receives all webhooks, routes events to per-ticket agents.
2. **Per-ticket agents** — one DO + container per active ticket. Stays alive through the full lifecycle: creation → implementation → PR → review → revision → merge → deploy → close.

## Architecture

```
Webhooks (Linear, GitHub)     Slack Socket Mode (WebSocket)
         │                            │
         v                            v
┌──────────────────────────────────────────────┐
│         Worker (stateless fetch handler)      │
│  - Verifies webhook signatures                │
│  - Proxies all events to Orchestrator DO      │
└──────────────────┬───────────────────────────┘
                   │
                   v
┌──────────────────────────────────────────────┐
│       Orchestrator DO (singleton)             │
│  Container: Slack Socket Mode listener        │
│  SQLite: tickets, event log                   │
│  Routes events to per-ticket agents via RPC   │
└──────┬───────────┬───────────┬───────────────┘
       │           │           │
       v           v           v
   ┌──────┐   ┌──────┐   ┌──────┐
   │TA #1 │   │TA #2 │   │TA #3 │  Per-ticket TicketAgent DOs
   │ DO+C │   │ DO+C │   │ DO+C │  Each has own container + SQLite
   │Claude │   │Claude │   │Claude│  Runs Agent SDK, full lifecycle
   └──────┘   └──────┘   └──────┘
```

## Wrangler Config

Two `[[containers]]` blocks, two DO classes. **No queue** — orchestrator dispatches directly via DO RPC (simpler, faster, gives orchestrator a handle to the agent for future events).

```toml
name = "product-engineer"
main = "src/index.ts"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

# Orchestrator — always-on, Slack Socket Mode, event routing
[[containers]]
class_name = "Orchestrator"
image = "./containers/orchestrator"
instance_type = "lite"
max_instances = 1

# Per-ticket agents — one per active ticket, runs Claude Agent SDK
[[containers]]
class_name = "TicketAgent"
image = "./containers/agent"
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

**Note:** There's a [reported issue](https://github.com/cloudflare/workerd/issues/4864) with multiple container classes hitting quota limits. If this blocks us, fallback is a single container class with both orchestrator and agent logic, differentiated by env var.

## Orchestrator DO

Singleton DO accessed via `env.ORCHESTRATOR.idFromName("main")`. Extends `Container` from `@cloudflare/containers`.

**Responsibilities:**
- Maintain Slack Socket Mode WebSocket (in container process)
- Receive webhooks (proxied by Worker fetch handler)
- Route events to per-ticket TicketAgent DOs via RPC
- Track active tickets in SQLite
- Log all events for debugging

**Container process** (`containers/orchestrator/`): Small Bun HTTP server + Slack Socket Mode client.
- Opens WebSocket to Slack via `apps.connections.open`
- On Slack event (app_mention): POST to DO via localhost
- Auto-reconnects on disconnect

**DO class (sketch):**
```typescript
export class Orchestrator extends Container {
  defaultPort = 3000;
  // No sleepAfter — always on

  get envVars() {
    return {
      SLACK_APP_TOKEN: this.env.SLACK_APP_TOKEN,
      SLACK_BOT_TOKEN: this.env.SLACK_BOT_TOKEN,
    };
  }

  async fetch(request: Request): Promise<Response> {
    // Route based on path: /linear, /github, /slack, /health
    // Identify product + ticket → routeToAgent()
  }

  async routeToAgent(ticketId: string, event: TicketEvent) {
    const id = this.env.TICKET_AGENT.idFromName(ticketId);
    const agent = this.env.TICKET_AGENT.get(id);
    await agent.handleEvent(event);
  }
}
```

**SQLite schema:**
```sql
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  slack_thread_ts TEXT,
  slack_channel TEXT,
  pr_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT,
  source TEXT NOT NULL,         -- "linear", "github", "slack", "api"
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

## Per-Ticket Agent DO (TicketAgent)

One instance per ticket, identified by `idFromName(ticketId)`. Extends `Container`.

**Container process** (`containers/agent/`): Bun HTTP server + Claude Agent SDK session.
- Listens on `defaultPort` for events from orchestrator DO
- Maintains a long-lived Claude Agent SDK `query()` session using `generateMessages()` async generator
- Each incoming event is yielded as a new user message into the session
- Agent tools (notify_slack, update_status) call back to DO via localhost
- On cold start (container wake from sleep), re-clones repo and rebuilds session from SQLite conversation history

**DO class (sketch):**
```typescript
export class TicketAgent extends Container {
  defaultPort = 3000;
  sleepAfter = "4h";

  get envVars() {
    const config = this.getTicketConfig(); // from SQLite
    return {
      ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
      GITHUB_TOKEN: this.env[config.secrets.GITHUB_TOKEN],
      SLACK_BOT_TOKEN: this.env.SLACK_BOT_TOKEN,
      PRODUCT: config.product,
      REPOS: JSON.stringify(config.repos),
      SLACK_CHANNEL: config.slack_channel,
    };
  }

  // Called by orchestrator via RPC
  async handleEvent(event: TicketEvent) {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (event_type, payload) VALUES (?, ?)",
      event.type, JSON.stringify(event.payload)
    );
    const port = this.ctx.container.getTcpPort(this.defaultPort);
    await port.fetch("http://localhost/event", {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  // Called by container process to update status
  async updateStatus(status: string, details: object) {
    this.ctx.storage.sql.exec("UPDATE ticket SET status = ? ...", status);
    // Notify orchestrator
    const orch = this.env.ORCHESTRATOR.get(
      this.env.ORCHESTRATOR.idFromName("main")
    );
    await orch.updateTicketStatus(this.ticketId, status, details);
  }
}
```

**SQLite schema:**
```sql
CREATE TABLE ticket (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  title TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  slack_thread_ts TEXT,
  pr_url TEXT,
  branch_name TEXT
);

CREATE TABLE conversation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,          -- JSON message content
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT,
  processed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

## Ticket Lifecycle State Machine

```
created → in_progress → pr_open → in_review → merged → closed
                │                    │    ↑
                │                    v    │
                │              needs_revision
                │
                ├→ deferred → closed
                └→ failed → closed
```

## Event Routing Table

| Source | Event | Orchestrator Action |
|--------|-------|-------------------|
| Linear | Issue created/updated | Find or create TicketAgent, forward event |
| GitHub | PR review submitted | Look up ticket by PR URL, forward to agent |
| GitHub | PR merged | Look up ticket, forward `pr_merged` event |
| GitHub | CI status change | Look up ticket by branch, forward to agent |
| Slack | @product-engineer mention | Identify product from channel, create ticket + agent |
| Slack | Thread reply to agent | Forward to agent owning that thread |
| API | POST /api/dispatch | Create ticket + agent |

## Container Images

**`containers/orchestrator/Dockerfile`** — Slack listener + HTTP server:
```dockerfile
FROM oven/bun:latest
COPY containers/orchestrator/ /app/
WORKDIR /app
RUN bun install
CMD ["bun", "run", "index.ts"]
```

**`containers/agent/Dockerfile`** — Agent SDK runtime with git/gh:
```dockerfile
FROM oven/bun:latest
RUN apt-get update && apt-get install -y git curl && <gh CLI install>
COPY agent/ /app/agent/
WORKDIR /app/agent
RUN bun install
CMD ["bun", "run", "server.ts"]
```

## Files to Change

| File | Action | Description |
|------|--------|-------------|
| `orchestrator/wrangler.toml` | Rewrite | Two containers, two DOs, remove queue |
| `orchestrator/src/index.ts` | Rewrite | Stateless fetch → proxy to Orchestrator DO |
| `orchestrator/src/orchestrator.ts` | **New** | Orchestrator DO class (extends Container) |
| `orchestrator/src/ticket-agent.ts` | **New** | TicketAgent DO class (extends Container) |
| `orchestrator/src/sandbox.ts` | Delete | Replaced by TicketAgent DO |
| `orchestrator/src/dispatch.ts` | Delete | Replaced by orchestrator routing |
| `orchestrator/src/linear-webhook.ts` | Adapt | Keep verification, change dispatch target |
| `orchestrator/src/github-webhook.ts` | Adapt | Keep verification, change dispatch target |
| `orchestrator/src/slack-commands.ts` | Delete | Slack via Socket Mode in orchestrator container |
| `orchestrator/src/registry.ts` | Keep | Product routing stays |
| `containers/orchestrator/index.ts` | **New** | Slack Socket Mode + HTTP server |
| `containers/orchestrator/Dockerfile` | **New** | Orchestrator container image |
| `containers/agent/Dockerfile` | **New** | Agent container image (adapted from current Dockerfile) |
| `agent/src/index.ts` | Rewrite | One-shot → long-lived event-driven server |
| `agent/src/server.ts` | **New** | HTTP server wrapping Agent SDK session |
| `agent/src/slack-listener.ts` | Delete | Slack listening moves to orchestrator |
| `Dockerfile` | Delete | Replaced by `containers/agent/Dockerfile` |

## What Stays the Same

- **English skills define behavior.** SKILL.md drives agent decisions. `settingSources: ["project"]` loads skills from the target repo.
- **Registry pattern.** Products → repos, channels, secrets, triggers.
- **Webhook verification.** Linear/GitHub HMAC verification logic stays.
- **Agent tools.** notify_slack, ask_question, update_task_status — backends change but interfaces stay.

## Verification

1. `curl https://product-engineer.fryanpan.workers.dev/health` — Worker responds
2. `wrangler tail` — Verify orchestrator container starts, Slack Socket Mode connects
3. Create a Linear issue → webhook fires → orchestrator creates TicketAgent → agent posts to Slack
4. @product-engineer in #health-tool → orchestrator routes → new agent spawned
5. Agent creates PR → submit review comment → agent responds to review
6. Wait 4h+ → send new event → verify agent wakes from sleep with context
