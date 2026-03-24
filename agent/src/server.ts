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
import { loadConfig, type TaskPayload, type TicketEvent, type MessageContent } from "./config";
import { createTools } from "./tools";
import { buildPrompt, buildEventPrompt, buildResumePrompt } from "./prompt";
import { buildMcpServers } from "./mcp";
import type { PluginPath } from "./plugins";
import { TokenTracker } from "./token-tracker";
import { TranscriptManager } from "./transcripts";
import { SlackEcho } from "./slack-echo";
import { resolveRoleConfig } from "./role-config";
import { setupWorkspace, checkAndCheckoutWorkBranch } from "./workspace-setup";
import { AgentLifecycle } from "./lifecycle";

if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN });
}

function userMessage(content: MessageContent): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "",
  };
}

// ── Configuration ────────────────────────────────────────────────────────

const app = new Hono();

console.log("[Agent] Starting server...");
console.log(`[Agent] Running as: uid=${process.getuid?.()} gid=${process.getgid?.()} HOME=${process.env.HOME}`);
console.log(`[Agent] Env check: ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? "SET" : "MISSING"}`);
console.log(`[Agent] Env check: GITHUB_TOKEN=${process.env.GITHUB_TOKEN ? "SET" : "MISSING"}`);
console.log(`[Agent] Env check: TICKET_UUID=${process.env.TICKET_UUID || "MISSING"}`);
console.log(`[Agent] Env check: PRODUCT=${process.env.PRODUCT || "MISSING"}`);
console.log(`[Agent] Env check: REPOS=${process.env.REPOS || "MISSING"}`);

const config = loadConfig();
const roleConfig = resolveRoleConfig(process.env.AGENT_ROLE, process.env.MODE);

console.log(`[Agent] Config loaded: ticket=${config.ticketUUID} product=${config.product} repos=${config.repos.join(",")} model=${config.model || "default"} role=${roleConfig.role}`);

// ── Shared instances ─────────────────────────────────────────────────────

const agentUuid = crypto.randomUUID();
console.log(`[Agent] Agent UUID: ${agentUuid}`);

const tokenTracker = new TokenTracker();
const transcriptMgr = new TranscriptManager({
  agentUuid,
  workerUrl: config.workerUrl,
  apiKey: config.apiKey,
  ticketUUID: config.ticketUUID,
});
const slackEcho = new SlackEcho({
  slackBotToken: config.slackBotToken,
  slackChannel: config.slackChannel,
  slackThreadTs: config.slackThreadTs,
  slackPersona: config.slackPersona,
});
const lifecycle = new AgentLifecycle({
  config,
  roleConfig,
  transcriptMgr,
  tokenTracker,
});

lifecycle.phoneHome(`server_started uid=${process.getuid?.()} HOME=${process.env.HOME} API_KEY=${config.apiKey ? "SET" : "MISSING"} ANTHROPIC=${process.env.ANTHROPIC_API_KEY ? "SET" : "MISSING"}`);
lifecycle.startTimers();

// ── Workspace state ──────────────────────────────────────────────────────

let workspaceReady = false;
let agentCwd = "";
let additionalDirs: string[] = [];
let loadedPlugins: PluginPath[] = [];

async function ensureWorkspace(): Promise<void> {
  if (workspaceReady) return;

  lifecycle.state.sessionStatus = "cloning";
  const result = await setupWorkspace({
    repos: config.repos,
    githubToken: config.githubToken,
    roleConfig,
    phoneHome: (msg) => lifecycle.phoneHome(msg),
  });

  agentCwd = result.agentCwd;
  additionalDirs = result.additionalDirs;
  loadedPlugins = result.plugins;
  process.chdir(agentCwd);

  workspaceReady = true;
}

// ── Message generator ────────────────────────────────────────────────────

let messageYielder: ((msg: SDKUserMessage) => void) | null = null;

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

// ── Drain buffered events ────────────────────────────────────────────────

async function drainBufferedEvents() {
  const maxWaitMs = 5000;
  const intervalMs = 100;
  let waited = 0;
  while (!messageYielder && waited < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    waited += intervalMs;
  }
  if (!messageYielder) {
    console.warn("[Agent] messageYielder not ready after 5s; skipping drain");
    return;
  }

  // ProjectAgents use a different drain endpoint than TicketAgents
  const drainUrl = roleConfig.isProjectLead
    ? `${config.workerUrl}/api/project-agent/drain-events?product=${encodeURIComponent(config.product)}`
    : `${config.workerUrl}/api/agent/${encodeURIComponent(config.ticketUUID)}/drain-events`;

  try {
    let batch = 0;
    const maxBatches = 10;
    while (batch < maxBatches) {
      const drainRes = await fetch(drainUrl, {
        headers: { "X-Internal-Key": config.apiKey },
      });
      if (!drainRes.ok) break;

      const { events } = (await drainRes.json()) as { events: TicketEvent[] };
      if (!events || events.length === 0) break;

      batch++;
      console.log(`[Agent] Drained ${events.length} buffered events (batch ${batch})`);

      for (const event of events) {
        const prompt = await buildEventPrompt(event, config.slackBotToken);
        messageYielder(userMessage(prompt));
      }
    }
  } catch (err) {
    console.warn("[Agent] Failed to drain buffered events:", err);
  }
}

