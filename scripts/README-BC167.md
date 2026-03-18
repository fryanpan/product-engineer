# BC-167 Setup Scripts

Scripts for setting up 7 repos with Product Engineer integration.

## Overview

Two scripts work together to fully set up each repo:

1. **`setup-repos.sh`** — Adds products to the orchestrator registry (one-time setup)
2. **`setup-repo-templates.sh`** — Sets up Claude templates in each repo (per-repo setup)

## Quick Start

### Step 1: Add Products to Registry

```bash
# Set environment variables
export WORKER_URL="https://product-engineer.example.workers.dev"
export API_KEY="your-api-key-here"
export GITHUB_ORG="fryanpan"
export SHARED_GITHUB_TOKEN="FRYANPAN_GITHUB_TOKEN"

# Run setup
bash scripts/setup-repos.sh
```

This adds all 7 products to the orchestrator registry via the admin API.

### Step 2: Set Up Each Repo

For each repo, run:

```bash
# Clone repo (if not already cloned)
git clone git@github.com:fryanpan/givewell-impact.git
cd givewell-impact

# Run template setup
bash /path/to/product-engineer/scripts/setup-repo-templates.sh \
  --repo-path . \
  --product-name "Givewell Impact" \
  --product-description "Nonprofit impact tracking and analysis" \
  --development-setup "npm install && npm run dev"

# Push changes
git push
```

Repeat for all 7 repos.

## Scripts

### `setup-repos.sh`

**Purpose:** Adds multiple products to the orchestrator registry.

**Environment Variables:**
- `WORKER_URL` (required) — Orchestrator worker URL
- `API_KEY` (required) — Admin API key
- `GITHUB_ORG` (default: `fryanpan`) — GitHub organization
- `SHARED_GITHUB_TOKEN` (default: `FRYANPAN_GITHUB_TOKEN`) — Shared GitHub token name

**What it does:**
- Adds all 7 products to registry via `POST /api/products`
- Verifies each product was added via `GET /api/products/<slug>`
- Prints next steps for manual setup

**What it doesn't do:**
- Create Slack channels (manual)
- Create Linear projects (manual)
- Create GitHub repos (manual)
- Set up Claude templates (use `setup-repo-templates.sh`)
- Configure GitHub webhooks (manual)

### `setup-repo-templates.sh`

**Purpose:** Sets up Claude Code templates in a target repository.

**Arguments:**
- `--repo-path` (required) — Path to target repo
- `--product-name` (required) — Product display name
- `--product-description` (optional) — Brief description
- `--development-setup` (optional) — Setup instructions

**What it does:**
- Copies `CLAUDE.md` from template (with placeholder replacement)
- Copies `.claude/settings.json` for agent permissions
- Copies `.mcp.json` for MCP server configuration
- Copies `.claude/rules/*.md` for alwaysApply rules
- Creates `docs/` structure:
  - `docs/product/decisions.md`
  - `docs/product/plans/`
  - `docs/process/learnings.md`
  - `docs/process/retrospective.md`
- Commits changes to git (if in a git repo)

**Backups:**
- If any file already exists, creates `.backup` copy before overwriting

## Products to Set Up

| Repo | Slack Channel | Linear Project | Product Name |
|------|---------------|----------------|--------------|
| givewell-impact | #nonprofit-impact | Nonprofit Impact | Givewell Impact |
| blog-assistant | #blog-assistant | Blog Assistant | Blog Assistant |
| tasks | #tasks | Tasks | Tasks |
| personal-crm | #personal-crm | personal-crm | Personal CRM |
| research-notes | #research-notes | Research Notes | Research Notes |
| task-pilot | #task-pilot | Task Pilot | Task Pilot |
| personal-finance | #personal-finance | Personal Finance | Personal Finance |

## Full Setup Example

