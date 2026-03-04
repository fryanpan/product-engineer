---
name: create-project
description: Scaffold a new project from scratch and connect it to the Product Engineer system. Handles repo creation, project structure setup, and registry integration.
---

# Create New Project

Scaffold a new project repository, set up the project structure, and connect it to the Product Engineer orchestrator.

## When to Use This

Use this skill when you need to create a brand new project from scratch. For adding existing repos to Product Engineer, use `/add-project` instead.

## Steps

### Step 1: Gather Project Requirements

Collect information from the user:
- **Project name** — kebab-case identifier (e.g., `health-tool`, `bike-tool`)
- **Project description** — what the project does
- **Project type** — web app, CLI tool, API service, library, etc.
- **Tech stack preferences** — language, framework, database, etc.
- **GitHub org** — which organization to create the repo under (e.g., `fryanpan`)
- **Slack channel name** — where the agent will communicate (e.g., `#health-tool`)
- **Linear project name** — the project name in Linear (e.g., `Health Tool`)

### Step 2: Check for Existing Scaffolding Skills

If the `fryanpan/ai-project-support` repo exists and has scaffolding skills, use those to set up the project structure. Common patterns:

- **Web app**: Next.js, React, TypeScript, Tailwind, database setup
- **API service**: Cloudflare Workers, Hono, TypeScript, D1/KV
- **CLI tool**: TypeScript/Node.js, commander, inquirer
- **Library**: TypeScript, Vitest, build config

If ai-project-support doesn't have relevant skills, scaffold manually based on project type.

### Step 3: Create GitHub Repository

```bash
# Create a new repo using GitHub CLI
gh repo create <org>/<project-name> --public --description "<description>"

# Clone it locally
git clone https://github.com/<org>/<project-name>.git
cd <project-name>
```

### Step 4: Scaffold Project Structure

Set up the basic project structure. At minimum, include:

**Essential files:**
- `README.md` — project overview, setup instructions
- `CLAUDE.md` — instructions for the Product Engineer agent
- `.gitignore` — appropriate for the tech stack
- `package.json` (for JS/TS) or equivalent
- `.claude/settings.json` — copy from product-engineer's `templates/claude-settings.json`
- `.mcp.json` — MCP server configuration

**Recommended directories:**
- `src/` — source code
- `tests/` — test files
- `docs/` — documentation

**CLAUDE.md template:**
```markdown
# [Project Name]

[Brief description of what this project does]

## Architecture

[High-level overview of how the project is structured]

## Development

\`\`\`bash
# Install dependencies
bun install

# Run locally
bun run dev

# Run tests
bun test

# Deploy
bun run deploy
\`\`\`

## Conventions

- [Tech stack specific conventions]
- [Code organization patterns]
- [Testing approach]
```

**MCP configuration (.mcp.json):**
```json
{
  "mcpServers": {
    "linear": {
      "command": "bun",
      "args": ["run", "mcp-linear"],
      "env": {
        "LINEAR_API_KEY": "${LINEAR_API_KEY}"
      }
    },
    "context7": {
      "command": "bun",
      "args": ["run", "mcp-context7"],
      "env": {
        "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
      }
    }
  }
}
```

### Step 5: Set Up Development Environment

Based on project type, install and configure:

**For TypeScript projects:**
```bash
bun init
bun add -D typescript @types/node
bun add -D vitest  # or your test framework
bun add -D prettier eslint  # code quality tools
```

**For Cloudflare Workers:**
```bash
bun create cloudflare@latest
# Or set up wrangler manually
bun add -D wrangler
```

**For Next.js:**
```bash
bunx create-next-app@latest . --typescript --tailwind --app --no-src-dir
```

### Step 6: Create Initial Commit

```bash
git add .
git commit -m "Initial project scaffold

- Basic project structure
- Development environment setup
- Claude agent configuration

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
git push -u origin main
```

### Step 7: Add to Product Engineer Registry

Use the `/add-project` skill to register the new repo:

1. Add entry to `orchestrator/src/registry.json`
2. Create Slack channel if needed
3. Create Linear project if needed
4. Verify secrets are configured
5. Deploy the updated orchestrator

### Step 8: Set Up Linear Project

1. Go to Linear → Projects
2. Create project with the specified name
3. Add initial issues:
   - Set up CI/CD
   - Add tests
   - Write documentation
   - Any project-specific setup tasks

### Step 9: Set Up Slack Channel

1. Create the channel in Slack
2. Invite `@PE` bot
3. Post welcome message with project context

### Step 10: Test End-to-End

1. Create a test Linear ticket: `@PE test: verify setup`
2. Or mention in Slack: `@PE test: create a hello world file`
3. Verify the agent responds and can work in the repo

## Scaffolding Patterns by Project Type

### Web Application (Next.js + Cloudflare)

**Stack:**
- Next.js 15 with App Router
- TypeScript
- Tailwind CSS
- Cloudflare Pages for hosting
- D1 for database

**Key files:**
- `app/` — Next.js app directory
- `components/` — React components
- `lib/` — utilities and database
- `wrangler.toml` — Cloudflare config
- `schema.sql` — D1 database schema

### API Service (Cloudflare Workers)

**Stack:**
- Cloudflare Workers
- Hono framework
- TypeScript
- D1 or KV for storage

**Key files:**
- `src/index.ts` — worker entrypoint
- `src/routes/` — API routes
- `wrangler.toml` — Cloudflare config
- `schema.sql` — D1 schema (if needed)

### CLI Tool

**Stack:**
- Node.js/Bun
- TypeScript
- Commander.js for CLI
- Inquirer for prompts

**Key files:**
- `src/cli.ts` — CLI entrypoint
- `src/commands/` — command handlers
- `bin/` — executable scripts

### Library/Package

**Stack:**
- TypeScript
- Vitest for testing
- TSup or similar for building

**Key files:**
- `src/index.ts` — main exports
- `tests/` — test files
- `tsconfig.json` — TypeScript config
- `package.json` — with proper exports

## Integration with AI Project Support

If `fryanpan/ai-project-support` exists and has scaffolding skills:

1. Load its skills: reference them in the prompt or use them directly if available
2. Use its templates and generators for consistent project structure
3. Follow its conventions for CLAUDE.md, testing, CI/CD setup

**Example integration:**
```
The user wants to create a [type] project.

1. Use ai-project-support's [scaffold-web-app/scaffold-api/etc] skill to generate the base structure
2. Customize with project-specific requirements
3. Add to Product Engineer registry using /add-project
```

## Post-Creation Checklist

After scaffolding, verify:
- [ ] Repo exists on GitHub
- [ ] Project has CLAUDE.md with clear instructions
- [ ] Agent permissions configured (.claude/settings.json)
- [ ] MCP servers configured (.mcp.json)
- [ ] Added to Product Engineer registry
- [ ] Slack channel created and bot invited
- [ ] Linear project created
- [ ] Test ticket creates a PR successfully
- [ ] README has setup instructions

## Troubleshooting

**GitHub CLI not authenticated:**
```bash
gh auth login
```

**Can't create repo:**
- Check you have permissions in the org
- Verify org name is correct
- Try creating manually on github.com first

**Agent can't access repo:**
- Verify GitHub token in Cloudflare secrets
- Check token has access to the org
- Verify token permissions: Contents (R/W), PRs (R/W)

**Dependencies install fails:**
- Check Node.js/Bun version
- Verify package.json syntax
- Check network/registry access
