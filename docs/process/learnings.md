# Learnings

Technical discoveries that should persist across sessions.

## Cloudflare Container SDK (Lifecycle)
- `sleepAfter` marks containers as "sleep eligible" after the timeout, but doesn't forcefully stop them. It's designed for hibernating idle containers, not stopping active ones.
- Containers with HTTP servers responding to health checks are never "idle" from the SDK's perspective - they need explicit `process.exit()` to stop.
- Always call `process.exit(0)` on successful completion and `process.exit(1)` on error to free resources immediately. Without this, containers sit idle until the sleepAfter timeout expires naturally.
- Exit codes (0 for success, 1 for error) allow monitoring to distinguish outcomes in container lifecycle logs.

## Cloudflare Container SDK (Configuration)
- `envVars` is a class field on Container base class, not a getter. JavaScript class fields create own properties that shadow prototype getters. Set `this.envVars` in the constructor instead of using `get envVars()`.
- `sleepAfter` only accepts hours (e.g., `"96h"`), not days. `"4d"` silently fails.
- `sleepAfter` was increased from `"15m"` to `"4h"` to allow time for CI, Copilot review, and deploy verification. Zombie container prevention now relies on conductor state checks (auto-resume and alarm both verify `agent_active`) rather than short container lifetimes.
- `alarm()` override must accept `alarmProps: { isRetry: boolean; retryCount: number }` — zero-arg signature causes type errors.
- `startAndWaitForPorts` accepts `{ ports, startOptions: { envVars } }` to pass env vars at start time.
- `containerFetch` auto-starts the container using `this.envVars` — set them in constructor from persisted config so cold restarts work.
- Container SDK docs are thin. Read the source code (`@cloudflare/containers`) when in doubt.
- In-memory flags on a Container DO (e.g., `private containerStarted = false`) survive DO restarts because the DO object is re-hydrated in memory — but the underlying container process is replaced on deploy. Always probe the container with a health check before trusting an in-memory "already started" flag. See `ensureContainerRunning()` in `conductor.ts` for the pattern.

## Agent SDK (Headless Execution)
- `ExitPlanMode` / `EnterPlanMode` require interactive user approval. In headless execution (no TTY), the agent hangs forever waiting. **Always ban plan mode** in headless agent prompts.
- `AskUserQuestion` also hangs headless — redirect to an MCP tool that posts to Slack instead.
- `bypassPermissions` mode fails when running as root. The SDK checks `process.getuid()` and refuses. Run containers as a non-root user.
- `settingSources: ["project"]` loads CLAUDE.md, all `alwaysApply: true` rules from `.claude/rules/`, and skills from `.claude/skills/` in the target repo. Interactive-only alwaysApply rules (asking for feedback, offering retros, watching for frustration) silently waste agent context tokens on every turn. Fix the target repos' rules to be headless-compatible rather than disabling settingSources.

## Agent SDK (Plugins in Headless Mode)
- `settingSources: ["project"]` loads CLAUDE.md, rules, and skills from the repo, but does NOT load `enabledPlugins` from `.claude/settings.json`. Plugins must be passed explicitly via the `plugins` query option.
- The SDK `plugins` option only supports `{ type: "local", path: "..." }` — no marketplace resolution. The agent must clone marketplace repos and resolve paths itself.
- `claude plugin install` requires the full CLI with OAuth login — not usable in headless containers. Instead, shallow-clone the marketplace GitHub repo directly (`anthropics/claude-plugins-official`).
- Marketplace repos use `.claude-plugin/marketplace.json` as the plugin index. URL-sourced entries (where `source` is an object with a `url` field, e.g., superpowers from `obra/superpowers`) require a separate git clone — they aren't bundled in the marketplace repo itself.
- Plugin loading should be non-fatal: if cloning fails, the agent continues without plugin skills.

## Docker / Container Deployment
- Docker build context paths matter when the Dockerfile is in a subdirectory. Use `context: .` in wrangler.jsonc and adjust COPY paths accordingly.
- Always run agent containers as non-root. Create a user in the Dockerfile: `RUN useradd -m agent && USER agent`.

## Debugging Deployed Containers
- `wrangler tail` is the primary observability tool for Container DO logs.
- Phone-home status updates (agent → worker → DO) are essential for tracking agent lifecycle in production.
- Add `onStop` and `onError` lifecycle hooks to Container subclasses — without them, crashes are invisible.
- stderr callbacks on the Agent SDK `query()` call surface Claude Code subprocess errors that would otherwise be lost.

## Cloudflare Deployment Config
- `WORKER_URL` in `wrangler.toml [vars]` must match the actual deployed URL. A stale placeholder silently breaks Socket Mode forwarding — the container starts and connects to Slack, but event forwarding to the Worker fails with empty URLs. Before deploying to a new account/subdomain, audit all `[vars]` entries in `wrangler.toml`.

