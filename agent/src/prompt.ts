/**
 * Prompt builder for the Product Engineer agent.
 *
 * Builds a task-specific prompt from the task payload. The agent's
 * decision-making framework comes from the product-engineer skill
 * (loaded via settingSources from the repo's .claude/skills/).
 *
 * This file handles task formatting, not agent behavior — behavior
 * lives in English skills.
 */

import type {
  TaskPayload,
  FeedbackData,
  TicketData,
  CommandData,
} from "./config";
import type { TicketEvent } from "./types";

export function buildPrompt(task: TaskPayload): string {
  const header = `You are a Product Engineer agent working on **${task.product}**.

## Your Task

${formatTask(task)}

## Repos

${task.repos.map((r) => `- \`${r}\``).join("\n")}

${task.repos.length > 1 ? "The repos are already cloned into /workspace/. Work across them as needed." : "The repo is already cloned into /workspace/."}

## How to Work

Follow the product-engineer skill in your skills directory. It defines your decision process:
1. Assess whether you have enough information
2. Decide if the work is implementable
3. Implement, ask for clarification, or defer
4. After completing the task, do a brief retro

Use the repo's existing CLAUDE.md, skills, and conventions. Don't fight the codebase — follow its patterns.

## Communication

- Use \`notify_slack\` at every state transition so the team can follow along
- Use \`update_task_status\` to keep the orchestrator informed
- Use \`ask_question\` when you need clarification (the reply comes as your next message)

## After Completing Work

1. Run the project's tests before creating a PR
2. Create a PR with a clear description
3. Assess risk — auto-merge low-risk changes, request review for risky ones
4. Do a brief retro: what went well, what was surprising, any gotchas for next time
5. Post the retro to Slack as a thread reply`;

  return header;
}

function formatTask(task: TaskPayload): string {
  switch (task.type) {
    case "feedback":
      return formatFeedback(task.data as FeedbackData);
    case "ticket":
      return formatTicket(task.data as TicketData);
    case "command":
      return formatCommand(task.data as CommandData);
  }
}

function formatFeedback(data: FeedbackData): string {
  const parts = [
    `**Type:** User feedback`,
    data.text && `**Feedback:** "${data.text}"`,
    data.page_url && `**Page URL:** ${data.page_url}`,
    data.annotations && `**Annotations:** ${data.annotations}`,
    data.screenshot && `**Screenshot:** (attached)`,
    `**Feedback ID:** ${data.id}`,
  ];
  return parts.filter(Boolean).join("\n");
}

function formatTicket(data: TicketData): string {
  const parts = [
    `**Type:** Linear ticket`,
    `**Title:** ${data.title}`,
    `**Description:** ${data.description}`,
    `**Priority:** ${data.priority}`,
    data.labels.length > 0 && `**Labels:** ${data.labels.join(", ")}`,
    `**Ticket ID:** ${data.id}`,
  ];
  return parts.filter(Boolean).join("\n");
}

function formatCommand(data: CommandData): string {
  return [
    `**Type:** Slack command`,
    `**From:** <@${data.user}>`,
    `**Message:** "${data.text}"`,
    `**Channel:** ${data.channel}`,
  ].join("\n");
}

export function buildEventPrompt(event: TicketEvent): string {
  const payload = event.payload as Record<string, unknown>;

  switch (event.type) {
    case "pr_review":
      return `A PR review was submitted:\n\n**State:** ${payload.state}\n**Body:** ${payload.body || "(no comment)"}\n\nRespond to the review. If changes are requested, make them, push, and notify Slack.`;
    case "pr_merged":
      return `The PR has been merged. Update the task status, notify Slack, and do a brief retro.`;
    case "ci_status":
      return `CI status update:\n\n**Status:** ${payload.status}\n**Description:** ${payload.description || ""}\n\nIf CI failed, investigate and fix. If it passed, continue with the workflow.`;
    case "slack_reply":
      return `The user replied via Slack:\n\n"${payload.text}"\n\nContinue processing with this information.`;
    default:
      return `New event: ${event.type}\n\n${JSON.stringify(payload, null, 2)}\n\nProcess this event appropriately.`;
  }
}
