# Agent Systems Research Summary

Research conducted across Autoclaude variants, production agent systems (Stripe Minions, Devin, SWE-agent, OpenHands), Anthropic's official patterns, and the Claude Code Agent SDK.

---

## Landscape

"Autoclaude" is not one system but an umbrella name for several community projects that automate Claude Code:

| System | Approach | Scale | Key Innovation |
|--------|----------|-------|----------------|
| **Aperant** (13K stars) | Desktop app + CLI, 6+ specialized agent roles | Up to 12 parallel terminals | QA reviewer/fixer loop, Graphiti knowledge graph for cross-session memory, multi-account rate limit rotation |
| **ashburnstudios/autoclaude** | Shell hooks on Claude Code | Single agent | Pre-compact hooks create `RESUME-*.md` handoff docs, CLAUDE.md as persistent memory, estimated token tracking |
| **r3e-network/AutoClaude** | VS Code extension + npm | Up to 50+ parallel agents | Script-based quality check loops, 12+ sub-agent types, auto-resume on rate limits |
| **Anthropic Quickstart** | Reference harness | Sequential | Two-agent pattern (initializer + coder), JSON feature lists, filesystem sandbox |
| **Stripe Minions** | Production internal tool | One agent per task | 70% deterministic / 30% LLM, pre-fetched context curation, selective CI (relevant tests only from 3M+ total) |
| **SWE-agent** (Princeton) | Academic research | Single agent per issue | 90% LLM-driven, custom shell interface, trajectory-based learning |
| **Devin** (Cognition) | Commercial product | Cloud sandboxes | ACU (compute) budgets, multi-tool environment (browser, terminal, editor), human-in-loop checkpoints |
| **OpenHands** (open source) | Event-stream architecture | Hierarchical delegation | Docker sandboxes per agent, runtime plugin system, browsing agent for web verification |

### What they all have in common

1. **Fresh SDK client per session.** No system maintains a single long-running agent. Sessions are short-lived, progress is persisted externally (git, JSON files, structured artifacts), and new sessions resume from that state.

2. **Structured progress tracking in JSON, not markdown.** Aperant uses `implementation_plan.json`, Anthropic's quickstart uses `feature_list.json`. JSON is machine-readable and prevents the corruption/ambiguity that markdown tracking suffers from.

3. **Git-based persistence.** All systems that handle code use git branches as the source of truth for work-in-progress. Commits = checkpoints. Branches = isolation.

4. **Retry budgets.** Stripe caps fix attempts at 2, then escalates. Aperant allows 5 subtask retries and 50 QA iterations before marking stuck. No production system loops indefinitely.

5. **Context curation before LLM invocation.** The most reliable production system (Stripe) pre-fetches all relevant context and curates it into a structured packet before the LLM sees it. Raw events/webhooks → structured context → LLM decision. This dramatically improves decision quality.

---

## Patterns That Apply to Product Engineer

### 1. JSON-Based Progress Tracking

**What:** Replace the current implicit progress tracking (git commits + markdown retros) with a machine-readable `ticket-state.json` per ticket.

**Why:** When the orchestrator needs to evaluate merge readiness, diagnose stuck agents, or brief a new agent session after restart, it needs structured data — not prose. A JSON file with explicit fields (`status`, `files_changed`, `tests_added`, `ci_result`, `review_state`, `retry_count`) is trivially parseable by both the LLM orchestrator and monitoring tools.

**How Aperant does it:** Each subtask has `{ id, title, status: "pending"|"in_progress"|"completed"|"failed", retries: 0, dependencies: [] }` in a JSON plan file. The agent reads the file at session start, picks the next incomplete item, works on it, updates the file.

**How Anthropic's quickstart does it:** `feature_list.json` with all features marked "failing" initially. Agent can only flip individual features to "passing" after tests confirm. This prevents premature completion claims.

### 2. Fresh Sessions with Aggressive Teardown

**What:** Spin down TicketAgent containers within 5 minutes of completing a logical unit of work (PR created, review addressed, merge done). Don't keep containers alive "in case" more events come — the orchestrator handles incoming events and decides whether to spin up a new session.

**Why:** Long-running idle containers are the #1 source of zombie agents (BC-118). Fresh sessions also prevent context window degradation — agents that run for hours accumulate noise and make worse decisions. Every similar system creates a new SDK client per session rather than extending existing ones.

**How it changes the architecture:** The orchestrator becomes the always-on component that receives events, evaluates them, and decides whether to (a) handle directly, (b) spin up a new agent session, or (c) buffer for later. TicketAgent containers become ephemeral workers, not persistent processes.

### 3. Structured Context Assembly

**What:** Before routing an event to an agent (or making an LLM decision), the orchestrator assembles a structured context packet: ticket metadata, recent git activity, CI status, PR state, review comments, related Slack messages. The agent/LLM sees a clean, complete picture — not raw webhook JSON.

**Why:** Stripe's key insight is that 70% of the value comes from deterministic context preparation, not LLM reasoning. A well-structured context packet makes even Haiku perform well. A raw webhook dump makes even Opus struggle.