## Multi-Agent Lifecycle
- Container SDK `alarm()` fires periodically to keep containers alive. Guard against restarting completed/terminal tasks — this pattern has caused bugs twice (investigation cascade in 8e93fcb, alarm restart for completed tasks). Always check terminal state at the top of `alarm()`.
- Multi-agent features have many interacting edge cases: deploy resume, terminal state, alarm restarts, merge target, retro ordering. Plan with explicit edge case enumeration before implementing — ask "what happens when X restarts for a task that's already done?" at every lifecycle boundary.
- **Lifecycle fixes need both forward-looking prevention AND retroactive cleanup.** When fixing a lifecycle bug, implement: (1) the fix for future instances, (2) cleanup mechanism for existing broken instances, (3) deploy both before declaring resolved. Example: BC-118 required 4 PRs because each fix only addressed new instances, not pre-existing stuck agents. PR #63 added `/cleanup-inactive` endpoint to forcefully shut down containers that were already stuck before the fix existed.

## Task Review Decision Engine
- **Default to action, not questions.** For Slack-originated requests, the bar for asking questions should be VERY high. The user already took action to mention the bot — they expect work to start, not a questionnaire.
- Only ask questions if BOTH conditions are met: (1) genuinely ambiguous about WHAT to do (not HOW), and (2) cannot be determined by reading code/comments/links.
- Agents have tools (`ask_question`, codebase exploration) to gather details during implementation. Don't block task creation for details the agent can gather itself.
- Prompt guidance must be specific and concrete. "Prefer X unless Y" is too vague — use explicit decision criteria + concrete examples.

## LLM Token Optimization
- `settingSources: ["project"]` injects ALL `alwaysApply: true` rules into every agent turn. Target repos with interactive-only alwaysApply rules (asking for feedback, offering retros, watching for user frustration) silently waste agent context tokens. Fix the target repos, not the agent config.
- Templates for headless-compatible target repo rules live in `templates/` — use `/propagate` to push updates to registered products.
- Total alwaysApply content across all rules in a target repo should be < 80 lines.
- Cost is roughly linear with turn count (~$0.02-0.03/turn at ~70K cached tokens). Reducing turns matters more than reducing prompt size.
- Cache hit rate is ~97% — cache reads ($0.30/M) dominate over cache writes ($3.75/M). Large contexts are cheap per-turn but expensive in aggregate across many turns.

## Slack Bot Self-Mention Limitation
- Slack does NOT fire `app_mention` events when a bot mentions itself. A message posted by `xoxb-` bot token containing `<@BOT_USER_ID>` will not trigger Socket Mode delivery.
- E2E tests that need to simulate user mentions must either: (a) use the internal endpoint (`/api/internal/slack-event`) with the `xapp-` token for auth, or (b) use a separate user OAuth token (not the bot token) to post the mention.
- The E2E test posts via bot for visibility, then sends the event directly to the internal endpoint as a workaround. This is the same code path Socket Mode uses.
- `scripts/setup.sh` supports `--env staging` for provisioning staging secrets.

## TaskManager Pattern
- Agent lifecycle management was diffused across 15+ direct DB manipulation points in `conductor.ts`. Consolidating into `TaskManager` class eliminated 4 bug classes at once (silent failures, state inconsistencies, duplicate agent spawns, deploy state loss).
- TaskManager must have zero in-memory state — all state in SQLite. This makes deploy re-hydration automatic: `new TaskManager(sql, env)` just works.
- `spawnAgent` must be re-entrant: safe to call for tasks already in `spawning`/`active` state (deploy recovery path). Don't throw — re-initialize the container.
- `stopAgent` must be idempotent: the same task might be stopped from supervisor, terminal status, and cleanup paths in the same deploy cycle.
- State machine validation catches invalid transitions early, but supervisor kill needs a raw SQL fallback since the task might be in any state.
- The `reactivate()` method is needed for thread replies — `sendEvent` checks `agent_active` and skips if 0, so the agent must be re-activated before sending.
- `reopenTask()` is the terminal-state counterpart to `reactivate()` — it transitions from any terminal state back to `active` and respawns the container. Only triggered by thread replies, never by automated paths (alarm, deploy, webhooks).

## GitHub Fine-Grained PATs
- Fine-grained PATs do NOT have a "Checks" permission. The check-runs API (`/repos/.../commits/.../check-runs`) is inaccessible. Use the commit statuses API (`/repos/.../commits/.../status`) instead, which requires "Commit statuses: Read" permission.
- Never use the check-runs API in code that runs with fine-grained PATs. Always use commit statuses.

