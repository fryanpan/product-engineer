# Definition of Done

Checklist items the agent MUST satisfy before creating a PR.
If any item cannot be satisfied, ask for help via Slack instead of creating the PR.

## Always
- [ ] All existing tests pass (`cd api && bun test`, `cd agent && bun test`)
- [ ] New code has test coverage for key logic and edge cases
- [ ] Self-reviewed diff for bugs, security issues, and unintended changes
- [ ] No secrets, API keys, personal project names, or repo URLs in committed code
- [ ] Changes match what was requested — no unrelated refactoring or scope creep

## When: workflow, orchestrator, or lifecycle changes
- [ ] Integration tested in staging — demonstrate the happy path works with real data
- [ ] Edge cases tested: what happens on container restart, deploy, alarm fire, or terminal state transition?
- [ ] Updated `docs/deployment-safety.md` if container lifecycle behavior changed

## When: administrative changes (adding products, updating config)
- [ ] Changes made via admin API (POST/PUT /api/products), not new code files
- [ ] No project-specific configuration (repo URLs, channel IDs, secret names) committed to source code
