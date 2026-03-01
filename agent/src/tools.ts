/**
 * Generic communication tools for the Product Engineer agent.
 *
 * These supplement Claude Code's built-in tools (file edit, bash, git).
 * Tools are product-agnostic — they use config values injected by the orchestrator.
 */

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentConfig } from "./config";

/** Shared state between tools and the streaming input generator. */
export interface ToolState {
  askedQuestion: boolean;
}

export function createTools(config: AgentConfig) {
  const { slackBotToken, slackChannel, orchestratorUrl, orchestratorApiKey } =
    config;
  const state: ToolState = { askedQuestion: false };

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
        body: JSON.stringify({ channel: slackChannel, text: message }),
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
        content: [{ type: "text" as const, text: "Slack notification sent" }],
      };
    },
  );

  const askQuestion = tool(
    "ask_question",
    "Post a clarifying question to the Slack thread. Use this when a task is ambiguous and you need more information. After calling this, wait — the user's reply will be provided as the next message.",
    {
      question: z.string().describe("The question to ask the user via Slack"),
    },
    async ({ question }) => {
      const threadTs = config.slackThreadTs;
      if (!threadTs) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No Slack thread available — cannot ask questions. Proceed with your best judgment or defer to a Linear ticket.",
            },
          ],
        };
      }

      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${slackBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: slackChannel,
          thread_ts: threadTs,
          text: `🤔 *Agent question:*\n${question}`,
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

      state.askedQuestion = true;

      return {
        content: [
          {
            type: "text" as const,
            text: "Question posted to Slack thread. The user's reply will be provided as the next message.",
          },
        ],
      };
    },
  );

  const updateTaskStatus = tool(
    "update_task_status",
    "Update the task's status in the orchestrator. Call this at every state transition.",
    {
      status: z
        .enum([
          "implementing",
          "implemented",
          "in_review",
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
      if (!orchestratorUrl || !orchestratorApiKey) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No orchestrator URL configured — status update skipped.",
            },
          ],
        };
      }

      const taskId =
        config.taskPayload.type === "feedback"
          ? (config.taskPayload.data as { id: string }).id
          : config.taskPayload.type === "ticket"
            ? (config.taskPayload.data as { id: string }).id
            : `cmd-${Date.now()}`;

      const body: Record<string, string> = { status };
      if (reason) body.reason = reason;
      if (pr_url) body.pr_url = pr_url;
      if (linear_ticket_id) body.linear_ticket_id = linear_ticket_id;

      const res = await fetch(
        `${orchestratorUrl}/api/tasks/${taskId}/status`,
        {
          method: "PATCH",
          headers: {
            "X-API-Key": orchestratorApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );

      if (!res.ok) {
        const text = await res.text();
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to update status: ${res.status} ${text}`,
            },
          ],
        };
      }

      return {
        content: [
          { type: "text" as const, text: `Task status updated to ${status}` },
        ],
      };
    },
  );

  return { tools: [notifySlack, askQuestion, updateTaskStatus], state };
}
