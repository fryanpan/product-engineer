/**
 * Generic communication tools for the Product Engineer agent.
 *
 * These supplement Claude Code's built-in tools (file edit, bash, git).
 * Tools are product-agnostic — they use config values injected by the TicketAgent DO.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentConfig } from "./config";

type ToolResult = { content: { type: "text"; text: string }[] };

function persistSlackThreadTs(config: AgentConfig, ts: string) {
  if (!config.slackThreadTs && ts) {
    config.slackThreadTs = ts;
    fetch(`${config.workerUrl}/api/internal/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": config.apiKey,
      },
      body: JSON.stringify({
        ticketId: config.ticketId,
        slack_thread_ts: ts,
      }),
    }).catch((err) =>
      console.error("[Agent] Failed to persist slack_thread_ts:", err),
    );
  }
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

  if (data.ts) persistSlackThreadTs(config, data.ts);
  return { content: [{ type: "text", text: "Message posted to Slack" }] };
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
    "Post a clarifying question to the Slack channel. Use this when a task is ambiguous and you need more information. The user's reply will arrive as a new event.",
    { question: z.string().describe("The question to ask the user via Slack") },
    ({ question }) => postToSlack(`*Agent question:*\n${question}`, config),
  );

  const updateTaskStatus = tool(
    "update_task_status",
    "Update the task's status. Call this at every state transition.",
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
          "asking",
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
      console.log(
        `[Agent] Status update: ${status}`,
        JSON.stringify({ reason, pr_url, linear_ticket_id }),
      );

      try {
        await fetch(`${config.workerUrl}/api/internal/status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.apiKey,
          },
          body: JSON.stringify({
            ticketId: config.ticketId,
            status,
            pr_url,
            branch_name: undefined,
          }),
        });
      } catch (err) {
        console.error("[Agent] Failed to update status:", err);
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

        const data = await res.json<{ transcripts: Array<{ ticketId: string; r2Key: string; uploadedAt: string; product: string; status: string }> }>();
        const transcriptList = data.transcripts
          .map((t) => `- ${t.ticketId} (${t.product}, ${t.status}) — ${t.r2Key}`)
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

  return { tools: [notifySlack, askQuestion, updateTaskStatus, listTranscripts, fetchTranscript] };
}
