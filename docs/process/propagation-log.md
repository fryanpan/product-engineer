# Propagation Log

## 2026-03-25 - BC-195: Template Updates from Recent Learnings

**Context:** Reviewed learnings from the last 2 weeks and identified patterns that should be codified in templates and agent skills. Propagated updates to reduce agent context token waste.

### Changes Propagated

| Artifact | Change | Impact |
|----------|--------|--------|
| **feedback-loop.md** | Removed interactive-only patterns | 76 → 39 lines (-49%) |
| **workflow-conventions.md** | Added lifecycle guidance, removed superpowers | 91 → 64 lines (-30%) |
| **CLAUDE.md** | Added "Testing Conventions" section | +7 lines |
| **definition-of-done.md** | Added template to all repos | New file |
| **github-webhooks.md** | Added opt-in GitHub webhook patterns | New file (alwaysApply: false) |

### PRs Created

| Repo | PR | Status | alwaysApply Before | alwaysApply After | Reduction |
|------|----|----|----|----|-----|
| bike-tool | [#24](https://github.com/fryanpan/bike-tool/pull/24) | Open | 167 lines | 103 lines | -38% |
| health-tool | [#130](https://github.com/fryanpan/health-tool/pull/130) | Open | 171 lines | 103 lines | -40% |
| blog-assistant | [#6](https://github.com/fryanpan/blog-assistant/pull/6) | Open | 93 lines | 103 lines | +11%* |
| givewell-impact | [#10](https://github.com/fryanpan/givewell-impact/pull/10) | Open | ~130 lines | 103 lines | ~-21% |
| octoturtle_assistant | [#4](https://github.com/fryanpan/octoturtle_assistant/pull/4) | Open | ~130 lines | 103 lines | ~-21% |
| personal-crm | [#8](https://github.com/fryanpan/personal-crm/pull/8) | Open | ~130 lines | 103 lines | ~-21% |
| personal-finance | [#2](https://github.com/fryanpan/personal-finance/pull/2) | Open | ~130 lines | 103 lines | ~-21% |
| research-notes | [#3](https://github.com/fryanpan/research-notes/pull/3) | Open | ~130 lines | 103 lines | ~-21% |
| task-pilot | [#2](https://github.com/fryanpan/task-pilot/pull/2) | Open | ~130 lines | 103 lines | ~-21% |
| product-engineer | [#119](https://github.com/fryanpan/product-engineer/pull/119) | Open | 39+64=103 | 39+64=103 | 0% (template repo) |

\* blog-assistant had already been partially updated, so final count is slightly higher

### Skipped Repos

- **prod-test-app** - No `.claude/` directory yet (needs initial setup via `/setup-product`)

### Estimated Impact

- **Before**: Average ~130 lines of alwaysApply rules per repo
- **After**: ~103 lines of alwaysApply rules per repo
- **Reduction**: ~27 lines per repo (-21%)
- **Cost savings**: ~$0.15 per agent session × 50 sessions/month × 9 repos = ~$67.50/month

### Patterns Codified

1. **Terminal state handling** - Added to lifecycle planning requirements
2. **GitHub webhook patterns** - New opt-in rule covering PR closed, terminal events, PAT limitations
3. **LLM context validation** - Fail-fast guidance in Testing Conventions
4. **Mock SQL** - Parameterized query requirement for tests
5. **Turn efficiency** - Removed interactive prompts from alwaysApply rules

### Source Learnings

Based on:
- BC-192: Production health check patterns
- BC-162: Agent lifecycle bugs (terminal state handling)
- BC-161: GitHub webhook handling (closed vs merged)
- BC-174: LLM decision quality (bad data → bad decisions)
- BC-157: Merge gate deduplication
- Multiple transcript reviews

### Next Steps

1. Monitor agent sessions after PRs merge to verify token reduction
2. Update product-engineer templates as new patterns emerge
3. Run next propagation in ~1 month or after significant learning accumulation
