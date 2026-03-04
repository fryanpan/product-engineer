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
    "Post a clarifying question to the Slack channel. Use this when a task is ambiguous and you need more information. The user's reply will arrive as a new event.",
    { question: z.string().describe("The question to ask the user via Slack") },
    ({ question }) => postToSlack(`*Agent question:*\n${question}`, config),
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

      // Update orchestrator
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
        asking: "In Progress",
      };

      const linearState = linearStateMap[status] || "In Progress";

      // Update Linear ticket if we have the ticket ID and API key
      if (linear_ticket_id && config.linearApiKey) {
        try {
          await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: config.linearApiKey,
            },
            body: JSON.stringify({
              query: `mutation($issueId: String!, $stateInput: WorkflowStateFilter!) {
                issueUpdate(id: $issueId, input: { state: $stateInput }) {
                  success
                  issue { id state { name } }
                }
              }`,
              variables: {
                issueId: linear_ticket_id,
                stateInput: { name: { eq: linearState } },
              },
            }),
          });
          console.log(`[Agent] Updated Linear ticket ${linear_ticket_id} to ${linearState}`);
        } catch (err) {
          console.error("[Agent] Failed to update Linear ticket:", err);
        }
      }

      // Update top-level Slack message with status
      if (config.slackThreadTs) {
        try {
          // Get original message first to preserve ticket info
          const historyRes = await fetch(
            `https://slack.com/api/conversations.history?channel=${encodeURIComponent(config.slackChannel)}&latest=${config.slackThreadTs}&inclusive=true&limit=1`,
            {
              headers: {
                Authorization: `Bearer ${config.slackBotToken}`,
              },
            },
          );

          if (historyRes.ok) {
            const historyData = (await historyRes.json()) as {
              ok: boolean;
              messages?: Array<{ text: string }>;
            };

            if (historyData.ok && historyData.messages?.[0]) {
              const originalText = historyData.messages[0].text;

              // Build status indicator
              let statusEmoji = "⏳";
              let statusText = status.replace(/_/g, " ").toUpperCase();
              if (["merged", "closed"].includes(status)) {
                statusEmoji = "✅";
                statusText = "**DONE**";
              } else if (status === "pr_open" || status === "in_review") {
                statusEmoji = "👀";
              } else if (status === "failed") {
                statusEmoji = "❌";
              }

              // Update message to include status
              const updatedText = `${statusEmoji} ${statusText}\n\n${originalText}`;

              await updateSlackMessage(updatedText, config.slackThreadTs, config);
              console.log(`[Agent] Updated Slack thread ${config.slackThreadTs} with status: ${status}`);
            }
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

  return { tools: [notifySlack, askQuestion, updateTaskStatus] };
}
