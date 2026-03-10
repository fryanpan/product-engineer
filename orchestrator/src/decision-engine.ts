/**
 * Decision Engine — renders Mustache templates, calls Anthropic API,
 * parses JSON responses, logs decisions to 4 destinations.
 */

import Mustache from "mustache";
import type { DecisionResponse, DecisionLog } from "./types";

// Import templates as text (Cloudflare Workers text module rule / Bun loader)
import ticketReviewTemplate from "./prompts/ticket-review.mustache";
import mergeGateTemplate from "./prompts/merge-gate.mustache";
import supervisorTemplate from "./prompts/supervisor.mustache";
import threadClassifyTemplate from "./prompts/thread-classify.mustache";

const TEMPLATES: Record<string, string> = {
  "ticket-review": ticketReviewTemplate,
  "merge-gate": mergeGateTemplate,
  "supervisor": supervisorTemplate,
  "thread-classify": threadClassifyTemplate,
};

// Decision model: Haiku for speed on triage/classify, Sonnet for merge quality
const DECISION_MODELS: Record<string, string> = {
  "ticket-review": "claude-haiku-4-5-20251001",
  "merge-gate": "claude-sonnet-4-6",
  "supervisor": "claude-haiku-4-5-20251001",
  "thread-classify": "claude-haiku-4-5-20251001",
};

export interface DecisionEngineConfig {
  anthropicApiKey: string;
  anthropicBaseUrl?: string; // For AI Gateway
  slackBotToken: string;
  decisionsChannel: string;
  linearAppToken: string;
}

export class DecisionEngine {
  private config: DecisionEngineConfig;

  constructor(config: DecisionEngineConfig) {
    this.config = config;
  }

  /** Render a Mustache template with the given data */
  renderTemplate(name: string, data: Record<string, unknown>): string {
    const template = TEMPLATES[name];
    if (!template) throw new Error(`Unknown template: ${name}`);
    return Mustache.render(template, data);
  }

  /** Parse JSON from LLM response, handling markdown code fences */
  parseDecisionResponse(text: string): DecisionResponse {
    let jsonStr = text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }
    return JSON.parse(jsonStr);
  }

  /** Call Anthropic API with a rendered prompt and parse the JSON response */
  async makeDecision(
    templateName: string,
    context: Record<string, unknown>,
  ): Promise<DecisionResponse> {
    const prompt = this.renderTemplate(templateName, context);
    const model = DECISION_MODELS[templateName] || "claude-haiku-4-5-20251001";
    const baseUrl = this.config.anthropicBaseUrl || "https://api.anthropic.com";

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };

    const textBlock = data.content.find((b) => b.type === "text");
    if (!textBlock) throw new Error("No text in Anthropic response");

    return this.parseDecisionResponse(textBlock.text);
  }

  /** Log a decision to all 4 destinations */
  async logDecision(
    log: DecisionLog,
    opts: {
      sqlExec: (sql: string, ...params: unknown[]) => void;
      slackChannel?: string;
      slackThreadTs?: string;
      linearIssueId?: string;
    },
  ): Promise<void> {
    // 1. SQLite
    opts.sqlExec(
      `INSERT INTO decision_log (id, timestamp, type, ticket_id, context_summary, action, reason, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      log.id,
      log.timestamp,
      log.type,
      log.ticket_id,
      log.context_summary,
      log.action,
      log.reason,
      log.confidence,
    );

    // Format for Slack
    const emoji =
      log.type === "ticket_review"
        ? "\uD83C\uDFAB"
        : log.type === "merge_gate"
          ? "\u2705"
          : "\uD83D\uDC41\uFE0F";
    const typeLabel = log.type
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    const slackText = `${emoji} *${typeLabel}*${log.ticket_id ? ` \u2014 \`${log.ticket_id}\`` : ""}\n*Action:* ${log.action}\n*Reason:* ${log.reason}`;

    // 2. #product-engineer-decisions channel
    await this.postSlack(this.config.decisionsChannel, slackText).catch(
      (err) =>
        console.error(
          "[DecisionEngine] Failed to post to decisions channel:",
          err,
        ),
    );

    // 3. Ticket Slack thread
    if (opts.slackChannel && opts.slackThreadTs) {
      await this.postSlack(
        opts.slackChannel,
        slackText,
        opts.slackThreadTs,
      ).catch((err) =>
        console.error(
          "[DecisionEngine] Failed to post to ticket thread:",
          err,
        ),
      );
    }

    // 4. Linear comment
    if (opts.linearIssueId && this.config.linearAppToken) {
      await this.postLinearComment(
        opts.linearIssueId,
        `${emoji} **${typeLabel}**\n**Action:** ${log.action}\n**Reason:** ${log.reason}`,
      ).catch((err) =>
        console.error("[DecisionEngine] Failed to post Linear comment:", err),
      );
    }
  }

  private async postSlack(channel: string, text: string, threadTs?: string) {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.slackBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel,
        text,
        ...(threadTs && { thread_ts: threadTs }),
      }),
    });
  }

  private async postLinearComment(issueId: string, body: string) {
    await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.linearAppToken}`,
      },
      body: JSON.stringify({
        query: `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
        variables: { issueId, body },
      }),
    });
  }
}
