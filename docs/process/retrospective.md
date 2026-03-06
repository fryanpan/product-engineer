# Retrospectives

Session retrospectives and process improvements.

## 2026-03-06 - LLM Cost Optimization & Project Management Migration

Analyzed AI Gateway costs and agent session transcripts, identified context bloat from interactive alwaysApply rules, implemented Option B (keep settingSources, fix target repos), migrated project management skills from ai-project-support, created headless-compatible templates.

### Time Breakdown

| Started | Phase | 👤 Hands-On Time | 🤖 Agent Time | Problems |
|---------|-------|-----------------|---------------|----------|
| Mar 6 12:03am | Research: AI Gateway + R2 transcript analysis | ██ 15m | ██████ 19m | ⚠ R2 token perms, API pagination |
| Mar 6 12:23am | Design: Context bloat analysis + architecture discussion | ████████ 27m | ██████ 14m | |
| Mar 6 12:53am | Migration + Implementation | ██ 8m | ████████████ ~35m | ⚠ Context compaction mid-task |

### Metrics

| Metric | Duration |
|--------|----------|
| Total wall-clock | ~1.5 hours |
| Hands-on | ~53 min (59%) |
| Automated agent time | ~68 min (76%) |
| Retro analysis time | ~5 min |

_Note: Hands-on and agent time overlapped within the session, so percentages are each relative to wall-clock time and may sum to >100%._

### Key Observations

1. Session was design-heavy (~60% discussion), implementation-light — right ratio for architectural decisions
2. Context compaction hit mid-implementation but summary preserved enough to continue cleanly
3. Research phase had minor friction (R2 auth, API pagination) but was a one-off cost analysis
4. Good decision flow — user steered away from over-engineering (no superpowers fork, no custom agent-skills directory)

### Feedback

**What worked:** Comprehensive research followed by good collaborative design discussion. High-quality back-and-forth on architectural options.

### Actions Taken

| Issue | Action Type | Change |
|-------|-------------|--------|
| settingSources learning incomplete | learnings.md | Expanded bullet to cover alwaysApply rule loading and token waste |
| No LLM token optimization learnings | learnings.md | New "LLM Token Optimization" section with cost model, line budgets |
| templates/ not documented | CLAUDE.md | Added to Key Directories table |
| New skills not documented | CLAUDE.md | Added /propagate and /aggregate to "Modifying Agent Behavior" |

## 2026-03-05 - Fix Agent Lifecycle Issues

Fix five agent lifecycle bugs: disable broken investigation flow, add git-branch auto-resume, reduce container TTL, fix skill compliance (merge policy, retro, code review).

### Time Breakdown

| Started (PT) | Phase | Hands-On | Agent | Problems |
|---------|-------|------------|----------|----------|
| 5:45pm | Initial request | 2m | | OAuth expired, retried at 6:40pm |
| 6:40pm | Investigation + planning | 3m | 9m | |
| 6:49pm | Implementation (subagent-driven) | 1m | 17m | |
| 7:06pm | Code review + fixes | 3m | 16m | Codex CLI not installed |
| 7:22pm | Simplify review + fixes | | 6m | |

### Metrics

| Metric | Duration |
|--------|----------|
| Total wall-clock | ~48 min (effective, excluding auth error gap) |
| Hands-on | ~9 min (19%) |
| Automated agent time | ~48 min (81%) |
| Retro analysis time | ~5 min |

### Key Observations

1. High autonomy ratio — after 2 direction-setting messages, session was almost entirely agent-driven
2. Code review caught a real alarm restart bug (same pattern as 8e93fcb investigation cascade)
3. Simplify review found 7 concrete issues: duplicate types, missing MIME normalization, sequential fetches
4. All behavioral fixes were English-only (SKILL.md edits) — validates "English over code" design
5. Root cause of these bugs: insufficient edge case planning for multi-agent lifecycle features

### Feedback

**What worked:** Session went smoothly, high autonomy, good code review coverage

**What didn't:** These bugs should have been caught earlier. Multi-agent behavior is hard to tune — 2+ days spent on these issues. Need more upfront planning and edge case review.

### Actions Taken

