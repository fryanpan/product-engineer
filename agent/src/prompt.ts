/**
 * Prompt builder for the Product Engineer agent.
 *
 * Builds a task-specific prompt from the task payload. CLAUDE.md and skills
 * are loaded via settingSources: ["project"] in server.ts — this file only
 * builds the task-specific user message with workflow instructions.
 *
 * Prompt text lives in Mustache templates under ./prompts/ — editable without
 * touching TypeScript.
 */

import Mustache from "mustache";
import initialTemplate from "./prompts/task-initial.mustache";
import researchTemplate from "./prompts/task-research-initial.mustache";
import resumeTemplate from "./prompts/task-resume.mustache";

import type {
  TaskPayload,
  FeedbackData,
  TicketData,
  CommandData,
  TicketEvent,
  SlackFile,
  MessageContent,
  ContentBlock,
} from "./config";
import { normalizeImageMediaType } from "./config";

/**
 * Fetch Slack image files and convert to base64 content blocks.
 * Non-images are skipped (agent can use fetch_slack_file tool if needed).
 * Fetches all images in parallel.
 */
async function fetchSlackFiles(
  files: SlackFile[],
  slackBotToken: string,
): Promise<ContentBlock[]> {
  const imageFiles = files.filter(f => f.mimetype.startsWith("image/"));
  if (imageFiles.length === 0) return [];

  const results = await Promise.allSettled(
    imageFiles.map(async (file): Promise<ContentBlock> => {
      const res = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${slackBotToken}` },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${file.name}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");

      return {
        type: "image",
        source: {
          type: "base64",
          media_type: normalizeImageMediaType(file.mimetype),
          data: base64,
        },
      };
    }),
  );

  const contentBlocks: ContentBlock[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      contentBlocks.push(result.value);
    } else {
      console.error(`[Prompt] Failed to fetch Slack file:`, result.reason);
    }
  }

  return contentBlocks;
}

export async function buildPrompt(
  task: TaskPayload,
  slackBotToken: string,
  productType?: string,
): Promise<MessageContent> {
  const template = productType === "research" ? researchTemplate : initialTemplate;
  const header = Mustache.render(template, {
    product: task.product,
    taskDescription: formatTask(task),
    reposList: task.repos.map((r) => `- \`${r}\``).join("\n"),
    reposContext:
      task.repos.length > 1
        ? "The repos are already cloned into /workspace/. Work across them as needed."
        : task.repos.length === 1
          ? "The repo is already cloned into /workspace/."
          : "No repos — working in /workspace/.",
  });

  // If task has files (from Slack), fetch and append images
  const files = (task.data as CommandData).files;
  if (files && files.length > 0) {
    const imageBlocks = await fetchSlackFiles(files, slackBotToken);
    if (imageBlocks.length > 0) {
      return [{ type: "text" as const, text: header }, ...imageBlocks];
    }
  }

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
    data.text && `**Feedback:**\n<user_input>\n${data.text}\n</user_input>`,
    data.page_url && `**Page URL:** ${data.page_url}`,
    data.annotations && `**Annotations:**\n<user_input>\n${data.annotations}\n</user_input>`,
    data.screenshot && `**Screenshot:** (attached)`,
    `**Feedback ID:** ${data.id}`,
  ];
  return parts.filter(Boolean).join("\n");
}

function formatTicket(data: TicketData): string {
  const parts = [
    `**Type:** Linear ticket`,
    data.identifier && `**Ticket:** ${data.identifier} (https://linear.app/issue/${data.identifier})`,
    `**Title:**\n<user_input>\n${data.title ?? "(no title)"}\n</user_input>`,
    `**Description:**\n<user_input>\n${data.description ?? "(no description)"}\n</user_input>`,
    `**Priority:** ${data.priority ?? "unset"}`,
    (data.labels?.length ?? 0) > 0 && `**Labels:** ${data.labels.join(", ")}`,
    `**Ticket ID:** ${data.id}`,
  ];
  return parts.filter(Boolean).join("\n");
}

