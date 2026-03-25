# Product Engineer Architecture

## System Overview

Product Engineer is an autonomous agent system that turns Linear tickets, Slack messages, and feedback into shipped code — or handles research, planning, and coordination tasks. The system runs on Cloudflare Workers + Containers, scaling to dozens of parallel agents across multiple repos.

### v3 Architecture (current)

v3 replaced rule-based TypeScript routing with **persistent Claude agent sessions**. All decision-making lives in English SKILL.md files, not code. The key change: a **ProjectLead** per registered product accumulates context over time, making decisions about how to handle incoming events.

```mermaid
graph TB
    subgraph Sources["Event Sources"]
        Linear["Linear Webhooks"]
        GitHub["GitHub Webhooks"]
        Slack["Slack Socket Mode"]
    end

    subgraph Security["API Layer — Worker (deterministic, non-LLM)"]
        HMAC["HMAC / Signature\nVerification"]
        INJECT["Injection Detection\n(vard pattern scan)"]
        DELIM["Secret Prompt\nDelimiter Wrapping"]
    end

    subgraph CF["Cloudflare Workers"]
        Worker["Worker (stateless)"]
        ConductorDO["Conductor DO\n(singleton, SQLite state)"]
        ConductorContainer["Conductor Container\nSlack Socket Mode WebSocket"]
    end

    subgraph ProjectLeads["Project Lead Sessions (persistent)"]
        PA1["ProjectLead DO\n'staging-test-app'\n(coding)"]
        PA2["ProjectLead DO\n'research'\n(research)"]
        PAN["ProjectLead DO\n'product-engineer'\n(self-editing)"]
    end

    subgraph TaskAgents["Task Agent Subagents (ephemeral)"]
        TA1["TaskAgent DO #1\n+ Agent Container\n(2h lifetime)"]
        TA2["TaskAgent DO #2\n+ Agent Container"]
    end

    Sources --> Security
    Security --> Worker
    Slack -->|WebSocket| ConductorContainer
    ConductorContainer -->|"POST /api/internal/slack-event"| Worker

    Worker --> ConductorDO
    ConductorDO -->|"channel → product\nlookup"| ProjectLeads
    PA1 -->|"spawn_task\n(parallel work needed)"| TaskAgents
    PAN -->|"spawn_task"| TaskAgents

    TaskAgents -.->|"heartbeats\nstatus updates"| Worker
    ProjectLeads -.->|"heartbeats"| Worker
```

### What changed from v2

| Aspect | v2 | v3 |
|--------|----|----|
| **Routing** | TypeScript rules in conductor | Channel→product DB lookup (deterministic) |
| **Decisions** | DecisionEngine (LLM per event) | ProjectLead SKILL.md (persistent session) |
| **Context** | Cold start every task | ProjectLead accumulates context over time |
| **Task lifecycle** | Conductor drives CI/merge gate | Task agents self-manage |
| **Research tasks** | Not supported | Same container, different SKILL.md + MCPs |
| **Security** | HMAC only | 4-layer defense: HMAC → injection detection → prompt delimiter → content limits |

---

## Component Details

### Worker (`api/src/index.ts`)

