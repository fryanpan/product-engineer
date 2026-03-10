# Unified Persistent Agent — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the one-shot queue-based architecture with persistent Orchestrator DO + per-ticket TicketAgent containers. Linear tickets, GitHub events, and Slack mentions all route through the Orchestrator to long-lived agents.

**Architecture:** Stateless Worker verifies webhooks and proxies to singleton Orchestrator DO. Orchestrator maintains Slack Socket Mode (in its container), tracks tickets in SQLite, and routes events to per-ticket TicketAgent containers via RPC. Each TicketAgent runs Claude Agent SDK in a long-lived HTTP server, receives events from the Orchestrator, and stays alive for 4 days between events.

**Tech Stack:** Cloudflare Workers + Containers (`@cloudflare/containers`), Durable Objects, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Hono, Bun, TypeScript, Sentry (`@sentry/cloudflare`).

**Design doc:** `docs/product/plans/2026-03-01-unified-persistent-agent-design.md`

---

## Task 1: Scaffold container directories, update config, shared types

**Files:**
- Create: `containers/orchestrator/Dockerfile`
- Create: `containers/orchestrator/package.json`
- Create: `containers/agent/Dockerfile`
- Create: `orchestrator/src/types.ts`
- Modify: `orchestrator/wrangler.toml`
- Modify: `orchestrator/package.json`
- Delete: `Dockerfile` (root)

**Step 1: Create container directories**

```bash
mkdir -p containers/orchestrator containers/agent
```

**Step 2: Write orchestrator container Dockerfile**

`containers/orchestrator/Dockerfile`:
```dockerfile
FROM oven/bun:latest
COPY containers/orchestrator/ /app/
WORKDIR /app
RUN bun install
CMD ["bun", "run", "index.ts"]
```

**Step 3: Write orchestrator container package.json**

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

**Step 4: Write agent container Dockerfile**

Adapted from root `Dockerfile`. Key change: entrypoint is `server.ts` (long-lived HTTP server), not `index.ts` (one-shot).

`containers/agent/Dockerfile`:
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
CMD ["bun", "run", "src/server.ts"]
```

**Step 5: Write shared types**

`orchestrator/src/types.ts`:
```typescript
export interface TicketEvent {
  type: string;       // "ticket_created", "ticket_updated", "pr_review", "pr_merged", "ci_status", "slack_mention", "slack_reply"
  source: string;     // "linear", "github", "slack", "api"
  ticketId: string;
  product: string;
  payload: unknown;
  slackThreadTs?: string;
  slackChannel?: string;
}

