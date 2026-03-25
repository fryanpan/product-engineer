---
name: propagate
description: Compare a project's Claude setup against templates, validate for antipatterns, and push approved updates via GitHub PRs.
argument-hint: "[artifact-type] [target-project]"
user-invocable: true
---

# Propagate Updates to Projects

Compare projects against `templates/` and push approved updates via GitHub PRs.

## Arguments

- `$ARGUMENTS` can specify:
  - A specific artifact: `rules`, `claude-md`, `settings`
  - `all` — compare everything (default if only a project name is given)
  - A target project name (product slug). If omitted, propagate to all registered products.

## Steps

1. **Parse arguments** to determine what to compare and which project(s).

2. **Load the product registry** via the admin API:
   - `GET /api/products` to list all products (requires `X-API-Key` header)
   - Each product has a `repos` array of GitHub repo identifiers (e.g., `"your-org/my-app"`)
   - If a target project is specified in arguments, match it against product slugs or repo names
   - If no target is specified, iterate over ALL products and ALL their repos
   - Each unique repo is a propagation target
   - The `WORKER_URL` and `API_KEY` can be found in the conductor's Cloudflare secrets or env

3. **For each target repo**, clone it to a temp directory (or use `gh repo clone <repo> /tmp/<repo-name>`) for comparison.

4. **Read the latest templates** from `templates/`:
   - Rules: `templates/rules/*.md`
   - Docs: `templates/docs/CLAUDE.md.tmpl`
   - Settings: `templates/claude-settings.json`
   - Definition of Done: `templates/definition-of-done.md` → `.claude/definition-of-done.md`
     - **Only push if the target repo does not already have `.claude/definition-of-done.md`.** Each repo customizes their own conditional sections, so never overwrite an existing file.

5. **Read the project's current setup**:
   - `.claude/rules/` — list all rules, read each
   - `.claude/settings.json` — current permissions
   - `CLAUDE.md` — current project guide

6. **Run antipattern validation** (see below).

7. **Generate a comparison report**:

   For each artifact, classify as:
   - **Missing** — template exists but project doesn't have it
   - **Outdated** — project has it but differs from template (show diff)
   - **Current** — matches template
   - **Custom** — project has something not in templates (note but don't touch)
   - **Antipattern** — fails validation checks (flag for fix)

   Present the report as a table:

   | Artifact | Status | Details |
   |----------|--------|---------|
   | rules/feedback-loop.md | Outdated | Template removed interactive prompts |
   | rules/workflow-conventions.md | Antipattern | Contains interactive-only content |
   | CLAUDE.md | Current | Matches template |

8. **Get approval for updates**:
   - In interactive mode: present the report and ask which updates to apply
   - In headless mode: use the `ask_question` Slack tool to post the comparison report and wait for approval via Slack reply

9. **For each target project**, create a single PR:
   - Create a branch: `product-engineer/propagate-{date}`
   - Apply approved changes, preserving project-specific customizations
   - Push and create PR with `gh pr create --repo <repo>`
   - Title: `[product-engineer] Update Claude setup from templates`

10. **Log to `docs/process/propagation-log.md`** and commit.

## Antipattern Validation

Run these checks on every project's `.claude/` setup:

### 1. Interactive-only alwaysApply rules
Scan `.claude/rules/*.md` files with `alwaysApply: true` for interactive patterns:
- **Ask for feedback** prompts (e.g., "Does this work as expected?", "Anything that felt clunky?")
- **Offer to run** patterns (e.g., "Want me to run `/retro`?", "Good moment for a quick retro")
- **Watch for friction** patterns (e.g., "If the user seems frustrated")
- **Periodic retro prompts** (e.g., "After ~2-3 hours of work")
- **AskUserQuestion** references
- **Plan mode** references (EnterPlanMode, ExitPlanMode)
- **TodoWrite** usage
- **Superpowers plugin** references (brainstorming, executing-plans, etc.) in alwaysApply rules

Flag as: `ANTIPATTERN: Interactive content in alwaysApply rule wastes agent context tokens`

### 2. Excessive alwaysApply token count
Sum the line count of all `alwaysApply: true` rules. Flag if > 80 lines total.

Flag as: `ANTIPATTERN: {N} lines of alwaysApply rules — target < 80 lines for agent efficiency`

### 3. Redundant skills
Check for skills that duplicate what the product-engineer agent already provides:
- Full interactive retro skills (agent uses task-retro from this repo)
- Plan persistence skills (agent doesn't use plan mode)
- Session startup skills

Flag as: `INFO: Skill may be redundant with product-engineer agent — verify if needed for interactive use`

### 4. Missing headless essentials
Check that the project has:
- `CLAUDE.md` with `@docs/process/learnings.md` import
- `.claude/settings.json` with appropriate permissions

Flag as: `MISSING: {item} — required for agent to work effectively`

## Principles

- **Never force-update.** Always show the comparison report, get approval first.
- **Preserve project-specific customizations.** The template is a baseline, not a mandate.
- **Report but don't touch custom artifacts.** If a project has skills/rules not in templates, note them but leave them alone.
- **One PR per project.** Bundle related changes into a single commit and PR per project.
