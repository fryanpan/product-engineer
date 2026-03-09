# LLM Orchestrator Design: Event Catalogue & Decision Framework

**Goal:** Replace the rules-based orchestrator with LLM-enhanced decision-making that eliminates the 1+ hour/day of human oversight.

**Core insight:** The current system has "Smart + Narrow" (TicketAgent sees one ticket deeply) and "Dumb + Wide" (Orchestrator sees all tickets but uses if/else). Nobody has **both intelligence and system-wide awareness**. The LLM Orchestrator gives the wide-scope component actual reasoning ability.

**Architecture (unchanged):** Orchestrator DO gains a Decision Engine that makes Anthropic API calls at key decision points. Decisions are async, logged to SQLite, and fall back to rules-based behavior on failure. The TicketAgent remains the implementation engine.

---

## Event Catalogue

Every event that flows through the system, with real examples and how the LLM should reason about them.

---

### 1. Ticket Creation (`ticket_created`)

**Source:** Linear webhook (issue create, assigned to agent)
**Current handling:** If assigned to agent email AND not terminal → create ticket row, route to agent, select model by keyword heuristic
**Frequency:** ~3-10/day

#### Real Examples

**Example A: BC-125 (Agent Dashboard with Google OAuth)**
- Linear ticket created, priority 2 (High), labels: `feature`
- Title: "Agent Dashboard with Google OAuth"
- Orchestrator created ticket, selected Sonnet (medium complexity), routed to TicketAgent
- Agent implemented full OAuth flow, dashboard UI, deployment
- Result: **PR #67 merged** — took ~45 minutes, worked well
- **Decision was correct.** Standard routing worked fine.

**Example B: BC-133 (Fix Slack Threading)**
- Linear ticket, priority 2, labels: `bug`
- Title: "Fix Slack threading — replies go to ticket thread"
- Orchestrator routed to agent, selected Sonnet
- Agent found the bug, fixed it, but the fix was incomplete — needed 3 separate sessions (commits edf0236, 9b014f6, 9c79c4c) to fully resolve
- Result: **PR #69 merged** — took multiple sessions across 2 days
- **What went wrong?** Nothing wrong with triage. The issue was that the agent didn't fully test the fix before declaring done. The orchestrator can't help here — this is TicketAgent quality.

