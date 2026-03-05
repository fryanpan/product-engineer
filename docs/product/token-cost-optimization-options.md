# Token Cost Optimization: Research & Options

**Date:** 2026-03-05
**Ticket:** BC-86
**Current Spend:** $40/day (~$1,200/month)

## Executive Summary

Good news: The codebase already has Cloudflare AI Gateway infrastructure implemented but **not activated**. Enabling it requires only configuration changes (no code). This will provide comprehensive analytics to identify cost centers, with advanced monitoring options available if deeper insights are needed.

---

## Current State

### What's Working
- ✅ Code is ready: `ANTHROPIC_BASE_URL` handling is fully implemented in `ticket-agent.ts`
- ✅ Tests exist: AI Gateway config is tested in `ticket-agent.test.ts`
- ✅ Documentation exists: `docs/cloudflare-ai-gateway.md` has setup instructions

### What's Missing
- ❌ **Registry not configured**: `orchestrator/src/registry.json` has no `cloudflare_ai_gateway` section
- ❌ **No monitoring active**: All traffic goes directly to Anthropic API
- ❌ **Zero visibility**: Cannot see per-ticket costs, token patterns, or optimization opportunities

### Why This Matters
Without analytics, we can't answer:
- Which tickets are expensive? (Is it research-heavy tickets? Code generation? Retries?)
- What's consuming input tokens? (Skills, CLAUDE.md, web search, codebase context?)
- Are there cost spikes? (Particular agents getting stuck? Inefficient prompts?)
- Where should we optimize first? (Biggest ROI for effort)

---

## Option 1: Enable Cloudflare AI Gateway (Recommended)

**Effort:** 10 minutes
**Cost:** $0 (included in Workers plan)
**Value:** High — immediate visibility into all LLM traffic

### What You Get
| Feature | Details |
|---------|---------|
| **Request logs** | Every Anthropic API call with full request/response bodies |
| **Token tracking** | Input/output tokens per request |
| **Cost analytics** | Spend by model (Sonnet 4.5, Haiku, etc.) |
| **Time series** | Usage trends by hour/day/week/month |
| **Error tracking** | Failed requests and rate limits |
| **Cache analytics** | Hit rates (if caching is enabled) |

### Dashboard Capabilities
- Filter by time range (hour/day/week/month)
- Model breakdown (see Sonnet vs Haiku usage)
- Cost trends (identify spending spikes)
- Request volume (tickets per day)

