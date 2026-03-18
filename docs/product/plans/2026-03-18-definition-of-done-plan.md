# Definition of Done — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-repo definition-of-done checklists that the ticket agent must satisfy before creating a PR, and the merge gate cross-references before merging.

**Architecture:** Each target repo gets a `.claude/definition-of-done.md` checklist file. The agent skill is updated to read and verify it pre-PR. The orchestrator's context assembler fetches it via GitHub API and includes it in the merge gate prompt. A template provides sensible defaults for new repos.

**Tech Stack:** TypeScript (Cloudflare Workers), Mustache templates, GitHub REST API, Claude Code Agent SDK

---

### Task 1: Create template definition-of-done file

**Files:**
- Create: `templates/definition-of-done.md`

**Step 1: Write the template file**

```markdown
# Definition of Done

Checklist items the agent MUST satisfy before creating a PR.
If any item cannot be satisfied, ask for help via Slack instead of creating the PR.

## Always
- [ ] All existing tests pass
- [ ] New code has test coverage for key logic and edge cases
- [ ] Self-reviewed diff for bugs, security issues, and unintended changes
- [ ] No secrets, API keys, or personal project references in committed code
- [ ] Changes match what was requested — no unrelated refactoring or scope creep
```

**Step 2: Commit**

```bash
git add templates/definition-of-done.md
git commit -m "feat: add template definition-of-done for target repos"
```

---

### Task 2: Create product-engineer repo's definition-of-done

**Files:**
- Create: `.claude/definition-of-done.md`

**Step 1: Write the product-engineer specific definition-of-done**

```markdown
# Definition of Done

Checklist items the agent MUST satisfy before creating a PR.
If any item cannot be satisfied, ask for help via Slack instead of creating the PR.

## Always
- [ ] All existing tests pass (`cd orchestrator && bun test`, `cd agent && bun test`)
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
```

**Step 2: Commit**

```bash
git add .claude/definition-of-done.md
git commit -m "feat: add definition-of-done for product-engineer repo"
```

---

### Task 3: Update agent skill to enforce definition-of-done

**Files:**
- Modify: `.claude/skills/product-engineer/SKILL.md` (lines 48-58, the Workflow section)

**Step 1: Read current skill file**

Read `.claude/skills/product-engineer/SKILL.md` to confirm current workflow step numbering.

**Step 2: Add definition-of-done verification between self-review (step 6) and PR creation (step 7)**

Insert after step 6 ("Self-review your diff") and before step 7 ("commit, push, create PR"):

```markdown
7. **Definition of Done check.** Read `.claude/definition-of-done.md` from the repo root.
   - Evaluate every `## Always` item.
   - Evaluate every `## When: <condition>` section where the condition matches your changes.
   - For each item: satisfy it (run the command, do the review) or confirm it's already satisfied.
   - If ANY item cannot be satisfied → call `ask_question` explaining what's blocking. Do NOT create the PR.
   - Add a `## Definition of Done` section to the PR description with each applicable item, a ✅ marker, and brief evidence (e.g., "✅ All tests pass — `bun test`: 47 passed, 0 failed").