**Example C: BC-118 (Agent Container Cleanup — investigation ticket)**
- Linear ticket created as investigation: "20 agents running, need cleanup"
- Orchestrator routed normally
- Agent began investigating, found 5 separate root causes, created 5 PRs (#55, #58, #61, #63, #64)
- Result: **Closed after manual coordination** — took days, required human oversight at every step
- **What went wrong?** This was a *meta-ticket about the orchestration system itself*. The agent couldn't fix the system it was running on. An LLM orchestrator should recognize self-referential tickets and escalate immediately: "This ticket is about the orchestrator infrastructure. I can't fix my own container lifecycle. Escalating to human."

**Example D: Slack-triggered ticket (hypothetical from workflows.md)**
- User @mentions agent: "Fix the BMI chart — it's showing wrong values"
- Creates `slack-{ts}` ticket ID, routes to agent
- Agent clones repo, reads code, fixes chart, creates PR, auto-merges
- Result: **Merged in 15 minutes**
- **Decision was correct.** Simple, well-scoped task.

#### How Should the LLM Decide?

The LLM triage gets: event type, ticket metadata (title, description, priority, labels), current system state (how many agents running, any stuck), and the product config.

**Decision output:** `{ action: "route" | "ignore" | "escalate" | "defer", model: "haiku" | "sonnet" | "opus", reason: string }`

**Key reasoning the LLM should apply:**

1. **Is this a self-referential ticket?** (mentions orchestrator, container, agent lifecycle, deployment pipeline) → **Escalate.** The agent can't fix its own infrastructure.

2. **Is this a duplicate of an active ticket?** Compare title/description against active tickets. If substantially similar → **Ignore** and note in Slack: "This looks like a duplicate of [active ticket]. Ignoring."

3. **Is the system overloaded?** If 5+ agents already running, consider deferring low-priority tickets. The LLM can reason about resource pressure in a way rules can't.

4. **Model selection should be richer than keyword matching.** Current heuristic scores keywords like "architecture" and "typo." The LLM should read the actual description and assess: How many files will this touch? Does it require cross-system changes? Is there ambiguity in the requirements? A "simple-sounding" ticket with vague requirements needs Opus more than a complex-sounding ticket with clear specs.

5. **Does this ticket need clarification before starting?** If the description is too vague to act on, the orchestrator should ask for clarification in Slack BEFORE spawning an agent. Current behavior wastes a container on vague tickets.

**What this replaces:** `model-selection.ts` keyword scoring, hardcoded `isAssignedToAgent` check, simple terminal-state guard.

---

### 2. PR Review Events (`pr_review`, `pr_review_comment`, `pr_comment`)

**Source:** GitHub webhook (review submitted, comment on PR)
**Current handling:** Extract branch → extract task ID → route event to agent. No filtering, no intelligence.
**Frequency:** ~2-5/day per active ticket

#### Real Examples

**Example A: BC-125 Copilot Review — 15 items**
- Copilot submitted automated review with 15 suggestions on PR #67
- Event forwarded to agent as `pr_review` with `review_state: "commented"` and `review_body`
- Agent received all 15 items, addressed them in one commit (fa9be54)
- Result: **Fixed all items, merged** — worked well
- **Decision was correct.** But the current system sends ALL review comments to the agent even if they're bot-generated noise. An LLM orchestrator could filter: "These are automated style suggestions, not human feedback. Route to agent but note: 'These are automated suggestions — fix what's valid, skip what's noise.'"

**Example B: Copilot Review on PR with no meaningful feedback**
- Copilot submits "LGTM" review with `review_state: "approved"` and empty body
- Current system: Routes to agent, agent wakes up, reads empty review, does nothing useful, wastes a turn
- **What went wrong?** Empty/trivial approvals from bots should be handled without waking the agent. An LLM orchestrator should recognize: "This is an automated approval with no action items. If checks pass, proceed to merge evaluation."

**Example C: Human review requesting changes**
- User reviews PR, requests specific code changes
- Event forwarded to agent
- Agent reads feedback, implements changes, pushes, notifies Slack
- **Decision was correct.** Human reviews with `changes_requested` should always route to agent.

**Example D: Review comment on a merged PR**
- After PR merges, someone leaves a comment
- GitHub sends `issue_comment` event
- Current system: Extracts branch, finds task ID, looks up ticket... which is already `merged` (terminal)
- Orchestrator ignores because terminal state check catches it
- **Decision is correct** but for wrong reason. An LLM should recognize: "This is a post-merge comment. If it describes a bug, create a new ticket. If it's just feedback, acknowledge in Slack."

#### How Should the LLM Decide?

**Decision output:** `{ action: "route_to_agent" | "auto_handle" | "ignore" | "create_followup", reason: string }`

**Key reasoning:**

1. **Who is the reviewer?** Bot (Copilot, CodeRabbit) vs human. Bot reviews with only "LGTM" → auto-handle (skip agent, proceed to merge evaluation). Bot reviews with specific changes → route to agent but label as "automated suggestions."

2. **What state is the review?** `approved` → trigger merge evaluation (don't need agent). `changes_requested` → always route to agent. `commented` → depends on content (substantive feedback vs drive-by comment).

3. **Is the PR already merged?** Post-merge feedback should create a followup ticket, not re-activate a dead agent.

4. **How many review rounds have happened?** If this is the 4th review cycle, the agent may be going in circles. LLM should check: "Has the same feedback been given twice? If so, escalate to human."

---

### 3. CI/Check Events (`checks_passed`, `checks_failed`, `ci_failure`, `workflow_failure`)

**Source:** GitHub webhook (`check_suite`, `check_run`, `workflow_run`)
**Current handling:** Only routes failures; ignores successes (except `check_suite` which routes both). No merge triggering on success.
**Frequency:** ~5-20/day (multiple checks per push)

#### Real Examples

**Example A: Tests pass after agent push**
- Agent pushes fix, CI runs, `check_suite` completes with `conclusion: "success"`
- Current: `checks_passed` event routed to agent
- Agent receives it but has no clear instruction on what to do — the agent prompt for `ci_status` just says "If it passed, continue with the workflow"
- **What went wrong?** The orchestrator should own the merge decision. When CI passes, the orchestrator should evaluate whether to merge — not send a vague prompt to the agent.

**Example B: CI failure — agent fixes and pushes again**
- Agent creates PR, CI fails due to test regression
- `ci_failure` event sent to agent with check name, conclusion, output summary
- Agent reads failure, fixes code, pushes again
- CI passes on second attempt
- Result: **Eventually merged** — but added latency. The agent had to wake up, parse CI output, fix, push.
- **Decision was mostly correct.** But the CI failure event currently only includes `output_title` and `output_summary` — often not enough to diagnose. The event should include the actual failure logs or a link the agent can fetch.

**Example C: Flaky test / external service timeout**
- CI fails due to intermittent network issue, not code problem
- Current: Agent wakes up, reads vague failure output, tries to "fix" code that isn't broken
- Result: **Wasted agent turns and money**
- **What should happen?** LLM orchestrator should recognize: "This is a flaky failure (network timeout, not assertion failure). Retry CI rather than waking the agent." It can distinguish flaky failures by checking: (1) Has this check failed before on other branches? (2) Is the failure message about timeouts/connections rather than assertions? (3) Did the same check pass recently?

**Example D: Copilot review check suite vs CI test check suite**
- GitHub sends separate `check_suite` events for Copilot review, CI tests, and deploy previews
- Current system: Treats all check suites the same way
- **What should happen?** The orchestrator should distinguish: Copilot review completion → check for review comments. CI test completion → evaluate merge readiness. Deploy preview completion → note URL for testing.

#### How Should the LLM Decide?

**Decision output:** `{ action: "evaluate_merge" | "route_failure_to_agent" | "retry_ci" | "ignore" | "escalate", reason: string }`

**Key reasoning:**

1. **On success:** Don't route to agent. Evaluate merge readiness directly. Check: Are ALL required checks passing? Is there an approved review? Are there unresolved review comments? If all green → merge (or request review for high-risk changes).

2. **On failure — is this flaky?** Check failure message content. Network timeouts, "service unavailable", rate limits → retry CI. Assertion failures, type errors, lint failures → route to agent.

3. **On failure — how many retries?** First failure → route to agent. Same test failing 3+ times → escalate to human: "Agent has failed to fix this test after 3 attempts."

4. **Which check is this?** Not all checks matter equally. A Copilot review "check" completing doesn't mean CI passed. The orchestrator needs to track which checks are required for merge.

---

### 4. PR Merge Events (`pr_merged`)

**Source:** GitHub webhook (PR closed + merged)
**Current handling:** Route event to agent → agent updates status to `merged` → orchestrator marks terminal → container shuts down
**Frequency:** ~2-5/day

#### Real Examples

**Example A: Agent auto-merges its own PR (BC-125)**
- Agent finished dashboard, created PR, CI passed, agent ran `gh pr merge --squash`
- GitHub sends `pr_merged` webhook
- Orchestrator receives it, forwards to agent
- Agent gets event, calls `update_task_status(merged)`, does retro, exits
- **Decision was correct** but the handshake is redundant. The agent already knows it merged — it initiated the merge. The webhook is just confirmation.

**Example B: Human merges agent's PR**
- Agent created PR, requested review, human approved and merged
- GitHub sends `pr_merged` webhook
- Orchestrator receives, forwards to agent
- Agent gets event, updates status, does retro
- **Decision was correct.** The agent needs this event to know it can wrap up.

**Example C: PR merged after container died (post-BC-118 scenario)**
- Agent created PR, container timed out before merge happened
- Human merged PR manually later
- GitHub sends `pr_merged` webhook
- Orchestrator receives it, looks up ticket... ticket might still be `pr_open` with `agent_active = 1`
- Routes to TicketAgent, but container is dead
- Event gets buffered in TicketAgent DO's event_buffer table
- **What went wrong?** The orchestrator should handle `pr_merged` itself — update status to `merged`, mark terminal, notify Slack — WITHOUT needing the agent container. The agent is just the implementation engine; the orchestrator should own state transitions.

#### How Should the LLM Decide?

**Decision output:** `{ action: "finalize" | "route_to_agent", reason: string }`

**Key reasoning:**

1. **`pr_merged`**** is a terminal event.** The orchestrator should handle it directly: update ticket to `merged`, mark `agent_active = 0`, notify Slack, shut down container. No need to route to agent first.

2. **If agent is alive:** Also send event so agent can do a brief retro. But don't DEPEND on the agent — the state transition should happen regardless.

3. **Check for follow-up work:** Was there a deployment? Any post-merge checks to monitor? The LLM can note: "PR merged. Deployment should happen within 5 minutes. I'll check deployment status at next supervisor tick."

---

### 5. Slack Mentions & Thread Replies (`app_mention`, `slack_reply`)

**Source:** Slack Socket Mode via orchestrator companion container
**Current handling:** New mentions → create ticket, route to agent. Thread replies → look up ticket by `thread_ts`, route `slack_reply` event.
**Frequency:** ~5-15/day

#### Real Examples

**Example A: New @mention — clear task**
- User: "@product-engineer fix the BMI chart — values are wrong for metric units"
- Orchestrator creates `slack-{ts}` ticket, resolves product from channel, routes to agent
- Agent clones, fixes, creates PR, auto-merges
- Result: **Merged in 15 minutes**
- **Decision was correct.** Clear, actionable request.

**Example B: New @mention — vague task (from user's frustrations)**
- User: "@product-engineer improve the dashboard"
- Orchestrator creates ticket, routes to agent
- Agent starts working on... what exactly? Picks some random improvement, spends 30 minutes implementing something the user didn't want
- Result: **Wasted credits, user frustrated**
- **What should happen?** LLM should recognize: "This request is vague. Before spawning an agent, ask clarifying questions in the thread: 'What specifically would you like improved? The layout, the data displayed, the performance?'"

**Example C: @mention in existing thread (BC-133 bug)**
- User replies in an active ticket's thread: "@product-engineer actually, also fix the header color"
- Before BC-133 fix: Used `slackEvent.ts` (reply ts) as thread root → created NEW thread instead of using existing one
- After fix (9c79c4c): Uses `slackEvent.thread_ts` to route to existing ticket
- **Decision is now correct** after the fix. But the current system always adds the extra request to the existing ticket — even if it's unrelated. An LLM should assess: "Is this related to the current ticket, or should this be a new task?"

**Example D: Thread reply answering agent's question**
- Agent asked: "Should I use REST or GraphQL for this endpoint?"
- User replies: "REST is fine"
- `slack_reply` event forwarded to agent
- Agent continues implementation
- **Decision was correct.** Simple question-answer flow.

**Example E: Thread reply with status question**
- User: "what's the status on this?"
- Current: Forwarded to agent, agent wakes up, posts a status update, wastes a turn
- **What should happen?** The orchestrator has all the status information already (SQLite). It should answer status questions directly: "Status: `in_progress`, branch: `ticket/BC-125`, last heartbeat: 2 minutes ago." No need to wake the agent.

#### How Should the LLM Decide?

**Decision output:** `{ action: "route_to_agent" | "ask_clarification" | "answer_directly" | "create_new_ticket" | "ignore", reason: string }`

**Key reasoning:**

1. **Is the request clear enough to act on?** If vague → ask clarifying questions in thread before spawning agent. The LLM can distinguish "fix the bug where X happens when Y" (actionable) from "improve the dashboard" (vague).

2. **Is this a status question?** "What's the status?" / "How's it going?" / "Update?" → Answer directly from SQLite. Don't wake agent.

3. **Is this a new task or continuation?** If @mention is in an existing ticket's thread, the LLM should assess: Is the request related to the current ticket (add it as continuation) or a separate task (create new ticket)?

4. **Is this an emergency?** "The site is down" / "Users can't log in" → Prioritize immediately, possibly interrupt a low-priority agent.

---

### 6. Agent Status Updates (phone-home)

**Source:** Agent server → Worker → Orchestrator DO (via POST /api/status)
**Current handling:** Update SQLite row (status, pr_url, branch_name, slack_thread_ts). If terminal status → mark inactive + notify TicketAgent DO.
**Frequency:** ~5-20/day per active ticket

#### Real Examples

**Example A: Normal lifecycle progression**
- Agent reports: `status: "in_progress"` → `status: "pr_open"` → `status: "merged"`
- Orchestrator updates DB at each step, marks terminal on `merged`
- **Works correctly.**

**Example B: Agent reports \****`failed`**
- Agent hits unrecoverable error, reports `status: "failed"`
- Orchestrator marks terminal, shuts down container
- **But:** No one investigates WHY it failed. The failure reason is buried in container logs.
- **What should happen?** On `failed` status, the LLM should: (1) Check the agent's last Slack messages for error context. (2) Post to Slack: "Agent failed on [ticket]. Last status before failure: [context]. Likely cause: [assessment]. Should I retry or defer?" This turns an invisible failure into an actionable notification.

**Example C: Agent goes silent — no heartbeat for 30+ minutes**
- Current: `checkAgentHealth()` finds stale heartbeat, logs it (report-only)
- **What should happen?** The supervisor should diagnose: Is the container dead? (health check fails) Did the agent get stuck in a loop? (high token usage, no progress) Is it waiting for a response? (last action was `ask_question`). Then take action: restart if dead, escalate if stuck, wait if pending response.

**Example D: Zombie agent — BC-118 scenario**
- 13 agents running with `agent_active = 1` but containers dead
- No heartbeats, no status updates, but `agent_active` flag never cleared
- Required manual cleanup endpoint (`/cleanup-inactive`)
- **Root cause:** Agents reached terminal state before the shutdown fix was deployed. Their `agent_active` flags were never flipped.
- **What the LLM supervisor should do:** Every tick, check for `agent_active = 1` with no heartbeat in 30+ minutes. If health check fails → force mark inactive and shut down. This replaces the manual cleanup with automatic detection.

#### How Should the LLM Decide?

**For status updates:** Mostly mechanical — update DB, check for terminal state. The LLM adds value on:

1. **Failed status:** Diagnose from available context, notify human with assessment
2. **Repeated restarts:** If an agent has been restarted 3+ times for the same ticket → escalate
3. **Cost monitoring:** If a ticket has consumed >$5 in tokens → alert in Slack

**For health monitoring (supervisor tick every 5 min):**

1. **Stale heartbeat + health check fails** → Container dead. If work in progress (branch exists, PR open) → restart container. If no work started → mark failed, notify.
2. **Stale heartbeat + health check passes** → Agent stuck in a loop. Check token usage — if growing fast, agent is burning money without progress. Kill and escalate.
3. **Active for >2 hours** → Approaching container TTL. Check progress. If PR is open and waiting for review → normal. If still implementing → warn user that this is a long-running task.

---

### 7. Deploy/Restart Events (container lifecycle)

**Source:** Container SDK alarm, auto-resume on container start
**Current handling:** `alarm()` calls `ensureContainerRunning()` (health check + restart). Auto-resume checks for git branch and starts new session.
**Frequency:** Every 60 seconds (alarm) + on deploy

#### Real Examples

**Example A: Normal deploy — agent working on BC-133**
- `wrangler deploy` triggers container replacement
- New container starts, auto-resume fires (5s delay)
- Detects `ticket/BC-133` branch on remote
- Builds resume prompt with git log + status + PR info
- Agent continues where it left off
- **Works correctly after the PR #65 fix.**

**Example B: Deploy after ticket already merged (BC-118 root cause)**
- Deploy triggers container restart for ALL TicketAgent DOs
- Containers that were already done (terminal status) get restarted
- Before fix: Alarm fires, `ensureContainerRunning()` starts container, auto-resume clones branch, starts new session → zombie agent
- After fix (PR #61): `alarm()` checks `isTerminal` flag before restarting
- **Fixed now, but illustrates the pattern.** Every lifecycle action needs: "Is this ticket still active?"

**Example C: Deploy while agent waiting for review**
- Agent created PR, posted to Slack, waiting for human review
- Deploy happens, container replaced
- Auto-resume starts new session, agent checks PR status... sees it's still waiting for review
- Agent has nothing to do but can't stop because it's "active"
- Sits idle for 30 minutes until idle timeout
- **What should happen?** The orchestrator should recognize: "This agent is waiting for external input (review). Don't restart the container — buffer incoming events and only restart when a review arrives."

#### How Should the LLM Decide?

The deploy/restart decision should be in the **supervisor tick**, not on deploy:

1. **Should this container be running?** Check: Is ticket terminal? Is agent waiting for external input? Has the agent been idle for >15 minutes? → Don't restart.

2. **Should this container be restarted?** Check: Is there active work (recent commits, agent was mid-implementation)? Is there a pending event in the buffer? → Restart.

3. **Should this container be killed?** Check: Terminal status? Agent reported failed? No activity for >1 hour with no pending events? → Kill and free resources.

---

## The Five Decision Points (Summary)

| # | Decision | Trigger | Current Logic | LLM Adds |
| --- | --- | --- | --- | --- |
| **1** | Event Triage | Any incoming event | Terminal check → route | Duplicate detection, vague-request clarification, self-referential ticket escalation, system load awareness, richer model selection |
| **2** | Merge Evaluation | CI passes on a PR | Agent decides (category-based: CSS=auto, API=review) | Orchestrator reads diff, assesses risk from content not categories, checks for test coverage, evaluates deployment impact |
| **3** | Supervisor | Every 5 min alarm | Report-only health check | Diagnose stuck/dead agents, detect zombies, monitor costs, manage container lifecycle intelligently, re-deliver missed events |
| **4** | Failure Triage | Agent reports `failed` or CI fails | Route to agent (CI) or mark terminal (failed) | Distinguish flaky CI from real failures, diagnose agent failures with context, retry vs escalate |
| **5** | Self-Improvement | Weekly/daily trigger | None | Review outcomes, identify patterns, propose skill/rule changes |

---

## Deep Dive: Merge Evaluation (the highest-value decision)

### Philosophy: Auto-merge is the default

The existing systems (Stripe Minions, Devin, SWE-agent) all require human review before merge. But those systems serve production businesses with billion-dollar revenues and much higher stakes. Product Engineer serves personal/hobbyist projects where:

- **Speed matters more than zero-defect.** If >90% of auto-merged changes are correct (or good-enough for personal use), the <10% can be caught in production and fixed quickly.
- **The overhead of manual review is the bottleneck.** Every PR that requires human review adds 30 minutes to hours of latency and context-switching.
- **Feature flags provide a safety net.** For risky features, flag them. Roll back if broken.
- **Staging environments provide verification.** If the agent can deploy to staging and prove the feature works (not just that tests pass), auto-merge confidence is very high.

**The default is auto-merge.** Escalation to human review only when the LLM identifies risk to three hard gates:

1. **Security / sensitive data** — authentication, authorization, encryption, API keys, PII handling
2. **Data integrity** — database schema migrations, data deletion, backup/restore changes
3. **Core user-facing workflows** — features that users (mostly the owner) depend on daily (e.g., symptom logging on health-tool, ride tracking on bike-tool)

Everything else auto-merges after CI passes + staging verification. New features, UI changes, refactors, config changes, dependency updates (non-security) — all auto-merge.

### Input for merge evaluation:
1. **The actual diff** (via GitHub API: `GET /repos/{owner}/{repo}/pulls/{number}/files`)
2. **CI results** (all checks passing?)
3. **Staging verification** (deployed to staging? feature verified working?)
4. **Ticket context** (what was asked? does the diff match?)
5. **Test coverage** (did the agent add/modify tests for the changed code?)

### Questions the LLM should answer:
1. **Does this change touch any of the three hard gates?** (Security, data integrity, core workflows) → If yes and risk can't be demonstrated as low, escalate.
2. **Does this diff do what the ticket asked for, and nothing else?** (Scope creep detection)
3. **Has the agent verified the feature works on staging?** (Not just CI — actual behavior verification)
4. **Are there tests for the new/changed behavior?**
5. **Is the LLM confident in its assessment?** If confidence is low → escalate rather than guess.

### Decision outputs:
- **Auto-merge:** CI passes, staging verified, no hard-gate risk, diff matches ticket → merge immediately
- **Escalate to human:** Touches hard gates (security/data/core workflows) AND agent can't demonstrate risk is low
- **Block and send back:** Diff doesn't match ticket, staging verification failed, or obvious bugs → send back to agent with instructions

### Example merge evaluations (revisited):

**BC-125 (Dashboard with OAuth):** Added new authentication flow. This touches **hard gate #1 (security)**. The LLM should check: Did the agent add tests for the auth flow? Does staging show the OAuth redirect working? Are credentials handled securely? If yes to all → auto-merge. If any uncertainty → escalate. In this specific case, the agent implemented OAuth correctly with proper scoping — an LLM reviewer reading the diff would likely auto-merge.

**BC-133 (Thread fix):** Changed 1 line in `orchestrator.ts`. No hard gates touched. CI passes. → Auto-merge without hesitation. The current category-based system would say "request review" because it touches "API code" — unnecessarily conservative.

**Hypothetical: New symptom logging endpoint on health-tool:** Touches **hard gate #3 (core user workflow)** — symptom logging is used daily. The LLM should check: Does staging show the new endpoint working? Does the existing logging flow still work? If verified → auto-merge. If the agent can't demonstrate existing flow works → escalate.

### Staging verification as the confidence multiplier

The LLM's merge confidence comes primarily from **verification, not reasoning**. An LLM reading a diff can miss subtle bugs. An LLM reading "staging deployment succeeded, feature smoke test passed, existing tests pass" has much higher confidence.

Each product should have a staging environment. The merge evaluation flow becomes:

```
CI passes → Deploy to staging → Agent verifies feature on staging → LLM evaluates merge
```

If staging verification passes: auto-merge almost everything (except hard-gate escalations where risk demonstration fails).
If staging verification fails or is unavailable: apply more conservative heuristics (test coverage, diff size, hard-gate proximity).

---

## Deep Dive: Supervisor Tick (the biggest gap)

Currently `checkAgentHealth()` is report-only (line 750 of orchestrator.ts). It finds stale heartbeats but takes no action. The user's frustration: "I'm spending 1+ hour/day managing agent overhead."

### What the supervisor should check every 5 minutes:

```
For each ticket where agent_active = 1:
  1. Heartbeat age → Is the agent responding?
  2. Container health → Is the process alive?
  3. Token usage trend → Is cost reasonable?
  4. Status progression → Is work actually progressing?
  5. Pending events → Are there undelivered events?

For tickets in pr_open status:
  6. CI status → Have checks completed?
  7. Review status → Any reviews pending?
  8. PR age → Has it been open too long without merge?

System-wide:
  9. Total active agents → Are we overloaded?
  10. Total cost today → Budget check
```

### What actions the supervisor should take:

| Condition | Action |
| --- | --- |
| Heartbeat stale >30min, health check fails | Restart container (if non-terminal), notify Slack |
| Heartbeat stale >30min, health check passes | Agent stuck — kill and escalate to human |
| Agent active >2h with no PR created | Likely stuck — escalate to human |
| PR open >4h with CI passed and no review | Nudge in Slack: "PR ready for review" |
| Agent cost >$5 on one ticket | Alert in Slack, consider killing |
| 5+ agents active simultaneously | Defer new low-priority tickets |
| Pending events in buffer for >10min | Re-deliver, check container health |
| Same failure event received 3+ times | Stop routing, escalate |

### Real example the supervisor would have caught:

**BC-118 zombie agents:** 13 containers running with no heartbeats, no progress, burning compute. The supervisor would have detected this at the first tick: "13 agents with stale heartbeats. Health checks fail on all 13. None are in terminal state in DB, but containers are dead. Marking all 13 inactive and shutting down containers." This would have prevented the entire BC-118 investigation.

---

## Architectural Principle: Ephemeral Agents, Persistent Orchestrator

Every similar system (Aperant, Anthropic Quickstart, Stripe Minions) creates a fresh SDK client per session. No system maintains a long-running agent. Product Engineer should be even more aggressive:

**Agent containers spin down within 5 minutes of completing a logical unit of work:**
- PR created → agent reports status, does retro, exits within 5 min
- Review feedback addressed → agent pushes fix, exits within 5 min
- Merge done → agent does retro, exits immediately
- Agent asked a question via Slack → agent exits, orchestrator will spin up new session when reply arrives

**The orchestrator is always on.** It receives all events, evaluates them, and decides:
- Handle directly (status questions, terminal events, simple CI retries)
- Spin up a new agent session (new work, review feedback, CI failure needing code changes)
- Buffer for later (events for tickets waiting on external input)

**Why this is better than keeping agents alive:**
- Eliminates zombie agents entirely — nothing stays alive to become a zombie
- Fresh context window every session — no degradation from accumulated noise
- Lower cost — no idle containers burning compute
- Simpler lifecycle — the only states are "not running" and "briefly running"
- Orchestrator can choose the right model per session (Haiku for a CI fix, Opus for a complex review)

**Progress persistence via JSON + git:**
- `ticket-state.json` in the orchestrator's SQLite tracks structured progress per ticket
- Git branches + commits are the source of truth for code state
- New sessions resume from: ticket-state.json (what to do) + git branch (where the code is)

### Retry budgets

Hard caps on every retry loop. Agents that loop indefinitely are the #1 cause of wasted credits.

| Scenario | Max Retries | On Exhaustion |
| --- | --- | --- |
| CI fix attempt | 3 | Escalate to human |
| PR review feedback cycle | 3 rounds | Escalate: "Agent can't resolve feedback" |
| Agent session restart (crash/error) | 2 | Mark failed, notify |
| Vague task clarification | 2 questions | Escalate: "Need clearer requirements" |

---

## Implementation Priority

Based on the above analysis, ordered by impact on the user's daily overhead:

| Priority | Decision Point | Why First | Estimated Value |
| --- | --- | --- | --- |
| **P0** | Supervisor tick + ephemeral agents | Eliminates zombie detection, stuck agent management, cost monitoring. This is where the 1h/day overhead comes from. | Saves ~45 min/day |
| **P1** | Merge evaluation + staging | Enables auto-merge for almost everything. Most visible quality improvement. | Saves ~10 min/day, eliminates review bottleneck |
| **P2** | Event triage (vague requests) | Stops wasting agent time on unclear tasks | Saves ~5 min/day, reduces credit waste |
| **P3** | Failure triage + retry budgets | Distinguishes flaky CI from real failures, prevents infinite loops | Saves ~5 min/day |
| **P4** | Self-improvement (outcome logging) | Only valuable once P0-P3 are stable | Long-term compound value |

---

## Decision Engine Design

The Decision Engine is a single function that makes Anthropic API calls:

```typescript
interface DecisionRequest {
  type: "triage" | "merge_eval" | "supervisor" | "failure_triage";
  context: Record<string, unknown>; // All relevant data for the decision
}

interface DecisionResponse {
  action: string;       // Decision-specific action
  reason: string;       // Human-readable explanation
  confidence: number;   // 0-1, for logging
}
```

**Key constraints:**
- Max 30 seconds per decision (use Haiku for speed-sensitive decisions, Sonnet for merge eval)
- Log every decision to SQLite (`decision_log` table: timestamp, type, context hash, action, reason)
- On API failure → fall back to current rules-based behavior
- Never block event delivery — decisions are `ctx.waitUntil()` for triage, synchronous only for merge eval

**Prompt structure:**
- System prompt: Compact system-wide context (active tickets, costs, recent decisions)
- User prompt: Specific decision context (event data, ticket state, relevant history)
- No chat history needed — each decision is independent

**Cost estimate:** ~$0.005 per decision (Haiku) to ~$0.05 per decision (Sonnet). At ~50 decisions/day = $0.25-$2.50/day. Tiny compared to agent costs (~$20-40/day for implementation).

---

## What Changes in the Codebase

| Component | Change |
| --- | --- |
| `orchestrator/src/decision-engine.ts` | **New.** Anthropic API client, prompt templates, decision logging |
| `orchestrator/src/context-assembler.ts` | **New.** Assembles structured context packets (GitHub diff, CI status, PR reviews, ticket history) before any LLM call |
| `orchestrator/src/orchestrator.ts` | `handleEvent()` gains triage call. New `supervisorTick()` with real actions. New `evaluateMerge()` endpoint. Handles `pr_merged` directly (terminal transitions without agent). |
| `orchestrator/src/ticket-agent.ts` | Aggressive teardown: 5-min exit after logical completion. Reduced `sleepAfter`. Agent exits on PR creation, review addressed, merge done, or question asked. |
| `.claude/skills/product-engineer/SKILL.md` | Remove auto-merge logic from agent. Agent creates PR and stops — orchestrator handles merge. Add "exit after logical completion" instruction. |
| `agent/src/prompt.ts` | Remove merge instructions. Add structured progress updates (JSON status reports). |
| `agent/src/server.ts` | Reduce idle timeout from 30min to 5min. Exit immediately after session completion instead of waiting. |
| `orchestrator/src/model-selection.ts` | Delete — replaced by LLM triage |
| SQLite schema | Add `decision_log` table, `outcomes` table, `ticket_state` JSON column on tickets |

---

## Edge Case Matrix (Lifecycle Boundaries)

Per workflow convention: explicit enumeration of lifecycle edge cases.

| Scenario | What Happens | Correct Behavior |
| --- | --- | --- |
| Container restart for terminal ticket | Alarm fires, checks isTerminal | Skip restart (existing behavior, verified) |
| Deploy while agent waiting for review | Auto-resume starts new session | Supervisor should NOT restart — buffer events, restart on review arrival |
| Agent fails, then retry webhook arrives | New event for failed ticket | LLM triage: "Ticket failed. Should I retry based on this new event?" — assess and decide |
| Two events arrive simultaneously for same ticket | Race condition on routing | Event buffer in TicketAgent DO handles this (existing behavior) |
| Agent creates PR, then container dies before merge eval | pr_open status, no agent | Supervisor detects: "PR open, agent dead, CI passed → evaluate merge directly" |
| Self-referential ticket (fix orchestrator) | Agent can't fix its own infrastructure | LLM triage escalates immediately |
| Vague Slack @mention | Agent wastes time on unclear task | LLM asks clarification before spawning agent |
| Status question in ticket thread | Agent wakes up unnecessarily | LLM answers directly from DB |
| 5+ agents running, new low-priority ticket | Resource pressure | LLM defers: "4 agents active. Deferring low-priority ticket until one completes." |
| Flaky CI failure | Agent tries to "fix" non-broken code | LLM recognizes flaky pattern, retries CI |
| Same review feedback given 3 times | Agent going in circles | LLM escalates: "Agent hasn't resolved this feedback after 3 attempts" |
