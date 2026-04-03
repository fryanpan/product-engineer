# Automated Prototype Deployment: Research & Recommendations

**Date:** 2026-03-31
**Context:** Reducing manual deployment setup for agent-created prototypes (e.g., Vite + React + Cloudflare Worker)

## Problem Statement

When the PE agent scaffolds a new project, the generated code is deployable but requires 6+ manual steps involving 3 different platforms (Cloudflare, Surge.sh, GitHub). The PE system already has credentials for Cloudflare, GitHub, and Linear. Most of this setup should be automatable.

---

## Option 1: Unified Cloudflare Worker with Static Assets (Recommended)

**What:** Combine frontend (Vite build output) and backend (Worker API) into a single Cloudflare Worker deployment using `[assets]` in `wrangler.toml`. Eliminates Surge.sh entirely.

**How it works:**
```toml
# wrangler.toml
name = "bike-route-finder"
main = "src/worker/index.ts"

[assets]
directory = "./dist"
not_found_handling = "single-page-application"
```

The Worker handles API routes (`/api/*`) while static assets are served directly from the `dist/` directory. SPA routing is handled automatically — unmatched paths return `index.html`. One `wrangler deploy` deploys everything.

**Setup effort:**
- One-time: Cloudflare account + API token (already exists in PE)
- Per-project: Zero additional platforms. Just `wrangler deploy`.

