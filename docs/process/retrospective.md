# Retrospectives

Session feedback and learnings to improve future work.

## 2026-03-08 - BC-118 Agent Lifecycle Fix

**What worked:**
- Systematic investigation: Read code, checked status endpoint, traced lifecycle
- Found root cause quickly by comparing container behavior vs DB state
- Screenshots from ticket showed the exact symptom (13 agents still "Running")
- Previous fix attempts (PR #61, #63) had done the hard work (shutdown endpoint, cleanup mechanism) - we just needed to wire them together

**What didn't:**
- Initial attempt to call cleanup endpoint failed (no WORKER_URL in agent env)
- Could have been faster if deployment-safety.md had included agent_active flag behavior
- The lifecycle state → DB flag mapping wasn't documented anywhere

**Action:**
- Document agent_active flag behavior in deployment-safety.md
- Add monitoring alert for `agent_active = 1` with stale heartbeat (>1 hour)
- Consider automated cleanup cron job that runs every 6 hours
