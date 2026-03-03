/**
 * Generic communication tools for the Product Engineer agent.
 *
 * These supplement Claude Code's built-in tools (file edit, bash, git).
 * Tools are product-agnostic — they use config values injected by the TicketAgent DO.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentConfig } from "./config";

export function createTools(config: AgentConfig) {
  const { slackBotToken, slackChannel } = config;

  const notifySlack = tool(
    "notify_slack",
    "Send a notification message to the product's Slack channel. Use this to keep the team informed of progress.",
    {
      message: z.string().describe("The message to post to Slack"),
    },
    async ({ message }) => {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${slackBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: slackChannel,
          text: message,
          ...(config.slackThreadTs && { thread_ts: config.slackThreadTs }),
        }),
      });

      if (!res.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Slack notification failed: ${res.status}`,
            },
          ],
        };
      }

      const data = (await res.json()) as { ok: boolean; error?: string; ts?: string };
      if (!data.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Slack API error: ${data.error}`,
            },
          ],
        };
      }

      // If this is the first Slack message (no thread_ts yet), persist it back
      // so future messages thread correctly and Slack replies route to this ticket.
      if (!config.slackThreadTs && data.ts) {
        config.slackThreadTs = data.ts;
        fetch(`${config.workerUrl}/api/internal/status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": config.apiKey,
          },
          body: JSON.stringify({
            ticketId: config.ticketId,
            slack_thread_ts: data.ts,
          }),
        }).catch((err) =>
          console.error("[Agent] Failed to persist slack_thread_ts:", err),
        );
      }

      return {
        content: [{ type: "text" as const, text: "Slack notification sent" }],
      };
    },
  );

  const askQuestion = tool(
    "ask_question",
    "Post a clarifying question to the Slack channel. Use this when a task is ambiguous and you need more information. The user's reply will arrive as a new event.",
    {
      question: z.string().describe("The question to ask the user via Slack"),
    },
    async ({ question }) => {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${slackBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: slackChannel,
          text: `*Agent question:*\n${question}`,
          ...(config.slackThreadTs && { thread_ts: config.slackThreadTs }),
        }),
      });

      if (!res.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to post question: ${res.status}`,
            },
          ],
        };
      }

      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Slack API error: ${data.error}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Question posted to Slack. The user's reply will arrive as a new event.",
          },
        ],
      };
    },
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

  return { tools: [notifySlack, askQuestion, updateTaskStatus] };
}