function formatFileList(files: SlackFile[]): string {
  return files.map(f => `- ${f.name} (${f.mimetype}, ${(f.size / 1024).toFixed(1)} KB)`).join("\n");
}

function formatCommand(data: CommandData): string {
  const parts = [
    `**Type:** Slack command`,
    `**From:** <@${data.user}>`,
    `**Message:**\n<user_input>\n${data.text}\n</user_input>`,
  ];

  if (data.files && data.files.length > 0) {
    parts.push(`**Attachments:**\n${formatFileList(data.files)}`);
    parts.push(`**Note:** File URLs are provided in the event payload. Use the Slack bot token to fetch files from url_private URLs.`);
  }

  parts.push(`**Channel:** ${data.channel}`);
  return parts.join("\n");
}

export async function buildEventPrompt(
  event: TicketEvent,
  slackBotToken: string,
): Promise<MessageContent> {
  const payload = event.payload as Record<string, unknown>;

  switch (event.type) {
    case "pr_review":
      return `A PR review was submitted:\n\n**State:** ${payload.review_state || payload.state}\n**Reviewer:** ${payload.reviewer || "unknown"}\n**Body:**\n<user_input>\n${payload.review_body || payload.body || "(no comment)"}\n</user_input>\n\nRespond to the review. If changes are requested, make them, push, and notify Slack.`;
    case "pr_review_comment":
      return `A review comment was posted on your PR:\n\n**Commenter:** ${payload.commenter || "unknown"}\n**File:** ${payload.file_path || "unknown"}\n**Line:** ${payload.line || "unknown"}\n**Comment:**\n<user_input>\n${payload.comment_body || "(no comment)"}\n</user_input>\n\nRespond to the comment. If changes are needed, make them, push, and notify Slack.`;
    case "pr_comment":
      return `A comment was posted on your PR:\n\n**Commenter:** ${payload.commenter || "unknown"}\n**Comment:**\n<user_input>\n${payload.comment_body || "(no comment)"}\n</user_input>\n\nRespond to the comment. If changes are needed, make them, push, and notify Slack.`;
    case "pr_merged":
      return `The PR has been merged. Update the task status to "merged", notify Slack, and do a brief retro.`;
    case "pr_closed":
      return `The PR was closed without being merged. Update the task status to "closed", notify Slack, and do a brief retro explaining what happened.`;
    case "ci_status":
      return `CI status update:\n\n**Status:** ${payload.status}\n**Description:** ${payload.description || ""}\n\nIf CI failed, investigate and fix. If it passed, continue with the workflow.`;
    case "linear_comment":
      return `A comment was posted on your Linear ticket:\n\n**Author:** ${payload.author}\n**Comment:**\n<user_input>\n${payload.body || "(no comment)"}\n</user_input>\n\nProcess this information and continue your work.`;
    case "slack_reply": {
      const files = payload.files as CommandData["files"];
      let message = `The user replied via Slack:\n\n<user_input>\n${payload.text}\n</user_input>`;

      if (files && files.length > 0) {
        message += `\n\n**Attachments:**\n${formatFileList(files)}`;

        // Fetch images and return structured content
        const imageBlocks = await fetchSlackFiles(files, slackBotToken);
        if (imageBlocks.length > 0) {
          return [
            { type: "text" as const, text: message + `\n\nContinue processing with this information.` },
            ...imageBlocks,
          ];
        }
      }

      return message + `\n\nContinue processing with this information.`;
    }
    default:
      return `New event: ${event.type}\n\n${JSON.stringify(payload, null, 2)}\n\nProcess this event appropriately.`;
  }
}

export function buildResumePrompt(
  branch: string,
  gitLog: string,
  gitStatus: string,
  prInfo: string,
): string {
  return Mustache.render(resumeTemplate, {
    branch,
    gitLog: gitLog || "(no commits on branch)",
    gitStatus: gitStatus || "(clean)",
    prInfo,
  });
}