// ── Session ──────────────────────────────────────────────────────────────

async function startSession(initialPrompt: MessageContent, resumeSessionId?: string) {
  if (lifecycle.state.sessionActive) return;
  lifecycle.state.sessionStatus = "starting_session";
  lifecycle.state.sessionStartTime = Date.now();
  lifecycle.state.lastMessageTime = Date.now();

  console.log("[Agent] Creating tools and MCP servers...");
  const { tools } = createTools(config);
  const toolServer = createSdkMcpServer({ name: "pe-tools", tools });
  const externalMcpServers = buildMcpServers();
  console.log(`[Agent] MCP servers: ${Object.keys(externalMcpServers).join(", ")}`);

  const messages = createMessageGenerator();
  lifecycle.state.sessionActive = true;

  messageYielder!(userMessage(initialPrompt));
  const promptLen = typeof initialPrompt === "string" ? initialPrompt.length : JSON.stringify(initialPrompt).length;
  console.log(`[Agent] Initial prompt queued (${promptLen} chars)`);

  if (resumeSessionId) {
    console.log(`[Agent] Resuming session: ${resumeSessionId}`);
  }

  lifecycle.phoneHome(`session_starting prompt_chars=${promptLen}${resumeSessionId ? ` resume=${resumeSessionId}` : ""}`);
  console.log("[Agent] Starting Agent SDK query()...");

  const queryOptions: any = {
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["project"],
    cwd: agentCwd || undefined,
    ...(additionalDirs.length > 0 ? { additionalDirectories: additionalDirs } : {}),
    maxTurns: roleConfig.maxTurns,
    permissionMode: "bypassPermissions",
    mcpServers: { "pe-tools": toolServer, ...externalMcpServers },
    ...(loadedPlugins.length > 0 ? { plugins: loadedPlugins } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    executable: "node",
    stderr: (data: string) => {
      lifecycle.state.lastStderr = data.slice(0, 500);
      console.error(`[Agent][SDK stderr] ${data.slice(0, 300)}`);
    },
    hooks: {
      SessionEnd: [{
        hooks: [async () => {
          await transcriptMgr.upload(true);
          return { continue: true };
        }],
      }],
    },
  };

  if (config.model) {
    queryOptions.model = config.model;
    console.log(`[Agent] Using model: ${config.model}`);
  }

  const session = query({ prompt: messages, options: queryOptions });
  console.log("[Agent] query() returned, starting consumption loop...");

  (async () => {
    try {
      lifecycle.state.sessionStatus = "running";
      lifecycle.phoneHome("session_running");

      for await (const message of session) {
        lifecycle.state.sessionMessageCount++;
        lifecycle.recordActivity();

        if (lifecycle.state.sessionMessageCount === 1) {
          if (message.session_id) {
            lifecycle.state.currentSessionId = message.session_id;
            console.log(`[Agent] Session ID: ${lifecycle.state.currentSessionId}`);
          }
          lifecycle.phoneHome(`first_message session_id=${lifecycle.state.currentSessionId}`);
        }

        if (message.type === "assistant" && message.message?.content) {
          let outputSnippet = "";
          for (const block of message.message.content) {
            if (block.type === "text") { outputSnippet = block.text.slice(0, 100); break; }
          }

          const usage = (message.message as any).usage;
          if (usage) {
            tokenTracker.recordTurn({
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              cacheReadTokens: usage.cache_read_input_tokens || 0,
              cacheCreationTokens: usage.cache_creation_input_tokens || 0,
              model: config.model,
              promptSnippet: lifecycle.state.lastUserPrompt.slice(0, 100),
              outputSnippet,
            });
          }

          for (const block of message.message.content) {
            if (block.type === "text") {
              lifecycle.state.lastAssistantText = block.text.slice(0, 500);
              console.log(`[Agent] ${block.text.slice(0, 200)}`);
              slackEcho.echoAssistantText(block.text);
            }
            if (block.type === "tool_use") {
              lifecycle.state.lastToolCall = `${block.name}(${JSON.stringify(block.input).slice(0, 100)})`;
              console.log(`[Agent] Tool: ${block.name}`);
              slackEcho.echoToolUse(block.name, block.input as Record<string, unknown>);
            }
          }
        } else if (message.type === "user") {
          const userMsg = message as SDKUserMessage;
          if (typeof userMsg.message.content === "string") {
            lifecycle.state.lastUserPrompt = userMsg.message.content;
          }
        } else if (message.type === "result") {
          const result = message as Record<string, unknown>;
          if (result.total_cost_usd) {
            tokenTracker.overrideCost(result.total_cost_usd as number);
          }
          console.log(`[Agent] Result message: ${JSON.stringify(result).slice(0, 300)}`);
          lifecycle.phoneHome(`result ${JSON.stringify(result).slice(0, 200)}`);
        }

        if (lifecycle.state.sessionMessageCount % 5 === 0) {
          lifecycle.phoneHome(`progress msgs=${lifecycle.state.sessionMessageCount} tool=${lifecycle.state.lastToolCall.slice(0, 80)}`);
        }
      }

      await lifecycle.handleSessionEnd();
      if (roleConfig.persistAfterSession) {
        messageYielder = null;
      }
    } catch (err) {
      await lifecycle.handleSessionError(err as Error);
      if (roleConfig.persistAfterSession) {
        messageYielder = null;
      }
    }
  })();
}

// ── HTTP routes ──────────────────────────────────────────────────────────

app.post("/event", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || key !== config.apiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const event = await c.req.json<TicketEvent>();
  console.log(`[Agent] Event: ${event.type} from ${event.source}`);
  lifecycle.recordActivity();

  try {
    if (event.slackThreadTs) {
      config.slackThreadTs = event.slackThreadTs;
      slackEcho.setThreadTs(event.slackThreadTs);
    }
    if (roleConfig.isProjectLead && event.slackChannel) {
      config.slackChannel = event.slackChannel;
    }

    await ensureWorkspace();

    if (!lifecycle.state.sessionActive) {
      // Check if this is a resume from suspended state
      let resumeSessionId: string | undefined;
      if (event.resumeTranscriptR2Key) {
        console.log(`[Agent] Resume requested: transcript=${event.resumeTranscriptR2Key}`);
        const downloadedSessionId = await transcriptMgr.download(event.resumeTranscriptR2Key);
        if (downloadedSessionId) {
          resumeSessionId = event.resumeSessionId || downloadedSessionId;
          console.log(`[Agent] Will resume session: ${resumeSessionId}`);
        } else {
          console.warn("[Agent] Transcript download failed — starting fresh session");
        }
      }

      const taskType: TaskPayload["type"] =
        event.type === "ticket_created" ? "ticket"
          : event.type === "slack_mention" || event.type === "slack_reply" ? "command"
            : event.type === "feedback" ? "feedback"
              : "ticket";

      const taskPayload: TaskPayload = {
        type: taskType,
        product: config.product,
        repos: config.repos,
        data: event.payload as TaskPayload["data"],
        ticketUUID: event.ticketUUID,
      };

      if (taskType === "ticket") {
        const ticketData = event.payload as any;
        config.ticketIdentifier = ticketData.identifier;
        config.ticketTitle = ticketData.title;
      }

      const prompt = await buildPrompt(taskPayload, config.slackBotToken, process.env.MODE, roleConfig.role);
      await startSession(prompt, resumeSessionId);
      drainBufferedEvents();
    } else if (messageYielder) {
      const continuationPrompt = await buildEventPrompt(event, config.slackBotToken);
      messageYielder(userMessage(continuationPrompt));
    } else {
      return c.json({ error: "Session initializing" }, 503);
    }

    return c.json({ ok: true });
  } catch (err) {
    console.error("[Agent] Event handling error:", err);
    lifecycle.phoneHome(`event_error ${String(err).slice(0, 200)}`);
    return c.json({ error: String(err) }, 500);
  }
});

