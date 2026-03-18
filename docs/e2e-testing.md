# E2E Testing Guide

End-to-end tests that exercise the full orchestrator lifecycle against staging or production.

## Test Scripts

| Script | Purpose | Duration |
|--------|---------|----------|
| `scripts/e2e-smoke-test.ts` | Quick connectivity check for all integrations | ~5 seconds |
| `scripts/e2e-staging-test.ts` | Full lifecycle test (Slack → Linear → Agent → PR → Merge) | ~10-15 minutes |

## Prerequisites

Set these environment variables:

```bash
export API_KEY="your-api-key"
export SLACK_BOT_TOKEN="xoxb-..."  # Staging Slack app token
export LINEAR_API_KEY="lin_api_..."
export GITHUB_TOKEN="ghp_..."  # Or GH_TOKEN
export WORKER_URL="https://your-worker.workers.dev"
```

## Smoke Test

Quick check that all integrations are connected. Run before deploying or after configuration changes.

```bash
# Against staging (default)
bun run scripts/e2e-smoke-test.ts

# Against production
bun run scripts/e2e-smoke-test.ts --env production

# Show help
bun run scripts/e2e-smoke-test.ts --help
```

Tests:
1. Worker health endpoint
2. Orchestrator status (via Worker → DO)
3. Slack API connectivity
4. Linear API connectivity
5. GitHub API connectivity
6. Decision log access
7. Product registry access

## Full E2E Test

Exercises the complete orchestrator lifecycle. **This will create real artifacts in staging** (Linear ticket, Slack thread, GitHub PR, merged code).

```bash
# Against staging (default)
bun run scripts/e2e-staging-test.ts

# Dry run (check prerequisites only)
bun run scripts/e2e-staging-test.ts --dry

# Show help
bun run scripts/e2e-staging-test.ts --help
```

### What It Tests

1. **Slack mention → Linear ticket creation**
   - Posts a message mentioning the staging bot
   - Verifies orchestrator creates a Linear ticket
   - Verifies ticket is linked to Slack thread

2. **Ticket review → agent spawn decision**
   - Decision engine evaluates the ticket
   - Agent container starts
   - Agent sends heartbeats

3. **Agent working**
   - Agent clones repo, starts SDK session
   - Test sends a follow-up message in thread (verifies thread routing)
   - Agent responds to the follow-up

4. **CI failure → automated fix**
   - Initial implementation has intentional syntax error
   - CI fails, agent receives webhook
   - Agent fixes the error

5. **Merge gate evaluation**
   - CI passes after fix
   - Decision engine evaluates merge-readiness
   - Merge gate approves

6. **Auto-merge**
   - PR is merged
   - Agent terminates
   - Deployment completes

### Bug Classes Covered

This test catches the class of bugs found during development:

| Bug Class | How Tested |
|-----------|------------|
| Supervisor spam loop | Verify agent terminates after merge |
| Merge gate race condition | CI failure → fix → merge sequence |
| Duplicate webhook dedup | Multiple events during agent lifecycle |
| Stale token refresh | Long-running test (10+ minutes) |
| Thread routing | Follow-up message sent mid-workflow |

### Environment Overrides

Override defaults for testing against different environments:

```bash
WORKER_URL=https://your-worker.workers.dev \
SLACK_CHANNEL=C0... \
LINEAR_TEAM_ID=... \
STAGING_REPO=your-org/some-repo \
bun run scripts/e2e-staging-test.ts
```

### Cleanup

The full E2E test creates real artifacts:
- Linear ticket (closed after merge)
- Slack thread (permanent)
- GitHub branch (deleted after merge)
- Merged commit (permanent in staging repo)

To fully clean up after a test:

```bash
# Reset staging repo main branch (dangerous!)
cd /path/to/staging-repo
git reset --hard HEAD~1
git push --force origin main

# Archive Linear ticket
# (Do this manually in Linear UI)
```

**Warning:** Only reset the repo if you're sure the test commit is the most recent. Check `git log` first.

## CI Integration

These tests are not run in CI — they require real API credentials and create real artifacts. Run them manually:

- Before deploying major orchestrator changes
- After configuration changes (secrets, registry)
- When investigating production issues

## Troubleshooting

### Test hangs waiting for agent

Check agent logs:
```bash
wrangler tail --env staging
```

Common issues:
- Missing `ANTHROPIC_API_KEY` in staging secrets
- GitHub token expired
- Slack app not invited to channel

### Test fails at merge gate

Check decision log:
```bash
curl -H "X-API-Key: $API_KEY" \
  "$WORKER_URL/api/orchestrator/decisions"
```

### Test completes but cleanup needed

Kill any stuck agents:
```bash
curl -X POST -H "X-API-Key: $API_KEY" \
  "$WORKER_URL/api/orchestrator/cleanup-inactive"
```
