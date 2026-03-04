# TicketAgent Worker

Separate worker for TicketAgent Durable Objects, enabling zero-downtime deploys.

## Why a Separate Worker?

When you deploy a Cloudflare Worker, all Durable Objects in that worker are reset. By splitting the TicketAgent DO into its own worker, we can:

1. Deploy orchestrator updates (frequent) without interrupting active agents
2. Deploy agent updates (infrequent) with gradual rollout
3. Enable session persistence via R2 FUSE mount — agents resume mid-task after container replacement

## Structure

- `src/index.ts` — Minimal stub exporting the TicketAgent class from `orchestrator/src/ticket-agent.ts`
- `wrangler.toml` — Worker config referencing the agent container image

## Deployment

### Standard Deploy (gradual rollout)

```bash
cd ticket-agent
wrangler versions upload    # Upload new version
wrangler versions deploy    # Gradual rollout (10% → 100%)
```

### Immediate Deploy (use with caution)

```bash
cd ticket-agent
wrangler deploy
```

This immediately replaces all TicketAgent containers. Agents will resume from R2, but use gradual rollout for safer deploys.

## Secrets

This worker needs the same secrets as the orchestrator worker. Set them once:

```bash
cd ticket-agent
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put LINEAR_API_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put API_KEY
wrangler secret put SENTRY_DSN
# Product-specific secrets (e.g., GITHUB_TOKEN_PRODUCT_A)
# R2 FUSE mount secrets
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put CF_ACCOUNT_ID
```

**Why duplicate secrets?** Workers don't share secrets. Each worker must have its own bindings.

## Monitoring

```bash
wrangler tail --name ticket-agent-worker
```

Look for:
- `[Agent] Resuming session from: ...` — Successful session resume
- `[Agent] deploy_recovery` — Container recovered from deploy
- `[Entrypoint] R2 bucket mounted at ~/.claude/projects` — FUSE mount success

## Troubleshooting

### Container fails to start

Check logs: `wrangler tail --name ticket-agent-worker`

Common issues:
- FUSE mount failed (check R2 secrets)
- Missing secrets (run `wrangler secret list`)
- Container image build failed (check Docker build output)

### Agents start fresh instead of resuming

**Symptoms:** No `deploy_recovery` in logs, agents lose context after deploy.

**Causes:**
- R2 mount not working (check entrypoint logs)
- Session files not found (check R2 bucket)
- Session ID extraction failed (implementation issue)

**Fix:** Verify R2 credentials, check FUSE mount logs in container.