Stateless Cloudflare Worker. Receives all inbound traffic and proxies to the Conductor DO. All security validation happens here before events reach any LLM.

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /api/webhooks/linear` | HMAC-SHA256 | Linear issue create/update |
| `POST /api/webhooks/github` | X-Hub-Signature-256 | PR review/merge, check_suite (CI) events |
| `POST /api/internal/slack-event` | `X-Internal-Key: SLACK_APP_TOKEN` | Slack events from Socket Mode container |
| `POST /api/internal/status` | `X-Internal-Key: API_KEY` | Agent status updates (pr_url, branch, formal status) |
| `POST /api/conductor/heartbeat` | `X-Internal-Key: API_KEY` | Agent heartbeats (free-form lifecycle messages) |
| `POST /api/dispatch` | `X-API-Key: API_KEY` | Programmatic event trigger |
| `GET/POST /api/products` | `X-API-Key: API_KEY` | Product registry CRUD |
| `ALL /api/project-lead/*` | `X-Internal-Key: API_KEY` | ProjectLead internal API |
| `GET /health` | None | Health check (also wakes Conductor container) |

### Conductor DO (`api/src/conductor.ts`)

Singleton Durable Object. Thin state store and event router — no decision logic.

**Tables:**
- `tasks` — id, product, status, slack_thread_ts, agent_active, last_heartbeat, checks_passed, agent_message
- `products` — slug, config (repos, secrets, channels, mode, slack_persona)
- `settings` — key/value (AI gateway config, Linear team ID)
- `token_usage` — per-task token consumption
- `merge_gate_retries` — task_id, retry_count, next_retry_at, phase (legacy, no longer used — agents self-manage merging)
- `task_metrics` — outcome tracking, pr_count, revision_count, cost

**Key methods:**
- `handleEvent` — Upserts task, routes to ProjectLead (v3) with TaskAgent fallback
- `handleSlackEvent` — Thread reply routing (lookup by `slack_thread_ts`) + new mention → ProjectLead
- `handleStatusUpdate` — Agent reports status, pr_url, branch. Validates against `TASK_STATES`.
- `handleHeartbeat` — Agent heartbeat with free-form message. Auto-transitions `spawning → active`.
- `ensureProjectLead` — Initializes ProjectLead DO for a product
- `routeToProjectLead` — Forwards events to the correct ProjectLead
- `handleProjectLeadRoute` — Internal API endpoints (spawn-task, list-tasks, etc.)

### Conductor Container (`containers/orchestrator/`)

Always-on container running a Slack Socket Mode WebSocket client. Forwards filtered events to the Worker.

**Event filtering (`slack-socket.ts`):**
```
Socket Mode event
  ├── Has bot_id? → DROP (ignore bot's own messages)
  ├── type === "app_mention"? → FORWARD
  ├── type === "message" AND has thread_ts AND no subtype? → FORWARD
  └── Otherwise → DROP
```

### ProjectLead DO (`api/src/project-lead.ts`) — NEW in v3

One Durable Object per registered product. Runs a persistent Agent SDK session that accumulates context over time.

**Endpoints:**
- `/initialize` / `/ensure-running` — Save config to SQLite, start container
- `/event` — Forward events to container; buffer if container not ready
- `/drain-events` — Container pulls buffered events on session start
- `/status` — Proxy container's session status
- `/health` — DO-level health check

**Key design:**
- No `sleepAfter` — persistent (alive indefinitely)
- `alarm()` every 5 min health-checks the container, restarts if dead
- Config persisted in SQLite — survives deploy
- Event buffer (up to 50 events) handles events during container restart
- Container runs same `agent/src/server.ts` with `AGENT_ROLE=project-lead`

### TaskAgent DO (`api/src/task-agent.ts`)

One Durable Object per task. Manages an ephemeral Container that runs the Claude Code Agent SDK.

**Endpoints:**
- `/initialize` — Save config to SQLite, start container with `startAndWaitForPorts`
- `/event` — Forward events to container via `containerFetch` (auto-starts if needed)
- `/mark-terminal` — Prevent alarm from restarting completed tasks
- `/status` — Proxy container's session status

**Lifecycle:**
- `sleepAfter: "2h"` — container sleeps after 2 hours of inactivity
- `alarm()` — checks session status, marks terminal if completed/errored
- `isTerminal()` — prevents container restart for finished tasks

### Agent Container (`agent/src/server.ts`)

HTTP server wrapping the Claude Code Agent SDK. Serves both ProjectLead and TaskAgent containers — behavior is configured via environment variables, not container type.

**Key env vars that control behavior:**
- `AGENT_ROLE` — `"project-lead"` or omitted (task agent)
- `MODE` — `"coding"` or `"research"`
- `REPOS` — JSON array of repos to clone
- `MODEL` — `"sonnet"`, `"opus"`, or `"haiku"`

```mermaid
graph LR
    subgraph "Agent Container Process"
        Server["Hono HTTP Server\nport 3000"]
        Session["Agent SDK Session\nquery() async loop"]
        MQ["Message Queue\n(messageYielder)"]
        Tools["MCP Tools\nnotify_slack, ask_question,\nupdate_task_status"]
        HB["Heartbeat Timer\nevery 2min"]
        TB["Transcript Backup\nevery 1min"]
    end

    Server -->|"POST /event"| MQ
    MQ -->|"yield messages"| Session
    Session -->|"tool calls"| Tools
    Tools -->|"Slack API"| Slack
    Tools -->|"phone-home"| Worker
    HB -->|"heartbeat"| Worker
    TB -->|"upload"| R2
```

---

## Agent Roles and Lifecycle

### Role Summary

| Role | Container | Lifetime | Timeouts | Max Turns | Purpose |
|------|-----------|----------|----------|-----------|---------|
| **Project Lead** | ProjectLead DO | Persistent (indefinite) | None (Infinity) | 1000 | Accumulates product context, routes events, manages task agents |
| **Task Agent (coding)** | TaskAgent DO | Ephemeral (≤2h) | 2h session, 5min idle | 200 | Implements a single task: code → PR → merge |
| **Task Agent (research)** | TaskAgent DO | Ephemeral (≤4h) | 4h session, 30min idle | 200 | Research, planning, or scheduling task |

### Project Lead Agent Lifecycle

```mermaid
stateDiagram-v2
    [*] --> uninitialized: DO created

    uninitialized --> starting: /initialize or /ensure-running called
    starting --> idle: Container boots, repos cloned

    idle --> running: Event arrives → SDK query() starts
    running --> running: New events injected via messageYielder
    running --> idle: SDK session completes (does NOT exit)
    running --> idle: SDK session errors (recovers, does NOT exit)

    idle --> running: Next event starts new SDK session

    state "Container Crash / Deploy" as crash
    running --> crash: Process killed
    idle --> crash: Process killed
    crash --> starting: alarm() detects dead container → restart

    note right of idle
        Container stays alive between sessions.
        No session/idle timeouts (Infinity).
        alarm() health-checks every 5 min.
    end note
```

**Start triggers:**
- First event routed to `ensureProjectLead()` by Conductor
- `alarm()` detects dead container after deploy/crash

**Session lifecycle:**
1. Event arrives at `/event` endpoint
2. If idle: creates new `messageYielder`, starts SDK `query()` with event prompt
3. If running: injects event into active session via `messageYielder`
4. When SDK `query()` returns: resets to `idle` — does NOT `process.exit()`
5. On error: logs, resets to `idle` — does NOT `process.exit()`
6. Container stays alive waiting for next event

**Stop conditions:**
- Never stops by design (persistent)
- Only replaced on deploy (Cloudflare replaces container image)

**Recovery after crash/deploy:**
1. Container dies
2. `alarm()` fires within 5 minutes (persisted in DO storage)
3. Health check `/health` fails → `startAndWaitForPorts()` called
4. Constructor restores `envVars` from SQLite-persisted config
5. Events that arrived while dead are in `event_buffer` (buffered by DO's `fetch()`)
6. Agent server calls `drainBufferedEvents()` on next session start

### Task Agent (Coding) Lifecycle

```mermaid
stateDiagram-v2
    [*] --> spawning: TaskManager.spawnAgent()

    spawning --> active: First heartbeat received
    active --> active: Working (events via messageYielder)
    active --> pr_open: Agent opens PR

    pr_open --> in_review: CI running / review pending
    in_review --> needs_revision: Review requests changes
    needs_revision --> pr_open: Agent pushes fix
    in_review --> merged: Agent merges (check_ci_status + merge_pr)

    pr_open --> merged: Agent merges directly (no CI)
    active --> failed: Agent errors or gives up
    pr_open --> closed: PR closed without merge

    merged --> [*]: process.exit(0)
    closed --> [*]: process.exit(0)
    failed --> [*]: process.exit(1)

    note right of active
        Session timeout: 2 hours
        Idle timeout: 5 minutes
        Heartbeat: every 2 min
    end note
```

**Start triggers:**
- Conductor calls `TaskManager.spawnAgent()` after receiving task event
- ProjectLead requests spawn via `/project-lead/spawn-task`

**What the agent does:**
1. Clones repos + loads plugins from target repo's `.claude/settings.json`
2. Builds prompt from task event, starts SDK `query()`
3. Reads codebase, implements, writes tests, commits
4. Opens PR, notifies Slack with PR link
5. Monitors CI using `check_ci_status` tool, fixes failures if needed
6. Responds to PR review feedback (events injected via messageYielder)
7. Merges PR using `merge_pr` tool when CI passes + approved

**Stop conditions:**
- `process.exit(0)` — session completes normally (PR merged, task closed)
- `process.exit(1)` — session errors
- `process.exit(0)` — session timeout (2h) or idle timeout (5min)
- Conductor calls `stopAgent()` on terminal status

**Communication to Slack:**
- Agent uses `notify_slack` MCP tool to post messages to the product's Slack channel
- First message creates the thread; subsequent messages reply in-thread
- `persistSlackThreadTs()` saves the thread ID back to conductor
- All messages are in the thread so the team has visibility

### Task Agent (Research) Lifecycle

Same as coding, except:
- Session timeout: **4 hours** (vs 2h)
- Idle timeout: **30 minutes** (vs 5min)
- `MODE=research` changes SKILL.md selection (research-agent vs product-engineer)
- No git operations, no PR workflow
- Terminal state: `closed` (user says done)
- Saves progress to Notion periodically

### Conductor (Cross-Product Assistant) — PLANNED (not yet implemented)

The v3 design includes a **Conductor** role for handling:
- Direct messages not mapped to any product
- Cross-product status queries ("what's everyone working on?")
- System meta-queries ("how is the system performing?")
- Routing ambiguous requests to the right Project Lead

**Current status:** The SKILL.md exists (`.claude/skills/assistant/SKILL.md`) but no Conductor agent DO has been implemented. Today, unrouted events are dropped. The Conductor agent would:
- Run as a persistent session like ProjectLead
- Have `list_tasks`, `list_products`, `get_task_transcript` tools for cross-product visibility
- Use a default persona (e.g., "Product Engineer")
- Route identified requests to the correct Project Lead

### Role Hierarchy

| Role | Scope | Lifetime | Purpose |
|------|-------|----------|---------|
| **Conductor** | Cross-product | Persistent | Routes unmatched events, answers system-wide queries |
| **Project Lead** | Per product | Persistent | Accumulates product context, triages events, spawns task agents |
| **Task Agent** | Per task | Ephemeral (2-4h) | Implements a single task end-to-end |

---

## Event Flows

### Flow 1: New Slack Mention → ProjectLead (v3)

```mermaid
sequenceDiagram
    participant User
    participant Slack
    participant SM as Socket Mode Container
    participant W as Worker
    participant O as Conductor DO
    participant PA as ProjectLead DO
    participant PAC as Project Lead Container

    User->>Slack: @product-engineer do X
    Slack->>SM: WebSocket event

    Note over SM: Filter: no bot_id,<br/>app_mention

    SM->>W: POST /api/internal/slack-event
    W->>W: Injection detection scan
    W->>O: handleSlackEvent()

    alt Product has Linear configured
        O->>O: Create Linear ticket
        O->>O: Upsert task in SQLite
        O->>PA: /event (via routeToProjectLead)
        PA->>PAC: containerFetch /event
        Note over PAC: ProjectLead decides:<br/>handle directly OR spawn TaskAgent
    else Product without Linear
        O->>PA: /event (direct route, no task)
        PA->>PAC: containerFetch /event
        Note over PAC: ProjectLead handles directly
    end

    PAC-->>Slack: notify_slack response
```

### Flow 2: Slack Thread Reply → Existing Agent

```mermaid
sequenceDiagram
    participant User
    participant Slack
    participant SM as Socket Mode Container
    participant W as Worker
    participant O as Conductor DO
    participant TA as TaskAgent DO
    participant AC as Agent Container

    User->>Slack: Replies in thread
    Slack->>SM: WebSocket event {thread_ts}

    SM->>W: POST /api/internal/slack-event
    W->>O: handleSlackEvent()

    Note over O: SQL: SELECT id, product<br/>FROM tasks<br/>WHERE slack_thread_ts = ?

    alt Task found with active agent
        O->>O: Reactivate agent_active = 1
        O->>TA: /event
        TA->>AC: containerFetch /event
        AC->>AC: messageYielder(buildEventPrompt)
        AC-->>User: Reply via notify_slack
    else Task found but agent stopped
        O->>O: Reactivate agent_active = 1
        O->>TA: /event (auto-starts container)
        Note over AC: New session starts with thread context
    else No task found + app_mention
        Note over O: Route as new mention (Flow 1)
    end
```

### Flow 3: Linear Ticket → ProjectLead → TaskAgent

```mermaid
sequenceDiagram
    participant Linear
    participant W as Worker
    participant O as Conductor DO
    participant PA as ProjectLead DO
    participant TA as TaskAgent DO
    participant AC as Agent Container

    Linear->>W: POST /api/webhooks/linear (HMAC verified)
    W->>O: handleEvent()
    O->>O: Upsert task in SQLite

    O->>PA: /event (via routeToProjectLead)
    Note over PA: ProjectLead assesses task

    alt Simple task
        Note over PA: Handles directly
    else Standard/complex task
        PA->>O: POST /project-lead/spawn-task
        O->>TA: /initialize + /event
        TA->>AC: Start container
        AC->>AC: Clone repos, build prompt, start SDK
        AC-->>W: phoneHome("session_running")
    end

    Note over AC: Agent implements,<br/>creates PR, monitors CI

    AC-->>Slack: notify_slack (progress)
    AC-->>W: Status update (pr_url)
```

### Flow 4: CI Check + Merge (Agent-Driven)

In v3, task agents self-manage CI monitoring and merging using `check_ci_status` and `merge_pr` MCP tools. The conductor no longer runs a merge gate.

```mermaid
sequenceDiagram
    participant AC as Agent Container
    participant GH as GitHub API
    participant Slack

    Note over AC: Agent opens PR

    AC->>GH: check_ci_status (poll)
    alt CI passing
        AC->>GH: merge_pr
        AC-->>Slack: notify_slack "PR merged"
    else CI failing
        AC->>AC: Read failure logs, fix, push
        AC->>GH: check_ci_status (retry)
    else No CI configured
        AC->>GH: merge_pr (proceed directly)
    end
```

---

## Security Architecture

Four independent defense layers — see `docs/architecture/security-layers.md` for details.

| Layer | Implementation | What It Catches |
|-------|---------------|-----------------|
| **1. HMAC/Signature** | Per-source verification at Worker | Spoofed webhooks |
| **2. Injection Detection** | `@andersmyrmel/vard` pattern scan on all free-text fields | Prompt injection attempts |
| **3. Prompt Delimiter** | Secret `PROMPT_DELIMITER` env var wraps untrusted input | Delimiter escape attacks |
| **4. Content Limits** | 1MB Worker, 100KB per-field, 50 events per task agent | Resource exhaustion |

---

## Key Lifecycle Boundaries

These boundaries have historically caused bugs. Always consider them when modifying lifecycle code.

| Boundary | What Happens | Watch Out For |
|----------|-------------|---------------|
| **Container restart** | Process killed, new container starts. `sessionActive = false`. | Events arriving before session restarts. Project leads recover to idle; task agents may auto-resume from work branch. |
| **Deploy** | All containers replaced with new image. DO storage persists. | ProjectLead: `alarm()` restarts container from persisted config. TaskAgent: `containerFetch` auto-starts. Socket Mode reconnection gap loses events. |
| **Session completed (task)** | `process.exit(0)`, container dies. | Thread replies to dead container — Conductor must handle. |
| **Session completed (project lead)** | Reset to `idle`, container stays alive. | Must properly null out `messageYielder` so next event creates a fresh session. |
| **Terminal state** | `agent_active = 0` in Conductor, `terminal = true` in TaskAgent. | `alarm()` must check terminal before restarting. Webhook events must not re-spawn. |
| **Socket Mode disconnect** | WebSocket closes, reconnect with exponential backoff. | Events during reconnection gap are permanently lost. |

### Recovery Matrix

| Failure | Project Lead Recovery | Task Agent Recovery |
|---------|----------------------|----------------------|
| **Container crash** | `alarm()` (5min) → health check fails → `startAndWaitForPorts()`. Config from SQLite. Buffered events drained. | Supervisor detects stale heartbeat → can re-spawn or mark failed |
| **Deploy** | Same as crash — `alarm()` persisted in DO storage, constructor reads config from SQLite | `containerFetch` auto-starts on next event. Fresh session (doesn't resume mid-SDK-call) |
| **SDK error** | Reset to `idle`, log error. Next event starts fresh session | `process.exit(1)` — container dies. Conductor can re-spawn if agent_active still set |
| **Network partition** | Events buffered in DO (up to 50). Drained on reconnect | Events buffered in TaskAgent DO. containerFetch retries |

---

## Data Flow: `slack_thread_ts`

This field routes thread replies to the correct agent. Its lifecycle:

1. **Task created:** `slack_thread_ts = NULL` in SQLite
2. **Agent posts first Slack message:** `notify_slack` → Slack returns `ts`
3. **`persistSlackThreadTs`:** Fire-and-forget POST to conductor with `slack_thread_ts = ts`
4. **Conductor updates DB:** `UPDATE tasks SET slack_thread_ts = ? WHERE id = ?`
5. **User replies in thread:** Slack sends event with `thread_ts` matching step 2's `ts`
6. **Conductor matches:** `SELECT ... WHERE slack_thread_ts = ?` finds the task

**Failure mode:** If step 3 fails silently, `slack_thread_ts` stays NULL and thread replies never route. No retry mechanism exists.

---

## Configuration

### Product Registry (SQLite via Admin API)

```json
{
  "repos": ["org/repo-name"],
  "slack_channel": "#channel-name",
  "slack_channel_id": "C0AHQK8LB34",
  "slack_persona": {
    "username": "PE Engineer",
    "icon_emoji": ":hammer_and_wrench:"
  },
  "mode": "coding",
  "triggers": {
    "linear": { "enabled": true, "project_name": "My Project" },
    "slack": { "enabled": true }
  },
  "secrets": {
    "GITHUB_TOKEN": "PRODUCT_GITHUB_TOKEN",
    "ANTHROPIC_API_KEY": "ANTHROPIC_API_KEY"
  }
}
```

### Secrets

| Secret | Scope | Purpose |
|--------|-------|---------|
| `SLACK_APP_TOKEN` | Global | Socket Mode WebSocket auth |
| `SLACK_BOT_TOKEN` | Global | Slack API calls |
| `API_KEY` | Global | Internal API auth between components |
| `WORKER_URL` | Global | Container → Worker callback URL |
| `ANTHROPIC_API_KEY` | Global | Claude API access |
| `PROMPT_DELIMITER` | Global | Secret delimiter wrapping untrusted input |
| `*_GITHUB_TOKEN` | Per-product | GitHub repo access |
| `LINEAR_API_KEY` | Global | Linear ticket updates |

### Model Selection

Per-product in registry config:
- **Sonnet** — default, most tasks
- **Opus** — complex repos or high-priority tasks
- **Haiku** — simple/low-priority tasks

---

## Agent Behavior (SKILL.md)

All agent decision-making is defined in English skill files, not TypeScript:

| Skill | Path | Role |
|-------|------|------|
| `coding-project-lead` | `.claude/skills/coding-project-lead/SKILL.md` | ProjectLead for coding products |
| `research-agent` | `.claude/skills/research-agent/SKILL.md` | ProjectLead/TaskAgent for research products |
| `ticket-agent-coding` | `.claude/skills/ticket-agent-coding/SKILL.md` | Self-managing task agent for coding tasks |
| `product-engineer` | `.claude/skills/product-engineer/SKILL.md` | Legacy task agent decision framework |
| `assistant` | `.claude/skills/assistant/SKILL.md` | Cross-product assistant (planned) |

The agent loads skills from this repo via `cwd` (project leads clone the PE repo for skills) and from the target product's repo via `additionalDirectories`.

---

## Observability

| Tool | What It Shows |
|------|---------------|
| `wrangler tail` | Worker + DO logs (status updates, heartbeats, errors) |
| Container `console.log` | Agent-side logs (not visible in `wrangler tail`) |
| Cloudflare AI Gateway | API requests, tokens, costs, cache rates |
| R2 Transcripts | Full Agent SDK conversation transcripts (JSONL) |
| Slack threads | Agent's communication trail |
| `/api/conductor/tasks` | All tasks with status, timestamps, agent_active |
| `/api/conductor/status` | Active agents summary |
| `/api/agent/:id/status` | Container session status, message count, errors |
| `/api/project-lead/status` | All ProjectLead statuses |
