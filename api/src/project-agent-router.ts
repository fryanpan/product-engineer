/**
 * ProjectAgent routing — manages ProjectAgent DO lifecycle and event routing.
 *
 * Extracted from orchestrator.ts to keep the orchestrator focused on
 * top-level request dispatch and ticket lifecycle.
 */

import type { ProductConfig } from "./registry";
import type { ProjectAgentConfig } from "./project-agent";
import type { TicketEvent } from "./types";
import type { AgentManager, SpawnConfig } from "./agent-manager";
import type { SqlExec } from "./db";
import { getGatewayConfig, getProductConfig, getSetting } from "./db";

// We need the Bindings type for env.PROJECT_AGENT access
import type { Bindings } from "./types";

// ---------------------------------------------------------------------------
// ProjectAgent DO lifecycle
// ---------------------------------------------------------------------------

/**
 * Ensure a ProjectAgent DO is initialized and running for a product.
 * Returns the DO stub for further interaction.
 */
export async function ensureProjectAgent(
  product: string,
  productConfig: ProductConfig,
  env: Bindings,
  sql: SqlExec,
): Promise<DurableObjectStub> {
  const id = env.PROJECT_AGENT.idFromName(product);
  const stub = env.PROJECT_AGENT.get(id);

  // Build ProjectAgentConfig
  const gatewayConfig = getGatewayConfig(sql);

  const config: ProjectAgentConfig = {
    product,
    repos: productConfig.repos,
    slackChannel: productConfig.slack_channel_id || productConfig.slack_channel,
    slackPersona: productConfig.slack_persona,
    secrets: productConfig.secrets,
    mode: productConfig.mode,
    gatewayConfig,
    model: "sonnet",
  };

  // Initialize (idempotent — if config unchanged and container healthy, returns immediately)
  const res = await stub.fetch(new Request("http://project-agent/ensure-running", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  }));

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown error");
    console.error(`[project-agent-router] Failed to ensure ProjectAgent for ${product}: ${errText}`);
  }

  return stub;
}

/**
 * Ensure the Conductor (cross-product coordinator) is running.
 * The Conductor is a special ProjectAgent keyed as "__conductor__".
 */
export async function ensureConductor(
  env: Bindings,
  sql: SqlExec,
): Promise<DurableObjectStub> {
  const id = env.PROJECT_AGENT.idFromName("__conductor__");
  const stub = env.PROJECT_AGENT.get(id);

  // Read conductor channel from settings
  const conductorChannel = getSetting(sql, "conductor_channel") || "";

  const conductorConfig: ProjectAgentConfig = {
    product: "__conductor__",
    repos: [],
    slackChannel: conductorChannel,
    secrets: {
      ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
    },
    mode: "flexible",
    model: "sonnet",
  };

  const res = await stub.fetch(new Request("http://project-agent/ensure-running", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conductorConfig),
  }));

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown error");
    console.error(`[project-agent-router] Failed to ensure Conductor: ${errText}`);
  }

  return stub;
}

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

/**
 * Route an event to the ProjectAgent for a product.
 * Ensures the agent is running first, then forwards the event.
 */
