/**
 * Product Engineer Agent — Claude Agent SDK entrypoint.
 *
 * Runs inside a Cloudflare Sandbox container. Reads task payload from env,
 * processes it using streaming input mode (for mid-task human feedback),
 * and either implements changes, asks clarifying questions via Slack,
 * or defers to a Linear ticket.
 *
 * The agent's decision-making logic comes from:
 * 1. The product-engineer skill (English, in .claude/skills/)
 * 2. The repo's CLAUDE.md and project skills (loaded via settingSources)
 * 3. The task-specific prompt (built by prompt.ts)
 */

import {
  query,
  createSdkMcpServer,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "./config";
import { createTools } from "./tools";
import { buildPrompt } from "./prompt";
import { SlackListener } from "./slack-listener";

function userMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  };
}

const REPLY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

async function main() {
  const startTime = Date.now();
  const config = loadConfig();
  const { tools, state } = createTools(config);
  const prompt = buildPrompt(config.taskPayload);

  const toolServer = createSdkMcpServer({
    name: "pe-tools",
    tools,
  });

  const { product, type } = config.taskPayload;
  console.log(`[PE Agent] Product: ${product}, Task type: ${type}`);

  let slackListener: SlackListener | null = null;

  async function* generateMessages(): AsyncGenerator<SDKUserMessage> {
    // Turn 1: Process the task
    yield userMessage(prompt);

    // If the agent asked a question via Slack, listen for the reply
    if (config.slackThreadTs && state.askedQuestion) {
      slackListener = new SlackListener(
        config.slackAppToken,
        config.slackThreadTs,
      );
      try {
        await slackListener.start();
        console.log("[PE Agent] Slack listener started, waiting for reply...");

        const reply = await slackListener.waitForReply(REPLY_TIMEOUT_MS);
        slackListener.close();

        if (reply) {
          console.log(`[PE Agent] Received Slack reply from ${reply.user}`);
          yield userMessage(
            `The user replied via Slack:\n\n"${reply.text}"\n\nContinue processing the task with this information.`,
          );
        } else {
          console.log("[PE Agent] No Slack reply received within timeout");
          yield userMessage(
            "No reply received within the timeout. Proceed with your best judgment, or defer to a Linear ticket if unclear.",
          );
        }
      } catch (err) {
        console.error("[PE Agent] Slack listener error:", err);
        slackListener?.close();
        yield userMessage(
          "Failed to connect to Slack for replies. Proceed with your best judgment, or defer to a Linear ticket if unclear.",
        );
      }
    }
  }

  const session = query({
    prompt: generateMessages(),
    options: {
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],
      maxTurns: 50,
      permissionMode: "acceptEdits",
      mcpServers: {
        "pe-tools": toolServer,
      },
    },
  });

  for await (const message of session) {
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === "text") {
          console.log(`[PE Agent] ${block.text.slice(0, 200)}`);
        }
        if (block.type === "tool_use") {
          console.log(`[PE Agent] Tool call: ${block.name}`);
        }
      }
    }
  }

  (slackListener as SlackListener | null)?.close();

  // Log session for cross-project review
  const sessionLog = {
    timestamp: new Date().toISOString(),
    product: config.taskPayload.product,
    taskType: config.taskPayload.type,
    taskId: config.taskPayload.type === "feedback"
      ? (config.taskPayload.data as { id: string }).id
      : config.taskPayload.type === "ticket"
        ? (config.taskPayload.data as { id: string }).id
        : `cmd-${Date.now()}`,
    duration_ms: Date.now() - startTime,
  };
  console.log(`[PE Session Log] ${JSON.stringify(sessionLog)}`);

  console.log("[PE Agent] Done");
}

main().catch((err) => {
  console.error("[PE Agent] Fatal error:", err);
  process.exit(1);
});
