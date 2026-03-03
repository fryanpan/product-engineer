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
import { loadConfig, type TaskPayload, type TicketEvent } from "./config";
import { createTools } from "./tools";
import { buildPrompt, buildEventPrompt } from "./prompt";
import { buildMcpServers } from "./mcp";

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

console.log("[Agent] Starting server...");
console.log(`[Agent] Running as: uid=${process.getuid?.()} gid=${process.getgid?.()} HOME=${process.env.HOME}`);
console.log(`[Agent] Env check: ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "SET" : "MISSING"}`);
console.log(`[Agent] Env check: GITHUB_TOKEN=${process.env.GITHUB_TOKEN ? "SET" : "MISSING"}`);
console.log(`[Agent] Env check: TICKET_ID=${process.env.TICKET_ID || "MISSING"}`);
console.log(`[Agent] Env check: PRODUCT=${process.env.PRODUCT || "MISSING"}`);
console.log(`[Agent] Env check: REPOS=${process.env.REPOS || "MISSING"}`);

const config = loadConfig();
console.log(`[Agent] Config loaded: ticket=${config.ticketId} product=${config.product} repos=${config.repos.join(",")}`);

// Phone-home: report lifecycle events to the worker so they appear in wrangler tail
function phoneHome(phase: string, detail?: string) {
  const body = {
    ticketId: config.ticketId,
    status: `agent:${phase}`,
    branch_name: detail || undefined,
  };
  console.log(`[Agent] phoneHome: ${phase} ${detail || ""}`);
  fetch(`${config.workerUrl}/api/internal/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": config.apiKey,
    },
    body: JSON.stringify(body),
  }).catch((err) => console.error("[Agent] phoneHome failed:", err));
}

phoneHome("server_started", `uid=${process.getuid?.()} HOME=${process.env.HOME} API_KEY=${config.apiKey ? "SET" : "MISSING"} ANTHROPIC=${process.env.ANTHROPIC_API_KEY ? "SET" : "MISSING"}`);

// Heartbeat every 2 minutes so we know the container is alive
setInterval(() => {
  phoneHome("heartbeat", `status=${sessionStatus} msgs=${sessionMessageCount} tool=${lastToolCall.slice(0, 60)}`);
}, 120_000);

let sessionActive = false;
let messageYielder: ((msg: SDKUserMessage) => void) | null = null;
let repoCloned = false;
let sessionStatus = "idle";
let lastToolCall = "";
let lastAssistantText = "";
let sessionMessageCount = 0;
let sessionError = "";
let lastStderr = "";

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
  sessionStatus = "cloning";

  console.log("[Agent] Setting up .netrc for GitHub auth...");
  const home = process.env.HOME || "/home/agent";
  const netrc = `machine github.com\nlogin x-access-token\npassword ${config.githubToken}\n`;
  await Bun.write(`${home}/.netrc`, netrc);
  const chmod = Bun.spawn(["chmod", "600", `${home}/.netrc`]);
  await chmod.exited;

  for (const repo of config.repos) {
    const repoName = repo.split("/").pop()!;
    if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) {
      throw new Error(`Invalid repo name: ${repoName}`);
    }
    console.log(`[Agent] Cloning ${repo}...`);
    const proc = Bun.spawn([
      "git",
      "clone",
      `https://github.com/${repo}.git`,
      `/workspace/${repoName}`,
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = proc.stderr ? await new Response(proc.stderr).text() : "no stderr";
      console.error(`[Agent] Clone failed: ${stderr}`);
      throw new Error(`Failed to clone ${repo}: exit code ${exitCode} — ${stderr}`);
    }
    console.log(`[Agent] Cloned ${repo} successfully`);
    phoneHome("clone_done", repoName);
  }

  // Set working directory to the first repo so Agent SDK tools operate on it
  const primaryRepo = config.repos[0].split("/").pop()!;
  if (!/^[a-zA-Z0-9._-]+$/.test(primaryRepo)) {
    throw new Error(`Invalid repo name: ${primaryRepo}`);
  }
  process.chdir(`/workspace/${primaryRepo}`);
  console.log(`[Agent] Working directory: /workspace/${primaryRepo}`);

  repoCloned = true;
}