**How it changes the architecture:** New `context-assembler.ts` module that queries GitHub API (diff, CI, reviews), SQLite (ticket history, related tickets), and Slack (thread messages) to build a structured context object before any LLM call.

### 4. LLM-Driven Auto-Merge with Escalation Rails

**What:** The LLM orchestrator evaluates every PR for merge readiness. Default is auto-merge. Escalation to human only when the LLM identifies risk to: security/sensitive data, data integrity, or core user-facing workflows.

**Why:** The existing systems are designed for production businesses with high stakes. Product Engineer serves personal/hobbyist projects where speed matters more than zero-defect. Issues found in production can be fixed quickly. For truly risky changes, feature flags provide a safety net.

**Escalation triggers (hard gates):**
- Authentication, authorization, or encryption changes
- Database schema migrations or data deletion
- Changes to core user workflows (e.g., symptom logging on health-tool)
- Dependency updates that could introduce supply chain risk
- The LLM's own confidence is low ("I'm not sure this is safe")

**Everything else auto-merges** after CI passes — including new features, UI changes, refactors, and config changes. The bet: >90% of auto-merged changes will be correct or good-enough. The <10% that aren't will be caught in production and fixed quickly.

### 5. Staging Environments for Verification

**What:** Each product gets a staging environment. Before merge, the agent deploys to staging and verifies the feature works — not just that tests pass, but that the actual user-facing behavior is correct.

**Why:** Automated tests catch regressions but miss integration issues, visual bugs, and workflow problems. A staging deployment lets the agent (or the orchestrator) do a real verification: hit the endpoint, check the response, screenshot the UI, verify the flow.

**How this works with auto-merge:** The merge evaluation becomes: CI passes AND staging verification passes → auto-merge. Either fails → escalate. This provides much higher confidence than CI alone, making aggressive auto-merge safe.

### 6. Retry Budgets

**What:** Hard caps on how many times an agent retries a failing step before escalating.

| Scenario | Max Retries | On Exhaustion |
|----------|-------------|---------------|
| CI fix attempt | 3 | Escalate to human |
| PR review feedback cycle | 3 rounds | Escalate: "Agent can't resolve reviewer's feedback" |
| Agent session restart | 2 | Mark failed, notify |
| Vague task clarification | 2 questions | Escalate: "Need clearer requirements" |

**Why:** Without caps, agents loop indefinitely (or until container TTL). This was a contributing factor in BC-118's zombie agents and is a universal pattern across all production systems.

### 7. Outcome Logging for Self-Improvement

**What:** Log structured outcomes for every ticket: `{ ticketId, product, startTime, endTime, turns, cost, filesChanged, testsAdded, mergeDecision, wasCorrect, humanInterventions, failureReason }`. Review outcomes weekly to identify patterns.

**Why:** Product Engineer is already ahead of most systems on cross-session learning (learnings.md, skill files). The next step is automated pattern detection: "Tickets in product X fail 40% of the time on CI — investigate the test suite." This requires structured outcome data, not prose retros.

**How Aperant does it:** Graphiti knowledge graph stores session insights as graph nodes with semantic search. Overkill for our scale. A simple `outcomes` table in the orchestrator's SQLite is sufficient.

---

## Patterns We're Deliberately NOT Adopting

| Pattern | Why Not |
|---------|---------|
| **Human review before every merge** | Too slow for personal projects. LLM merge evaluation + staging verification provides sufficient confidence. |
| **Multiple specialized agent roles** (Aperant's 6+ types) | Complexity not justified. One generalist TicketAgent per ticket is simpler and sufficient for our scale. |
| **Knowledge graph for memory** (Aperant's Graphiti) | Overkill. SQLite outcomes table + learnings.md + skill files cover our needs. |
| **Parallel agent farms** (r3e's 50+ agents) | Resource waste. 3-5 concurrent agents is our practical ceiling. |
| **ACU/compute budgets** (Devin) | Token cost tracking via `maxBudgetUsd` on the SDK + orchestrator-level alerts is simpler. |
| **Custom shell interface** (SWE-agent) | Claude Code's built-in tools are sufficient. No need to rebuild. |

---

## Key Takeaways for the LLM Orchestrator Design

1. **The orchestrator is the brain, agents are the hands.** The orchestrator should make all high-level decisions (triage, merge, lifecycle). Agents should implement, test, and create PRs — then stop.

2. **Ephemeral agents, persistent orchestrator.** Agent containers spin up, do work, spin down within minutes. The orchestrator (Durable Object + SQLite) is always on, always aware, always deciding.

3. **Structured everything.** JSON for progress tracking, structured context for LLM decisions, structured outcomes for learning. Markdown is for humans; JSON is for machines.

4. **Auto-merge is the default.** Escalate only on security, data integrity, or core workflow risk. Move fast, fix in production. Feature flags for anything uncertain.

5. **Staging before merge.** The LLM's confidence comes from verification, not reasoning. If the agent can deploy to staging and prove the feature works, auto-merge is safe.

6. **Retry budgets prevent zombies.** Hard caps on every retry loop. Escalate don't loop.
