/**
 * Generic communication tools for the Product Engineer agent.
 *
 * These supplement Claude Code's built-in tools (file edit, bash, git).
 * Tools are product-agnostic — they use config values injected by the TicketAgent DO.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { normalizeImageMediaType, type AgentConfig } from "./config";

type ToolResult = { content: { type: "text"; text: string }[] };

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
          ticketUUID: config.ticketUUID,
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
  }
  return { content: [{ type: "text", text: "Message posted to Slack" }] };
}

async function updateSlackMessage(
  text: string,
  ts: string,
  config: AgentConfig,
): Promise<ToolResult> {
  const res = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.slackBotToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: config.slackChannel,
      ts,
      text,
    }),
  });

  if (!res.ok) {
    return { content: [{ type: "text", text: `Slack update failed: ${res.status}` }] };
  }

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    return { content: [{ type: "text", text: `Slack update error: ${data.error}` }] };
  }

  return { content: [{ type: "text", text: "Slack message updated" }] };
}

export function createTools(config: AgentConfig) {
  const notifySlack = tool(
    "notify_slack",
    "Send a notification message to the product's Slack channel. Use this to keep the team informed of progress.",
    { message: z.string().describe("The message to post to Slack") },
    ({ message }) => postToSlack(message, config),
  );

  const askQuestion = tool(
    "ask_question",
    "Post a clarifying question to the Slack channel. Use this when a task is ambiguous and you need more information. The user's reply will arrive as a new event. IMPORTANT: Only call this tool ONCE per question session - do not ask multiple questions in rapid succession.",
    { question: z.string().describe("The question to ask the user via Slack") },
    async ({ question }) => {
      // Update status to "needs_info" first to prevent multiple question prompts
      try {
        await fetch(`${config.workerUrl}/api/internal/status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.apiKey,
          },
          body: JSON.stringify({
            ticketUUID: config.ticketUUID,
            status: "needs_info",
          }),
        });
      } catch (err) {
        console.warn("[Agent] Failed to update status to needs_info:", err);
      }

      return postToSlack(`*Agent question:*\n${question}`, config);
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
    async ({ status, reason, pr_url, linear_ticket_id: explicitTicketId }) => {
      const linear_ticket_id = explicitTicketId || config.ticketUUID;
      console.log(
        `[Agent] Status update: ${status}`,
        JSON.stringify({ reason, pr_url, linear_ticket_id }),
      );

      // Update orchestrator
      try {
        await fetch(`${config.workerUrl}/api/internal/status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.apiKey,
          },
          body: JSON.stringify({
            ticketUUID: config.ticketUUID,
            status,
            pr_url,
            branch_name: undefined,
          }),
        });
      } catch (err) {
        console.error("[Agent] Failed to update orchestrator status:", err);
      }

      // Map status to Linear workflow state
      const linearStateMap: Record<string, string> = {
        in_progress: "In Progress",
        pr_open: "In Review",
        in_review: "In Review",
        needs_revision: "In Progress",
        merged: "Done",
        closed: "Done",
        deferred: "Canceled",
        failed: "Canceled",
      };

      const linearState = linearStateMap[status] || "In Progress";

      // Update Linear ticket if we have the ticket ID and API key
      if (linear_ticket_id && config.linearAppToken) {
        try {
          // First, look up the workflow state ID by name from the issue's team
          const stateRes = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.linearAppToken}`,
            },
            body: JSON.stringify({
              query: `query($issueId: String!) {
                issue(id: $issueId) {
                  team { states { nodes { id name } } }
                }
              }`,
              variables: { issueId: linear_ticket_id },
            }),
          });
          const stateData = await stateRes.json() as {
            data?: { issue?: { team?: { states?: { nodes?: { id: string; name: string }[] } } } };
          };
          const states = stateData.data?.issue?.team?.states?.nodes || [];
          const targetState = states.find((s) => s.name === linearState);

          if (!targetState) {
            console.warn(`[Agent] Could not find Linear state "${linearState}" for ticket ${linear_ticket_id}`);
          } else {
            await fetch("https://api.linear.app/graphql", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.linearAppToken}`,
              },
              body: JSON.stringify({
                query: `mutation($issueId: String!, $stateId: String!) {
                  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
                    success
                    issue { id state { name } }
                  }
                }`,
                variables: {
                  issueId: linear_ticket_id,
                  stateId: targetState.id,
                },
              }),
            });
            console.log(`[Agent] Updated Linear ticket ${linear_ticket_id} to ${linearState}`);
          }
        } catch (err) {
          console.error("[Agent] Failed to update Linear ticket:", err);
        }
      }

      // Update top-level Slack message with status
      if (config.slackThreadTs) {
        try {
          // Build status indicator
          let statusEmoji = "⏳";
          let statusText = status.replace(/_/g, " ").toUpperCase();
          if (["merged", "closed"].includes(status)) {
            statusEmoji = "✅";
            statusText = "DONE";
          } else if (status === "pr_open" || status === "in_review") {
            statusEmoji = "👀";
            statusText = "IN REVIEW";
          } else if (status === "failed") {
            statusEmoji = "❌";
            statusText = "FAILED";
          }

          // Generate brief summary from ticket title (first sentence or first 100 chars)
          const ticketIdentifier = config.ticketIdentifier || config.ticketUUID;
          let briefSummary = config.ticketTitle || "Working on task";

          // Truncate to ~100 chars and ensure it ends cleanly
          if (briefSummary.length > 100) {
            const firstSentence = briefSummary.match(/^[^.!?]+[.!?]/);
            briefSummary = firstSentence ? firstSentence[0] : briefSummary.slice(0, 100) + "...";
          }

          // Compact format: emoji STATUS - TICKET-ID: brief summary
          const updatedText = `${statusEmoji} ${statusText} - ${ticketIdentifier}: ${briefSummary}`;

          const updateResult = await updateSlackMessage(updatedText, config.slackThreadTs, config);
          const resultText = updateResult.content[0]?.text || "";
          if (resultText.includes("failed") || resultText.includes("error")) {
            console.error(`[Agent] Failed to update Slack thread: ${resultText}`);
          } else {
            console.log(`[Agent] Updated Slack thread ${config.slackThreadTs} with status: ${status}`);
          }
        } catch (err) {
          console.error("[Agent] Failed to update Slack message:", err);
        }
      }

      return {
        content: [
          { type: "text" as const, text: `Task status updated to ${status}` },
        ],
      };
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

        const data = (await res.json()) as { transcripts: Array<{ ticketUUID: string; ticketId: string; r2Key: string; uploadedAt: string; product: string; status: string }> };
        const transcriptList = data.transcripts
          .map((t: { ticketId: string; product: string; status: string; r2Key: string }) => `- ${t.ticketId} (${t.product}, ${t.status}) — ${t.r2Key}`)
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
                source: {
                  type: "base64" as const,
                  media_type: normalizeImageMediaType(mimetype || "image/png"),
                  data: base64,
                },
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

  return { tools: [notifySlack, askQuestion, updateTaskStatus, listTranscripts, fetchTranscript, fetchSlackFile] };
}
