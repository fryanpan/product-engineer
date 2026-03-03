# Learnings

Technical discoveries that should persist across sessions.

## Cloudflare Container SDK
- `envVars` is a class field on Container base class, not a getter. JavaScript class fields create own properties that shadow prototype getters. Set `this.envVars` in the constructor instead of using `get envVars()`.
- `sleepAfter` only accepts hours (e.g., `"96h"`), not days. `"4d"` silently fails.
- `alarm()` override must accept `alarmProps: { isRetry: boolean; retryCount: number }` — zero-arg signature causes type errors.
- `startAndWaitForPorts` accepts `{ ports, startOptions: { envVars } }` to pass env vars at start time.
- `containerFetch` auto-starts the container using `this.envVars` — set them in constructor from persisted config so cold restarts work.
- Container SDK docs are thin. Read the source code (`@cloudflare/containers`) when in doubt.

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