async function startSession(initialPrompt: string) {
  if (sessionActive) return;
  sessionStatus = "starting_session";

  console.log("[Agent] Creating tools and MCP servers...");
  const { tools } = createTools(config);
  const toolServer = createSdkMcpServer({ name: "pe-tools", tools });
  const externalMcpServers = buildMcpServers();
  console.log(`[Agent] MCP servers: ${Object.keys(externalMcpServers).join(", ")}`);

  const messages = createMessageGenerator();
  // messageYielder is now assigned — safe to mark session active
  sessionActive = true;

  messageYielder!(userMessage(initialPrompt));
  console.log(`[Agent] Initial prompt queued (${initialPrompt.length} chars)`);

  phoneHome("session_starting", `prompt_chars=${initialPrompt.length}`);
  console.log("[Agent] Starting Agent SDK query()...");
  const session = query({
    prompt: messages,
    options: {
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],
      maxTurns: 200,
      permissionMode: "bypassPermissions",
      mcpServers: { "pe-tools": toolServer, ...externalMcpServers },
      // Force node runtime — cli.js is a Node bundle, Bun may have compat issues
      executable: "node",
      stderr: (data: string) => {
        lastStderr = data.slice(0, 500);
        console.error(`[Agent][SDK stderr] ${data.slice(0, 300)}`);
        phoneHome("sdk_stderr", data.slice(0, 200));
      },
    },
  });
  console.log("[Agent] query() returned, starting consumption loop...");

  (async () => {
    try {
      sessionStatus = "running";
      phoneHome("session_running");
      for await (const message of session) {
        sessionMessageCount++;
        if (sessionMessageCount === 1) phoneHome("first_message");
        if (message.type === "assistant" && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === "text") {
              lastAssistantText = block.text.slice(0, 500);
              console.log(`[Agent] ${block.text.slice(0, 200)}`);
            }
            if (block.type === "tool_use") {
              lastToolCall = `${block.name}(${JSON.stringify(block.input).slice(0, 100)})`;
              console.log(`[Agent] Tool: ${block.name}`);
            }
          }
        } else if (message.type === "result") {
          const result = message as Record<string, unknown>;
          console.log(`[Agent] Result message: ${JSON.stringify(result).slice(0, 300)}`);
          phoneHome("result", JSON.stringify(result).slice(0, 200));
        }
        // Periodic phone-home every 5th message so we can track progress
        if (sessionMessageCount % 5 === 0) {
          phoneHome("progress", `msgs=${sessionMessageCount} tool=${lastToolCall.slice(0, 80)}`);
        }
      }
      console.log("[Agent] Session ended normally");
      sessionStatus = "completed";
      phoneHome("session_completed", `msgs=${sessionMessageCount}`);
    } catch (err) {
      console.error("[Agent] Session error:", err);
      sessionError = String(err);
      sessionStatus = "error";
      sessionActive = false;
      phoneHome("session_error", `${String(err).slice(0, 150)} | stderr=${lastStderr.slice(0, 100)}`);
    }
  })();
}

app.post("/event", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || key !== config.apiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const event = await c.req.json<TicketEvent>();
  console.log(`[Agent] Event: ${event.type} from ${event.source}`);

  try {
    // Capture thread_ts from event so Slack tools reply in-thread
    if (event.slackThreadTs) {
      config.slackThreadTs = event.slackThreadTs;
    }

    await cloneRepos();

    if (!sessionActive) {
      const taskType: TaskPayload["type"] =
        event.type === "ticket_created"
          ? "ticket"
          : event.type === "slack_mention"
            ? "command"
            : event.type === "feedback"
              ? "feedback"
              : "ticket";
      const taskPayload: TaskPayload = {
        type: taskType,
        product: config.product,
        repos: config.repos,
        data: event.payload as TaskPayload["data"],
      };
      const prompt = buildPrompt(taskPayload);
      await startSession(prompt);
    } else if (messageYielder) {
      const continuationPrompt = buildEventPrompt(event);
      messageYielder(userMessage(continuationPrompt));
    } else {
      return c.json({ error: "Session initializing" }, 503);
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("[Agent] Event handling error:", err);
    phoneHome("event_error", String(err).slice(0, 200));
    return c.json({ error: String(err) }, 500);
  }
});

app.get("/health", (c) =>
  c.json({ ok: true, service: "ticket-agent-container" }),
);

app.get("/status", (c) =>
  c.json({
    service: "ticket-agent-container",
    ticketId: config.ticketId,
    product: config.product,
    sessionActive,
    sessionStatus,
    sessionMessageCount,
    lastToolCall,
    lastAssistantText: lastAssistantText.slice(0, 300),
    sessionError,
    lastStderr,
    repoCloned,
  }),
);

export default {
  port: 3000,
  fetch: app.fetch,
};