```bash
# ── Step 1: Add all products to registry ──────────────────────

export WORKER_URL="https://product-engineer.fryanpan.workers.dev"
export API_KEY="$(wrangler secret list | grep API_KEY)"
export GITHUB_ORG="fryanpan"
export SHARED_GITHUB_TOKEN="FRYANPAN_GITHUB_TOKEN"

bash scripts/setup-repos.sh

# ── Step 2: Set up each repo ──────────────────────────────────

# givewell-impact
git clone git@github.com:fryanpan/givewell-impact.git
bash scripts/setup-repo-templates.sh \
  --repo-path ./givewell-impact \
  --product-name "Givewell Impact" \
  --product-description "Nonprofit impact tracking and analysis"
cd givewell-impact && git push && cd ..

# blog-assistant
git clone git@github.com:fryanpan/blog-assistant.git
bash scripts/setup-repo-templates.sh \
  --repo-path ./blog-assistant \
  --product-name "Blog Assistant" \
  --product-description "AI-powered blog writing and editing assistant"
cd blog-assistant && git push && cd ..

# tasks
git clone git@github.com:fryanpan/tasks.git
bash scripts/setup-repo-templates.sh \
  --repo-path ./tasks \
  --product-name "Tasks" \
  --product-description "Personal task management and tracking"
cd tasks && git push && cd ..

# personal-crm
git clone git@github.com:fryanpan/personal-crm.git
bash scripts/setup-repo-templates.sh \
  --repo-path ./personal-crm \
  --product-name "Personal CRM" \
  --product-description "Personal relationship and contact management"
cd personal-crm && git push && cd ..

# research-notes
git clone git@github.com:fryanpan/research-notes.git
bash scripts/setup-repo-templates.sh \
  --repo-path ./research-notes \
  --product-name "Research Notes" \
  --product-description "Research notes and knowledge management"
cd research-notes && git push && cd ..

# task-pilot
git clone git@github.com:fryanpan/task-pilot.git
bash scripts/setup-repo-templates.sh \
  --repo-path ./task-pilot \
  --product-name "Task Pilot" \
  --product-description "AI task automation and workflow management"
cd task-pilot && git push && cd ..

# personal-finance
git clone git@github.com:fryanpan/personal-finance.git
bash scripts/setup-repo-templates.sh \
  --repo-path ./personal-finance \
  --product-name "Personal Finance" \
  --product-description "Personal finance tracking and analysis"
cd personal-finance && git push && cd ..

# ── Step 3: Manual setup ──────────────────────────────────────

# 1. Create Slack channels and invite bot
# 2. Create Linear projects
# 3. Configure GitHub webhooks
# 4. Test each integration

# See docs/setup-7-repos-bc167.md for detailed instructions
```

## Manual Setup Required

After running the scripts, you still need to:

### 1. Create Slack Channels

For each product:
1. Create channel in Slack (e.g., `#nonprofit-impact`)
2. Invite bot: `/invite @product-engineer`
3. (Optional) Get channel ID and add to registry

### 2. Create Linear Projects

For each product:
1. Go to Linear → Projects → "New Project"
2. Use exact name from table above
3. Ensure it's in the correct team

### 3. Create GitHub Repos (if needed)

For repos that don't exist:
1. Create on GitHub (public or private)
2. Initialize with README (optional)
3. Clone locally before running `setup-repo-templates.sh`

### 4. Configure GitHub Webhooks

For each repo:
1. Go to repo settings → Webhooks → "Add webhook"
2. URL: `https://product-engineer.example.workers.dev/api/webhooks/github`
3. Content type: `application/json`
4. Secret: `GITHUB_WEBHOOK_SECRET` value from Cloudflare
5. Events: Pull requests, Pull request reviews
6. Active: ✓

### 5. Verify GitHub Token Access

Ensure the shared GitHub token (or per-repo tokens) have:
- Repository access: All 7 repos
- Permissions:
  - Contents: Read and write
  - Pull requests: Read and write
  - Issues: Read and write
  - Commit statuses: Read and write

## Testing

For each repo, test all integration points:

### Test Linear Integration

```bash
# Create a test ticket in the Linear project
# Watch the Slack channel for agent notification
# Verify agent creates a PR
```

### Test Slack Integration

```bash
# In the Slack channel:
@product-engineer test: create a hello world file

# Verify agent responds in thread
# Verify agent creates a PR
```

### Test Thread Replies

```bash
# Reply in the ticket thread WITHOUT mentioning the bot
# Agent should respond within a few minutes
```

## Troubleshooting

See `docs/setup-7-repos-bc167.md` for detailed troubleshooting guides.

**Common issues:**

- **Registry API returns 401**: Check `API_KEY` is correct
- **Registry API returns 404**: Check `WORKER_URL` is correct and worker is deployed
- **Template script fails**: Check `--repo-path` exists and is a directory
- **Git commit fails**: Ensure repo is initialized with `git init`
- **Agent doesn't respond**: Verify webhooks are configured and secrets are set

## References

- Main documentation: `docs/setup-7-repos-bc167.md`
- Setup skill: `.claude/skills/setup-product/SKILL.md`
- Add project skill: `.claude/skills/add-project/SKILL.md`
- Templates directory: `templates/`
