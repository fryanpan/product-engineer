/**
 * ProjectLead routing — manages ProjectLead DO lifecycle and event routing.
 *
 * Extracted from conductor.ts to keep the conductor focused on
 * top-level request dispatch and task lifecycle.
 */

import type { ProductConfig } from "./registry";
import type { ProjectLeadConfig } from "./project-lead";
import type { TaskEvent } from "./types";
import type { TaskManager, SpawnConfig } from "./task-manager";
import type { SqlExec } from "./db";
import { getGatewayConfig, getProductConfig, getSetting } from "./db";

// We need the Bindings type for env.PROJECT_LEAD access
import type { Bindings } from "./types";

// ---------------------------------------------------------------------------
// ProjectLead DO lifecycle
// ---------------------------------------------------------------------------

/**
 * Ensure a ProjectLead DO is initialized and running for a product.
 * Returns the DO stub for further interaction.
 */
export async function ensureProjectLead(
  product: string,
  productConfig: ProductConfig,
  env: Bindings,
  sql: SqlExec,
): Promise<DurableObjectStub> {
  const id = env.PROJECT_LEAD.idFromName(product);
  const stub = env.PROJECT_LEAD.get(id);

  // Build ProjectLeadConfig
  const gatewayConfig = getGatewayConfig(sql);

  const config: ProjectLeadConfig = {
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
  const res = await stub.fetch(new Request("http://project-lead/ensure-running", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  }));

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown error");
    console.error(`[project-lead-router] Failed to ensure ProjectLead for ${product}: ${errText}`);
  }

  return stub;
}

/**
 * Ensure the Conductor (cross-product coordinator) is running.
 * The Conductor is a special ProjectLead keyed as "__conductor__".
 */
export async function ensureConductor(
  env: Bindings,
  sql: SqlExec,
): Promise<DurableObjectStub> {
  const id = env.PROJECT_LEAD.idFromName("__conductor__");
  const stub = env.PROJECT_LEAD.get(id);

  // Read conductor channel from settings
  const conductorChannel = getSetting(sql, "conductor_channel") || "";

  const conductorConfig: ProjectLeadConfig = {
    product: "__conductor__",
    repos: [],
    slackChannel: conductorChannel,
    secrets: {
      ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
    },
    mode: "flexible",
    model: "sonnet",
  };

  const res = await stub.fetch(new Request("http://project-lead/ensure-running", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(conductorConfig),
  }));

  if (!res.ok) {
    const errText = await res.text().catch(() => "unknown error");
    console.error(`[project-lead-router] Failed to ensure Conductor: ${errText}`);
  }

  return stub;
}

// ---------------------------------------------------------------------------
// Event routing
// ---------------------------------------------------------------------------

/**
 * Route an event to the ProjectLead for a product.
 * Ensures the agent is running first, then forwards the event.
 */
