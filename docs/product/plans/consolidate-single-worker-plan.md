# Consolidate ticket-agent back into orchestrator worker

## Context

The ticket-agent was split into a separate worker for zero-downtime deploys — deploying orchestrator wouldn't restart TicketAgent DOs. Now that TicketAgent persists state in SQLite (and can resume sessions from R2), the split adds complexity without meaningful benefit: duplicate secrets provisioning, deploy ordering constraints, cross-script DO bindings that fail if the other worker doesn't exist yet.

This is a fresh Cloudflare account with no in-flight tickets, so there's no DO namespace migration concern.

## Changes

### 1. `orchestrator/wrangler.toml`
- Remove `script_name = "ticket-agent-worker"` from `TICKET_AGENT` DO binding
- Add second `[[containers]]` block for the agent Dockerfile (`../agent/Dockerfile`, instance_type `basic`, max_instances 10)

### 2. Delete `ticket-agent/` directory
- It's a thin re-export stub with no unique logic — `TicketAgent` class already lives in `orchestrator/src/ticket-agent.ts`

### 3. `.github/workflows/deploy.yml`
- Remove `deploy-ticket-agent` job
- Remove `detect-changes` job (no longer needed — single deploy)
- Remove ticket-agent install/typecheck steps from `test` job
- Simplify `deploy-orchestrator` to just need `test`

### 4. `docs/deployment-safety.md`
- Update "Split Workers" architecture section → single worker
- Remove separate ticket-agent secrets provisioning
- Update `wrangler tail --name ticket-agent-worker` → `--name product-engineer`

### 5. Other docs/scripts
- `scripts/setup.sh`: Set secrets once (no ticket-agent directory)
- `docs/deploy.md`: Remove ticket-agent-first deploy ordering, single `wrangler deploy`
- `README.md`: Simplify deploy instructions
- `CLAUDE.md`: Remove references to split workers

### No changes needed
- `orchestrator/src/index.ts` — already exports `TicketAgent`
- `orchestrator/src/orchestrator.ts` — `this.env.TICKET_AGENT` works the same
- `orchestrator/src/types.ts` — `TICKET_AGENT: DurableObjectNamespace` unchanged
- All tests — none are aware of the two-worker topology

## Verification
1. `cd orchestrator && bun test` — all tests pass
2. `cd orchestrator && npx wrangler deploy` — deploys both containers
3. Trigger a Linear webhook → agent container starts and processes ticket
4. `wrangler tail` shows both Orchestrator and TicketAgent logs in one stream
