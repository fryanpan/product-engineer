---
name: create-project
description: Scaffold a new project from scratch and connect it to the Product Engineer system. Handles repo creation, project structure setup, and registry integration.
---

# Create New Project

Scaffold a new project repository, set up the project structure, and connect it to the Product Engineer conductor.

## When to Use This

Use this skill when you need to create a brand new project from scratch. For adding existing repos to Product Engineer, use `/add-project` instead.

## Steps

### Step 1: Gather Project Requirements

Collect information from the user:
- **Project name** — kebab-case identifier (e.g., `health-tool`, `bike-tool`)
- **Project description** — what the project does
- **Project type** — web app, CLI tool, API service, library
- **Tech stack preferences** — language, framework, database
- **GitHub org** — which organization to create the repo under
- **Slack channel name** — where the agent will communicate
- **Linear project name** — the project name in Linear that will trigger this product

### Step 2: Create GitHub Repository

```bash
gh repo create <org>/<project-name> --public --description "<description>"
git clone https://github.com/<org>/<project-name>.git
cd <project-name>
```

### Step 3: Scaffold Project Structure

**Essential files:**
- `README.md` — project overview, setup instructions
- `CLAUDE.md` — from `templates/docs/CLAUDE.md.tmpl`, fill in placeholders
- `.gitignore` — appropriate for the tech stack
- `package.json` (for JS/TS) or equivalent
- `.claude/settings.json` — copy from `templates/claude-settings.json`
- `.mcp.json` — MCP server configuration
- `wrangler.toml` — from `templates/worker-template/wrangler.toml.tmpl`, fill in `{{project_name}}` and `{{subdomain}}`
- `src/worker.ts` — from `templates/worker-template/src/worker.ts.tmpl`
- `.github/workflows/deploy.yml` — from `templates/worker-template/.github/workflows/deploy.yml.tmpl`
- `.github/workflows/ci.yml` — from `templates/worker-template/.github/workflows/ci.yml.tmpl`

**Rules (from templates — headless-optimized):**
- `.claude/rules/feedback-loop.md` — copy from `templates/rules/feedback-loop.md`
- `.claude/rules/workflow-conventions.md` — copy from `templates/rules/workflow-conventions.md`

**Token optimization guidelines for rules:**
- `alwaysApply: true` rules are injected into EVERY agent prompt turn — keep them concise
- Total alwaysApply content should be < 80 lines across all rules
- Never include interactive patterns (asking user questions, offering retros, watching for frustration)
- Never reference plan mode, TodoWrite, or superpowers plugin in alwaysApply rules
- Project-specific skills (invoked on demand) can be longer — they're only loaded when needed

**Recommended directories:**
- `src/` — source code
- `tests/` — test files
- `docs/process/` — learnings.md, retrospective.md
- `docs/product/` — decisions.md, plans/

### Step 4: Set Up Development Environment

Based on project type, install and configure the appropriate toolchain.

### Step 5: Create Initial Commit

```bash
git add .
git commit -m "Initial project scaffold with Product Engineer integration"
git push -u origin main
```

### Step 6: Add to Product Engineer Registry

Use the `/add-project` skill to register the new repo via the admin API.

### Step 7: Provision Deployment Secrets

Automatically provision secrets so CI/CD works without manual configuration.

**Load PE's production secrets:**
```bash
eval $(./scripts/load-secrets.sh prod)
```

**Set GitHub Actions secrets for the new repo:**
```bash
gh secret set CLOUDFLARE_API_TOKEN --body "$CLOUDFLARE_API_TOKEN" --repo <org>/<project-name>
gh secret set CLOUDFLARE_ACCOUNT_ID --body "$CLOUDFLARE_ACCOUNT_ID" --repo <org>/<project-name>
```

**Initial deploy to create the Worker:**
```bash
cd <project-dir>
bun install
bun run build
wrangler deploy
```

Note the live URL from wrangler output (e.g., `https://<project-name>.fryanpan.workers.dev`).

**Set Worker runtime secrets:**
```bash
echo "$LINEAR_API_KEY" | wrangler secret put LINEAR_API_KEY --name <project-name>
echo "$LINEAR_TEAM_ID" | wrangler secret put LINEAR_TEAM_ID --name <project-name>
echo "$LINEAR_PROJECT_ID" | wrangler secret put LINEAR_PROJECT_ID --name <project-name>
```

**Defense in depth notes:**
- GitHub tokens: already per-product in PE registry
- Cloudflare API token: shared for now (future: create per-project scoped tokens via Cloudflare API)
- Linear API key: shared workspace key (acceptable — only creates issues)

### Step 8: Set Up Linear + Slack

1. Create Linear project with the specified name
2. Create Slack channel, invite `@PE` bot

### Step 9: Test End-to-End

1. Verify the live URL returns the app (from Step 7)
2. Push a change to main and verify CI/CD deploys automatically
3. Mention in Slack: `@PE test: create a hello world file`

## Post-Creation Checklist

- [ ] Repo exists on GitHub with CLAUDE.md and unified Worker config
- [ ] `.claude/rules/` has headless-compatible rules only (< 80 lines total alwaysApply)
- [ ] `.claude/settings.json` configured
- [ ] Added to Product Engineer registry
- [ ] GitHub Actions secrets set (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
- [ ] Worker deployed and accessible at `<project>.fryanpan.workers.dev`
- [ ] Worker runtime secrets set (LINEAR_API_KEY, LINEAR_TEAM_ID, LINEAR_PROJECT_ID)
- [ ] CI/CD deploys on push to main
- [ ] Slack channel created and bot invited
- [ ] Linear project created
- [ ] Test mention creates a PR successfully