export async function routeToProjectLead(
  product: string,
  event: TaskEvent,
  env: Bindings,
  sql: SqlExec,
): Promise<void> {
  // Load product config
  const productConfig = getProductConfig(sql, product);

  if (!productConfig) {
    throw new Error(`No product config for ${product} — cannot route to ProjectLead`);
  }

  const stub = await ensureProjectLead(product, productConfig, env, sql);

  const res = await stub.fetch(new Request("http://project-lead/event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }));

  if (res.ok) {
    console.log(`[project-lead-router] Routed ${event.type} to ProjectLead for ${product}`);
  } else if (res.status === 202) {
    console.log(`[project-lead-router] Event buffered in ProjectLead for ${product} (container starting)`);
  } else {
    throw new Error(`ProjectLead event routing failed: ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Sub-router for /project-lead/* endpoints
// ---------------------------------------------------------------------------

/**
 * Handle internal project lead API requests.
 * These endpoints are called by the project lead container via the worker.
 */
export async function handleProjectLeadRoute(
  subpath: string,
  request: Request,
  env: Bindings,
  sql: SqlExec,
  taskManager: TaskManager,
): Promise<Response> {
  switch (subpath) {
    case "spawn-task": {
      // Project lead requests spawning a task agent for a task
      const body = await request.json<{
        product: string;
        taskUUID: string;
        taskId?: string;
        taskTitle?: string;
        taskDescription?: string;
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

      // Create task in DB and transition to reviewing so spawnAgent accepts it
      try {
        taskManager.createTask({
          taskUUID: body.taskUUID,
          product: body.product,
          slackThreadTs: body.slackThreadTs,
          slackChannel: body.slackChannel,
          taskId: body.taskId,
          title: body.taskTitle,
        });
        // Transition from created → reviewing (spawnAgent requires reviewing or queued)
        taskManager.updateStatus(body.taskUUID, { status: "reviewing" });
      } catch {
        // Already exists or already in reviewing — fine
      }

      // Build spawn config
      const gatewayConfig = getGatewayConfig(sql);

      const effectiveMode = body.mode || productConfig.mode;
      const spawnConfig: SpawnConfig = {
        product: body.product,
        repos: effectiveMode === "research" ? [] : productConfig.repos,
        slackChannel: body.slackChannel || productConfig.slack_channel_id || productConfig.slack_channel,
        slackThreadTs: body.slackThreadTs,
        secrets: productConfig.secrets,
        gatewayConfig,
        model: body.model || "sonnet",
        mode: effectiveMode,
        slackPersona: productConfig.slack_persona,
      };

      try {
        await taskManager.spawnAgent(body.taskUUID, spawnConfig);

        // Send the task description as an event so the task agent starts work
        if (body.taskDescription || body.taskTitle) {
          const taskEvent: TaskEvent = {
            type: "slack_mention",
            source: "internal",
            taskUUID: body.taskUUID,
            product: body.product,
            payload: {
              text: body.taskDescription || body.taskTitle || "",
              title: body.taskTitle || "",
            },
          };
          try {
            await taskManager.sendEvent(body.taskUUID, taskEvent);
          } catch (err) {
            console.warn(`[project-lead-router] spawn-task: event delivery deferred for ${body.taskUUID}:`, err);
            // Agent may not be ready yet — it will receive the event via buffer drain
          }
        }

        return Response.json({ ok: true, taskUUID: body.taskUUID, status: "spawned" });
      } catch (err) {
        console.error(`[project-lead-router] spawn-task failed for ${body.taskUUID}:`, err);
        return Response.json({ error: "spawn failed" }, { status: 500 });
      }
    }

    case "list-tasks": {
      // List all tasks for a product
      const url = new URL(request.url);
      const product = url.searchParams.get("product");
      if (!product) return Response.json({ error: "product required" }, { status: 400 });

      const rows = sql.exec(
        `SELECT task_uuid, task_id, title, status, agent_active, pr_url,
                branch_name, agent_message, created_at, updated_at
         FROM tasks WHERE product = ? ORDER BY created_at DESC LIMIT 50`,
        product,
      ).toArray();
      return Response.json({ tasks: rows });
    }

    case "send-event": {
      // Forward an event to a specific task agent
      const body = await request.json<{ taskUUID: string; event: TaskEvent }>();
      try {
        await taskManager.sendEvent(body.taskUUID, body.event);
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: "send failed" }, { status: 500 });
      }
    }

    case "relay-to-project": {
      // Relay a message/event to a specific product's ProjectLead DO
      const body = await request.json<{ product: string; event: TaskEvent }>();

      // Load product config
      const productConfig = getProductConfig(sql, body.product);

      if (!productConfig) {
        return Response.json({ error: "product not found" }, { status: 404 });
      }

      try {
        const stub = await ensureProjectLead(body.product, productConfig, env, sql);
        const res = await stub.fetch(new Request("http://project-lead/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body.event),
        }));

        if (res.ok) {
          return Response.json({ ok: true, routed: body.product });
        }
        return Response.json({ error: "relay failed" }, { status: res.status });
      } catch (err) {
        console.error(`[project-lead-router] relay-to-project failed for ${body.product}:`, err);
        return Response.json({ error: "relay failed" }, { status: 500 });
      }
    }

    case "stop-task": {
      // Stop a task agent
      const body = await request.json<{ taskUUID: string; reason?: string }>();
      try {
        await taskManager.stopAgent(body.taskUUID, body.reason || "project_lead_request");
        return Response.json({ ok: true });
      } catch (err) {
        return Response.json({ error: "stop failed" }, { status: 500 });
      }
    }

    case "drain-events": {
      // Drain buffered events from a specific ProjectLead DO.
      // Called by the container after starting a session to pick up events
      // that were buffered while the container was starting/restarting.
      const url = new URL(request.url);
      const product = url.searchParams.get("product");
      if (!product) return Response.json({ error: "product required" }, { status: 400 });

      const id = env.PROJECT_LEAD.idFromName(product);
      const stub = env.PROJECT_LEAD.get(id);
      return stub.fetch(new Request("http://project-lead/drain-events"));
    }

    case "status": {
      // Get status of all project leads
      const productRows = sql.exec(
        "SELECT slug FROM products",
      ).toArray() as Array<{ slug: string }>;

      const statuses: Record<string, unknown> = {};
      for (const row of productRows) {
        try {
          const id = env.PROJECT_LEAD.idFromName(row.slug);
          const stub = env.PROJECT_LEAD.get(id);
          const res = await stub.fetch(new Request("http://project-lead/status"));
          statuses[row.slug] = res.ok ? await res.json() : { error: `${res.status}` };
        } catch {
          statuses[row.slug] = { error: "unreachable" };
        }
      }
      return Response.json({ project_leads: statuses });
    }

    default:
      return Response.json({ error: "not found" }, { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Restart all ProjectLead containers (post-deploy)
// ---------------------------------------------------------------------------

/**
 * Force restart all ProjectLead containers to pick up new code after deploy.
 */
export async function restartProjectLeads(
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
      const id = env.PROJECT_LEAD.idFromName(product);
      const stub = env.PROJECT_LEAD.get(id);
      const res = await stub.fetch(new Request("http://project-lead/restart", {
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

  console.log(`[project-lead-router] Restarted ${results.filter(r => r.success).length}/${results.length} ProjectLeads`);
  return Response.json({ ok: true, results });
}
