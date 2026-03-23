/**
 * StatusUpdater — extracted from the update_task_status tool handler in tools.ts.
 *
 * Manages status propagation to three systems:
 * 1. Orchestrator (internal API)
 * 2. Linear (GraphQL)
 * 3. Slack (chat.update on the top-level thread message)
 */

export interface StatusUpdaterConfig {
  workerUrl: string;
  apiKey: string;
  ticketUUID: string;
  slackBotToken: string;
  slackChannel: string;
  slackThreadTs?: string;
  linearAppToken?: string;
  ticketIdentifier?: string;
  ticketTitle?: string;
  fetchFn?: typeof fetch;
}

const LINEAR_STATE_MAP: Record<string, string> = {
  in_progress: "In Progress",
  pr_open: "In Review",
  in_review: "In Review",
  needs_revision: "In Progress",
  merged: "Done",
  closed: "Done",
  deferred: "Canceled",
  failed: "Canceled",
  asking: "In Progress",
  needs_info: "In Progress",
};

export class StatusUpdater {
  private config: StatusUpdaterConfig;

  constructor(config: StatusUpdaterConfig) {
    this.config = config;
  }

  /** Update the Slack thread timestamp (called when first Slack message creates a thread). */
  setSlackThreadTs(ts: string): void {
    this.config.slackThreadTs = ts;
  }

  /** Use explicit fetchFn if provided, otherwise fall back to globalThis.fetch at call time. */
  private get fetch(): typeof fetch {
    return this.config.fetchFn || globalThis.fetch;
  }

  /**
   * POST status to the orchestrator's internal status endpoint.
   */
  async updateOrchestrator(status: string, pr_url?: string): Promise<void> {
    try {
      await this.fetch(`${this.config.workerUrl}/api/internal/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": this.config.apiKey,
        },
        body: JSON.stringify({
          ticketUUID: this.config.ticketUUID,
          status,
          pr_url,
          branch_name: undefined,
        }),
      });
    } catch (err) {
      console.error("[StatusUpdater] Failed to update orchestrator status:", err);
    }
  }

  /**
   * Update the Linear ticket's workflow state via GraphQL.
   * Skips if no linearAppToken is configured.
   */
  async updateLinear(status: string, ticketId: string): Promise<void> {
    if (!this.config.linearAppToken) return;

    const linearState = LINEAR_STATE_MAP[status] || "In Progress";

    try {
      // Look up workflow states for the issue's team
      const stateRes = await this.fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.linearAppToken}`,
        },
        body: JSON.stringify({
          query: `query($issueId: String!) {
            issue(id: $issueId) {
              team { states { nodes { id name } } }
            }
          }`,
          variables: { issueId: ticketId },
        }),
      });

      const stateData = (await stateRes.json()) as {
        data?: {
          issue?: {
            team?: { states?: { nodes?: { id: string; name: string }[] } };
          };
        };
      };
      const states = stateData.data?.issue?.team?.states?.nodes || [];
      const targetState = states.find((s) => s.name === linearState);

      if (!targetState) {
        console.warn(
          `[StatusUpdater] Could not find Linear state "${linearState}" for ticket ${ticketId}`,
        );
        return;
      }

      await this.fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.linearAppToken}`,
        },
        body: JSON.stringify({
          query: `mutation($issueId: String!, $stateId: String!) {
            issueUpdate(id: $issueId, input: { stateId: $stateId }) {
              success
              issue { id state { name } }
            }
          }`,
          variables: {
            issueId: ticketId,
            stateId: targetState.id,
          },
        }),
      });

      console.log(
        `[StatusUpdater] Updated Linear ticket ${ticketId} to ${linearState}`,
      );
    } catch (err) {
      console.error("[StatusUpdater] Failed to update Linear ticket:", err);
    }
  }

  /**
   * Update the top-level Slack message with a status emoji and text.
   * Skips if no slackThreadTs is configured.
   */
  async updateSlackStatus(status: string): Promise<void> {
    if (!this.config.slackThreadTs) return;

    try {
      let statusEmoji = "⏳";
      let statusText = status.replace(/_/g, " ").toUpperCase();

      if (["merged", "closed"].includes(status)) {
        statusEmoji = "✅";
        statusText = "DONE";
      } else if (status === "pr_open" || status === "in_review") {
        statusEmoji = "👀";
        statusText = "IN REVIEW";
      } else if (status === "failed") {
        statusEmoji = "❌";
        statusText = "FAILED";
      }

      const ticketIdentifier =
        this.config.ticketIdentifier || this.config.ticketUUID;
      let briefSummary = this.config.ticketTitle || "Working on task";

      if (briefSummary.length > 100) {
        const firstSentence = briefSummary.match(/^[^.!?]+[.!?]/);
        briefSummary = firstSentence
          ? firstSentence[0]
          : briefSummary.slice(0, 100) + "...";
      }

      const updatedText = `${statusEmoji} ${statusText} - ${ticketIdentifier}: ${briefSummary}`;

      const res = await this.fetch("https://slack.com/api/chat.update", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.slackBotToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: this.config.slackChannel,
          ts: this.config.slackThreadTs,
          text: updatedText,
        }),
      });

      if (!res.ok) {
        console.error(
          `[StatusUpdater] Slack update failed: ${res.status}`,
        );
        return;
      }

      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        console.error(
          `[StatusUpdater] Slack update error: ${data.error}`,
        );
      } else {
        console.log(
          `[StatusUpdater] Updated Slack thread ${this.config.slackThreadTs} with status: ${status}`,
        );
      }
    } catch (err) {
      console.error("[StatusUpdater] Failed to update Slack message:", err);
    }
  }

  /**
   * Run all three status updates in parallel.
   */
  async updateAll(
    status: string,
    opts?: { pr_url?: string; linearTicketId?: string },
  ): Promise<void> {
    const ticketId = opts?.linearTicketId || this.config.ticketUUID;

    await Promise.all([
      this.updateOrchestrator(status, opts?.pr_url),
      this.updateLinear(status, ticketId),
      this.updateSlackStatus(status),
    ]);
  }
}