### What It DOESN'T Give You
- ❌ **No per-ticket attribution** — logs show anonymous requests (can't easily see "BC-86 cost $5")
- ❌ **No prompt analysis** — can't break down "50K tokens from skills vs. 20K from codebase context"
- ❌ **Manual correlation required** — need to cross-reference timestamps with container logs to map requests to tickets

### Implementation
1. **Create AI Gateway** in Cloudflare dashboard (2 min)
   - Navigate to **AI > AI Gateway**
   - Create gateway (name: `product-engineer`)
   - Note Account ID and Gateway ID

2. **Update registry** (2 min)
   - Add to `orchestrator/src/registry.json`:
     ```json
     {
       "cloudflare_ai_gateway": {
         "account_id": "YOUR_ACCOUNT_ID",
         "gateway_id": "product-engineer"
       },
       ...
     }
     ```

3. **Load into database** (3 min)
   - Run migration or manually insert into settings table
   - Could use existing admin endpoint if available

4. **Deploy** (3 min)
   - `cd orchestrator && bun run deploy`
   - New agents will automatically route through gateway

5. **Verify** (2 min)
   - Trigger a test ticket
   - Check AI Gateway dashboard for traffic

### Monitoring Strategy
With AI Gateway enabled, you can:
1. **Weekly cost reviews** — check dashboard for spending trends
2. **Anomaly detection** — alert on daily spend > $60 (50% above baseline)
3. **Model usage** — track if agents are using Haiku vs Sonnet (Haiku is 5x cheaper)
4. **Correlation analysis** — manually map high-cost days to Linear tickets for patterns

### Pros
- ✅ Zero cost, zero risk
- ✅ Immediate visibility (data appears within 2 minutes)
- ✅ No code changes required
- ✅ Foundation for future optimization
- ✅ Free tier: 100K logs/month (likely sufficient for current volume)

### Cons
- ❌ Manual correlation needed to identify expensive tickets
- ❌ No automatic per-ticket cost breakdown
- ❌ Limited to Cloudflare's analytics UI (no programmatic access without GraphQL)

---

## Option 2: Add Per-Ticket Cost Tracking

**Effort:** 4-6 hours
**Cost:** $0 (code changes only)
**Value:** Medium-High — answers "which tickets are expensive?"

### Approach
Instrument the agent to track token usage per ticket and log to SQLite + Slack.

### What You Get
- Per-ticket cost breakdown ("BC-86 used 2.3M tokens, cost $11.50")
- Token attribution by phase (clone, plan, implement, test, review)
- Slack notifications with cost summary when ticket completes
- SQLite table for historical queries

### Implementation
1. **Capture usage from Agent SDK** (2-3 hours)
   - Wrap `query()` iterator to count tokens from `message.usage` fields
   - Track cumulative input/output tokens per session
   - Calculate cost using Anthropic's pricing (Sonnet 4.5: $3 input / $15 output per MTok)

2. **Store in SQLite** (1 hour)
   - Add `ticket_costs` table to Orchestrator DO
   - Columns: `ticket_id`, `total_input_tokens`, `total_output_tokens`, `estimated_cost_usd`, `completed_at`
   - Update via phone-home API when session ends

3. **Slack reporting** (1 hour)
   - Add cost summary to retro or completion message
   - Example: "✅ Ticket complete. Used 2.3M tokens ($11.50)"

4. **Dashboard queries** (30 min)
   - Add `/api/costs` endpoint to query historical data
   - Weekly cost summaries by product

### Example Output
```
BC-86 Token Usage:
- Input:  1,234,567 tokens ($3.70)
- Output:   456,789 tokens ($6.85)
- Total:  1,691,356 tokens ($10.55)
```

### Pros
- ✅ Direct ticket-to-cost mapping
- ✅ No external dependencies
- ✅ Persistent storage for trend analysis
- ✅ Can combine with Option 1 (AI Gateway) for dual tracking

### Cons
- ❌ Requires code changes (testing, deployment)
- ❌ No visibility into *why* a ticket was expensive (still need prompt analysis)
- ❌ Agent SDK `usage` field may not include all token counts (e.g., tool use may be aggregated)

---

## Option 3: Full Observability with Third-Party Platform

**Effort:** 1-2 days
**Cost:** $50-200/month (vendor pricing)
**Value:** High — comprehensive LLM observability

### Leading Platforms (2026)

| Platform | Strengths | Pricing | Notes |
|----------|-----------|---------|-------|
| **Braintrust** | Per-request cost breakdowns, tag-based attribution, budget alerts | $0-200/mo | Best for per-ticket and per-user tracking |
| **LangWatch** | Full trace capture, cost attribution by feature/user | $50+/mo | Strong for multi-step agent workflows |
| **Traceloop** | OpenTelemetry-based, auto-instrumentation | Open source / hosted | Good for standardized observability |
| **Helicone** | Proxy-based (no SDK changes), simple integration | $0-100/mo | Easiest to set up |

### What You Get
- 🎯 **Per-ticket cost attribution** — tag every request with `ticket_id`
- 📊 **Prompt analysis** — break down input tokens by source (skills, context, etc.)
- 🔍 **Request traces** — see full conversation flow with timings
- 📈 **Advanced dashboards** — drill down by model, user, feature, ticket
- 🚨 **Budget alerts** — notify when spending exceeds thresholds
- 🔗 **API access** — programmatic queries for custom reporting

### Implementation Path
1. **Choose platform** based on needs (Braintrust recommended for ticket attribution)
2. **Integrate SDK or proxy** — modify `agent/src/server.ts` to route through platform
3. **Tag requests** — pass `ticket_id` as metadata on every Anthropic call
4. **Configure dashboards** — set up cost views, alerts, and reports

### Use Cases
- "Show me all tickets that cost >$10"
- "Which prompts/skills consume the most tokens?"
- "Are we over-using Sonnet when Haiku would suffice?"
- "Set alert if daily spend exceeds $60"

### Pros
- ✅ Production-grade observability
- ✅ Minimal code changes (SDK wrappers or proxy)
- ✅ Advanced analytics out-of-the-box
- ✅ Scales to multiple products/agents
- ✅ Dedicated support

### Cons
- ❌ Monthly cost ($50-200)
- ❌ Vendor lock-in
- ❌ Integration effort (1-2 days)
- ❌ May be overkill for current scale

---

## Option 4: Custom Metadata Tagging + AI Gateway

**Effort:** 2-3 hours
**Cost:** $0
**Value:** Medium — pragmatic middle ground

### Approach
Enhance AI Gateway logs with custom headers for ticket identification.

### Implementation
1. **Add custom headers** to Anthropic requests
   - Cloudflare AI Gateway preserves custom headers in logs
   - Add `X-Ticket-ID: BC-86` header to all Agent SDK requests
   - Requires wrapping Agent SDK HTTP client (some complexity)

2. **Query logs via GraphQL**
   - Cloudflare exposes AI Gateway logs via GraphQL API
   - Filter by custom header to get per-ticket requests
   - Aggregate tokens and costs programmatically

3. **Build simple dashboard**
   - Weekly cron job to query GraphQL API
   - Generate CSV or post to Slack: "Last week's expensive tickets"

### Pros
- ✅ Free (uses existing AI Gateway)
- ✅ Ticket attribution without external vendors
- ✅ Programmatic access via GraphQL

### Cons
- ❌ Requires modifying Agent SDK HTTP layer (fragile)
- ❌ GraphQL queries are manual (not a polished UI)
- ❌ Still limited compared to specialized platforms

---

## Recommendations

### Phase 1: Quick Wins (This Week)
**Do Option 1: Enable Cloudflare AI Gateway**

- **Why:** Zero risk, zero cost, 10-minute setup
- **Outcome:** Immediate visibility into daily spending, model usage, error rates
- **Next:** After 1 week, review dashboard to identify high-cost days/patterns

### Phase 2: Targeted Instrumentation (Next Week)
**Do Option 2: Per-Ticket Cost Tracking**

- **Why:** Answers "which tickets are expensive?" without external costs
- **Outcome:** Direct ticket-to-cost mapping for prioritizing optimizations
- **Effort:** 4-6 hours of focused dev work

### Phase 3: Deep Optimization (If Needed)
**Evaluate Option 3 based on findings**

- **Decision point:** If per-ticket tracking reveals persistent high costs OR if you need prompt-level analysis
- **Criteria for upgrading:**
  - Spending exceeds $1,500/month consistently
  - Multiple expensive tickets per week with unclear cause
  - Need budget enforcement (hard caps)

---

## Cost Optimization Strategies (Post-Instrumentation)

Once you have visibility, common optimizations include:

### 1. Model Selection
- Use **Haiku 4.5** ($0.80/$4 per MTok) for simple tasks
  - Code review comments
  - Status updates
  - Simple bug fixes
- Reserve **Sonnet 4.5** ($3/$15) for complex reasoning
  - Architecture planning
  - Multi-file refactors
  - Debugging obscure issues

### 2. Prompt Optimization
- **Reduce context size**
  - Trim verbose CLAUDE.md files
  - Consolidate skills (merge similar ones)
  - Selective file reads (don't dump entire files)
- **Cache system prompts** (Anthropic supports prompt caching)
  - System messages, skills, docs cached between requests
  - 90% cost reduction on cached tokens

### 3. Early Termination
- **Stop unprofitable agents**
  - If ticket exceeds $20 in tokens, ask for human guidance
  - Prevents runaway costs on stuck agents

### 4. Batching
- **Group similar tickets**
  - Process multiple small fixes in one session (shared context)
  - Amortize setup costs

---

## Expected ROI

### Current State
- **Spend:** $40/day = $1,200/month
- **Visibility:** None

### After Option 1 (AI Gateway)
- **Spend:** $40/day (unchanged)
- **Visibility:** High-level trends, model usage, error rates
- **Effort:** 10 minutes
- **ROI:** Foundation for optimization

### After Option 2 (Per-Ticket Tracking)
- **Spend:** $40/day (unchanged initially)
- **Visibility:** Per-ticket costs, identify expensive patterns
- **Effort:** 4-6 hours
- **ROI:** Enables targeted optimization (expect 20-40% cost reduction after identifying waste)

### After Optimization (Est.)
- **Spend:** $25-30/day = $750-900/month
- **Savings:** $300-450/month ($3,600-5,400/year)
- **Payback:** Immediate (instrumentation effort < 1 day)

---

## Next Steps

1. **Decide on immediate action**
   - Option 1 (AI Gateway) is a no-brainer — enable it today
   - Option 2 (Per-Ticket Tracking) is high-value, low-cost — do it next week
   - Option 3 (Third-Party Platform) — defer until we see Option 1+2 results

2. **After 1 week of AI Gateway data**
   - Review spending patterns
   - Identify high-cost days/tickets
   - Decide if deeper instrumentation (Option 2) is needed

3. **After per-ticket tracking is live**
   - Identify the top 3 most expensive ticket types
   - Implement targeted optimizations (model selection, prompt tuning, early termination)
   - Measure impact

---

## Questions for Decision

1. **Do you want me to enable AI Gateway now?** (Option 1 — 10 minutes)
2. **Should I implement per-ticket cost tracking?** (Option 2 — 4-6 hours)
3. **Any specific cost questions you want answered?** (e.g., "Which product is most expensive?")

---

## Sources

### Cloudflare AI Gateway
- [AI Gateway Observability](https://www.cloudflare.com/developer-platform/products/ai-gateway/)
- [Cloudflare AI Gateway Pricing 2026](https://www.truefoundry.com/blog/cloudflare-ai-gateway-pricing)
- [Analytics Dashboard Docs](https://developers.cloudflare.com/ai-gateway/observability/analytics/)
- [AI Gateway Features](https://developers.cloudflare.com/ai-gateway/features/)

### Token Tracking Solutions
- [Anthropic Usage & Cost API](https://docs.anthropic.com/en/api/usage-cost-api)
- [Cost Reporting in Claude Console](https://support.anthropic.com/en/articles/9534590-cost-and-usage-reporting-in-console)
- [Datadog Anthropic Integration](https://docs.datadoghq.com/integrations/anthropic-usage-and-costs/)
- [nOps AI Cost Tracking](https://www.nops.io/blog/anthropic-api-pricing/)

### LLM Observability Platforms
- [Traceloop: Track Token Usage Per User](https://www.traceloop.com/blog/from-bills-to-budgets-how-to-track-llm-token-usage-and-cost-per-user)
- [Best LLM Monitoring Tools 2026](https://www.braintrust.dev/articles/best-llm-monitoring-tools-2026)
- [OpenTelemetry for LLM Tracking](https://oneuptime.com/blog/post/2026-02-06-track-token-usage-prompt-costs-model-latency-opentelemetry/view)
- [Portkey: Tracking LLM Token Usage](https://portkey.ai/blog/tracking-llm-token-usage-across-providers-teams-and-workloads/)
- [LangWatch: Monitoring Tools 2026](https://langwatch.ai/blog/4-best-tools-for-monitoring-llm-agentapplications-in-2026)
- [Langfuse: Cost Tracking for LLM Apps](https://langfuse.com/docs/observability/features/token-and-cost-tracking)