## Status Field vs Agent Lifecycle
- The `status` field is for the **formal state machine** (12 states: created → reviewing → spawning → active → pr_open → merged etc.). It must only contain values from `TASK_STATES`.
- Agent lifecycle messages ("starting session", "cloning repos", "pushing to branch") go to `agent_message` via the `/heartbeat` endpoint. These are free-form strings, not state machine states.
- Old agent containers were writing `agent:*` strings into `status` via `handleStatusUpdate`, polluting the state machine. Fix: `handleStatusUpdate` validates against `TASK_STATES` and rejects invalid values.
- The `spawning → active` transition is now automatic: first heartbeat from the agent triggers it in `handleHeartbeat`. No explicit status update needed.
- Terminal states (`merged`, `closed`, `deferred`, `failed`) can now be reopened via `reopenTask()`. This adds a `terminal → active` reverse transition to the state machine. `reopenTask()` bypasses the `updateStatus()` terminal guard by writing directly to SQL, then calls `spawnAgent`. This is the only sanctioned path for reversing a terminal state.

## updateStatus Terminal Guard
- `updateStatus()` silently returns early if the task is in a terminal state. Any code path that needs to transition OUT of a terminal state must bypass it with direct SQL — do not call `updateStatus()`.
- `reopenTask()` is the canonical bypass pattern: it writes `status='active', agent_active=1` directly, then clears the TaskAgent DO's terminal flag via `/clear-terminal`, then spawns the agent.
- Unit tests that mock `updateStatus()` at the routing layer will miss this guard. Integration tests must exercise the full `reopenTask()` → SQL path to catch silent no-ops.

## Merge Gate for Repos Without CI
- The merge gate was only triggered by `check_suite` webhooks (CI). Repos without CI never got a merge gate evaluation, leaving PRs stuck forever.
- Fix: always trigger the merge gate when `pr_url` is reported in `handleStatusUpdate`. The merge gate then checks:
  1. **CI**: `fetchCIStatus` returns `hasCI: false` when no commit statuses exist → skip CI wait. `hasCI: true` with pending CI → retry up to 5x (90s apart).
  2. **Copilot review**: if enabled, wait via retries (5x, 90s). If not found after retries → proceed without.
- The CI wait and Copilot wait are sequential phases sharing the `merge_gate_retries` table with a `phase` column. Counter resets when transitioning from `ci` → `copilot` phase.
- For repos WITH CI, the `checks_passed` webhook path still works as the fast path — it sets `checks_passed=1` in the DB and calls `evaluateMergeGate` directly.

## Slack Thread Routing
- The Conductor looks up existing tasks by `slack_thread_ts` (exact string match). Re-triggers must use the original top-level message `ts`, not a reply `ts` — otherwise a new task is created instead of routing to the existing one.
- For new `app_mention` events, `slackEvent.ts` (not `thread_ts`) becomes the canonical `thread_ts` stored in the DB. Subsequent replies arrive with `thread_ts` matching that original `ts`. The asymmetry is intentional — Slack uses the first message's `ts` as the thread identifier.

## Slack Thread Reply Respawning
- Thread replies to tasks in terminal, suspended, or dead-container (agent_active=0) states now respawn the agent instead of being silently dropped.
- The conductor calls `reopenTask()` (for terminal states) or `reactivate()` (for inactive agents) before forwarding the event, ensuring the container is alive to receive it.
- This is intentional: a user replying in a thread signals they want more work done, even if the agent previously completed or failed.

## Mock SQL in Tests
- The mock SQL helper used in conductor tests only captures parameterized values (`?` placeholders) in SET clauses. Literal string values in SQL (e.g., `SET status = 'active'`) are invisible to the mock and won't update the in-memory store.
- Always use parameterized SQL (`SET status = ?` with a param) rather than literals when writing code that will be tested with the mock.

## Bun Test Mock Isolation
- `mock.module()` in bun:test is **process-global** and persists across all test files in the same run. If `foo.test.ts` calls `mock.module("./bar")`, then `baz.test.ts` importing `./bar` gets the mock, not the real module. Never use `mock.module()` for modules that other test files also test.
- `globalThis.fetch` replacement (`globalThis.fetch = mock(...)`) leaks across test files unless explicitly restored. Use `spyOn(globalThis, "fetch")` with `mockRestore()` in `afterEach` instead.
- When asserting fetch call counts, filter `mock.calls` by URL rather than using `toHaveBeenCalledTimes(0)` — other test files may leave the spy in an impure state.

