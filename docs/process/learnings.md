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
- `sleepAfter` was increased from `"15m"` to `"4h"` to allow time for CI, Copilot review, and deploy verification. Zombie container prevention now relies on orchestrator state checks (auto-resume and alarm both verify `agent_active`) rather than short container lifetimes.
- `alarm()` override must accept `alarmProps: { isRetry: boolean; retryCount: number }` — zero-arg signature causes type errors.
- `startAndWaitForPorts` accepts `{ ports, startOptions: { envVars } }` to pass env vars at start time.
- `containerFetch` auto-starts the container using `this.envVars` — set them in constructor from persisted config so cold restarts work.
- Container SDK docs are thin. Read the source code (`@cloudflare/containers`) when in doubt.
- In-memory flags on a Container DO (e.g., `private containerStarted = false`) survive DO restarts because the DO object is re-hydrated in memory — but the underlying container process is replaced on deploy. Always probe the container with a health check before trusting an in-memory "already started" flag. See `ensureContainerRunning()` in `orchestrator.ts` for the pattern.

## Agent SDK (Headless Execution)
- `ExitPlanMode` / `EnterPlanMode` require interactive user approval. In headless execution (no TTY), the agent hangs forever waiting. **Always ban plan mode** in headless agent prompts.
- `AskUserQuestion` also hangs headless — redirect to an MCP tool that posts to Slack instead.
- `bypassPermissions` mode fails when running as root. The SDK checks `process.getuid()` and refuses. Run containers as a non-root user.
- `settingSources: ["project"]` loads CLAUDE.md, all `alwaysApply: true` rules from `.claude/rules/`, and skills from `.claude/skills/` in the target repo. Interactive-only alwaysApply rules (asking for feedback, offering retros, watching for frustration) silently waste agent context tokens on every turn. Fix the target repos' rules to be headless-compatible rather than disabling settingSources.

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
- Container SDK `alarm()` fires periodically to keep containers alive. Guard against restarting completed/terminal tickets — this pattern has caused bugs twice (investigation cascade in 8e93fcb, alarm restart for completed tickets). Always check terminal state at the top of `alarm()`.
- Multi-agent features have many interacting edge cases: deploy resume, terminal state, alarm restarts, merge target, retro ordering. Plan with explicit edge case enumeration before implementing — ask "what happens when X restarts for a ticket that's already done?" at every lifecycle boundary.
- **Lifecycle fixes need both forward-looking prevention AND retroactive cleanup.** When fixing a lifecycle bug, implement: (1) the fix for future instances, (2) cleanup mechanism for existing broken instances, (3) deploy both before declaring resolved. Example: BC-118 required 4 PRs because each fix only addressed new instances, not pre-existing stuck agents. PR #63 added `/cleanup-inactive` endpoint to forcefully shut down containers that were already stuck before the fix existed.

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

## AgentManager Pattern
- Agent lifecycle management was diffused across 15+ direct DB manipulation points in `orchestrator.ts`. Consolidating into `AgentManager` class eliminated 4 bug classes at once (silent failures, state inconsistencies, duplicate agent spawns, deploy state loss).
- AgentManager must have zero in-memory state — all state in SQLite. This makes deploy re-hydration automatic: `new AgentManager(sql, env)` just works.
- `spawnAgent` must be re-entrant: safe to call for tickets already in `spawning`/`active` state (deploy recovery path). Don't throw — re-initialize the container.
- `stopAgent` must be idempotent: the same ticket might be stopped from supervisor, terminal status, and cleanup paths in the same deploy cycle.
- State machine validation catches invalid transitions early, but supervisor kill needs a raw SQL fallback since the ticket might be in any state.
- The `reactivate()` method is needed for thread replies — `sendEvent` checks `agent_active` and skips if 0, so the agent must be re-activated before sending.

## Slack Thread Routing
- The Orchestrator looks up existing tickets by `slack_thread_ts` (exact string match). Re-triggers must use the original top-level message `ts`, not a reply `ts` — otherwise a new ticket is created instead of routing to the existing one.
- For new `app_mention` events, `slackEvent.ts` (not `thread_ts`) becomes the canonical `thread_ts` stored in the DB. Subsequent replies arrive with `thread_ts` matching that original `ts`. The asymmetry is intentional — Slack uses the first message's `ts` as the thread identifier.
