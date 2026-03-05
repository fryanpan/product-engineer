# Learnings

Technical discoveries that should persist across sessions.

## Cloudflare Container SDK
- `envVars` is a class field on Container base class, not a getter. JavaScript class fields create own properties that shadow prototype getters. Set `this.envVars` in the constructor instead of using `get envVars()`.
- `sleepAfter` only accepts hours (e.g., `"2h"`), not days. `"4d"` silently fails.
- `alarm()` override must accept `alarmProps: { isRetry: boolean; retryCount: number }` — zero-arg signature causes type errors.
- `startAndWaitForPorts` accepts `{ ports, startOptions: { envVars } }` to pass env vars at start time.
- `containerFetch` auto-starts the container using `this.envVars` — set them in constructor from persisted config so cold restarts work.
- Container SDK docs are thin. Read the source code (`@cloudflare/containers`) when in doubt.
- In-memory flags on a Container DO (e.g., `private containerStarted = false`) survive DO restarts because the DO object is re-hydrated in memory — but the underlying container process is replaced on deploy. Always probe the container with a health check before trusting an in-memory "already started" flag. See `ensureContainerRunning()` in `orchestrator.ts` for the pattern.

## Agent SDK (Headless Execution)
- `ExitPlanMode` / `EnterPlanMode` require interactive user approval. In headless execution (no TTY), the agent hangs forever waiting. **Always ban plan mode** in headless agent prompts.
- `AskUserQuestion` also hangs headless — redirect to an MCP tool that posts to Slack instead.
- `bypassPermissions` mode fails when running as root. The SDK checks `process.getuid()` and refuses. Run containers as a non-root user.
- `settingSources: ["project"]` loads CLAUDE.md and skills from the repo the agent is working in — no need to pass skills explicitly.

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

## Slack Thread Routing
- The Orchestrator looks up existing tickets by `slack_thread_ts` (exact string match). Re-triggers must use the original top-level message `ts`, not a reply `ts` — otherwise a new ticket is created instead of routing to the existing one.
- For new `app_mention` events, `slackEvent.ts` (not `thread_ts`) becomes the canonical `thread_ts` stored in the DB. Subsequent replies arrive with `thread_ts` matching that original `ts`. The asymmetry is intentional — Slack uses the first message's `ts` as the thread identifier.