export async function routeToProjectAgent(
  product: string,
  event: TicketEvent,
  env: Bindings,
  sql: SqlExec,
): Promise<void> {
  // Load product config
  const productConfig = getProductConfig(sql, product);

  if (!productConfig) {
    throw new Error(`No product config for ${product} — cannot route to ProjectAgent`);
  }

  const stub = await ensureProjectAgent(product, productConfig, env, sql);

  const res = await stub.fetch(new Request("http://project-agent/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }));

  if (res.ok) {
    console.log(`[project-agent-router] Routed ${event.type} to ProjectAgent for ${product}`);
  } else if (res.status === 202) {
    console.log(`[project-agent-router] Event buffered in ProjectAgent for ${product} (container starting)`);
  } else {
    throw new Error(`ProjectAgent event routing failed: ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Sub-router for /project-agent/* endpoints
// ---------------------------------------------------------------------------

/**
 * Handle internal project agent API requests.
 * These endpoints are called by the project agent container via the worker.
 */
export async function handleProjectAgentRoute(
  subpath: string,
  request: Request,
  env: Bindings,
  sql: SqlExec,
  agentManager: AgentManager,
): Promise<Response> {
  switch (subpath) {
    case "spawn-task": {
      // Project agent requests spawning a ticket agent for a task
      const body = await request.json<{
        product: string;
        ticketUUID: string;
        ticketId?: string;
        ticketTitle?: string;
        ticketDescription?: string;
        slackThreadTs?: string;
        slackChannel?: string;
        mode?: "coding" | "research" | "flexible";
        model?: string;
      }>();

      // Load product config
      const productConfig = getProductConfig(sql, body.product);
      if (!productConfig) {
        return Response.json({ error: "product not found" }, { status: 404 });
      }

      // Create ticket in DB and transition to reviewing so spawnAgent accepts it
      try {
        agentManager.createTicket({
          ticketUUID: body.ticketUUID,
          product: body.product,
          slackThreadTs: body.slackThreadTs,
          slackChannel: body.slackChannel,
          ticketId: body.ticketId,
          title: body.ticketTitle,
        });
        // Transition from created → reviewing (spawnAgent requires reviewing or queued)
        agentManager.updateStatus(body.ticketUUID, { status: "reviewing" });
      } catch {
        // Already exists or already in reviewing — fine
      }

      // Build spawn config
      const gatewayConfig = getGatewayConfig(sql);

      const spawnConfig: SpawnConfig = {
        product: body.product,
        repos: productConfig.repos,
        slackChannel: body.slackChannel || productConfig.slack_channel_id || productConfig.slack_channel,
        slackThreadTs: body.slackThreadTs,
        secrets: productConfig.secrets,
        gatewayConfig,
        model: body.model || "sonnet",
        mode: body.mode || productConfig.mode,
        slackPersona: productConfig.slack_persona,
      };

      try {
        await agentManager.spawnAgent(body.ticketUUID, spawnConfig);

        // Send the task description as an event so the ticket agent starts work
        if (body.ticketDescription || body.ticketTitle) {
          const taskEvent: TicketEvent = {
            type: "slack_mention",
            source: "internal",
            ticketUUID: body.ticketUUID,
            product: body.product,
            payload: {
              text: body.ticketDescription || body.ticketTitle || "",
              title: body.ticketTitle || "",
            },
          };
          try {
            await agentManager.sendEvent(body.ticketUUID, taskEvent);
          } catch (err) {
            console.warn(`[project-agent-router] spawn-task: event delivery deferred for ${body.ticketUUID}:`, err);
            // Agent may not be ready yet — it will receive the event via buffer drain
          }
        }

        return Response.json({ ok: true, ticketUUID: body.ticketUUID, status: "spawned" });
      } catch (err) {
        console.error(`[project-agent-router] spawn-task failed for ${body.ticketUUID}:`, err);
        return Response.json({ error: "spawn failed" }, { status: 500 });
      }
    }

    case "list-tasks": {
      // List all tickets for a product
      const url = new URL(request.url);
      const product = url.searchParams.get("product");
      if (!product) return Response.json({ error: "product required" }, { status: 400 });

      const rows = sql.exec(
        `SELECT ticket_uuid, ticket_id, title, status, agent_active, pr_url,
                branch_name, agent_message, created_at, updated_at
         FROM tickets WHERE product = ? ORDER BY created_at DESC LIMIT 50`,
        product,
      ).toArray();
      return Response.json({ tasks: rows });
    }

    case "send-event": {
      // Forward an event to a specific ticket agent
      const body = await request.json<{ ticketUUID: string; event: TicketEvent }>();
      try {
        await agentManager.sendEvent(body.ticketUUID, body.event);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: "send failed" }, { status: 500 });
      }
    }

    case "relay-to-project": {
      // Relay a message/event to a specific product's ProjectAgent DO
      const body = await request.json<{ product: string; event: TicketEvent }>();

      // Load product config
      const productConfig = getProductConfig(sql, body.product);

      if (!productConfig) {
        return Response.json({ error: "product not found" }, { status: 404 });
      }

      try {
        const stub = await ensureProjectAgent(body.product, productConfig, env, sql);
        const res = await stub.fetch(new Request("http://project-agent/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body.event),
        }));

        if (res.ok) {
          return Response.json({ ok: true, routed: body.product });
        }
        return Response.json({ error: "relay failed" }, { status: res.status });
      } catch (err) {
        console.error(`[project-agent-router] relay-to-project failed for ${body.product}:`, err);
        return Response.json({ error: "relay failed" }, { status: 500 });
      }
    }

    case "stop-task": {
      // Stop a ticket agent
      const body = await request.json<{ ticketUUID: string; reason?: string }>();
      try {
        await agentManager.stopAgent(body.ticketUUID, body.reason || "project_agent_request");
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: "stop failed" }, { status: 500 });
      }
    }

    case "drain-events": {
      // Drain buffered events from a specific ProjectAgent DO.
      // Called by the container after starting a session to pick up events
      // that were buffered while the container was starting/restarting.
      const url = new URL(request.url);
      const product = url.searchParams.get("product");
      if (!product) return Response.json({ error: "product required" }, { status: 400 });

      const id = env.PROJECT_AGENT.idFromName(product);
      const stub = env.PROJECT_AGENT.get(id);
      return stub.fetch(new Request("http://project-agent/drain-events"));
    }

    case "status": {
      // Get status of all project agents
      const productRows = sql.exec(
        "SELECT slug FROM products",
      ).toArray() as Array<{ slug: string }>;

      const statuses: Record<string, unknown> = {};
      for (const row of productRows) {
        try {
          const id = env.PROJECT_AGENT.idFromName(row.slug);
          const stub = env.PROJECT_AGENT.get(id);
          const res = await stub.fetch(new Request("http://project-agent/status"));
          statuses[row.slug] = res.ok ? await res.json() : { error: `${res.status}` };
        } catch {
          statuses[row.slug] = { error: "unreachable" };
        }
      }
      return Response.json({ project_agents: statuses });
    }

    default:
      return Response.json({ error: "not found" }, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Restart all ProjectAgent containers (post-deploy)
// ---------------------------------------------------------------------------

/**
 * Force restart all ProjectAgent containers to pick up new code after deploy.
 */
export async function restartProjectAgents(
  env: Bindings,
  sql: SqlExec,
): Promise<Response> {
  const productRows = sql.exec(
    "SELECT slug FROM products",
  ).toArray() as Array<{ slug: string }>;

  const products = [...productRows.map(r => r.slug), "__conductor__"];
  const results: Array<{ product: string; success: boolean; error?: string }> = [];

  for (const product of products) {
    try {
      const id = env.PROJECT_AGENT.idFromName(product);
      const stub = env.PROJECT_AGENT.get(id);
      const res = await stub.fetch(new Request("http://project-agent/restart", {
        method: "POST",
      }));
      if (res.ok) {
        results.push({ product, success: true });
      } else {
        const errText = await res.text().catch(() => "unknown");
        results.push({ product, success: false, error: errText });
      }
    } catch (err) {
      results.push({ product, success: false, error: String(err) });
    }
  }

  console.log(`[project-agent-router] Restarted ${results.filter(r => r.success).length}/${results.length} ProjectAgents`);
  return Response.json({ ok: true, results });
}
