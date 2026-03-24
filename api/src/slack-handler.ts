/**
 * Slack event handling — extracted from orchestrator.ts.
 *
 * Handles all Slack event processing including thread replies, conductor routing,
 * product channel routing, @mention with Linear ticket creation, and status commands.
 */

import type { TicketEvent } from "./types";
import type { ProductConfig } from "./registry";
import type { SqlExec } from "./db";
import { getSetting, setSetting, getGatewayConfig, getAllProductConfigs, ensureTicketMetrics } from "./db";
import { getSystemStatus as getSystemStatusData, formatStatusMessage } from "./observability";
import { normalizeSlackEvent } from "./security/normalized-event";
import { addReaction } from "./slack-utils";
import type { AgentManager } from "./agent-manager";

// ---------------------------------------------------------------------------
// Dependency bundle — everything the handler needs from the orchestrator
// ---------------------------------------------------------------------------

export interface SlackHandlerDeps {
  sql: SqlExec;
  env: Record<string, unknown>;
  agentManager: AgentManager;
  routeToProjectAgent: (product: string, event: TicketEvent) => Promise<void>;
  ensureConductor: () => Promise<DurableObjectStub>;
  handleTicketReview: (event: TicketEvent) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helper — resolves a Slack channel to a product slug
// ---------------------------------------------------------------------------

export function resolveProductFromChannel(
  products: Record<string, ProductConfig>,
  channel: string,
): string | null {
  for (const [name, config] of Object.entries(products)) {
    if (config.slack_channel_id === channel || config.slack_channel === channel) {
      return name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slack API utility
// ---------------------------------------------------------------------------

/** Post a message to Slack. Returns the message ts on success, null on failure. */
export async function postSlackMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string | null,
): Promise<string | null> {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        text,
        ...(threadTs && { thread_ts: threadTs }),
      }),
    });

    if (!res.ok) {
      console.error(`[slack-handler] Slack API error: ${res.status}`);
      return null;
    }

    const data = await res.json() as { ok: boolean; ts?: string; error?: string };
    if (!data.ok) {
      console.error(`[slack-handler] Slack API error: ${data.error}`);
      return null;
    }
    return data.ts || null;
  } catch (err) {
    console.error("[slack-handler] Failed to post Slack message:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Linear token helpers
// ---------------------------------------------------------------------------

/** Get the Linear OAuth app token — checks SQLite settings for a stored token, falls back to env binding. */
function getLinearAppToken(sql: SqlExec, env: Record<string, unknown>): string {
  try {
    const value = getSetting(sql, "linear_app_token");
    if (value) return value;
  } catch {
    // Settings table may not exist yet during early init
  }
  return (env.LINEAR_APP_TOKEN as string) || "";
}

/** Refresh the Linear OAuth token using the stored refresh token. */
export async function refreshLinearToken(sql: SqlExec, env: Record<string, unknown>): Promise<boolean> {
  try {
    const refreshToken = getSetting(sql, "linear_refresh_token");

    if (!refreshToken) {
      console.log("[slack-handler] No Linear refresh token stored, skipping refresh");
      return false;
    }

    const clientId = (env.LINEAR_APP_CLIENT_ID as string) || "";
    const clientSecret = (env.LINEAR_APP_CLIENT_SECRET as string) || "";
    if (!clientId || !clientSecret) {
      console.warn("[slack-handler] LINEAR_APP_CLIENT_ID or LINEAR_APP_CLIENT_SECRET not set, cannot refresh");
      return false;
    }

    const res = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      console.error(`[slack-handler] Linear token refresh failed: ${res.status}`);
      return false;
    }

    const data = await res.json() as { access_token: string; refresh_token?: string };
    setSetting(sql, "linear_app_token", data.access_token);

    if (data.refresh_token) {
      setSetting(sql, "linear_refresh_token", data.refresh_token);
    }

    console.log("[slack-handler] Linear token refreshed successfully");
    return true;
  } catch (err) {
    console.error("[slack-handler] Linear token refresh error:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// LLM-generated ticket summary
// ---------------------------------------------------------------------------

/** Use LLM to generate a structured ticket title and description from a Slack message. */
export async function generateTicketSummary(
  rawText: string,
  product: string,
  slackUser: string,
  env: Record<string, unknown>,
  sql: SqlExec,
): Promise<{ title: string; description: string }> {
  if (!rawText) {
    return { title: "Slack request (no description)", description: `**Slack request from <@${slackUser}>**` };
  }

  const apiKey = (env.ANTHROPIC_API_KEY as string) || "";
  if (!apiKey) {
    throw new Error("No ANTHROPIC_API_KEY configured");
  }

  // Check for AI Gateway config
  const gatewayConfig = getGatewayConfig(sql);
  const baseUrl = gatewayConfig
    ? `https://gateway.ai.cloudflare.com/v1/${gatewayConfig.account_id}/${gatewayConfig.gateway_id}/anthropic`
    : "https://api.anthropic.com";

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: `You are generating a Linear ticket from a Slack message for the "${product}" product.

Given this Slack message:
<message>
${rawText}
</message>

Generate a JSON object with:
- "title": A concise ticket title (imperative form, max 120 chars). Capture WHAT the request is.
- "description": A well-structured ticket description that captures WHY the user is asking (their goal) and any relevant context from the message. Include the original Slack message as a quote block for reference. Format with markdown.

Respond with ONLY the JSON object, no other text.`,
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text in Anthropic response");

  // Parse JSON from response, handling potential markdown code fences
  let jsonText = textBlock.text.trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonText = fenceMatch[1].trim();

  const parsed = JSON.parse(jsonText) as { title: string; description: string };

  // Ensure title isn't too long
  const title = parsed.title.length > 200 ? parsed.title.slice(0, 197) + "..." : parsed.title;

  return {
    title,
    description: parsed.description || `**Slack request from <@${slackUser}>:**\n\n${rawText}`,
  };
}

// ---------------------------------------------------------------------------
// Status command handler
// ---------------------------------------------------------------------------

async function handleStatusCommand(
  channel: string,
  threadTs: string,
  token: string,
  sql: SqlExec,
): Promise<void> {
  try {
    const statusData = getSystemStatusData(sql);
    const message = formatStatusMessage(statusData, channel);
    await postSlackMessage(token, channel, message, threadTs);
    console.log(`[slack-handler] Posted status to channel=${channel}`);
  } catch (err) {
    console.error("[slack-handler] Failed to handle status command:", err);
  }
}

// ---------------------------------------------------------------------------
// Main Slack event handler
// ---------------------------------------------------------------------------

/** Handle an incoming Slack event. Main entry point for all Slack processing. */
export async function handleSlackEvent(
  slackEvent: {
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    thread_ts?: string;
    ts?: string;
    slash_command?: string;
    reaction?: string;
    item?: { ts: string; channel: string };
  },
  deps: SlackHandlerDeps,
): Promise<Response> {
  const { sql, env, agentManager, routeToProjectAgent, ensureConductor, handleTicketReview } = deps;
  const slackBotToken = (env.SLACK_BOT_TOKEN as string) || "";

  // Fast-ack: immediately add eyes reaction so user knows we received the event
  if (slackEvent.ts && slackEvent.channel && slackEvent.type === "app_mention") {
    addReaction({
      token: slackBotToken,
      channel: slackEvent.channel,
      timestamp: slackEvent.ts,
      name: "eyes",
    }); // Fire-and-forget — don't await
  }

  // Scan for injection attacks before processing
  if (slackEvent.text) {
    const scanResult = await normalizeSlackEvent(slackEvent as Record<string, unknown>);
    if (!scanResult.ok) {
      console.warn(`[slack-handler] Slack event rejected: ${scanResult.error}`);
      return Response.json({ ok: true, rejected: true, reason: "injection detected" });
    }
  }

  // Handle slash commands or /agent-status mentions
  const isStatusCommand =
    slackEvent.slash_command === "agent-status" ||
    (slackEvent.type === "app_mention" &&
      typeof slackEvent.text === "string" &&
      /(^|\s)\/agent-status(\s|$)/.test(slackEvent.text));

  if (isStatusCommand) {
    console.log(
      `[slack-handler] Received /agent-status command from user=${slackEvent.user} channel=${slackEvent.channel}`,
    );
    const targetTs = slackEvent.thread_ts || slackEvent.ts || "";
    await handleStatusCommand(slackEvent.channel || "", targetTs, slackBotToken, sql);
    return Response.json({ ok: true, handled: "status_command" });
  }

  // If it's a thread reply, look up existing ticket by thread_ts
  if (slackEvent.thread_ts) {
    console.log(`[slack-handler] Thread reply received: thread_ts=${slackEvent.thread_ts} type=${slackEvent.type} user=${slackEvent.user || "unknown"}`);
    const rows = sql.exec(
      "SELECT ticket_uuid, product, status, agent_active FROM tickets WHERE slack_thread_ts = ?",
      slackEvent.thread_ts,
    ).toArray() as { ticket_uuid: string; product: string; status: string; agent_active: number }[];

    if (rows.length > 0) {
      const ticket = rows[0];
      console.log(`[slack-handler] Thread reply matched ticket=${ticket.ticket_uuid} product=${ticket.product}`);

      // Don't re-activate terminal tickets
      if (agentManager.isTerminalStatus(ticket.status)) {
        console.log(`[slack-handler] Thread reply for terminal ticket ${ticket.ticket_uuid} (status=${ticket.status}) — ignoring`);
        return Response.json({ ok: true, ignored: true, reason: "terminal ticket" });
      }

      // Re-activate agent on thread reply — user is explicitly engaging
      agentManager.reactivate(ticket.ticket_uuid);
      const event: TicketEvent = {
        type: "slack_reply",
        source: "slack",
        ticketUUID: ticket.ticket_uuid,
        product: ticket.product,
        payload: slackEvent,
        slackThreadTs: slackEvent.thread_ts,
        slackChannel: slackEvent.channel,
      };
      console.log(`[slack-handler] Routing thread reply to agent for ticket=${ticket.ticket_uuid}`);
      await agentManager.sendEvent(ticket.ticket_uuid, event);
      return Response.json({ ok: true, ticketUUID: ticket.ticket_uuid });
    } else {
      console.log(`[slack-handler] No ticket found for thread_ts=${slackEvent.thread_ts}`);
    }

    // Thread reply but no ticket found — silently ignore.
    if (slackEvent.type === "message") {
      return Response.json({ ok: true, ignored: true, reason: "thread not tracked" });
    }
  }

  // Check if this message is in the conductor's dedicated channel.
  const conductorChannelId = getSetting(sql, "conductor_channel");

  if (!conductorChannelId) {
    console.log(`[slack-handler] No conductor_channel configured in settings — conductor routing skipped for channel ${slackEvent.channel}`);
  } else if (slackEvent.channel !== conductorChannelId) {
    console.log(`[slack-handler] Message in channel ${slackEvent.channel} does not match conductor channel ${conductorChannelId}`);
  }

  if (conductorChannelId && slackEvent.channel === conductorChannelId) {
    console.log(`[slack-handler] Mention in conductor channel ${conductorChannelId} — routing to Conductor`);

    try {
      const conductorStub = await ensureConductor();
      const rawText = (slackEvent.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      const event: TicketEvent = {
        type: "slack_mention",
        source: "slack",
        ticketUUID: `conductor-${slackEvent.ts || Date.now()}`,
        product: "__conductor__",
        payload: {
          text: rawText,
          user: slackEvent.user,
          channel: slackEvent.channel,
          ts: slackEvent.ts,
        },
        slackThreadTs: slackEvent.thread_ts || slackEvent.ts,
        slackChannel: slackEvent.channel,
      };
      await conductorStub.fetch(new Request("http://project-agent/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      }));
      return Response.json({ ok: true, routed: "conductor" });
    } catch (err) {
      console.error("[slack-handler] Failed to route to Conductor:", err);
      return Response.json({ error: "conductor_routing_failed" }, { status: 500 });
    }
  }

  // Resolve product from channel
  const products = getAllProductConfigs(sql);
  const product = resolveProductFromChannel(products, slackEvent.channel || "");

  if (!product) {
    // Unmapped channel — only respond on @-mention, silently ignore plain messages
    if (slackEvent.type === "app_mention") {
      console.log(`[slack-handler] No product mapped to channel ${slackEvent.channel} — replying to mention`);
      await postSlackMessage(
        slackBotToken,
        slackEvent.channel || "",
        `ℹ️ This channel is not configured for any product. Ask an admin to register it.`,
        slackEvent.ts || ""
      );
    }
    return Response.json({ ok: true, ignored: true, reason: "unmapped_channel" });
  }

  // Product channel: route ALL messages to ProjectAgent.
  // For plain messages (no @-mention), route directly — no Linear ticket.
  if (slackEvent.type !== "app_mention") {
    console.log(`[slack-handler] Plain message in ${product} channel — routing to ProjectAgent`);
    const rawText = (slackEvent.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
    const event: TicketEvent = {
      type: "slack_mention",
      source: "slack",
      ticketUUID: `chat-${slackEvent.ts || Date.now()}`,
      product,
      payload: {
        text: rawText,
        user: slackEvent.user,
        channel: slackEvent.channel,
        ts: slackEvent.ts,
      },
      slackThreadTs: slackEvent.thread_ts || slackEvent.ts,
      slackChannel: slackEvent.channel,
    };
    routeToProjectAgent(product, event).catch(err =>
      console.error(`[slack-handler] ProjectAgent routing failed for ${product}:`, err)
    );
    return Response.json({ ok: true, routed: "project_agent", product });
  }

  const slackThreadTs = slackEvent.thread_ts || slackEvent.ts;
  const productConfig = products[product];
  const projectName = productConfig.triggers?.linear?.project_name;

  // Products without Linear route directly to ProjectAgent without creating a Linear ticket.
  if (!projectName) {
    console.log(`[slack-handler] No Linear project for ${product} — routing directly to ProjectAgent`);

    const rawText = (slackEvent.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
    const ticketUUID = `slack-${slackEvent.ts || Date.now()}`;

    // Create ticket record so thread replies can be routed
    try {
      agentManager.createTicket({
        ticketUUID,
        product,
        slackThreadTs: slackThreadTs || undefined,
        slackChannel: slackEvent.channel || undefined,
        title: rawText.slice(0, 100),
      });
    } catch {
      // Already exists — fine (e.g. re-delivery)
    }

    const directEvent: TicketEvent = {
      type: "slack_mention",
      source: "slack",
      ticketUUID,
      product,
      payload: {
        text: rawText,
        user: slackEvent.user,
        channel: slackEvent.channel,
        ts: slackEvent.ts,
      },
      slackThreadTs: slackThreadTs || undefined,
      slackChannel: slackEvent.channel || undefined,
    };

    // Route to ProjectAgent (fire-and-forget)
    routeToProjectAgent(product, directEvent).catch(err =>
      console.error(`[slack-handler] Direct ProjectAgent routing failed for ${product}:`, err)
    );

    return Response.json({ ok: true, routed: "project_agent", product });
  }

  // --- @mention with Linear ticket creation ---

  // Load settings for Linear API
  const settings = sql.exec("SELECT key, value FROM settings").toArray() as Array<{ key: string; value: string }>;
  const settingsMap = Object.fromEntries(settings.map(s => [s.key, s.value]));
  const teamId: string | undefined = settingsMap.linear_team_id;
  const appUserId: string | undefined = settingsMap.linear_app_user_id;
  const linearToken = getLinearAppToken(sql, env);

  if (!teamId || !linearToken) {
    await postSlackMessage(
      slackBotToken,
      slackEvent.channel || "",
      `❌ Linear integration not configured (missing team ID or token).`,
      slackThreadTs || "",
    );
    return Response.json({ error: "linear not configured" }, { status: 500 });
  }

  // Strip the @mention from the text to get the raw request
  const rawText = (slackEvent.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();

  // Use LLM to generate a structured title and description
  let title: string;
  let description: string;
  try {
    const generated = await generateTicketSummary(rawText, product, slackEvent.user || "unknown", env, sql);
    title = generated.title;
    description = generated.description;
  } catch (err) {
    console.error("[slack-handler] LLM title generation failed, using fallback:", err);
    const normalized = rawText.replace(/\s+/g, " ").trim();
    title = normalized
      ? (normalized.length <= 200 ? normalized : normalized.slice(0, 197) + "...")
      : "Slack request (no description)";
    description = `**Slack request from <@${slackEvent.user}>:**\n\n${rawText}`;
  }

  // Look up the Linear project ID by name
  const projectRes = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${linearToken}`,
    },
    body: JSON.stringify({
      query: `query($teamId: String!) {
        team(id: $teamId) {
          projects { nodes { id name } }
        }
      }`,
      variables: { teamId },
    }),
  });

  let projectId: string | null = null;
  if (projectRes.ok) {
    const projectData = await projectRes.json() as {
      data?: { team?: { projects?: { nodes?: Array<{ id: string; name: string }> } } };
      errors?: Array<{ message: string }>;
    };
    if (projectData.errors) {
      console.error(`[slack-handler] Linear project lookup errors:`, JSON.stringify(projectData.errors));
    }
    const normalizedName = projectName.toLowerCase();
    const projects = projectData.data?.team?.projects?.nodes || [];
    projectId = projects.find(p => p.name.toLowerCase() === normalizedName)?.id || null;
    console.log(`[slack-handler] Project lookup: name="${projectName}" found=${!!projectId} (${projects.length} projects in team)`);
  } else {
    console.error(`[slack-handler] Linear project lookup failed: ${projectRes.status} ${await projectRes.text().catch(() => "")}`);
  }

  // Create the Linear issue
  console.log(`[slack-handler] Creating Linear issue: team=${teamId} project=${projectId} assignee=${appUserId} title="${title}"`);
  const createRes = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${linearToken}`,
    },
    body: JSON.stringify({
      query: `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }`,
      variables: {
        input: {
          teamId,
          title,
          description,
          ...(projectId && { projectId }),
          ...(appUserId && { assigneeId: appUserId }),
        },
      },
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    console.error(`[slack-handler] Failed to create Linear issue: ${createRes.status} ${errText}`);
    await postSlackMessage(
      slackBotToken,
      slackEvent.channel || "",
      `❌ Failed to create Linear ticket. Please try again or create one manually.`,
      slackThreadTs || "",
    );
    return Response.json({ error: "linear issue creation failed" }, { status: 500 });
  }

  const createData = await createRes.json() as {
    data?: { issueCreate?: { success: boolean; issue?: { id: string; identifier: string; url: string } } }
  };
  const issue = createData.data?.issueCreate?.issue;

  if (!issue) {
    console.error("[slack-handler] Linear issueCreate returned no issue:", JSON.stringify(createData));
    await postSlackMessage(
      slackBotToken,
      slackEvent.channel || "",
      `❌ Failed to create Linear ticket. Please try again or create one manually.`,
      slackThreadTs || "",
    );
    return Response.json({ error: "linear issue creation failed" }, { status: 500 });
  }

  console.log(`[slack-handler] Created Linear issue ${issue.identifier} (${issue.id}) from Slack mention`);

  // Post acknowledgment as a NEW top-level message (not a reply).
  // This message becomes the ticket thread — all future updates reply here.
  const ticketThreadTs = await postSlackMessage(
    slackBotToken,
    slackEvent.channel!,
    `📋 Created <${issue.url}|${issue.identifier}>: ${title}\n⏳ Working on it...`,
  );

  // Reply briefly in the user's original thread pointing to the ticket thread
  if (ticketThreadTs) {
    postSlackMessage(
      slackBotToken,
      slackEvent.channel!,
      `👋 On it! Follow progress in the thread above.`,
      slackThreadTs,
    ).catch(err => console.warn("[slack-handler] Failed to post thread pointer:", err));
  }

  // Store the Slack thread association so the Linear webhook handler can link them.
  const threadTsToStore = ticketThreadTs || slackThreadTs || null;
  sql.exec(
    `INSERT INTO slack_thread_map (linear_issue_id, slack_thread_ts, slack_channel)
     VALUES (?, ?, ?)
     ON CONFLICT(linear_issue_id) DO UPDATE SET
       slack_thread_ts = excluded.slack_thread_ts,
       slack_channel = excluded.slack_channel`,
    issue.id, threadTsToStore, slackEvent.channel || null,
  );

  // Dispatch ticket review directly instead of waiting for the Linear webhook roundtrip.
  const ticketEvent: TicketEvent = {
    type: "ticket_created",
    source: "slack",
    ticketUUID: issue.id,
    product,
    payload: {
      id: issue.id,
      identifier: issue.identifier,
      title,
      description: rawText,
      priority: 3,
      labels: [],
    },
    slackThreadTs: threadTsToStore || undefined,
    slackChannel: slackEvent.channel || undefined,
  };

  // Create ticket in DB before review
  try {
    agentManager.createTicket({
      ticketUUID: issue.id,
      product,
      slackThreadTs: threadTsToStore || undefined,
      slackChannel: slackEvent.channel || undefined,
      ticketId: issue.identifier,
      title,
    });
  } catch {
    // Ticket already exists (from a fast Linear webhook) — safe to proceed
  }

  // Initialize ticket_metrics row
  ensureTicketMetrics(sql, issue.id);

  handleTicketReview(ticketEvent).catch(err =>
    console.error("[slack-handler] Direct ticket review failed:", err)
  );

  return Response.json({ ok: true, linearIssue: issue.identifier });
}