app.get("/health", (c) =>
  c.json({ ok: true, service: "ticket-agent-container" }),
);

app.get("/status", (c) =>
  c.json({
    service: "ticket-agent-container",
    ticketUUID: config.ticketUUID,
    product: config.product,
    sessionActive: lifecycle.state.sessionActive,
    sessionStatus: lifecycle.state.sessionStatus,
    sessionMessageCount: lifecycle.state.sessionMessageCount,
    sessionError: lifecycle.state.sessionError,
    repoCloned: workspaceReady,
  }),
);

app.post("/shutdown", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || key !== config.apiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  console.log("[Agent] Shutdown requested - exiting container");
  lifecycle.phoneHome(`shutdown_requested status=${lifecycle.state.sessionStatus} msgs=${lifecycle.state.sessionMessageCount}`);
  lifecycle.stopTimers();

  const SHUTDOWN_TIMEOUT_MS = 15000;
  const shutdownWork = (async () => {
    await transcriptMgr.upload(true);
    if (lifecycle.state.sessionActive || lifecycle.state.sessionMessageCount > 0) {
      await tokenTracker.report({
        ticketUUID: config.ticketUUID,
        workerUrl: config.workerUrl,
        apiKey: config.apiKey,
        slackBotToken: config.slackBotToken,
        slackChannel: config.slackChannel,
        slackThreadTs: config.slackThreadTs,
        sessionMessageCount: lifecycle.state.sessionMessageCount,
      });
    }
  })();

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.warn(`[Agent] Shutdown work exceeded ${SHUTDOWN_TIMEOUT_MS}ms timeout`);
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
  });

  try {
    await Promise.race([shutdownWork, timeoutPromise]);
  } finally {
    setTimeout(() => process.exit(0), 100);
  }

  return c.json({ ok: true });
});

