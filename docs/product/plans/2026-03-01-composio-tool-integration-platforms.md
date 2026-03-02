# Composio and Tool Integration Platforms for AI Agents

**Date:** 2026-03-01
**Problem:** How should we manage tool access, API keys/secrets, and integrations (Linear, Slack, Notion, GitHub) for Claude Code agents running in Cloudflare Sandbox containers? Composio is one option -- is it the right one, or is there something simpler?

---

## Context

We are building a Product Engineer Agent system: Claude Code agents running in Cloudflare Sandbox containers (Firecracker microVMs), triggered by Linear issues, with access to tools like Linear, Slack, Notion, and GitHub. One team (Booster) already uses Composio. Composio also publishes an open-source Agent Orchestrator with Linear plugin support.

The core question: do we need a tool orchestration platform like Composio, or can we get by with direct secret management (Cloudflare Secrets Store, environment variables, or a proxy pattern)?

---

## Option 1: Composio

**What it is:** An AI-native integration platform that connects LLMs and agents to 250+ SaaS apps. Provides managed authentication (OAuth flows, token refresh, credential storage), a unified SDK, and MCP server endpoints that agents connect to.

**GitHub:** https://github.com/ComposioHQ/composio

### How It Works

1. Install `composio-core` (Python) or use their CLI
2. Create a Composio client with your API key
3. Request tool access for specific apps (e.g., `toolkits=["linear", "slack", "notion", "github"]`)
4. Composio generates an MCP endpoint URL
5. Pass that URL to Claude Code via `claude mcp add --transport http <name> <url> --headers X-API-Key:<key>`
6. First use triggers OAuth flow -- user authenticates, Composio stores tokens
7. All subsequent API calls route through Composio's servers

```python
from composio import Composio

composio = Composio(api_key=COMPOSIO_API_KEY)
session = composio.create(
    user_id="agent-1",
    toolkits=["linear", "slack", "notion", "github"],
)
mcp_url = session.mcp.url
# Pass mcp_url to Claude Code or Agent SDK
```

### Tool Router ("Rube")

Composio's "Tool Router" is a universal MCP server with access to 850+ apps. It provides just-in-time tool loading so Claude only loads tools relevant to the current task, avoiding the token cost of exposing all 250+ toolkits at once. Also includes a "remote workbench" for handling large tool responses outside the LLM context window.

### Pricing

- **Free tier:** Available for development (limited actions)
- **Paid plans:** Start at ~$29/month, usage-based (per-action pricing)
- **Enterprise:** Custom pricing, VPC/on-premise deployment, dedicated SLA
- **Startup credits:** Up to $25K in free credits for eligible startups
- Pricing scales with executed actions, not seat count

### Security

