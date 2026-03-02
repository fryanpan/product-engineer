/**
 * Long-lived HTTP server wrapping the Agent SDK.
 *
 * Receives events via POST /event from the TicketAgent DO.
 * On first event: clones repos, starts Agent SDK session.
 * On subsequent events: yields new messages into the running session.
 */

import * as Sentry from "@sentry/bun";
import { Hono } from "hono";
import {
  query,
  createSdkMcpServer,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, type TaskPayload } from "./config";
import { createTools } from "./tools";
import { buildPrompt, buildEventPrompt } from "./prompt";
import type { TicketEvent } from "./types";

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}

function userMessage(content: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  };
}

const app = new Hono();
const config = loadConfig();

let sessionActive = false;
let messageYielder: ((msg: SDKUserMessage) => void) | null = null;
let repoCloned = false;

function createMessageGenerator(): AsyncGenerator<SDKUserMessage> {
  const queue: SDKUserMessage[] = [];
  let resolve: (() => void) | null = null;

  messageYielder = (msg: SDKUserMessage) => {
    queue.push(msg);
    if (resolve) {
      const r = resolve;
      resolve = null;
      r();
    }
  };

  return (async function* () {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      await new Promise<void>((r) => {
        resolve = r;
      });
    }
  })();
}

async function cloneRepos() {
  if (repoCloned) return;

  const netrc = `machine github.com\nlogin x-access-token\npassword ${config.githubToken}\n`;
  await Bun.write("/root/.netrc", netrc);
  const chmod = Bun.spawn(["chmod", "600", "/root/.netrc"]);
  await chmod.exited;

  for (const repo of config.repos) {
    const repoName = repo.split("/").pop()!;
    console.log(`[Agent] Cloning ${repo}...`);
    const proc = Bun.spawn([
      "git",
      "clone",
      `https://github.com/${repo}.git`,
      `/workspace/${repoName}`,
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Failed to clone ${repo}: exit code ${exitCode}`);
    }
  }

  repoCloned = true;
}

async function startSession(initialPrompt: string) {
  if (sessionActive) return;
  sessionActive = true;

  const { tools } = createTools(config);
  const toolServer = createSdkMcpServer({ name: "pe-tools", tools });
  const messages = createMessageGenerator();

  messageYielder!(userMessage(initialPrompt));

  const session = query({
    prompt: messages,
    options: {
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],
      maxTurns: 200,
      permissionMode: "acceptEdits",
      mcpServers: { "pe-tools": toolServer },
    },
  });

  (async () => {
    try {
      for await (const message of session) {
        if (message.type === "assistant" && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === "text") {
              console.log(`[Agent] ${block.text.slice(0, 200)}`);
            }
            if (block.type === "tool_use") {
              console.log(`[Agent] Tool: ${block.name}`);
            }
          }
        }
      }
    } catch (err) {
      console.error("[Agent] Session error:", err);
      sessionActive = false;
    }
  })();
}

app.post("/event", async (c) => {
  const event = await c.req.json<TicketEvent>();
  console.log(`[Agent] Event: ${event.type} from ${event.source}`);

  try {
    // Capture thread_ts from event so Slack tools reply in-thread
    if (event.slackThreadTs) {
      config.slackThreadTs = event.slackThreadTs;
    }

    await cloneRepos();

    if (!sessionActive) {
      const taskPayload: TaskPayload = {
        type:
          event.type === "ticket_created"
            ? "ticket"
            : event.type === "slack_mention"
              ? "command"
              : "ticket",
        product: config.product,
        repos: config.repos,
        data: event.payload as TaskPayload["data"],
      };
      const prompt = buildPrompt(taskPayload);
      await startSession(prompt);
    } else {
      const continuationPrompt = buildEventPrompt(event);
      messageYielder!(userMessage(continuationPrompt));
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("[Agent] Event handling error:", err);
    return c.json({ error: String(err) }, 500);
  }
});

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "ticket-agent-container",
    sessionActive,
    product: config.product,
    ticketId: config.ticketId,
  }),
);

export default {
  port: 3000,
  fetch: app.fetch,
};