**What becomes automatable:**
- `wrangler deploy` can run in GitHub Actions with `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (PE already has these)
- Worker secrets (`wrangler secret put`) can be scripted
- No separate frontend hosting account needed
- No `VITE_WORKER_URL` needed — frontend and backend share the same origin (`/api/...` is relative)

**Manual steps remaining:**
- None for basic deployment. GitHub Actions with `cloudflare/wrangler-action` handles it.
- Linear webhook setup still needs manual Linear UI step (or Linear API call)

**Tradeoffs:**
- (+) Single deployment, single URL, single platform
- (+) No CORS issues (same origin)
- (+) Free tier: 100K requests/day on Workers free plan
- (+) Eliminates 3 secrets (SURGE_TOKEN, CLOUDFLARE_API_TOKEN for Pages, VITE_WORKER_URL)
- (-) Cloudflare-specific — but PE is already all-in on Cloudflare
- (-) Workers have 1MB script size limit (rarely hit for API code; assets are separate)

**Verdict: Best option.** This is the simplest path with the least moving parts. PE already has all required credentials.

---

## Option 2: Cloudflare Pages + Functions

**What:** Use Cloudflare Pages (with Functions for backend) instead of a separate Worker.

**How it works:** Pages deploys a frontend project and allows `/functions/*.ts` files to act as API endpoints (backed by Workers). Can use Direct Upload for programmatic deployment via `wrangler pages deploy ./dist`.

**Setup effort:**
- One-time: Same Cloudflare account (already exists)
- Per-project: Create Pages project via API, configure build

**What becomes automatable:**
- Project creation: `POST /accounts/{account_id}/pages/projects` API
- Deployment: `wrangler pages deploy ./dist --project-name=<name>`
- Secrets: Pages has environment variables (not Worker secrets)

**Manual steps remaining:**
- None for basic deployment

**Tradeoffs:**
- (+) Git integration option for auto-deploy on push
- (+) Preview deployments per PR (nice for prototypes)
- (-) Pages Functions have limitations vs full Workers (no Durable Objects, limited bindings)
- (-) Cloudflare is converging Pages into Workers — Pages may eventually be deprecated
- (-) Direct Upload projects can't switch to Git integration later
- (-) Two deployment models to maintain (PE uses Workers for itself, Pages for prototypes)

**Verdict: Viable but inferior to Option 1.** The convergence of Pages into Workers means betting on the legacy path. Workers with static assets is the future direction.

---

## Option 3: Secret Provisioning Automation (Complements any option)

**What:** Automate all secret/config setup that currently requires manual steps.

### 3a. GitHub Actions Secrets via `gh secret set`

The PE agent already has `gh` CLI access. After creating a repo:

```bash
gh secret set CLOUDFLARE_API_TOKEN --body "$CF_TOKEN" --repo org/project
gh secret set CLOUDFLARE_ACCOUNT_ID --body "$CF_ACCOUNT" --repo org/project
```

This eliminates manual GitHub Settings navigation entirely. The agent can set all required Actions secrets programmatically.

### 3b. Worker Secrets via Wrangler

```bash
echo "$LINEAR_API_KEY" | wrangler secret put LINEAR_API_KEY --name project-worker
```

Or via the Cloudflare API directly:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME/secrets" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -d '{"name":"LINEAR_API_KEY","text":"$VALUE","type":"secret_text"}'
```

### 3c. Shared Credentials from PE Registry

The PE system already stores shared secrets (LINEAR_API_KEY, SLACK_BOT_TOKEN, ANTHROPIC_API_KEY). For prototype projects that use the same Linear workspace and Slack instance, these can be injected directly:

- **Linear:** Use the shared `LINEAR_API_KEY` from PE's registry. No per-project Linear token needed.
- **GitHub:** Use the org-wide `GITHUB_TOKEN` from PE's registry.
- **Cloudflare:** Use PE's own `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

**Setup effort:** One-time implementation of a `provision-secrets` step in the `/create-project` skill.

**Manual steps remaining:** None for secrets that PE already has. Only truly new credentials (e.g., a third-party API key the prototype needs) require manual input.

**Verdict: Essential regardless of hosting choice.** This should be implemented first — it eliminates the majority of manual steps.

---

## Option 4: Inner Platform — PE-Managed Subdomain

**What:** Deploy all prototypes under a PE-managed domain (e.g., `bike-finder.projects.pe.dev`) using Cloudflare for SaaS or wildcard DNS + Worker routing.

**How it works:**
1. PE owns `projects.pe.dev` with a wildcard DNS record (`*.projects.pe.dev`)
2. A dispatch Worker routes `<project>.projects.pe.dev` to the correct project's assets/API
3. New projects are just new entries in the routing table — no per-project DNS or domain setup

**Implementation approaches:**
- **Cloudflare for SaaS (custom hostnames):** Designed for multi-tenant SaaS. Each prototype gets a custom hostname. Supports SSL automatically.
- **Workers for Platforms:** Designed for running customer-provided Workers. Each prototype is a separate Worker script dispatched by hostname.
- **Simple approach:** Single Worker with KV-based routing table. Store `project-slug → Worker script name` mappings. Wildcard route handles dispatch.

**Setup effort:**
- One-time: Domain setup, wildcard DNS, dispatch Worker, routing table in KV
- Per-project: One KV entry + `wrangler deploy` of the project's Worker

**Manual steps remaining:** None — the dispatch Worker handles routing automatically.

**Tradeoffs:**
- (+) Zero per-project infrastructure setup
- (+) Instant "deployment" — just upload assets and add routing entry
- (+) Central monitoring and access control
- (-) More complex initial setup (dispatch Worker, routing logic)
- (-) Shared domain means shared rate limits and security boundary
- (-) Custom domains require additional Cloudflare for SaaS setup
- (-) Over-engineering for prototypes that may never need production-grade hosting

**Verdict: Interesting but premature.** Worth revisiting if PE is deploying 10+ prototypes. For now, the per-project Worker approach (Option 1) is simpler and gives each project independence.

---

## Option 5: Zero-Config Platforms (Vercel, Netlify)

**What:** Use Vercel or Netlify's git integration for automatic deployments.

### Vercel
- Zero-config for Vite/React — auto-detects framework
- API routes via `/api/*.ts` files (serverless functions)
- Programmatic project creation via REST API
- `vercel.ts` for TypeScript-based configuration
- Free tier: 100GB bandwidth, 100K function invocations

### Netlify
- Similar zero-config for static sites
- Netlify Functions for backend (AWS Lambda under the hood)
- API for programmatic project creation
- Free tier: 100GB bandwidth, 125K function invocations

**Setup effort:**
- One-time: Create platform account, generate API token
- Per-project: API call to create project + link GitHub repo

**Manual steps remaining:**
- One-time platform account creation (cannot be automated)
- Per-project: Minimal — API handles most setup

**Tradeoffs:**
- (+) True zero-config for standard frameworks
- (+) Preview deployments per PR (both)
- (+) Vercel has excellent DX for React/Next.js
- (-) Introduces a new vendor outside the Cloudflare ecosystem
- (-) PE would need to manage Vercel/Netlify API tokens in addition to Cloudflare
- (-) Serverless functions have different constraints than Workers (cold starts, runtime limits)
- (-) Backend features (Durable Objects, KV, R2) not available — would still need Cloudflare for those

**Verdict: Not recommended.** Adding another platform increases complexity. Cloudflare Workers with static assets provides equivalent functionality within the existing ecosystem.

---

## Option 6: Infrastructure-as-Code (Terraform/Pulumi)

**What:** Generate Terraform or Pulumi config alongside code for declarative infrastructure.

**How it works:** The agent generates a `main.tf` or `Pulumi.ts` that declares the Worker, secrets, DNS records, and GitHub Actions secrets. `terraform apply` provisions everything.

**Setup effort:**
- One-time: Terraform/Pulumi setup, state backend (e.g., Terraform Cloud or S3)
- Per-project: Generate config, run `terraform apply`

**Tradeoffs:**
- (+) Declarative, reproducible, version-controlled infrastructure
- (+) Can manage multi-cloud resources (Cloudflare + GitHub + Linear)
- (-) Heavy dependency for prototype projects
- (-) State management adds complexity (state locking, drift detection)
- (-) Terraform Cloudflare provider may lag behind Wrangler features
- (-) The agent would need Terraform/Pulumi installed in its container

**Verdict: Over-engineering for prototypes.** IaC makes sense for production infrastructure, not throwaway prototypes. The Wrangler CLI + `gh` CLI combination achieves the same automation with less overhead.

---

## Recommendation: Phased Approach

### Phase 1: Secret Automation (Immediate, ~1 day)

Update the `/create-project` skill to automatically provision secrets:

```
1. Create GitHub repo (already done)
2. gh secret set CLOUDFLARE_API_TOKEN --body "$CF_TOKEN" --repo org/project
3. gh secret set CLOUDFLARE_ACCOUNT_ID --body "$CF_ACCOUNT" --repo org/project
4. Any project-specific secrets from PE registry
```

This alone eliminates 50%+ of manual steps regardless of hosting choice.

### Phase 2: Unified Worker Template (1-2 days)

Create a project template that uses Workers with static assets instead of Surge.sh:

```
wrangler.toml:
  [assets]
  directory = "./dist"
  not_found_handling = "single-page-application"

GitHub Actions:
  - Build frontend (npm run build)
  - wrangler deploy (deploys everything)
```

Key changes to the template:
- Replace Surge.sh deployment step with `wrangler deploy`
- Remove `VITE_WORKER_URL` — use relative `/api/` paths instead
- Remove `SURGE_TOKEN` secret
- Add `wrangler.toml` with `[assets]` config
- Single GitHub Actions workflow instead of separate frontend/backend deploys

### Phase 3: Full Automation in `/create-project` (2-3 days)

The enhanced `/create-project` skill would:

1. `gh repo create` (already done)
2. Scaffold code with unified Worker template
3. `gh secret set` for all required Actions secrets (from PE registry)
4. Initial `wrangler deploy` to create the Worker
5. `wrangler secret put` for any Worker-level secrets
6. Report the live URL back to the user

**End state:** User says "create a bike route finder app" and gets back a live URL with CI/CD configured. Zero manual steps.

### Phase 4: Inner Platform (Future, if needed)

If PE is deploying many prototypes, implement the subdomain routing approach (Option 4) for even faster deployment. But only if the volume justifies the complexity.

---

## Summary Comparison

| Criteria | Unified Worker (Rec.) | CF Pages | Vercel/Netlify | Inner Platform | IaC |
|----------|----------------------|----------|---------------|---------------|-----|
| Per-project manual steps | 0 | 0 | 1 (account) | 0 | 0 |
| New vendor dependencies | 0 | 0 | 1 | 0 | 1 |
| Secrets to manage | 2 (CF token + account) | 2 | 3+ | 2 | 2+ |
| Fits PE ecosystem | Perfect | Good | Poor | Perfect | OK |
| Setup complexity | Low | Low | Medium | High (one-time) | High |
| Preview deployments | No* | Yes | Yes | No | No |
| Cost (free tier) | 100K req/day | 500 req/min | 100K inv/mo | 100K req/day | Free |

*Preview deployments could be added via branch-based Worker names, but not built-in.

---

## Key Insight

The biggest win is not switching platforms — it is **automating what PE already has credentials for**. The PE system holds Cloudflare API tokens, GitHub tokens, and Linear API keys. The `/create-project` skill just needs to use them programmatically instead of printing manual instructions.

The unified Worker approach (Option 1) is the cherry on top: it collapses two platforms (Surge + Cloudflare Workers) into one, eliminating an entire class of cross-origin configuration.
