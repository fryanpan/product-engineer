---
alwaysApply: true
---

# GitHub Webhook Patterns

## PR Closed Webhooks

GitHub PR webhooks have `action: "closed"` with a `merged: true|false` flag. Always handle BOTH cases:

```typescript
if (action === "closed" && merged === true) {
  // PR was merged
} else if (action === "closed" && merged === false) {
  // PR was closed without merging
}
```

**Never** only handle the merged case — closed-but-not-merged PRs will stay in your system forever.

## Terminal Events Must Update State Directly

Terminal webhook events (`pr_merged`, `pr_closed`) should update your state directly, not route through async handlers:
- The container/process that created the PR may have already exited
- Don't forward terminal events to potentially-dead agents
- Handle these events at the routing layer with synchronous state updates

## Fine-Grained PAT Limitations

Fine-grained GitHub PATs do NOT have a "Checks" permission. Use the commit statuses API instead:
- ❌ `/repos/{owner}/{repo}/commits/{ref}/check-runs` — requires Checks permission (not available)
- ✅ `/repos/{owner}/{repo}/commits/{ref}/status` — requires "Commit statuses: Read" permission

Never use the check-runs API in code that runs with fine-grained PATs.
