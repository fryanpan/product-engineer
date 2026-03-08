## 2026-03-08 - BC-125: Agent Dashboard with Google OAuth

**What worked:**
- Reusing existing orchestrator `/status` endpoint instead of creating new data layer
- Single-page HTML approach (no build step, no framework dependencies)
- Leveraging Cloudflare KV for session storage (automatic TTL, distributed)
- Security-first design from the start (OAuth CSRF, HttpOnly cookies, email allowlist)
- Comprehensive documentation (setup guide + user guide + inline comments)
- TypeScript type safety caught issues early (cookie header types, query param nullability)

**What didn't:**
- Initial HTML import type declaration didn't work (`export default` vs `export =`)
- Had to add `@ts-ignore` for HTML import (wrangler handles it but TypeScript doesn't understand)
- User requested security review mid-implementation - should have proactively documented security considerations first
- Git identity not configured in container - minor delay on commit

**Action:**
- Template: When adding authentication to a Cloudflare Worker, use KV + OAuth + session cookies pattern (proven secure + simple)
- Documentation: Always include security section in implementation docs before asking for review
- Agent containers: Consider pre-configuring git identity to avoid commit delays
- HTML imports: Use `@ts-ignore` for wrangler-bundled assets that TypeScript doesn't understand

**Learnings:**
- Cloudflare KV TTL is perfect for session management (no manual cleanup needed)
- OAuth state parameter validation via temporary KV entry (5 min TTL) prevents CSRF
- HttpOnly + Secure + SameSite cookies provide strong session security baseline
- Email allowlist via comma-separated env var is simple and effective for small teams
- Auto-refresh with countdown timer gives users visibility into refresh timing
- Separating "needs help" agents improves monitoring UX (asking status + stale heartbeats)

## 2025-01-15 - Multi-Agent Lifecycle Fixes (Alarm Restart)

**What worked:**
- Two-stage commit strategy: (1) alarm guard, (2) shutdown hook, (3) terminal state check
- Explicit edge case enumeration in planning prevented bugs
- Retroactive cleanup endpoint (`/cleanup-inactive`) fixed existing broken instances

**What didn't:**
- First two PRs only addressed new instances, not pre-existing stuck agents
- Took 4 PRs to fully resolve because cleanup wasn't part of the initial plan

**Action:**
- Lifecycle fixes need BOTH forward-looking prevention AND retroactive cleanup
- Always ask "what happens to existing broken instances?" before declaring resolved

## 2025-01-10 - Multi-Agent Investigation Cascade

**What worked:**
- Auto-resume detection prevented false positives
- Alarm guards at top of lifecycle methods (check terminal state first)

**What didn't:**
- Didn't enumerate edge cases upfront (alarm restart for completed tickets)
- Investigation loop created cascading tickets

**Action:**
- For multi-agent/lifecycle features: enumerate edge cases in planning phase
- Always check terminal state at the top of alarm() and auto-resume

## 2024-12-20 - Cloudflare AI Gateway Integration

**What worked:**
- Centralized monitoring for all LLM traffic across products
- Simple integration: just set ANTHROPIC_BASE_URL
- Dashboard shows cache hit rates, token usage, costs

**What didn't:**
- Gateway config was hardcoded in orchestrator initially
- No visibility into per-product vs per-ticket breakdowns

**Action:**
- Store gateway config in registry (per-product optional)
- Document analytics features in main README

## 2024-12-15 - Agent SDK settingSources Optimization

**What worked:**
- Identified alwaysApply rules were wasting tokens (70K cached per turn)
- Templates + propagate made it easy to push fixes to all products
- Cost dropped significantly after removing interactive-only rules

**What didn't:**
- Didn't notice the waste until after running expensive multi-turn sessions
- Target repos had accumulated interactive rules over time

**Action:**
- Audit alwaysApply rules for headless compatibility before enabling settingSources
- Keep total alwaysApply content under 80 lines
- Templates are source of truth — propagate regularly

## 2024-12-01 - Container Lifecycle (sleepAfter, process.exit)

**What worked:**
- Explicit process.exit(0) for success, process.exit(1) for errors
- onStop and onError hooks made crashes visible
- Health checks via HTTP probe more reliable than in-memory flags

**What didn't:**
- Assumed sleepAfter would forcefully stop containers (it just marks "sleep eligible")
- Containers with HTTP servers never idle from SDK's perspective
- In-memory flags survive DO restarts but underlying container gets replaced

**Action:**
- Always call process.exit() when agent completes (success or error)
- Use health checks (HTTP) over in-memory flags for post-deploy reliability
- sleepAfter is for idle containers, not active ones with servers

## 2024-11-20 - Agent SDK Headless Execution

**What worked:**
- Banning plan mode + AskUserQuestion prevented hangs
- bypassPermissions mode worked after switching to non-root user
- settingSources: ["project"] loaded target repo context automatically

**What didn't:**
- Initial attempts ran as root (bypassPermissions failed)
- Didn't realize EnterPlanMode would hang forever (no TTY)

**Action:**
- Always run agent containers as non-root (RUN useradd -m agent && USER agent)
- Never use plan mode or AskUserQuestion in headless agents
- Redirect user questions to MCP tool that posts to Slack
