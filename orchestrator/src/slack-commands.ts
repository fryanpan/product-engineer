/**
 * Slack event handler for agent commands.
 *
 * Listens for messages that mention the bot or use specific commands.
 * Dispatches tasks to the appropriate product's agent.
 *
 * Supports:
 * - Direct mentions: "@PE fix the login bug" in #health-tool
 * - Slash commands: /pe fix the login bug (future)
 */

import { Hono } from "hono";
import { loadRegistry } from "./registry";
import type { Bindings } from "./index";

const slackCommands = new Hono<{ Bindings: Bindings }>();

interface SlackEventPayload {
  type: string;
  challenge?: string;
  event?: {
    type: string;
    text: string;
    user: string;
    channel: string;
    thread_ts?: string;
    ts: string;
    bot_id?: string;
  };
}

// Handle Slack Events API (including URL verification challenge)
slackCommands.post("/events", async (c) => {
  // Verify Slack signing secret
  const signingSecret = c.env.SLACK_SIGNING_SECRET;
  if (signingSecret) {
    const timestamp = c.req.header("X-Slack-Request-Timestamp");
    const slackSig = c.req.header("X-Slack-Signature");
    if (!timestamp || !slackSig) {
      return c.json({ error: "Missing Slack signature headers" }, 401);
    }
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
      return c.json({ error: "Request too old" }, 401);
    }

    const rawBody = await c.req.text();
    const baseString = `v0:${timestamp}:${rawBody}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(signingSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const receivedHex = slackSig.replace("v0=", "");
    const receivedBytes = new Uint8Array(
      receivedHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)),
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      receivedBytes,
      new TextEncoder().encode(baseString),
    );
    if (!valid) {
      return c.json({ error: "Invalid Slack signature" }, 401);
    }

    const payload = JSON.parse(rawBody) as SlackEventPayload;
    return handleSlackEvent(payload, c.env);
  }

  const payload = await c.req.json<SlackEventPayload>();
  return handleSlackEvent(payload, c.env);
});

async function handleSlackEvent(payload: SlackEventPayload, env: Bindings) {
  // URL verification challenge
  if (payload.type === "url_verification") {
    return new Response(JSON.stringify({ challenge: payload.challenge }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const event = payload.event;
  if (!event || event.type !== "app_mention" || event.bot_id) {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Determine product from channel
  const registry = loadRegistry();
  let matchedProduct: string | null = null;

  for (const [name, config] of Object.entries(registry.products)) {
    if (
      config.triggers.slack?.enabled &&
      config.slack_channel === `#${event.channel}`
    ) {
      matchedProduct = name;
      break;
    }
  }

  // If channel doesn't match, try to extract product from message
  // e.g., "@PE health-tool fix the bug"
  if (!matchedProduct) {
    const words = event.text.split(/\s+/);
    for (const word of words) {
      if (registry.products[word]) {
        matchedProduct = word;
        break;
      }
    }
  }

  if (!matchedProduct) {
    // Can't determine product — respond in thread
    return new Response(
      JSON.stringify({
        ok: true,
        ignored: true,
        reason: "could not determine product",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Strip the bot mention from the text
  const cleanText = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

  const taskMessage = {
    type: "command" as const,
    product: matchedProduct,
    data: {
      text: cleanText,
      user: event.user,
      channel: event.channel,
      thread_ts: event.thread_ts || event.ts,
    },
  };

  const queue = env.TASK_QUEUE;
  await queue.send(taskMessage);

  // Acknowledge immediately — the agent will respond in the Slack thread
  return new Response(JSON.stringify({ ok: true, product: matchedProduct }), {
    headers: { "Content-Type": "application/json" },
  });
}

export { slackCommands };