## Clean-Slate DO Migrations
- `deleted_classes` + `new_sqlite_classes` in wrangler.toml creates fresh DOs with empty SQLite. All settings, product configs, and task history are lost.
- The `CREATE TABLE IF NOT EXISTS` statement must include ALL columns (not just the original ones). Legacy `addColumn` + `ALTER TABLE RENAME COLUMN` migrations fail silently on fresh DOs because the intermediate column names (e.g., `identifier`) never existed.
- After a clean-slate deploy: re-seed products via admin API, re-configure settings (linear_team_id, linear_app_token, conductor_channel, cloudflare_ai_gateway), verify with smoke test.

## GitHub Webhooks
- GitHub PR webhooks have `action: "closed"` with a `merged: true|false` flag. Always handle BOTH cases:
  - `action === "closed" && merged === true` → PR was merged (route as `pr_merged` event)
  - `action === "closed" && merged === false` → PR was closed without merging (route as `pr_closed` event)
- If you only handle the merged case, tasks with closed-but-not-merged PRs stay in `pr_open` status forever, causing supervisor to repeatedly trigger merge gate evaluations (every 5 min).
- **Terminal webhook events (`pr_merged`, `pr_closed`) must update conductor state directly.** Don't route them through `sendEvent` to the agent container — the container may have already exited. Handle these events in `handleEvent` by updating status and calling `stopAgent`, not by forwarding to the (possibly dead) agent. (Fixed in BC-162)

## Linear Webhook Integration
- Products without a `triggers` field crash `getProductByLinearProject()` when it accesses `config.triggers.linear` — always use `config.triggers?.linear?.enabled`. One missing `?` caused a 500 on every Linear webhook, which made Linear stop delivering after repeated failures.
- Linear stops delivering webhooks after repeated 500 errors. The webhook shows `enabled: true` in the API but no deliveries arrive. Fix: delete and recreate the webhook. After recreation, delivery may still be delayed due to internal backoff.
- The `vard` injection detector in `strict()` mode flags "AI" (severity 0.65) as `delimiterInjection`. Adding `.threshold(0.8)` filters false positives while real injections score 0.9+. When adding common words to ticket descriptions, check if the injection scanner rejects them.
- `LINEAR_WEBHOOK_SECRET` must be synced between the Linear webhook config (`secret` field) and the Cloudflare Worker secret. Use `wrangler secret put LINEAR_WEBHOOK_SECRET` and verify the values match.

## Dispatch API
- The dispatch endpoint (`POST /api/dispatch`) requires `type: "task_created"` for new tasks. Using `type: "task"` or any other value silently skips `handleTaskReview` — the event is accepted (200 OK) but no agent is spawned. The event falls through to the "route to TaskAgent" catch-all, which fails silently when no agent exists yet.
- Always use `task_created` as the event type when dispatching new work via the API.

## CI Workflow & Multi-PR Coordination
- CI (`ci.yml`) triggers on `pull_request` events only (not `push`). Pushes to feature branches (e.g., from subagents via SSH) do not trigger CI — only opening or synchronizing a PR against `main` does. Use an empty commit to force a `synchronize` event if a push doesn't trigger CI.
- When merging multiple PRs that touch the same repo, they must be rebased sequentially — merging one PR changes the base and creates conflicts in the others. Merge one at a time, rebasing the next PR onto updated `main` before merging.

## Supervisor Health Detection
- The supervisor uses the `last_heartbeat` column (set by agent phone-home via `/heartbeat`) to detect stale agents. Don't confuse this with `updated_at`, which changes on any task field update (status, PR URL, metadata).
- Always include `last_heartbeat` in SQL queries for supervisor context. Using `updated_at` for staleness detection gives false positives because status updates (which aren't real heartbeats) reset the timer. (Fixed in BC-162)

## Agent Cost Optimization
- Cache reads dominate cost at ~72% of total spend. At ~70K cached tokens/turn, cost is ~$0.02-0.03/turn for Sonnet. Reducing turns matters more than reducing prompt size.
- **Implementation subagent pattern**: dispatching the coding phase as a subagent via the `Agent` tool gives it fresh ~20K context vs the parent's growing 100K+ history — 84% cheaper per turn. With ~25 implementation turns/task, this is the single biggest cost lever.
- **Haiku for CI monitoring**: polling CI in a Haiku subagent (87% cheaper cache reads vs Sonnet: $0.04/MTok vs $0.30/MTok) is appropriate for low-intelligence retry loops.
- Subagents dispatched via the `Agent` tool in Claude Code do NOT inherit the parent's custom MCP servers (e.g. `pe-tools`). They only get standard Claude Code tools. Use `gh pr checks` via Bash for CI status — not PE-specific tools like `check_ci_status`.
- Plugin context overhead: each plugin adds 2-4K tokens to every turn. Removing commit-commands and scoping code-simplifier to simplification tasks only saves ~4-8K tokens/turn.
- Retros add ~2 turns per task with low signal. Removing them from the default flow and doing them externally across sessions is more cost-efficient.