export default {
  port: 3000,
  fetch: app.fetch,
};

// ── Auto-resume ──────────────────────────────────────────────────────────

setTimeout(async () => {
  if (lifecycle.state.sessionActive) return;

  try {
    await ensureWorkspace();
    const branch = await checkAndCheckoutWorkBranch(config.ticketUUID);

    if (branch) {
      // Check orchestrator state before resuming
      try {
        const statusRes = await fetch(
          `${config.workerUrl}/api/orchestrator/ticket-status/${encodeURIComponent(config.ticketUUID)}`,
          { headers: { "X-Internal-Key": config.apiKey } },
        );
        if (statusRes.ok) {
          const ticketStatus = (await statusRes.json()) as {
            agent_active?: number;
            status?: string;
            terminal?: boolean;
          };
          if (ticketStatus.agent_active === 0 || ticketStatus.terminal) {
            console.log(`[Agent] Ticket ${config.ticketUUID} is inactive — skipping auto-resume`);
            lifecycle.phoneHome(`auto_resume_skipped reason=inactive status=${ticketStatus.status}`);
            process.exit(0);
            return;
          }
        }
      } catch (err) {
        console.warn("[Agent] Could not check orchestrator status, proceeding with resume:", err);
      }

      console.log(`[Agent] Auto-resuming from branch: ${branch}`);
      lifecycle.phoneHome(`auto_resume branch=${branch}`);

      const logProc = Bun.spawn(["git", "log", "--oneline", "-10"]);
      const gitLog = await new Response(logProc.stdout).text();
      const statusProc = Bun.spawn(["git", "status", "--short"]);
      const gitStatus = await new Response(statusProc.stdout).text();
      const prProc = Bun.spawn(["gh", "pr", "view", "--json", "url,state,title", branch]);
      const prOutput = await new Response(prProc.stdout).text();
      const prExit = await prProc.exited;
      const prInfo = prExit === 0 ? prOutput.trim() : "No PR found";

      const resumePrompt = buildResumePrompt(branch, gitLog.trim(), gitStatus.trim(), prInfo);

      // Try transcript-based session resume for full conversation history
      let autoResumeSessionId: string | undefined;
      try {
        const ticketInfoRes = await fetch(
          `${config.workerUrl}/api/orchestrator/ticket-status/${encodeURIComponent(config.ticketUUID)}`,
          { headers: { "X-Internal-Key": config.apiKey } },
        );
        if (ticketInfoRes.ok) {
          const ticketInfo = await ticketInfoRes.json() as {
            session_id?: string;
            transcript_r2_key?: string;
          };
          if (ticketInfo.transcript_r2_key) {
            const downloadedSessionId = await transcriptMgr.download(ticketInfo.transcript_r2_key);
            if (downloadedSessionId) {
              autoResumeSessionId = ticketInfo.session_id || downloadedSessionId;
              console.log(`[Agent] Auto-resume will use session: ${autoResumeSessionId}`);
            }
          }
        }
      } catch (err) {
        console.warn("[Agent] Could not fetch ticket info for transcript resume:", err);
      }

      if (config.slackChannel && config.slackBotToken) {
        await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.slackBotToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: config.slackChannel,
            text: `Container restarted — resuming work from branch \`${branch}\``,
            ...(config.slackThreadTs && { thread_ts: config.slackThreadTs }),
          }),
        }).catch((err: Error) => console.error("[Agent] Failed to post recovery message:", err));
      }

      await startSession(resumePrompt, autoResumeSessionId);
      drainBufferedEvents();
    } else {
      console.log("[Agent] No existing work branch found — waiting for event");
    }
  } catch (err) {
    console.error("[Agent] Auto-resume failed:", err);
    lifecycle.phoneHome(`auto_resume_failed ${String(err).slice(0, 200)}`);
  }
}, 5000);