| Issue | Action Type | Change |
|-------|-------------|--------|
| Edge cases not caught during planning | workflow-conventions.md | Added multi-agent edge case matrix requirement to Planning section |
| Alarm restart bug repeated known pattern | learnings.md | Added alarm restart loop learning to Container SDK section |
| No multi-agent lifecycle learnings | learnings.md | New "Multi-Agent Lifecycle" section with edge case planning guidance |
| Stale TTL example in learnings | learnings.md | Updated `"96h"` example to `"2h"` |
| Stale TTL in security.md | security.md | Updated 2 references from "4 days" to "2 hours" |
| CI typecheck failure | config.ts | Extracted `ContentBlock` interface to fix type narrowing |

## 2026-03-03 - Product Engineer: From Zero to Working Agent

Full build-out of the Product Engineer system: orchestrator, agent, containers, deployment, and first successful autonomous ticket completion.

### Time Breakdown

| Started (PT) | Phase | 👤 Hands-On | 🤖 Agent | Problems |
|---------|-------|------------|----------|----------|
| Mar 1 6:30pm | Architecture & plan (design, write plan, dispatch subagents) | ████ 32m | ██████████████████████████████ ~5h | |
| Mar 2 9:58am | Security review (Codex, Cloudflare research, hardening) | ███ 24m | ███ 30m | |
| Mar 2 11:29am | Features & config (Slack flow, MCP, permissions, security docs) | ████ 32m | ██████ 60m | ⚠ Missing Slack integration discovered late |
| Mar 2 8:37pm | Secrets & setup (provision keys, Notion page, channel IDs, cleanup) | ███ 24m | ███ 30m | ⚠ 7 tool errors (Notion MCP flaky) |
| Mar 2 9:42pm | Deploy & initial debug (Docker, container startup, envVars) | ██████ 55m | ██████ 60m | ⚠ 6 distinct bugs: sleepAfter, Docker paths, container start, envVars shadowing, merge conflicts |
| Mar 2 11:11pm | Overnight autonomous debug (root user, plan mode, e2e verify) | ██ 15m | ██████████████████ ~3h | ⚠ Root blocks bypassPermissions, plan mode hangs headless |
| Mar 3 9:42am | PR review & polish (soften rules, Copilot feedback, fix tests) | █ 9m | █ 8m | |

### Metrics

