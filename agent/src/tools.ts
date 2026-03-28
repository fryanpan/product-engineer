/**
 * Generic communication tools for the Product Engineer agent.
 *
 * These supplement Claude Code's built-in tools (file edit, bash, git).
 * Tools are product-agnostic — they use config values injected by the TaskAgent DO.
 */

import { tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { normalizeImageMediaType, type AgentConfig } from "./config";
import { checkCIStatus, mergePR } from "./merge-gate";
import { StatusUpdater } from "./status-updater";

type ToolResult = { content: { type: "text"; text: string }[] };

/** Extract non-empty Slack persona fields for spreading into API payloads. */
function slackPersonaFields(config: AgentConfig): Record<string, string> {
  if (!config.slackPersona) return {};
  const fields: Record<string, string> = {};
  if (config.slackPersona.username) fields.username = config.slackPersona.username;
  if (config.slackPersona.icon_emoji) fields.icon_emoji = config.slackPersona.icon_emoji;
  if (config.slackPersona.icon_url) fields.icon_url = config.slackPersona.icon_url;
  return fields;
}

export async function persistSlackThreadTs(
  config: AgentConfig,
  ts: string,
  maxRetries = 3,
  fetchFn: typeof fetch = fetch,
) {
  if (config.slackThreadTs || !ts) return;

  // Set locally immediately so rapid follow-up Slack posts stay threaded.
  // The retry loop below persists to the orchestrator DB as a separate concern.
  config.slackThreadTs = ts;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchFn(`${config.workerUrl}/api/internal/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": config.apiKey,
        },
        body: JSON.stringify({
          taskUUID: config.taskUUID,
          slack_thread_ts: ts,
        }),
      });

      if (res.ok) return;
      console.warn(`[Agent] persist slack_thread_ts attempt ${attempt}/${maxRetries} failed: ${res.status}`);
    } catch (err) {
      console.warn(`[Agent] persist slack_thread_ts attempt ${attempt}/${maxRetries} error:`, err);
    }

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
  }
  console.error("[Agent] Failed to persist slack_thread_ts to orchestrator after all retries");
}

async function postToSlack(
  text: string,
  config: AgentConfig,
  statusUpdater?: StatusUpdater,
): Promise<ToolResult> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slackBotToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: config.slackChannel,
      text,
      ...(config.slackThreadTs && { thread_ts: config.slackThreadTs }),
      ...slackPersonaFields(config),
    }),
  });

  if (!res.ok) {
    return { content: [{ type: "text", text: `Slack API failed: ${res.status}` }] };
  }

  const data = (await res.json()) as { ok: boolean; error?: string; ts?: string };
  if (!data.ok) {
    return { content: [{ type: "text", text: `Slack API error: ${data.error}` }] };
  }

  if (data.ts) {
    // Fire-and-forget with retries — don't block the tool response
    persistSlackThreadTs(config, data.ts).catch(() => {});
    // Keep StatusUpdater in sync so Slack thread updates use the correct ts
    if (statusUpdater) statusUpdater.setSlackThreadTs(data.ts);
  }
  return { content: [{ type: "text", text: "Message posted to Slack" }] };
}

export function createTools(config: AgentConfig) {
  const statusUpdater = new StatusUpdater({
    workerUrl: config.workerUrl,
    apiKey: config.apiKey,
    taskUUID: config.taskUUID,
    slackBotToken: config.slackBotToken,
    slackChannel: config.slackChannel,
    slackThreadTs: config.slackThreadTs,
    linearAppToken: config.linearAppToken,
    taskIdentifier: config.taskIdentifier,
    taskTitle: config.taskTitle,
  });

  const notifySlack = tool(
    "notify_slack",
    "Send a notification message to the product's Slack channel. Use this to keep the team informed of progress.",
    { message: z.string().describe("The message to post to Slack") },
    ({ message }) => postToSlack(message, config, statusUpdater),
  );

  const askQuestion = tool(
    "ask_question",
    "Post a clarifying question to the Slack channel. Use this when a task is ambiguous and you need more information. The user's reply will arrive as a new event. IMPORTANT: Only call this tool ONCE per question session - do not ask multiple questions in rapid succession.",
    { question: z.string().describe("The question to ask the user via Slack") },
    async ({ question }) => {
      // Update status to "needs_info" first to prevent multiple question prompts
      await statusUpdater.updateAll("needs_info").catch(err =>
        console.warn("[Agent] Failed to update status to needs_info:", err),
      );
      return postToSlack(`*Agent question:*\n${question}`, config, statusUpdater);
    },
  );

  const updateTaskStatus = tool(
    "update_task_status",
    "Update the task's status. Call this at every state transition. This will update Linear ticket status and edit the top-level Slack message.",
    {
      status: z
        .enum([
          "in_progress",
          "pr_open",
          "in_review",
          "needs_revision",
          "merged",
          "closed",
          "deferred",
          "failed",
        ])
        .describe("The new status for this task"),
      reason: z
        .string()
        .optional()
        .describe("Why the agent chose this disposition"),
      pr_url: z.string().optional().describe("URL of the created PR"),
      linear_ticket_id: z
        .string()
        .optional()
        .describe("ID of the created or referenced Linear ticket"),
    },
    async ({ status, reason, pr_url, linear_ticket_id }) => {
      const taskId = linear_ticket_id || config.taskUUID;
      console.log(`[Agent] Status update: ${status}`, JSON.stringify({ reason, pr_url, taskId }));
      await statusUpdater.updateAll(status, { pr_url, linearTicketId: taskId });
      return { content: [{ type: "text" as const, text: `Task status updated to ${status}` }] };
    },
  );

  const listTranscripts = tool(
    "list_transcripts",
    "List available agent transcripts. Use this to find transcripts for analysis. Returns tickets with their transcript R2 keys.",
    {
      limit: z.number().optional().describe("Maximum number of transcripts to return (default 50)"),
      sinceHours: z.number().optional().describe("Only return transcripts from the last N hours"),
    },
    async ({ limit = 50, sinceHours }) => {
      try {
        const params = new URLSearchParams({ limit: limit.toString() });
        if (sinceHours) params.append("sinceHours", sinceHours.toString());

        const res = await fetch(`${config.workerUrl}/api/transcripts?${params}`, {
          headers: {
            "X-API-Key": config.apiKey,
          },
        });

        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Failed to list transcripts: ${res.status}` }] };
        }

        const data = (await res.json()) as { transcripts: Array<{ taskUUID: string; taskId: string; r2Key: string; uploadedAt: string; product: string; status: string }> };
        const transcriptList = data.transcripts
          .map((t: { taskId: string; product: string; status: string; r2Key: string }) => `- ${t.taskId} (${t.product}, ${t.status}) — ${t.r2Key}`)
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${data.transcripts.length} transcripts:\n${transcriptList}`,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error listing transcripts: ${err}` }] };
      }
    },
  );

  const fetchTranscript = tool(
    "fetch_transcript",
    "Fetch the full JSONL transcript for a specific ticket. Use this to analyze agent behavior and decision-making.",
    {
      r2Key: z.string().describe("The R2 key for the transcript (from list_transcripts)"),
    },
    async ({ r2Key }) => {
      try {
        const res = await fetch(`${config.workerUrl}/api/transcripts/${encodeURIComponent(r2Key)}`, {
          headers: {
            "X-API-Key": config.apiKey,
          },
        });

        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Failed to fetch transcript: ${res.status}` }] };
        }

        const transcript = await res.text();
        const lines = transcript.split("\n").filter((l) => l.trim());
        const summary = `Transcript: ${r2Key}\nLines: ${lines.length}\nSize: ${transcript.length} bytes\n\nFirst 10 lines:\n${lines.slice(0, 10).join("\n")}`;

        return {
          content: [
            {
              type: "text" as const,
              text: summary,
            },
          ],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error fetching transcript: ${err}` }] };
      }
    },
  );

  const fetchSlackFile = tool(
    "fetch_slack_file",
    "Fetch a file attachment from Slack. Use this to view images or download files attached to Slack messages. Returns the file content as base64 for images, or as text for other file types.",
    {
      url: z.string().describe("The url_private or url_private_download from the Slack file object"),
      mimetype: z.string().optional().describe("The MIME type of the file (e.g., 'image/png')"),
    },
    async ({ url, mimetype }) => {
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${config.slackBotToken}`,
          },
        });

        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Failed to fetch Slack file: ${res.status} ${res.statusText}` }] };
        }

        const isImage = mimetype?.startsWith("image/");

        if (isImage) {
          // For images, return as base64 in an image content block so Claude can view it
          const arrayBuffer = await res.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString("base64");

          return {
            content: [
              {
                type: "image" as const,
                data: base64,
                mimeType: normalizeImageMediaType(mimetype || "image/png"),
              },
            ],
          };
        } else {
          // For non-images, return as text
          const text = await res.text();
          return {
            content: [
              {
                type: "text" as const,
                text: `File content (${mimetype || "unknown type"}):\n\n${text}`,
              },
            ],
          };
        }
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error fetching Slack file: ${err}` }] };
      }
    },
  );

  const checkCiStatus = tool(
    "check_ci_status",
    "Check CI status for a PR. Returns commit statuses (passing/failing/pending/none). Use after opening a PR to monitor CI.",
    {
      pr_url: z.string().describe("The GitHub PR URL to check CI for"),
    },
    async ({ pr_url }) => {
      if (!config.githubToken) {
        return { content: [{ type: "text" as const, text: "No GitHub token configured" }] };
      }
      const result = await checkCIStatus(pr_url, config.githubToken);
      return {
        content: [{
          type: "text" as const,
          text: `CI Status: ${result.ciStatus}\nReady: ${result.ready}\nReason: ${result.reason}${result.retryAfterMs ? `\nRetry in: ${result.retryAfterMs / 1000}s` : ""}`,
        }],
      };
    },
  );

  const mergePr = tool(
    "merge_pr",
    "Merge a PR using squash merge. Only call when CI passes and PR is ready. This is IRREVERSIBLE.",
    {
      pr_url: z.string().describe("The GitHub PR URL to merge"),
    },
    async ({ pr_url }) => {
      if (!config.githubToken) {
        return { content: [{ type: "text" as const, text: "No GitHub token configured" }] };
      }
      const result = await mergePR(pr_url, config.githubToken);
      if (result.merged) {
        // Report merged status to orchestrator
        try {
          await fetch(`${config.workerUrl}/api/internal/status`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Key": config.apiKey,
            },
            body: JSON.stringify({
              taskUUID: config.taskUUID,
              status: "merged",
            }),
          });
        } catch { /* best effort */ }
        return { content: [{ type: "text" as const, text: "PR merged successfully!" }] };
      }
      return { content: [{ type: "text" as const, text: `Merge failed: ${result.error}` }] };
    },
  );

  // --- Conductor-specific tools ---

  const listTasks = tool(
    "list_tasks",
    "List all active tasks across all products. Returns ticket IDs, products, statuses, and last activity.",
    {
      status_filter: z.string().optional().describe("Filter by status (e.g., 'active', 'pr_open')"),
      product_filter: z.string().optional().describe("Filter by product slug"),
    },
    async ({ status_filter, product_filter }) => {
      try {
        const params = new URLSearchParams();
        if (product_filter) params.append("product", product_filter);

        const res = await fetch(`${config.workerUrl}/api/conductor/status`, {
          headers: { "X-API-Key": config.apiKey },
        });
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Failed to list tasks: ${res.status}` }] };
        }
        const data = await res.json() as {
          activeAgents?: Array<{
            task_uuid: string; task_id: string; product: string;
            status: string; agent_message: string | null; pr_url: string | null;
            last_heartbeat: string | null;
          }>;
          tasks?: Array<{
            task_uuid: string; task_id: string; product: string;
            status: string; agent_message: string | null; pr_url: string | null;
          }>;
        };

        let agents = data.activeAgents || data.tasks || [];
        if (status_filter) {
          agents = agents.filter(a => a.status === status_filter);
        }
        if (product_filter) {
          agents = agents.filter(a => a.product === product_filter);
        }

        if (agents.length === 0) {
          return { content: [{ type: "text" as const, text: "No active tasks found." }] };
        }

        const summary = agents.map(a =>
          `- **${a.product}** [${a.status}] ${a.task_id || a.task_uuid}: ${(a.agent_message || "no recent message").slice(0, 100)}${a.pr_url ? ` | PR: ${a.pr_url}` : ""}`
        ).join("\n");

        return { content: [{ type: "text" as const, text: `Tasks (${agents.length}):\n\n${summary}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    },
  );

  const spawnTask = tool(
    "spawn_task",
    "Spawn a task agent to work on a task. If a taskUUID is provided (e.g., from a task_created event), the agent works on that existing task. Otherwise a new task is created.",
    {
      product: z.string().describe("Product slug (e.g., 'staging-test-app')"),
      description: z.string().describe("Task description — what should be done"),
      taskUUID: z.string().optional().describe("Existing task UUID to spawn an agent for (from event payload). Omit to create a new task."),
    },
    async ({ product, description, taskUUID: existingUUID }) => {
      try {
        const taskUUID = existingUUID || `conductor-task-${Date.now()}`;
        const res = await fetch(`${config.workerUrl}/api/project-lead/spawn-task`, {
          method: "POST",
          headers: {
            "X-Internal-Key": config.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            product,
            taskUUID,
            taskTitle: description.slice(0, 80),
            taskDescription: description,
            mode: "coding",
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          return { content: [{ type: "text" as const, text: `Failed to spawn task: ${res.status} ${text}` }] };
        }
        const data = await res.json() as { taskUUID?: string };
        return { content: [{ type: "text" as const, text: `Task spawned for ${product}: ${data.taskUUID || taskUUID}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    },
  );

  const sendMessageToTask = tool(
    "send_message_to_task",
    "Send a message/instructions to a product's project lead agent. Use to relay user directions or provide context.",
    {
      product: z.string().describe("Product slug to send the message to"),
      message: z.string().describe("The message to relay to the project lead"),
    },
    async ({ product, message }) => {
      try {
        const res = await fetch(`${config.workerUrl}/api/project-lead/relay-to-project`, {
          method: "POST",
          headers: {
            "X-Internal-Key": config.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            product,
            event: {
              type: "conductor_message",
              source: "internal",
              taskUUID: `conductor-relay-${Date.now()}`,
              product,
              payload: { text: message, from: "conductor" },
            },
          }),
        });
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Failed to send message: ${res.status}` }] };
        }
        return { content: [{ type: "text" as const, text: `Message sent to ${product}'s project lead.` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    },
  );

  const createSchedule = tool(
    "create_recurring_schedule",
    "Create a recurring schedule that will spawn tasks automatically. Use natural language like 'daily at 9am: review AI news' or 'every monday at 10am: team sync' or 'monthly on 15th at 12:00: generate report'.",
    {
      scheduleText: z.string().describe("Natural language schedule (e.g., 'daily at 9am: review AI news')"),
    },
    async ({ scheduleText }) => {
      try {
        const res = await fetch(`${config.workerUrl}/api/schedules`, {
          method: "POST",
          headers: {
            "X-Internal-Key": config.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            product: config.product,
            scheduleText,
            createdBy: config.slackChannel,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          return { content: [{ type: "text" as const, text: `Failed to create schedule: ${text}` }] };
        }
        const data = await res.json() as { id: string; next_scheduled_for: string };
        return { content: [{ type: "text" as const, text: `Schedule created (ID: ${data.id}). Next run: ${data.next_scheduled_for}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    },
  );

  const listSchedules = tool(
    "list_recurring_schedules",
    "List all recurring schedules for this product.",
    {},
    async () => {
      try {
        const res = await fetch(`${config.workerUrl}/api/schedules?product=${config.product}`, {
          headers: { "X-Internal-Key": config.apiKey },
        });
        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Failed to list schedules: ${res.status}` }] };
        }
        const data = await res.json() as { schedules: Array<{ id: string; title: string; recurrence: string; time: string; enabled: number; next_scheduled_for: string }> };
        if (data.schedules.length === 0) {
          return { content: [{ type: "text" as const, text: "No recurring schedules found." }] };
        }
        const summary = data.schedules.map(s =>
          `• ${s.title} (${s.recurrence} at ${s.time}) - ${s.enabled ? "enabled" : "disabled"}\n  ID: ${s.id}\n  Next: ${s.next_scheduled_for}`
        ).join("\n\n");
        return { content: [{ type: "text" as const, text: `Recurring Schedules:\n\n${summary}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    },
  );

  const pauseSchedule = tool(
    "pause_recurring_schedule",
    "Pause (disable) a recurring schedule by ID. The schedule remains in the system but won't create new tasks.",
    {
      scheduleId: z.string().describe("Schedule ID to pause"),
    },
    async ({ scheduleId }) => {
      try {
        const res = await fetch(`${config.workerUrl}/api/schedules/${scheduleId}`, {
          method: "PUT",
          headers: {
            "X-Internal-Key": config.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ enabled: false }),
        });
        if (!res.ok) {
          const text = await res.text();
          return { content: [{ type: "text" as const, text: `Failed to pause schedule: ${text}` }] };
        }
        return { content: [{ type: "text" as const, text: `Schedule ${scheduleId} paused.` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    },
  );

  const resumeSchedule = tool(
    "resume_recurring_schedule",
    "Resume (enable) a paused recurring schedule by ID.",
    {
      scheduleId: z.string().describe("Schedule ID to resume"),
    },
    async ({ scheduleId }) => {
      try {
        const res = await fetch(`${config.workerUrl}/api/schedules/${scheduleId}`, {
          method: "PUT",
          headers: {
            "X-Internal-Key": config.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ enabled: true }),
        });
        if (!res.ok) {
          const text = await res.text();
          return { content: [{ type: "text" as const, text: `Failed to resume schedule: ${text}` }] };
        }
        return { content: [{ type: "text" as const, text: `Schedule ${scheduleId} resumed.` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    },
  );

  const deleteSchedule = tool(
    "delete_recurring_schedule",
    "Permanently delete a recurring schedule by ID.",
    {
      scheduleId: z.string().describe("Schedule ID to delete"),
    },
    async ({ scheduleId }) => {
      try {
        const res = await fetch(`${config.workerUrl}/api/schedules/${scheduleId}`, {
          method: "DELETE",
          headers: { "X-Internal-Key": config.apiKey },
        });
        if (!res.ok) {
          const text = await res.text();
          return { content: [{ type: "text" as const, text: `Failed to delete schedule: ${text}` }] };
        }
        return { content: [{ type: "text" as const, text: `Schedule ${scheduleId} deleted.` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    },
  );

  // Build tool list based on agent role
  const agentRole = process.env.AGENT_ROLE || "ticket";
  const isConductorRole = agentRole === "conductor";
  const isProjectLeadRole = agentRole === "project-lead" || isConductorRole;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allTools: SdkMcpToolDefinition<any>[] = [notifySlack, askQuestion, updateTaskStatus, listTranscripts, fetchTranscript, fetchSlackFile];

  // Conductor and project leads can spawn/relay tasks and manage schedules
  if (isProjectLeadRole) {
    allTools.push(listTasks, spawnTask, sendMessageToTask, createSchedule, listSchedules, pauseSchedule, resumeSchedule, deleteSchedule);
  }

  // All non-conductor roles get CI/merge tools (project leads need them for direct coding)
  if (!isConductorRole) {
    allTools.push(checkCiStatus, mergePr);
  }

  return { tools: allTools };
}