export interface TicketRecord {
  id: string;
  product: string;
  status: string;
  slack_thread_ts: string | null;
  slack_channel: string | null;
  pr_url: string | null;
  branch_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface TicketAgentConfig {
  ticketId: string;
  product: string;
  repos: string[];
  slackChannel: string;
  secrets: Record<string, string>; // logical name → binding name
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

  // Per-product GitHub tokens
  HEALTH_TOOL_GITHUB_TOKEN: string;
  BIKE_TOOL_GITHUB_TOKEN: string;

  [key: string]: unknown;
}
```

**Step 6: Rewrite wrangler.toml**

Replace entire `orchestrator/wrangler.toml`:
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

**Note:** There's a [known issue](https://github.com/cloudflare/workerd/issues/4864) with multiple container classes. If this blocks deployment, the fallback is a single container class with role determined by env var. Cross that bridge when we get to it.

**Step 7: Update orchestrator dependencies**

```bash
cd orchestrator && bun remove @cloudflare/sandbox && bun add @cloudflare/containers @sentry/cloudflare
```

**Step 8: Delete root Dockerfile**

```bash
git rm Dockerfile
```

**Step 9: Commit**

```bash
git add containers/ orchestrator/wrangler.toml orchestrator/package.json orchestrator/bun.lockb orchestrator/src/types.ts
git commit -m "scaffold: container directories, wrangler config, shared types for persistent architecture"
```

---

## Task 2: Orchestrator DO class

**Files:**
- Create: `orchestrator/src/orchestrator.ts`
- Create: `orchestrator/src/orchestrator.test.ts`

The Orchestrator extends `Container` from `@cloudflare/containers`. It owns all persistent state (tickets table). Its container runs the Slack Socket Mode listener (Task 5).

**Step 1: Write the test**

`orchestrator/src/orchestrator.test.ts`:

Test the pure logic functions extracted from the Orchestrator: `findOrCreateTicket`, `lookupTicketByPrUrl`, `lookupTicketByBranch`, `updateTicketStatus`. Since DO SQLite can't be directly unit-tested without miniflare, test the SQL logic via a mock or test the helper functions that format/parse data.

```typescript
import { describe, test, expect } from "bun:test";
import { buildTicketEvent } from "./orchestrator";

describe("buildTicketEvent", () => {
  test("creates event from Linear webhook data", () => {
    const event = buildTicketEvent("linear", "ticket_created", {
      id: "LIN-123",
      product: "health-tool",
      title: "Fix login",
      description: "Login is broken",
    });
    expect(event.type).toBe("ticket_created");
    expect(event.source).toBe("linear");
    expect(event.ticketId).toBe("LIN-123");
    expect(event.product).toBe("health-tool");
  });

  test("creates event from GitHub PR review", () => {
    const event = buildTicketEvent("github", "pr_review", {
      ticketId: "LIN-123",
      product: "health-tool",
      review: { state: "changes_requested", body: "Fix the types" },
    });
    expect(event.type).toBe("pr_review");
    expect(event.source).toBe("github");
  });

  test("creates event from Slack mention", () => {
    const event = buildTicketEvent("slack", "slack_mention", {
      product: "health-tool",
      text: "fix the login bug",
      user: "U12345",
      channel: "C12345",
      threadTs: "1234567890.123456",
    });
    expect(event.type).toBe("slack_mention");
    expect(event.slackThreadTs).toBe("1234567890.123456");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd orchestrator && bun test orchestrator.test.ts
```

Expected: FAIL — `buildTicketEvent` not found.

**Step 3: Write Orchestrator DO class**

`orchestrator/src/orchestrator.ts`:

```typescript
import { Container } from "@cloudflare/containers";
import { getProduct } from "./registry";
import type { TicketEvent, TicketRecord, TicketAgentConfig, Bindings } from "./types";

// Pure helper — exported for testing
export function buildTicketEvent(
  source: string,
  type: string,
  data: Record<string, unknown>,
): TicketEvent {
  return {
    type,
    source,
    ticketId: (data.ticketId || data.id || `${source}-${Date.now()}`) as string,
    product: data.product as string,
    payload: data,
    slackThreadTs: data.threadTs as string | undefined,
    slackChannel: data.channel as string | undefined,
  };
}

export class Orchestrator extends Container<Bindings> {
  defaultPort = 3000;
  // No sleepAfter — always on

  private dbInitialized = false;

  get envVars() {
    return {
      SLACK_APP_TOKEN: this.env.SLACK_APP_TOKEN,
      SLACK_BOT_TOKEN: this.env.SLACK_BOT_TOKEN,
    };
  }

  private initDb() {
    if (this.dbInitialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        product TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        slack_thread_ts TEXT,
        slack_channel TEXT,
        pr_url TEXT,
        branch_name TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.dbInitialized = true;
  }

  async fetch(request: Request): Promise<Response> {
    this.initDb();
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/event":
        return this.handleEvent(request);
      case "/health":
        return Response.json({ ok: true, service: "orchestrator-do" });
      case "/tickets":
        return this.listTickets();
      case "/ticket/status":
        return this.handleStatusUpdate(request);
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  private async handleEvent(request: Request): Promise<Response> {
    const event = await request.json<TicketEvent>();

    // Upsert ticket
    this.ctx.storage.sql.exec(
      `INSERT INTO tickets (id, product, slack_thread_ts, slack_channel)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')`,
      event.ticketId,
      event.product,
      event.slackThreadTs || null,
      event.slackChannel || null,
    );

    // Route to TicketAgent
    await this.routeToAgent(event);

    return Response.json({ ok: true, ticketId: event.ticketId });
  }

  private async routeToAgent(event: TicketEvent) {
    const productConfig = getProduct(event.product);
    if (!productConfig) {
      console.error(`[Orchestrator] Unknown product: ${event.product}`);
      return;
    }

    const id = this.env.TICKET_AGENT.idFromName(event.ticketId);
    const agent = this.env.TICKET_AGENT.get(id) as DurableObjectStub;

    // Initialize agent config (idempotent — agent stores in SQLite)
    const config: TicketAgentConfig = {
      ticketId: event.ticketId,
      product: event.product,
      repos: productConfig.repos,
      slackChannel: productConfig.slack_channel,
      secrets: productConfig.secrets,
    };

    await agent.fetch(new Request("http://internal/initialize", {
      method: "POST",
      body: JSON.stringify(config),
    }));

    // Forward the event
    await agent.fetch(new Request("http://internal/event", {
      method: "POST",
      body: JSON.stringify(event),
    }));
  }

  private async handleStatusUpdate(request: Request): Promise<Response> {
    const { ticketId, status, pr_url, branch_name } = await request.json<{
      ticketId: string;
      status: string;
      pr_url?: string;
      branch_name?: string;
    }>();

    const updates: string[] = ["status = ?", "updated_at = datetime('now')"];
    const values: (string | null)[] = [status];

    if (pr_url) {
      updates.push("pr_url = ?");
      values.push(pr_url);
    }
    if (branch_name) {
      updates.push("branch_name = ?");
      values.push(branch_name);
    }

    values.push(ticketId);
    this.ctx.storage.sql.exec(
      `UPDATE tickets SET ${updates.join(", ")} WHERE id = ?`,
      ...values,
    );

    return Response.json({ ok: true });
  }

  private listTickets(): Response {
    const rows = this.ctx.storage.sql.exec(
      "SELECT * FROM tickets ORDER BY updated_at DESC LIMIT 50",
    ).toArray();
    return Response.json({ tickets: rows });
  }
}
```

**Step 4: Run tests**

```bash
cd orchestrator && bun test orchestrator.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add orchestrator/src/orchestrator.ts orchestrator/src/orchestrator.test.ts
git commit -m "feat: Orchestrator DO class with SQLite ticket tracking and event routing"
```

---

## Task 3: TicketAgent Container class

**Files:**
- Create: `orchestrator/src/ticket-agent.ts`
- Create: `orchestrator/src/ticket-agent.test.ts`

The TicketAgent extends `Container`. It stores minimal config in SQLite (one row — just enough for `envVars` to resolve secrets). Everything else is on the container's filesystem.

**Step 1: Write the test**

`orchestrator/src/ticket-agent.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { resolveAgentEnvVars } from "./ticket-agent";

describe("resolveAgentEnvVars", () => {
  test("resolves secrets from env bindings", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {
        GITHUB_TOKEN: "HEALTH_TOOL_GITHUB_TOKEN",
        ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      },
    };
    const env = {
      HEALTH_TOOL_GITHUB_TOKEN: "ghp_abc123",
      ANTHROPIC_API_KEY: "sk-ant-xyz",
      SLACK_BOT_TOKEN: "xoxb-slack",
    } as Record<string, string>;

    const vars = resolveAgentEnvVars(config, env);
    expect(vars.GITHUB_TOKEN).toBe("ghp_abc123");
    expect(vars.ANTHROPIC_API_KEY).toBe("sk-ant-xyz");
    expect(vars.PRODUCT).toBe("health-tool");
    expect(vars.REPOS).toBe(JSON.stringify(["fryanpan/health-tool"]));
    expect(vars.TICKET_ID).toBe("LIN-123");
    expect(vars.SLACK_CHANNEL).toBe("#health-tool");
    expect(vars.SLACK_BOT_TOKEN).toBe("xoxb-slack");
  });

  test("warns on missing secret binding", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {
        GITHUB_TOKEN: "MISSING_TOKEN",
      },
    };
    const env = {} as Record<string, string>;

    const vars = resolveAgentEnvVars(config, env);
    expect(vars.GITHUB_TOKEN).toBe("");
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd orchestrator && bun test ticket-agent.test.ts
```

Expected: FAIL — `resolveAgentEnvVars` not found.

**Step 3: Write TicketAgent class**

`orchestrator/src/ticket-agent.ts`:

```typescript
import { Container } from "@cloudflare/containers";
import type { TicketEvent, TicketAgentConfig, Bindings } from "./types";

// Pure helper — exported for testing
export function resolveAgentEnvVars(
  config: TicketAgentConfig,
  env: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {
    PRODUCT: config.product,
    TICKET_ID: config.ticketId,
    REPOS: JSON.stringify(config.repos),
    SLACK_CHANNEL: config.slackChannel,
    SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN || "",
  };

  for (const [logicalName, bindingName] of Object.entries(config.secrets)) {
    const value = env[bindingName];
    if (value) {
      vars[logicalName] = value;
    } else {
      console.warn(`[TicketAgent] Secret ${logicalName} (binding: ${bindingName}) not found`);
      vars[logicalName] = "";
    }
  }

  return vars;
}

export class TicketAgent extends Container<Bindings> {
  defaultPort = 3000;
  sleepAfter = "4d";

  private configLoaded = false;

  private initDb() {
    if (this.configLoaded) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.configLoaded = true;
  }

  private getConfig(): TicketAgentConfig | null {
    this.initDb();
    const row = this.ctx.storage.sql.exec(
      "SELECT value FROM config WHERE key = 'agent_config'"
    ).toArray()[0] as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  private setConfig(config: TicketAgentConfig) {
    this.initDb();
    this.ctx.storage.sql.exec(
      `INSERT INTO config (key, value) VALUES ('agent_config', ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`,
      JSON.stringify(config),
      JSON.stringify(config),
    );
  }

  get envVars() {
    const config = this.getConfig();
    if (!config) {
      // Config not yet initialized — container will get a /initialize call before /event
      return {};
    }
    return resolveAgentEnvVars(config, this.env as unknown as Record<string, string>);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/initialize": {
        const config = await request.json<TicketAgentConfig>();
        this.setConfig(config);
        return Response.json({ ok: true });
      }
      case "/event": {
        const event = await request.json<TicketEvent>();
        // Forward to the container process
        const port = this.ctx.container.getTcpPort(this.defaultPort);
        const res = await port.fetch("http://localhost/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
        });
        return res;
      }
      case "/health": {
        return Response.json({ ok: true, service: "ticket-agent-do" });
      }
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }
}
```

**Step 4: Run tests**

```bash
cd orchestrator && bun test ticket-agent.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add orchestrator/src/ticket-agent.ts orchestrator/src/ticket-agent.test.ts
git commit -m "feat: TicketAgent Container class with minimal config storage"
```

---

## Task 4: Rewrite Worker entry point

**Files:**
- Rewrite: `orchestrator/src/index.ts`
- Modify: `orchestrator/src/linear-webhook.ts` — change dispatch from queue to Orchestrator DO
- Modify: `orchestrator/src/github-webhook.ts` — change dispatch, add PR review event
- Delete: `orchestrator/src/dispatch.ts`
- Delete: `orchestrator/src/sandbox.ts`
- Delete: `orchestrator/src/slack-commands.ts`

The Worker is now a thin proxy. It verifies signatures, parses payloads, and forwards everything to the Orchestrator DO.

**Step 1: Rewrite index.ts**

`orchestrator/src/index.ts`:

```typescript
/**
 * Product Engineer Worker — stateless proxy to Orchestrator DO.
 *
 * Verifies webhook signatures. Proxies events to the singleton Orchestrator DO.
 * No queue, no sandbox launcher. All state lives in the Orchestrator.
 */

import { Hono } from "hono";
import { linearWebhook } from "./linear-webhook";
import { githubWebhook } from "./github-webhook";
import type { Bindings } from "./types";

// Export DO classes for wrangler
export { Orchestrator } from "./orchestrator";
export { TicketAgent } from "./ticket-agent";

const app = new Hono<{ Bindings: Bindings }>();

// Health check (Worker-level, no need to proxy)
app.get("/health", (c) => c.json({ ok: true, service: "product-engineer-worker" }));

// Webhook handlers — verify signatures, then proxy to Orchestrator DO
app.route("/api/webhooks/linear", linearWebhook);
app.route("/api/webhooks/github", githubWebhook);

// Dispatch API — programmatic trigger
app.post("/api/dispatch", async (c) => {
  const apiKey = c.req.header("X-API-Key");
  if (!apiKey || apiKey !== c.env.API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json<{
    product: string;
    type: string;
    data: unknown;
    slack_thread_ts?: string;
  }>();

  if (!body.product || !body.type || !body.data) {
    return c.json({ error: "Missing product, type, or data" }, 400);
  }

  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: body.type,
      source: "api",
      ticketId: (body.data as Record<string, unknown>).id || `api-${Date.now()}`,
      product: body.product,
      payload: body.data,
      slackThreadTs: body.slack_thread_ts,
    }),
  }));
});

// Orchestrator health/status (proxied to DO)
app.get("/api/orchestrator/tickets", async (c) => {
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/tickets"));
});

export function getOrchestrator(env: Bindings): DurableObjectStub {
  const id = env.ORCHESTRATOR.idFromName("main");
  return env.ORCHESTRATOR.get(id);
}

export default { fetch: app.fetch };
```

**Step 2: Adapt linear-webhook.ts**

Keep all HMAC verification logic. Change the dispatch from `env.TASK_QUEUE.send()` to forwarding to Orchestrator DO via `getOrchestrator(env)`. The key changes are:
- Import `getOrchestrator` from `./index` and `Bindings` from `./types` (not from `./index`)
- Replace `queue.send(taskMessage)` with `orchestrator.fetch()`
- Import `Bindings` from `./types` instead of `./index`

**Step 3: Adapt github-webhook.ts**

Keep HMAC verification. Add handling for `pull_request_review` events (not just merge). Change dispatch to Orchestrator DO. Key additions:
- On `pull_request` action `closed` + `merged`: look up ticket by branch, forward `pr_merged` event
- On `pull_request_review`: forward `pr_review` event so agent can respond to review comments

**Step 4: Delete old files**

```bash
git rm orchestrator/src/dispatch.ts orchestrator/src/sandbox.ts orchestrator/src/slack-commands.ts
```

**Step 5: Run existing tests to verify nothing breaks**

```bash
cd orchestrator && bun test
```

Fix any import issues. The `linear-webhook.test.ts` and `registry.test.ts` should still pass since we kept the verification logic and registry.

**Step 6: Commit**

```bash
git add orchestrator/src/
git commit -m "feat: rewrite Worker as stateless proxy to Orchestrator DO

Removed queue consumer, sandbox launcher, and Slack events handler.
Adapted Linear/GitHub webhook handlers to forward events to Orchestrator DO.
Added PR review event handling for persistent agent lifecycle."
```

---

## Task 5: Orchestrator container — Slack Socket Mode listener

**Files:**
- Create: `containers/orchestrator/index.ts`
- Create: `containers/orchestrator/slack-socket.ts`

This is the process that runs inside the Orchestrator's container. It maintains a Slack Socket Mode WebSocket and forwards events to the DO.

**Step 1: Write Slack Socket Mode client**

`containers/orchestrator/slack-socket.ts`:

Adapted from `agent/src/slack-listener.ts` but generalized:
- Calls `apps.connections.open` with `SLACK_APP_TOKEN`
- Opens WebSocket to Slack
- Handles `app_mention` events → forwards to DO
- Handles `message` events in threads → forwards to DO (for agent replies)
- Auto-reconnects with exponential backoff
- Acknowledges all envelopes

```typescript
interface SlackEnvelope {
  envelope_id: string;
  type: string;
  payload?: {
    event?: {
      type: string;
      text?: string;
      user?: string;
      channel?: string;
      thread_ts?: string;
      ts: string;
      bot_id?: string;
    };
  };
}

export class SlackSocket {
  private appToken: string;
  private onEvent: (event: SlackEnvelope["payload"]["event"] & {}) => void;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 60_000;

  constructor(
    appToken: string,
    onEvent: (event: NonNullable<SlackEnvelope["payload"]>["event"] & {}) => void,
  ) {
    this.appToken = appToken;
    this.onEvent = onEvent;
  }

  async connect(): Promise<void> {
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const data = await res.json() as { ok: boolean; url?: string; error?: string };
    if (!data.ok || !data.url) {
      throw new Error(`Slack Socket Mode error: ${data.error || "no URL"}`);
    }

    this.ws = new WebSocket(data.url);
    this.reconnectAttempts = 0;

    this.ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        ) as SlackEnvelope;

        // Acknowledge the envelope
        if (envelope.envelope_id) {
          this.ws?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        }

        // Forward relevant events
        const slackEvent = envelope.payload?.event;
        if (slackEvent && !slackEvent.bot_id) {
          if (slackEvent.type === "app_mention" || slackEvent.type === "message") {
            this.onEvent(slackEvent);
          }
        }
      } catch {
        // Ignore malformed messages
      }
    });

    this.ws.addEventListener("close", () => {
      console.log("[SlackSocket] Connection closed, reconnecting...");
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", (err) => {
      console.error("[SlackSocket] Error:", err);
    });

    console.log("[SlackSocket] Connected to Slack Socket Mode");
  }

  private scheduleReconnect() {
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    this.reconnectAttempts++;
    console.log(`[SlackSocket] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect().catch(console.error), delay);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}
```

**Step 2: Write HTTP server**

`containers/orchestrator/index.ts`:

The container process starts the Slack Socket Mode client and runs an HTTP server. The DO communicates with this container, and this container forwards Slack events back to the DO.

```typescript
import { Hono } from "hono";
import { SlackSocket } from "./slack-socket";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "orchestrator-container" }));

// Start Slack Socket Mode
const slackAppToken = process.env.SLACK_APP_TOKEN;
if (slackAppToken) {
  const socket = new SlackSocket(slackAppToken, async (event) => {
    // Forward Slack events to the DO's fetch handler
    // The container can reach the DO at the defaultPort via the internal network
    // But actually — the container IS inside the DO. Events need to go back to
    // the DO for routing. The DO's fetch is the external interface.
    // We POST to stdout/log and let the DO handle it via its own mechanisms.
    //
    // Actually: the Orchestrator DO's fetch() is called by the Worker.
    // The container process needs a way to send events to the DO.
    // In Cloudflare Containers, the container can make HTTP requests to
    // the DO via the internal port. But the DO IS the container's parent.
    //
    // The pattern: container → POST to localhost:DO_PORT → DO.fetch() handles it.
    // But the container's port IS the defaultPort. The DO exposes the container
    // on defaultPort to the outside. Internal communication goes the other way.
    //
    // Alternative: the container writes events to a file or stdout, and the DO
    // polls. But that's ugly.
    //
    // Simplest approach: the container makes an HTTP request to the Worker's
    // public URL, which proxies to the Orchestrator DO. This adds a hop but
    // is simple and reliable.
    //
    // Even simpler: store events in a queue (array) and have the DO poll
    // via getTcpPort().fetch("/events") periodically. But that adds latency.
    //
    // Best approach for v1: the container calls the Worker's public endpoint
    // at /api/webhooks/slack/socket-event, which proxies to the Orchestrator DO.
    // The Worker URL is injected as an env var.
    try {
      console.log(`[Orchestrator Container] Slack event: ${event.type} from ${event.user || "unknown"}`);

      // Forward to DO via the Worker's public endpoint
      // Note: WORKER_URL env var needs to be added to envVars in orchestrator.ts
      const workerUrl = process.env.WORKER_URL || "https://product-engineer.fryanpan.workers.dev";
      await fetch(`${workerUrl}/api/internal/slack-event`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": process.env.SLACK_APP_TOKEN || "", // reuse as internal auth
        },
        body: JSON.stringify(event),
      });
    } catch (err) {
      console.error("[Orchestrator Container] Failed to forward Slack event:", err);
    }
  });

  socket.connect().catch((err) => {
    console.error("[Orchestrator Container] Failed to start Socket Mode:", err);
  });
} else {
  console.warn("[Orchestrator Container] No SLACK_APP_TOKEN — Socket Mode disabled");
}

export default {
  port: 3000,
  fetch: app.fetch,
};
```

**Step 3: Add the internal Slack event route to the Worker**

In `orchestrator/src/index.ts`, add:

```typescript
// Internal: Slack events from the orchestrator container's Socket Mode
app.post("/api/internal/slack-event", async (c) => {
  // Basic auth — reuse app token as internal key
  const key = c.req.header("X-Internal-Key");
  if (!key || key !== c.env.SLACK_APP_TOKEN) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const event = await c.req.json<{
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    thread_ts?: string;
    ts: string;
  }>();

  // Determine product from channel or message text (reuse logic from old slack-commands.ts)
  // ... route to orchestrator DO
  const orchestrator = getOrchestrator(c.env);
  return orchestrator.fetch(new Request("http://internal/slack-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }));
});
```

Also add a `/slack-event` handler to the Orchestrator DO's `fetch()` to handle routing Slack events to the right TicketAgent (by channel → product lookup, or by thread_ts → existing ticket lookup).

**Step 4: Install orchestrator container dependencies**

```bash
cd containers/orchestrator && bun install
```

**Step 5: Commit**

```bash
git add containers/orchestrator/ orchestrator/src/index.ts orchestrator/src/orchestrator.ts
git commit -m "feat: orchestrator container with Slack Socket Mode listener

Container maintains persistent WebSocket to Slack. Events forwarded to
Orchestrator DO via Worker's internal endpoint for routing to agents."
```

---

## Task 6: Agent server — long-lived HTTP wrapper for Agent SDK

**Files:**
- Create: `agent/src/server.ts`
- Rewrite: `agent/src/index.ts` (re-export server)
- Modify: `agent/src/config.ts` (remove slackAppToken, add ticketId)
- Modify: `agent/src/tools.ts` (status updates use DO callback)
- Modify: `agent/src/prompt.ts` (add event-continuation prompts)
- Delete: `agent/src/slack-listener.ts`

The agent server is a Bun HTTP server that wraps the Claude Agent SDK. On the first `/event`, it clones repos, creates the Agent SDK session, and processes the task. On subsequent `/event` calls, it yields new messages into the session.

**Step 1: Update config.ts**

Remove `slackAppToken` field. Add `ticketId`. Remove `slackThreadTs` (now comes per-event). Remove `orchestratorUrl` and `orchestratorApiKey` (status updates go through DO, not HTTP API).

```typescript
export interface AgentConfig {
  taskPayload: TaskPayload | null;  // null on cold start before first event
  ticketId: string;
  product: string;
  repos: string[];
  anthropicApiKey: string;
  githubToken: string;
  slackBotToken: string;
  slackChannel: string;
  linearApiKey: string;
}

export function loadConfig(): AgentConfig {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) throw new Error(`Missing required env var: ${name}`);
    return val;
  };

  return {
    taskPayload: null, // Set by first event
    ticketId: required("TICKET_ID"),
    product: required("PRODUCT"),
    repos: JSON.parse(required("REPOS")),
    anthropicApiKey: required("ANTHROPIC_API_KEY"),
    githubToken: required("GITHUB_TOKEN"),
    slackBotToken: required("SLACK_BOT_TOKEN"),
    slackChannel: process.env.SLACK_CHANNEL || "#general",
    linearApiKey: process.env.LINEAR_API_KEY || "",
  };
}
```

**Step 2: Update tools.ts**

Remove the `orchestratorUrl`/`orchestratorApiKey` dependency from `update_task_status`. The agent's status updates now go through the DO — the server.ts will handle forwarding. For v1, keep `update_task_status` calling a local callback URL (the server itself), which forwards to the DO.

Also: `ask_question` now posts to Slack with the current event's `slackThreadTs` (passed as context to the tool). The reply comes as a new `/event` from the Orchestrator (which received it via Socket Mode).

**Step 3: Write server.ts**

`agent/src/server.ts`:

```typescript
import { Hono } from "hono";
import {
  query,
  createSdkMcpServer,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, type AgentConfig } from "./config";
import { createTools } from "./tools";
import { buildPrompt, buildEventPrompt } from "./prompt";
import type { TicketEvent } from "./types";

function userMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  };
}

const app = new Hono();
const config = loadConfig();

// State for the long-lived Agent SDK session
let sessionActive = false;
let messageYielder: ((msg: SDKUserMessage) => void) | null = null;
let repoCloned = false;

// Set up the async generator that feeds messages to the Agent SDK
function createMessageGenerator(): AsyncGenerator<SDKUserMessage> {
  const queue: SDKUserMessage[] = [];
  let resolve: (() => void) | null = null;

  messageYielder = (msg: SDKUserMessage) => {
    queue.push(msg);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  };

  return (async function* () {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      await new Promise<void>((r) => { resolve = r; });
    }
  })();
}

async function cloneRepos() {
  if (repoCloned) return;

  // Set up git auth
  const netrc = `machine github.com\nlogin x-access-token\npassword ${config.githubToken}\n`;
  await Bun.write("/root/.netrc", netrc);
  const chmod = Bun.spawn(["chmod", "600", "/root/.netrc"]);
  await chmod.exited;

  // Clone repos
  for (const repo of config.repos) {
    const repoName = repo.split("/").pop()!;
    console.log(`[Agent] Cloning ${repo}...`);
    const proc = Bun.spawn(["git", "clone", `https://github.com/${repo}.git`, `/workspace/${repoName}`]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Failed to clone ${repo}: exit code ${exitCode}`);
    }
  }

  repoCloned = true;
  console.log("[Agent] Repos cloned");
}