```

Renumber subsequent steps (old 7 → 8, old 8 → 9, old 9 → 10).

**Step 3: Commit**

```bash
git add .claude/skills/product-engineer/SKILL.md
git commit -m "feat: agent skill enforces definition-of-done before PR creation"
```

---

### Task 4: Add `fetchDefinitionOfDone` to ContextAssembler

**Files:**
- Modify: `orchestrator/src/context-assembler.ts` (add method + integrate into `forMergeGate`)
- Test: `orchestrator/src/context-assembler.test.ts`

**Step 1: Write the failing test**

Add to `orchestrator/src/context-assembler.test.ts`:

```typescript
it("includes definitionOfDone in merge gate context when file exists", async () => {
  // Mock fetch to return definition-of-done content for GitHub Contents API
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/contents/.claude/definition-of-done.md")) {
      const content = Buffer.from("## Always\n- [ ] Tests pass").toString("base64");
      return new Response(JSON.stringify({ content, encoding: "base64" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Return minimal valid responses for other GitHub API calls
    if (urlStr.includes("/pulls/") && !urlStr.includes("/reviews") && !urlStr.includes("/comments")) {
      if (init?.headers && (init.headers as Record<string, string>)["Accept"]?.includes("diff")) {
        return new Response("diff content", { status: 200 });
      }
      return new Response(JSON.stringify({
        title: "Test PR", changed_files: 1, additions: 10, deletions: 2,
        head: { sha: "abc123" }, mergeable: true, mergeable_state: "clean",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (urlStr.includes("/reviews") || urlStr.includes("/comments")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (urlStr.includes("/status")) {
      return new Response(JSON.stringify({ state: "success", total_count: 1, statuses: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(url, init);
  };

  try {
    const assembler = new ContextAssembler({
      sqlExec: mockSqlExec as any,
      slackBotToken: "xoxb-test",
      linearAppToken: "lin_test",
      githubTokens: { "test-product": "ghp_test" },
    });

    const ctx = await assembler.forMergeGate({
      ticketUUID: "abc-123",
      identifier: "PE-42",
      title: "Fix button",
      product: "test-product",
      pr_url: "https://github.com/org/repo/pull/1",
      branch: "ticket/abc-123",
      repo: "org/repo",
    });

    expect(ctx.definitionOfDone).toBe("## Always\n- [ ] Tests pass");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it("returns no definitionOfDone when file does not exist", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    if (urlStr.includes("/contents/.claude/definition-of-done.md")) {
      return new Response("Not Found", { status: 404 });
    }
    if (urlStr.includes("/pulls/") && !urlStr.includes("/reviews") && !urlStr.includes("/comments")) {
      if (init?.headers && (init.headers as Record<string, string>)["Accept"]?.includes("diff")) {
        return new Response("diff", { status: 200 });
      }
      return new Response(JSON.stringify({
        title: "PR", changed_files: 1, additions: 1, deletions: 0,
        head: { sha: "def456" }, mergeable: true, mergeable_state: "clean",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (urlStr.includes("/reviews") || urlStr.includes("/comments")) {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (urlStr.includes("/status")) {
      return new Response(JSON.stringify({ state: "success", total_count: 1, statuses: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return originalFetch(url, init);
  };

  try {
    const assembler = new ContextAssembler({
      sqlExec: mockSqlExec as any,
      slackBotToken: "xoxb-test",
      linearAppToken: "lin_test",
      githubTokens: { "test-product": "ghp_test" },
    });

    const ctx = await assembler.forMergeGate({
      ticketUUID: "abc-123",
      identifier: "PE-42",
      title: "Fix button",
      product: "test-product",
      pr_url: "https://github.com/org/repo/pull/1",
      branch: "ticket/abc-123",
      repo: "org/repo",
    });

    expect(ctx.definitionOfDone).toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

**Step 2: Run tests to verify they fail**

Run: `cd orchestrator && bun test context-assembler`
Expected: FAIL — `definitionOfDone` not present in context

**Step 3: Add `fetchDefinitionOfDone` method to `ContextAssembler`**

Add to `orchestrator/src/context-assembler.ts` in the private helpers section (after `fetchPRComments`, around line 318):

```typescript
/**
 * Fetch .claude/definition-of-done.md from the target repo via GitHub Contents API.
 * Returns the file content as a string, or null if the file doesn't exist.
 */
private async fetchDefinitionOfDone(repo: string, token: string): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/.claude/definition-of-done.md`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "product-engineer-orchestrator",
      },
    },
  );
  if (!res.ok) return null;
  const data = await res.json() as { content?: string; encoding?: string };
  if (!data.content) return null;
  return Buffer.from(data.content, "base64").toString("utf-8").trim();
}
```

**Step 4: Integrate into `forMergeGate`**

In `forMergeGate` method, add `fetchDefinitionOfDone` to the existing `Promise.all` call (line 78). Add it as a 6th parallel fetch:

```typescript
const [prDetails, reviews, prComments, diff, linearComments, definitionOfDone] = await Promise.all([
  prNumber && ghToken ? this.fetchPRDetails(repoPath, prNumber, ghToken) : null,
  prNumber && ghToken ? this.fetchPRReviews(repoPath, prNumber, ghToken) : [],
  prNumber && ghToken ? this.fetchPRComments(repoPath, prNumber, ghToken) : [],
  prNumber && ghToken ? this.fetchPRDiff(repoPath, prNumber, ghToken) : "",
  this.fetchLinearComments(ticket.ticketUUID).catch(() => []),
  ghToken ? this.fetchDefinitionOfDone(repoPath, ghToken).catch(() => null) : null,
]);
```

Add `definitionOfDone` to the returned context object (line 129, before the closing brace):

```typescript
  ...(definitionOfDone ? { definitionOfDone } : {}),
```

**Step 5: Run tests to verify they pass**

Run: `cd orchestrator && bun test context-assembler`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add orchestrator/src/context-assembler.ts orchestrator/src/context-assembler.test.ts
git commit -m "feat: fetch definition-of-done in merge gate context assembly"
```

---

### Task 5: Update merge gate prompt to reference definition-of-done

**Files:**
- Modify: `orchestrator/src/prompts/merge-gate.mustache` (add section before "Decision Required")

**Step 1: Add the definition-of-done section**

Insert before the `## Decision Required` section (before line 69):

```mustache
{{#definitionOfDone}}
## Definition of Done
The repo defines these acceptance criteria that the agent must satisfy before creating a PR:

{{{definitionOfDone}}}

Verify the PR description includes a "Definition of Done" section addressing every applicable checklist item. If items are missing or clearly unsatisfied, use "send_back" with details of what's missing.
{{/definitionOfDone}}
```

**Step 2: Commit**

```bash
git add orchestrator/src/prompts/merge-gate.mustache
git commit -m "feat: merge gate prompt references definition-of-done checklist"
```

---

### Task 6: Add project-specific Claude rule for administrative operations

**Files:**
- Create: `.claude/rules/administrative-operations.md`

This addresses the PR #88 problem where the agent wrote code instead of using the admin API.

**Step 1: Write the rule**

```markdown
# Administrative Operations

- Adding products, updating registry config, or changing orchestrator settings must be done via the admin API (POST/PUT/DELETE /api/products, PUT /api/settings/*), not by writing new code files or config files
- Never commit project-specific configuration (repo URLs, channel IDs, secret names, GitHub tokens) into source code — these belong in the runtime registry (SQLite via admin API)
- The registry.json file in orchestrator/src/ is a seed template only — do not add real product configs to it
```

**Step 2: Commit**

```bash
git add .claude/rules/administrative-operations.md
git commit -m "feat: add claude rule preventing code-based admin changes"
```

---

### Task 7: Run full test suite and verify

**Files:**
- No new files — verification only

**Step 1: Run orchestrator tests**

Run: `cd orchestrator && bun test`
Expected: ALL PASS

**Step 2: Run agent tests**

Run: `cd agent && bun test`
Expected: ALL PASS

**Step 3: Verify merge gate prompt renders correctly**

Manually inspect that `merge-gate.mustache` is valid Mustache syntax by reading the final file.

**Step 4: Commit any fixes if needed**

---

### Task 8: Update propagate skill to include definition-of-done template

**Files:**
- Modify: `.claude/skills/propagate/SKILL.md` (add `templates/definition-of-done.md` to the list of files pushed to target repos)

**Step 1: Read the propagate skill**

Read `.claude/skills/propagate/SKILL.md` to find where template files are listed.

**Step 2: Add definition-of-done.md to the template file list**

Add `templates/definition-of-done.md → .claude/definition-of-done.md` to the list of files that `/propagate` pushes to target repos. If a repo already has a `.claude/definition-of-done.md`, propagate should NOT overwrite it (it's repo-specific).

**Step 3: Commit**

```bash
git add .claude/skills/propagate/SKILL.md
git commit -m "feat: propagate pushes definition-of-done template to new repos"
```