| Metric | Duration |
|--------|----------|
| Total wall-clock | ~39 hours (Mar 1 6:30pm → Mar 3 9:53am PT) |
| Hands-on | ~3.2 hours (8%) |
| Agent autonomous | ~10 hours (26%) |
| Idle/away/sleeping | ~26 hours (66%) |
| Sessions | 6 (across 4 worktrees) |
| PRs created | 7 (#2, #11, #12, #13, #14, #15, #16) |
| Agent-created PRs | 1 (health-tool #56 — BC-66 rename) |

### Key Observations

**1. The deploy-debug cycle consumed the most effort (55m hands-on, 6 distinct bugs)**
Each bug was a different layer: Cloudflare Container SDK quirks (`sleepAfter` format, `envVars` class field shadowing), Docker build context paths, container lifecycle (`startAndWaitForPorts` vs `start`). These were all discoverable only at deploy time — no local dev environment for Cloudflare Containers.

**2. The overnight autonomous session was highly effective**
User said "keep working overnight" and walked away. The agent:
- Investigated SDK source code to understand `query()` internals
- Discovered root cause (root user blocks `bypassPermissions`) by adding `stderr` callback
- Fixed Dockerfile, redeployed, verified
- Discovered second issue (plan mode hangs headless), fixed prompt
- Triggered a fresh run and watched the agent complete BC-66 end-to-end
- Created the PR with full observability data
All with ~15 minutes of human setup.

**3. The Cloudflare Container SDK has sharp edges that aren't well-documented**
- `envVars` as a class field that shadows getters (JavaScript class semantics)
- `sleepAfter` only accepts hours, not days
- `alarm()` requires `{ isRetry, retryCount }` argument
- Container SDK docs are thin — had to read source code

**4. Security review was proactive and caught real issues**
Used Codex CLI + manual review in parallel. Caught: no auth on internal routes, unsanitized ticket IDs, exposed status data. Most were addressed immediately.

**5. Friction from context window exhaustion**
The main build session (56 turns) hit context limits and required a continuation session. The continuation lost some context and had to re-read files.

**6. Git workflow was messy in the deploy phase**
14+ errors from merge conflicts, wrong branches, cherry-pick issues. Multiple "please merge" user messages. The rush to fix deploy bugs while keeping PRs clean caused thrash.

### Actions Taken

| Issue | Action Type | Change |
|-------|-------------|--------|
| Plan mode hangs headless agent | Prompt update | Added "NEVER use plan mode" rule to `agent/src/prompt.ts` |
| AskUserQuestion hangs headless | Prompt update | Redirected to `ask_question` MCP tool (posts to Slack) |
| Root user blocks bypassPermissions | Dockerfile fix | Run agent container as non-root `agent` user |
| envVars getter shadowed by class field | Code fix | Replaced getter with constructor assignment in both DOs |
| Phone-home overwrites branch_name | Code fix | Stopped sending diagnostics via `branch_name` field |
| No observability into container crashes | Code fix | Added `onStop`/`onError` lifecycle hooks, stderr callback |
| Disabled MCP servers breaking tests | Test fix | Skipped Notion/Sentry tests (npx hangs in containers) |

## 2026-03-03 - Slack Socket Mode debugging + PR review feedback

Debugged why `@product-engineer` Slack mentions weren't working, fixed container liveness after deploys, and addressed Copilot review feedback across PRs #20, #21, #22.

### Time Breakdown

| Started (PT) | Phase | 👤 Hands-On | 🤖 Agent | Problems |
|---------|-------|------------|----------|----------|
| Mar 3 2:01pm | Debug Slack Socket Mode (WORKER_URL, container dormancy) | ██ 15m | █ 14m | ⚠ 3 errors during deploy/investigation |
| Mar 3 2:30pm | Re-trigger stalled agents (API calls, wrong thread IDs) | ██ 20m | █ 11m | ⚠ Wrong timestamps, user did it manually |
| Mar 3 3:01pm | PR creation + review fixes (#20, #21, #22) | █ 13m | █ 5m | ⚠ Rebase conflict, typecheck failure |
| Mar 3 3:19pm | Wrap-up | 2m | 1m | |

### Metrics

| Metric | Duration |
|--------|----------|
| Total wall-clock | 1h 21m |
| Hands-on | ~50m (62%) |
| Automated agent time | ~31m (38%) |
| Idle/away | minimal |
| PRs addressed | 3 (#20, #21, #22) |
| Retro analysis time | ~8 min |

### Key Observations

1. **WORKER_URL placeholder was the root cause of Slack not working** — `wrangler.toml` had `<your-subdomain>` sitting in production unnoticed. Container started fine, connected to Slack, but couldn't forward events.
2. **Re-triggering stalled agents was a 20-min dead end** — Used wrong thread timestamps from logs, created duplicate tickets instead of routing to existing ones. Should have recognized earlier that original tasks came from Linear, not Slack.
3. **Container liveness flag (`containerStarted`) goes stale across deploys** — In-memory boolean survives DO restarts but the container process is replaced. Fixed with TCP health check probe.
4. **Three PRs of review feedback handled efficiently** — Parallelized investigation, bundled PR #21 fixes into PR #22 since #21 was already merged.

### Feedback

**What worked:** Debugging Slack Socket Mode was fast — root cause identified within minutes. PR review feedback was handled in parallel across three PRs.

**What didn't:** Re-triggering stalled agents via internal API wasted time — wrong approach for tasks that originated from Linear.

### Actions Taken

| Issue | Action Type | Change |
|-------|-------------|--------|
| Container in-memory flag stale across deploys | learnings.md | Added gotcha about health-checking before trusting flags |
| WORKER_URL placeholder unnoticed | learnings.md | New "Cloudflare Deployment Config" section |
| Slack thread re-trigger duplicates | learnings.md | New "Slack Thread Routing" section |
| CLAUDE.md missing deployment safety info | CLAUDE.md | Added `agent_active`, `[vars]` config, and deployment-safety.md pointers |
| Missing test coverage for agent_active | Linear ticket | Created BC-80 |