async function startSession(initialPrompt: string) {
  if (sessionActive) return;
  sessionActive = true;

  const { tools } = createTools(config);
  const toolServer = createSdkMcpServer({ name: "pe-tools", tools });
  const messages = createMessageGenerator();

  // Yield the initial prompt
  messageYielder!(userMessage(initialPrompt));

  // Start the Agent SDK session (runs in background)
  const session = query({
    prompt: messages,
    options: {
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],
      maxTurns: 200,  // High limit for long-lived sessions
      permissionMode: "acceptEdits",
      mcpServers: { "pe-tools": toolServer },
    },
  });

  // Process messages in background
  (async () => {
    try {
      for await (const message of session) {
        if (message.type === "assistant" && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === "text") {
              console.log(`[Agent] ${block.text.slice(0, 200)}`);
            }
            if (block.type === "tool_use") {
              console.log(`[Agent] Tool: ${block.name}`);
            }
          }
        }
      }
    } catch (err) {
      console.error("[Agent] Session error:", err);
      sessionActive = false;
    }
  })();
}

// Handle incoming events from the TicketAgent DO
app.post("/event", async (c) => {
  const event = await c.req.json<TicketEvent>();
  console.log(`[Agent] Event: ${event.type} from ${event.source}`);

  try {
    await cloneRepos();

    if (!sessionActive) {
      // First event — build the initial prompt and start session
      const prompt = buildPrompt({
        type: event.type === "ticket_created" ? "ticket" : event.type === "slack_mention" ? "command" : "ticket",
        product: config.product,
        repos: config.repos,
        data: event.payload as Record<string, unknown>,
      });
      await startSession(prompt);
    } else {
      // Subsequent event — yield as continuation message
      const continuationPrompt = buildEventPrompt(event);
      messageYielder!(userMessage(continuationPrompt));
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("[Agent] Event handling error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

app.get("/health", (c) => c.json({
  ok: true,
  service: "ticket-agent-container",
  sessionActive,
  product: config.product,
  ticketId: config.ticketId,
}));

export default {
  port: 3000,
  fetch: app.fetch,
};
```

**Step 4: Add buildEventPrompt to prompt.ts**

Add a function that formats follow-up events (PR reviews, CI status, Slack replies, etc.) as continuation messages for the Agent SDK session:

```typescript
export function buildEventPrompt(event: TicketEvent): string {
  const payload = event.payload as Record<string, unknown>;

  switch (event.type) {
    case "pr_review":
      return `A PR review was submitted:\n\n**State:** ${payload.state}\n**Body:** ${payload.body || "(no comment)"}\n\nRespond to the review. If changes are requested, make them, push, and notify Slack.`;

    case "pr_merged":
      return `The PR has been merged. Update the task status, notify Slack, and do a brief retro.`;

    case "ci_status":
      return `CI status update:\n\n**Status:** ${payload.status}\n**Description:** ${payload.description || ""}\n\nIf CI failed, investigate and fix. If it passed, continue with the workflow.`;

    case "slack_reply":
      return `The user replied via Slack:\n\n"${payload.text}"\n\nContinue processing with this information.`;

    default:
      return `New event: ${event.type}\n\n${JSON.stringify(payload, null, 2)}\n\nProcess this event appropriately.`;
  }
}
```

**Step 5: Add shared TicketEvent type to agent**

Create `agent/src/types.ts` matching the orchestrator's `TicketEvent` interface (or copy the relevant types).

**Step 6: Delete slack-listener.ts**

```bash
git rm agent/src/slack-listener.ts
```

**Step 7: Update agent's index.ts**

Replace the one-shot entrypoint with a re-export of the server:

```typescript
// Agent entrypoint — long-lived HTTP server for persistent ticket agents
export { default } from "./server";
```

**Step 8: Run agent tests**

```bash
cd agent && bun test
```

Fix any import issues from changed config/prompt interfaces. Update `prompt.test.ts` if needed.

**Step 9: Commit**

```bash
git add agent/src/
git commit -m "feat: agent HTTP server for long-lived Agent SDK sessions

Replaced one-shot agent with persistent HTTP server. First event starts
the session, subsequent events are yielded as continuation messages.
Supports PR review, CI status, and Slack reply events."
```

---

## Task 7: Rewrite product-engineer skill with decision framework

**Files:**
- Rewrite: `.claude/skills/product-engineer/SKILL.md`

This skill is loaded by the TicketAgent via `settingSources: ["project"]`. It defines how the agent makes decisions.

**Step 1: Rewrite the skill**

`.claude/skills/product-engineer/SKILL.md`:

```markdown
---
name: product-engineer
description: Decision framework for the Product Engineer ticket agent. Defines how to assess, implement, and deliver tasks with minimal human interaction.
---

# Product Engineer — Ticket Agent

You are a Product Engineer agent working on a ticket. You receive events (ticket creation, PR reviews, CI status, Slack replies) and deliver working software.

## Decision Framework

### Reversible decisions → decide autonomously

For anything that's not destructive and not hard to change in the future:

1. Check what best satisfies the requirements
2. Pick the simplest approach
3. Ensure it's technically sound
4. Use existing work (packages, patterns, conventions) where possible
5. Document the decision in the PR description or code comments

Examples: file structure, naming, implementation approach, which package to use, test strategy, error handling patterns, code organization.

### Hard-to-reverse / destructive decisions → batch and ask

For decisions that are expensive to undo or could cause data loss:

1. Collect all such decisions as you encounter them
2. Present them as a **single Slack message** with context and options
3. Wait for the user's reply before proceeding
4. Never ask one question at a time — always batch

Examples: database schema changes, API contract changes, deleting data, force push, architectural choices that affect multiple systems, external service integrations with billing/security implications.

## Workflow

### On receiving a ticket/command

1. Read the task. If clear → proceed. If ambiguous on reversible aspects → make your best call. If ambiguous on irreversible aspects → batch questions and ask via Slack.
2. Notify Slack: "Working on: [brief description]"
3. Update status to `in_progress`
4. Create a branch: `ticket/<id>` or `feedback/<id>`
5. Read the relevant code. Understand existing patterns before changing anything.
6. Implement. Keep changes minimal — only what the task requires.
7. Run tests. Fix anything you broke.
8. Commit with a descriptive message.
9. Push and create a PR with clear title and description.
10. Assess risk:
    - **Low risk** (auto-merge): CSS, text, layout, docs, tests, config
    - **High risk** (request review): data model, auth, APIs, security, dependencies
11. Notify Slack with the PR link and risk assessment.
12. Update status with PR URL.

### On receiving a PR review

1. Read the review comments.
2. If changes requested: make them, push, notify Slack.
3. If approved: merge (if you have permission), notify Slack, update status to `merged`.

### On receiving a CI failure

1. Read the failure output.
2. Diagnose and fix.
3. Push the fix, notify Slack.

### On receiving a Slack reply

1. Parse the reply as an answer to your previous question(s).
2. Continue with the task using the new information.

## Communication

- Notify Slack at **every state transition** (starting, implementing, PR created, blocked, done)
- Use `notify_slack` for updates, `ask_question` for questions that need replies
- Keep messages concise — the team is scanning, not reading novels
- When asking questions, batch them. One message, all questions.

## Principles

- **Follow the repo's conventions.** Read CLAUDE.md and existing code first. Match the style.
- **Keep changes small.** Don't refactor. Don't add unrequested features. Don't improve things that work.
- **Fail gracefully.** If stuck, notify Slack, update status to `failed`, stop. Don't retry endlessly.
- **Document decisions.** Every autonomous decision should be visible in the PR description or comments.
```

**Step 2: Commit**

```bash
git add .claude/skills/product-engineer/SKILL.md
git commit -m "feat: rewrite product-engineer skill with decision framework

Encodes reversible vs irreversible decision logic. Autonomous on
reversible decisions, batches hard-to-reverse decisions for human input.
Added PR review, CI failure, and Slack reply handling."
```

---

## Task 8: Sentry integration

**Files:**
- Modify: `orchestrator/src/index.ts` — wrap with Sentry
- Modify: `agent/src/server.ts` — add Sentry error reporting
- Modify: `containers/orchestrator/index.ts` — add Sentry error reporting
- Modify: `containers/orchestrator/package.json` — add `@sentry/bun`
- Modify: `agent/package.json` — add `@sentry/bun`

**Step 1: Add Sentry to the Worker**

`@sentry/cloudflare` wraps the Worker's fetch handler. In `orchestrator/src/index.ts`:

```typescript
import * as Sentry from "@sentry/cloudflare";

// Wrap the export default
export default Sentry.withSentry(
  (env) => ({ dsn: env.SENTRY_DSN }),
  { fetch: app.fetch },
);
```

Add `SENTRY_DSN` to the Bindings type and provision the secret in Cloudflare.

**Step 2: Add Sentry to container processes**

For the orchestrator container and agent container, use `@sentry/bun`:

```bash
cd containers/orchestrator && bun add @sentry/bun
cd ../../agent && bun add @sentry/bun
```

In each container's entrypoint:

```typescript
import * as Sentry from "@sentry/bun";

Sentry.init({ dsn: process.env.SENTRY_DSN });
```

**Step 3: Add SENTRY_DSN to envVars**

In `orchestrator/src/orchestrator.ts` and `orchestrator/src/ticket-agent.ts`, add `SENTRY_DSN` to the `envVars` getter so container processes receive it.

**Step 4: Commit**

```bash
git add orchestrator/ agent/ containers/
git commit -m "feat: add Sentry error reporting across Worker, Orchestrator, and Agent"
```

---

## Task 9: Update documentation

**Files:**
- Rewrite: `docs/product/implementation-phases.md`
- Modify: `CLAUDE.md`

**Step 1: Rewrite implementation-phases.md**

Remove Phase 4. Describe Phases 1-3 as a unified system. Mark the approach as "build all at once" rather than sequential phases. Reference the design doc and this implementation plan.

**Step 2: Update CLAUDE.md**

Update the architecture section to reflect persistent agents:
- Replace references to queue/sandbox with Orchestrator DO + TicketAgent containers
- Update the ASCII diagram
- Update the "How It Works" section
- Update testing instructions

**Step 3: Commit**

```bash
git add docs/product/implementation-phases.md CLAUDE.md
git commit -m "docs: update architecture and phases for persistent agent system"
```

---

## Task 10: Permission template for product repos

**Files:**
- Create: `templates/claude-settings.json`
- Modify: `.claude/skills/setup-product/SKILL.md` — reference the template

**Step 1: Create the standard settings template**

`templates/claude-settings.json`:

```json
{
  "permissions": {
    "allow": [
      "Bash(git *)",
      "Bash(gh *)",
      "Bash(bun *)",
      "Bash(npm *)",
      "Bash(npx *)",
      "Bash(ls *)",
      "Bash(mkdir *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(rm *)",
      "Bash(curl *)",
      "Read(*)",
      "Write(*)",
      "Edit(*)"
    ]
  }
}
```

**Step 2: Update setup-product skill**

Add a step to the setup-product skill: "Copy `templates/claude-settings.json` to the product repo's `.claude/settings.json` if it doesn't already have one. This ensures the agent can work without permission prompts."

**Step 3: Commit**

```bash
git add templates/ .claude/skills/setup-product/SKILL.md
git commit -m "feat: standard Claude permissions template for product repos

Applied during /setup-product. Allows the agent to run common
development commands without permission prompts."
```

---

## Task 11: Integration test — deploy and verify

**Step 1: Run all tests**

```bash
cd orchestrator && bun test
cd ../agent && bun test
```

**Step 2: Install all container dependencies**

```bash
cd containers/orchestrator && bun install
```

**Step 3: Deploy**

```bash
cd orchestrator && npx wrangler deploy
```

If two container classes hit quota issues, fallback: single container class with role determined by env var (see design doc note).

**Step 4: Provision SENTRY_DSN secret**

```bash
cd orchestrator && npx wrangler secret put SENTRY_DSN
```

**Step 5: Verify health**

```bash
curl https://product-engineer.fryanpan.workers.dev/health
```

Expected: `{"ok":true,"service":"product-engineer-worker"}`

**Step 6: Check orchestrator container starts**

```bash
cd orchestrator && npx wrangler tail --format pretty
```

Look for `[SlackSocket] Connected to Slack Socket Mode` in logs.

**Step 7: End-to-end test — create a Linear issue**

Create a test issue in Linear under the "Health Tool" project. Verify:
1. Webhook fires → Worker logs show event received
2. Orchestrator creates TicketAgent
3. Agent posts to #health-tool Slack channel
4. Agent creates a PR (or defers if the task is unclear)

**Step 8: End-to-end test — Slack mention**

In #health-tool, post: `@product-engineer what tests does this project have?`

Verify:
1. Socket Mode picks up the mention
2. Orchestrator creates TicketAgent
3. Agent responds in a Slack thread

**Step 9: Commit any fixes**

```bash
git add -A && git commit -m "fix: integration fixes from end-to-end testing"
```

---

## Task Order and Dependencies

```
Task 1 (scaffold) ──→ Task 2 (Orchestrator DO) ──┐
                  ──→ Task 3 (TicketAgent DO) ────┤
                                                   ├──→ Task 4 (Worker rewrite) ──→ Task 11 (integration)
                  ──→ Task 5 (Orchestrator container) ─┤
                  ──→ Task 6 (Agent server) ───────────┘
                  ──→ Task 7 (Skill rewrite)   [independent]
                  ──→ Task 8 (Sentry)          [after Tasks 4-6]
                  ──→ Task 9 (Docs)            [independent]
                  ──→ Task 10 (Permissions)     [independent]
```

**Parallelizable:** Tasks 2+3 (both DOs), Tasks 5+6 (both containers), Tasks 7+9+10 (all independent).