- SOC 2 Type 2 and ISO compliant
- Tokens and keys encrypted at rest and in transit
- Composio stores and manages OAuth tokens -- you don't handle refresh flows
- The agent never sees raw credentials (they're injected server-side)

### Pros

- **Fastest time-to-value for multi-tool access.** OAuth flows, token refresh, and API wrappers are handled. Linear, Slack, Notion, GitHub all have pre-built toolkits.
- **MCP-native.** Works directly with Claude Code via `claude mcp add`.
- **Auth management is the killer feature.** OAuth is genuinely hard to do right (token refresh, scope management, multi-tenant auth). Composio handles all of it.
- **Tool Router reduces token waste.** Only loads tools relevant to the current task.
- **Already proven with the team.** Booster uses it; Composio's Agent Orchestrator has a Linear plugin.

### Cons

- **All API traffic routes through Composio's servers.** Every tool call is a round-trip to their infrastructure. Adds latency and a dependency on their uptime.
- **No tool customization.** You can't inspect or modify Composio's tool implementations. If their Linear tool doesn't do what you need, you're stuck.
- **Limited observability.** No custom debug messages, no OpenTelemetry export, no per-request logging you control.
- **Vendor lock-in.** Your agent's tool access depends on Composio staying up, maintaining their API, and keeping prices reasonable.
- **Cost at scale is unclear.** Usage-based pricing on per-action basis could get expensive with autonomous agents making many API calls.
- **Overkill for simple use cases.** If you only need 4 tools with API keys, a full platform is heavy.

### Assessment for Our Use Case

Composio solves a real problem (OAuth management for multi-tool agents), but introduces a significant dependency. Every tool call routes through their servers, and you can't customize tool behavior. For a system running in Cloudflare Sandbox where we control the infrastructure, this adds a layer we may not need.

**Best fit:** If you need 10+ integrations with OAuth flows and don't want to manage tokens yourself. Not obviously the right choice for 4 tools where you already have API keys.

---

## Option 2: Cloudflare Secrets Store + Direct Environment Variables

**What it is:** Store API keys in Cloudflare's native Secrets Store (or per-Worker secrets), inject them as environment variables into sandbox containers. The agent accesses tools directly via their APIs or MCP servers you run yourself.

### How It Works

1. Store secrets using Wrangler CLI or the Cloudflare dashboard:
   ```bash
   wrangler secret put LINEAR_API_KEY
   wrangler secret put SLACK_BOT_TOKEN
   wrangler secret put NOTION_API_KEY
   wrangler secret put GITHUB_TOKEN
   ```
2. Access in Workers/Sandbox via `env`:
   ```javascript
   const linearKey = await env.SECRETS_STORE.get("LINEAR_API_KEY")
   ```
3. Pass to Claude Code agent as environment variables when spawning the sandbox
4. Agent uses official MCP servers (Linear, GitHub, etc.) or direct API calls with those credentials

### Cloudflare Secrets Store (Beta)

- **Centralized:** Account-level secrets shared across Workers (vs. per-Worker secrets which are scoped to individual Workers)
- **Encrypted:** At rest across all Cloudflare data centers
- **RBAC:** Super Administrator or Secrets Store Admin roles for creating secrets; Secrets Store Deployer role for binding to Workers
- **Audit logging:** All changes recorded
- **Free tier:** 20 secrets per account (plenty for 4-5 tool integrations)
- **CLI:** `wrangler secrets-store secret create <STORE_ID> --name <NAME> --scopes workers`

### Per-Worker Secrets (Simpler)

The traditional approach: `wrangler secret put <KEY>` stores a secret scoped to a single Worker.

- Simpler but secrets are duplicated if multiple Workers need them
- No RBAC or audit logging
- Fine for a single-Worker-per-project architecture

### Pros

- **Simplest possible approach.** No third-party dependencies. Secrets are stored where your code runs.
- **No additional latency.** Tool calls go directly to Linear/Slack/Notion/GitHub APIs, not through a middleman.
- **Full control.** You choose which MCP servers to run, how to call APIs, what to log.
- **Free or near-free.** Cloudflare Secrets Store is free for 20 secrets. Per-Worker secrets are free.
- **Native to your infrastructure.** Already using Cloudflare Sandbox -- secrets are part of the same platform.
- **No vendor lock-in.** You own your integration code.

### Cons

- **You manage OAuth yourself.** For tools requiring OAuth (Slack, Notion), you need to handle token refresh, scope management, and re-authentication. This is significant work.
- **No unified tool abstraction.** Each tool integration is bespoke code or a separate MCP server config.
- **Secret rotation is manual.** You decide when and how to rotate keys.
- **Credential sprawl risk.** If you add more projects and tools, managing dozens of secrets across multiple Workers gets messy.
- **No per-user auth.** All agents share the same credentials. No way to scope tool access per-project without separate secrets per project.

### Assessment for Our Use Case

This is the right starting point if most of our tools use simple API keys (Linear, GitHub) rather than OAuth. The question is how much of the integration surface requires OAuth flows.

**Tool-by-tool auth complexity:**

| Tool | Auth Type | Difficulty with Env Vars |
|------|-----------|--------------------------|
| Linear | API key or OAuth | **Easy** -- API key works for most operations |
| GitHub | Personal Access Token or GitHub App | **Easy** -- PAT works; GitHub App is more work but well-documented |
| Slack | Bot token (OAuth install) | **Medium** -- Bot token is long-lived after initial OAuth install, but some operations need user tokens |
| Notion | Integration token (internal) or OAuth (public) | **Easy** -- Internal integration token works if you own the workspace |

For our specific tools, most can work with long-lived API keys/tokens. We don't need the full OAuth flow management that Composio provides.

**Best fit:** When you have 4-5 tools that support API key auth, you already use Cloudflare, and you want the simplest possible architecture.

---

## Option 3: Proxy Pattern (Anthropic's Recommended Approach)

**What it is:** Run a credential-injecting proxy outside the agent's sandbox. The agent sends unauthenticated requests; the proxy adds API keys before forwarding to the target service. The agent never sees credentials.

This is Anthropic's officially recommended pattern for production agent deployments, documented at https://platform.claude.com/docs/en/agent-sdk/secure-deployment.

### How It Works

```
Agent (in Sandbox)  -->  Proxy (outside Sandbox)  -->  Linear/Slack/GitHub API
   No credentials          Injects API keys              Authenticated request
```

1. Agent sends requests to a local Unix socket or HTTP endpoint
2. Proxy running outside the container intercepts the request
3. Proxy looks up the appropriate credential for the target service
4. Proxy injects auth headers and forwards the request
5. Response flows back to the agent

### Implementation Options

- **Envoy Proxy** with `credential_injector` filter -- production-grade, declarative config
- **LiteLLM** -- LLM gateway with credential injection and rate limiting
- **Custom proxy** -- lightweight Go/Python/Node service that pattern-matches URLs and injects headers
- **MCP server as proxy** -- run an MCP server outside the sandbox that wraps authenticated API calls; the agent sees only the tool interface

### Pros

- **Best security model.** Agent never sees credentials, even if compromised via prompt injection.
- **Anthropic-recommended.** Aligns with the platform's security guidance. Future tooling will likely support this pattern.
- **Centralized credential management.** One proxy manages all secrets for all agents.
- **Domain allowlisting.** Proxy can enforce which APIs the agent can reach.
- **Full audit trail.** All API calls flow through a single point you control.
- **Works with any tool.** Not limited to tools that have Composio integrations.

### Cons

- **More infrastructure to build and maintain.** You need to deploy, monitor, and update the proxy.
- **Initial setup complexity.** Configuring credential injection rules, TLS termination, and domain allowlists takes engineering time.
- **Latency of one more hop** (though on the same host, this is negligible).
- **Still need to manage the secrets themselves.** The proxy needs access to the actual API keys -- you still need a secrets store.
- **OAuth token refresh still needs handling.** The proxy doesn't magically solve OAuth -- it just centralizes where you deal with it.

### Assessment for Our Use Case

The proxy pattern is the gold standard for security, and it aligns well with a Cloudflare Sandbox architecture where agents run in isolated microVMs with no direct network access. The proxy could run as a Cloudflare Worker or Durable Object sitting between the sandbox and external APIs.

However, it's more engineering work upfront. The question is whether the security benefit justifies the investment at our current scale.

**Best fit:** Multi-tenant production deployments where agents process untrusted content. Worth building toward, but may be premature for an initial MVP.

---

## Option 4: Nango

**What it is:** Developer infrastructure platform for product integrations. Supports 600+ APIs with white-label authentication, tool definitions stored in git, and an MCP server for AI agents.

**Website:** https://nango.dev

### How It Works

1. Define integrations as code in a git repo
2. Nango handles OAuth flows and token storage
3. Access tools via Nango's MCP server or API
4. Open-source tool templates you can inspect and modify

### Pricing

- **Free tier** available
- **Starter:** $250/month
- **Enterprise:** Custom pricing, self-hosting available
- Usage-based on connected accounts and API requests
- SOC 2 Type II, GDPR, HIPAA compliant

### Pros

- Open-source tool templates (unlike Composio's black-box tools)
- Better observability (OpenTelemetry export, fulltext search)
- Self-hosting option for enterprise
- Tool definitions stored in git (version-controlled, auditable)
- <100ms overhead on tool calls

### Cons

- **Expensive.** $250/month minimum vs. Composio's ~$29/month.
- **Designed for product integrations, not agent tooling.** The platform is built for SaaS companies building customer-facing integrations. AI agent use is a secondary use case.
- **Overkill for our needs.** We don't need 600+ APIs, data syncs, webhooks, or unified APIs.
- **Complex pricing.** Multiple variables (customers, API requests, records) make costs hard to predict.

### Assessment for Our Use Case

Nango is a better platform than Composio for teams building customer-facing integrations, but it's worse for our use case. We don't need product integration infrastructure -- we need simple, secure tool access for internal agents. The $250/month minimum is hard to justify for 4 tools.

---

## Option 5: Arcade

**What it is:** Agent tool-calling platform focused on authentication and governance. Acts as an MCP runtime that ensures agents act with user-specific permissions, not shared service accounts.

**Website:** https://www.arcade.dev

### How It Works

1. Arcade stores tokens and secrets in its runtime
2. When an agent needs to call an API, Arcade executes the call and returns results
3. The LLM never directly accesses authentication credentials
4. 100+ pre-built MCP servers for common tools

### Key Differentiator

Arcade's main value proposition is **per-user identity.** Each agent action is scoped to a specific user's permissions, using their OAuth tokens. This matters for enterprise environments where audit trails and access control are critical.

### Pros

- Strong security model -- LLM never sees credentials
- Per-user identity and permission scoping
- 100+ pre-built MCP servers
- Backed by $12M seed round (stable company)

### Cons

- **Smaller tool catalog** than Composio (historically 21 APIs, now 100+)
- **Enterprise-focused pricing** -- likely expensive for small teams
- **Less mature** than Composio for developer experience
- **Same vendor dependency** as Composio -- API calls route through their infrastructure

### Assessment for Our Use Case

Arcade's per-user identity model is interesting if we eventually need audit trails showing which user's permissions an agent acted with. But for internal agents using service accounts, this is unnecessary complexity. Not the right fit now.

---

## Option 6: MCP Gateways and Registries (Emerging)

A new category of infrastructure is emerging in 2026 for managing MCP servers at scale:

- **Kong MCP Registry** (part of Kong Konnect): Curated catalog of MCP servers within existing API management, inheriting policy controls from REST APIs.
- **MCP Gateway Registry** (community open-source): Centralized gateway with OAuth authentication, dynamic tool discovery, and audit logging. https://github.com/agentic-community/mcp-gateway-registry
- **Workato Enterprise MCP**: 100+ pre-built MCP servers with comprehensive audit trails, integrated with Workato's workflow automation.

These are all enterprise-grade and premature for our needs. Worth watching but not adopting yet.

---

## Recommendation

### Start with Cloudflare Secrets Store + Direct MCP Servers (Option 2)

For the initial Product Engineer Agent, use the simplest approach:

1. **Store API keys in Cloudflare Secrets Store** (or per-Worker secrets). Linear API key, GitHub PAT, Slack bot token, Notion integration token -- all work with long-lived credentials.

2. **Run official MCP servers directly.** Linear, GitHub, and other MCP servers can be configured in the agent's `.mcp.json` with credentials passed as environment variables. No middleman needed.

3. **Pass credentials to sandbox containers** via environment variables when spawning them. The Cloudflare Sandbox SDK supports this.

### Why Not Composio (Yet)

- We only need 4 tools, and all 4 work with API keys/tokens. Composio's main value -- OAuth management -- is not needed.
- Adding Composio means every tool call routes through their servers. That's an unnecessary dependency and latency hit.
- The cost is small but nonzero and hard to predict at scale (per-action pricing with autonomous agents).
- We lose the ability to customize or debug tool behavior.
- If Composio has an outage, our agents stop working.

### When to Reconsider Composio

Composio becomes worth it if:
- We add 5+ tools that require OAuth flows (e.g., Google Calendar, Salesforce, HubSpot)
- We need per-user authentication (multiple users, each with their own OAuth tokens)
- Token refresh becomes a recurring pain point
- We want the Tool Router's dynamic tool loading to reduce token costs across many integrations

### Build Toward the Proxy Pattern (Option 3)

As the system matures, evolve toward Anthropic's recommended proxy pattern:
- Run a credential-injecting proxy (Envoy or custom) as a Cloudflare Worker or Durable Object
- Agents in sandboxes route all external requests through the proxy
- Proxy injects credentials, enforces domain allowlists, and logs all traffic
- This gives us Composio's security benefits (agents never see credentials) without the vendor dependency

### Implementation Sketch

**Phase 1 (MVP):**
```
Cloudflare Worker (orchestrator)
  |
  +--> Secrets Store: LINEAR_API_KEY, GITHUB_TOKEN, SLACK_TOKEN, NOTION_TOKEN
  |
  +--> Spawn Sandbox Container
         |
         +--> Claude Code agent
         |      env: LINEAR_API_KEY, GITHUB_TOKEN, ...
         |      .mcp.json: linear-server, github-server
         |
         +--> Direct API calls to Linear, GitHub, etc.
```

**Phase 2 (Hardened):**
```
Cloudflare Worker (orchestrator)
  |
  +--> Secrets Store (credentials)
  |
  +--> Credential Proxy (Worker/DO)
  |      - Injects auth headers
  |      - Domain allowlist
  |      - Audit logging
  |
  +--> Spawn Sandbox Container
         |
         +--> Claude Code agent
         |      No credentials in env
         |      Proxy URL configured
         |
         +--> Requests route through proxy
```

**Phase 3 (If needed):**
- Evaluate Composio or similar platform if tool count grows significantly
- Consider MCP Gateway pattern for centralized tool management
- Add per-user auth if multi-tenant requirements emerge

---

## Summary Comparison

| Dimension | Composio | CF Secrets + Direct | Proxy Pattern | Nango | Arcade |
|-----------|----------|---------------------|---------------|-------|--------|
| **Setup time** | ~1 hour | ~30 min | ~1-2 days | ~2 hours | ~1 hour |
| **Monthly cost** | ~$29+ (usage-based) | Free (20 secrets) | Free (infra cost only) | $250+ | Unknown (enterprise) |
| **Security** | Good (SOC 2, encrypted) | Good (CF encryption, RBAC) | Best (agent never sees creds) | Good (SOC 2 Type II) | Good (agent never sees creds) |
| **Latency** | Extra hop to Composio servers | Direct to API | One local hop (negligible) | Extra hop to Nango servers | Extra hop to Arcade servers |
| **Tool coverage** | 250+ apps | Whatever you configure | Whatever you configure | 600+ APIs | 100+ apps |
| **Customizability** | None (black box) | Full | Full | Open-source templates | Limited |
| **OAuth management** | Handled | Manual | Manual (centralized) | Handled | Handled |
| **Vendor dependency** | High | None | None | High | High |
| **Claude Code support** | Native (MCP) | Native (env vars + MCP) | Native (proxy config) | MCP available | MCP available |
| **Right for 4 tools** | Overkill | Good fit | Good fit (Phase 2) | Overkill | Overkill |
| **Right for 20+ tools** | Good fit | Gets messy | Good fit | Good fit | Good fit |

---

## Sources

### Composio
- [Composio Homepage](https://composio.dev/)
- [Composio Pricing](https://composio.dev/pricing)
- [Composio GitHub](https://github.com/ComposioHQ/composio)
- [Composio Linear + Claude Code Integration](https://composio.dev/toolkits/linear/framework/claude-code)
- [Composio Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
- [Composio Build vs. Buy Framework](https://composio.dev/blog/build-vs-buy-ai-agent-integrations)

### Cloudflare
- [Cloudflare Secrets Store Docs](https://developers.cloudflare.com/secrets-store/)
- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Secrets Store Workers Integration](https://developers.cloudflare.com/secrets-store/integrations/workers/)
- [Cloudflare Secrets Store Beta Announcement](https://blog.cloudflare.com/secrets-store-beta/)
- [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/)

### Anthropic Security Guidance
- [Securely Deploying AI Agents](https://platform.claude.com/docs/en/agent-sdk/secure-deployment)
- [Claude Code Sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing)
- [Claude Code Sandboxing Docs](https://code.claude.com/docs/en/sandboxing)

### Alternatives
- [Nango Homepage](https://nango.dev/)
- [Nango: Composio Alternatives](https://nango.dev/blog/composio-alternatives)
- [Nango Pricing](https://nango.dev/pricing)
- [Arcade Homepage](https://www.arcade.dev/)
- [Arcade vs WorkOS](https://workos.com/blog/arcade-vs-workos-agent-authentication-enterprise-auth)
- [MCP Gateway Registry (GitHub)](https://github.com/agentic-community/mcp-gateway-registry)
- [MCP Registry & Gateway Comparison](https://www.paperclipped.de/en/blog/mcp-registry-gateway-enterprise-ai-agents/)
- [Merge: Composio Alternatives](https://www.merge.dev/blog/composio-alternatives)
