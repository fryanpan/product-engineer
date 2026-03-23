/**
 * Slack API utility helpers — reactions, message posting, etc.
 * Designed for fast-ack patterns (e.g., 👀 on event receipt).
 */

export interface SlackReactionOptions {
  token: string;
  channel: string;
  timestamp: string;
  name: string; // Reaction name without colons, e.g. "eyes"
}

/**
 * Add a reaction to a Slack message. Non-throwing — logs errors.
 * Used for fast-ack patterns: immediately react to show receipt.
 */
export async function addReaction(opts: SlackReactionOptions): Promise<boolean> {
  try {
    const res = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: opts.channel,
        timestamp: opts.timestamp,
        name: opts.name,
      }),
    });

    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) {
      // "already_reacted" is not an error — idempotent behavior
      if (data.error === "already_reacted") return true;
      console.warn(`[slack-utils] addReaction failed: ${data.error}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[slack-utils] addReaction error:", err);
    return false;
  }
}

/**
 * Remove a reaction from a Slack message. Non-throwing — logs errors.
 * Used to clear fast-ack reactions after processing completes.
 */
export async function removeReaction(opts: SlackReactionOptions): Promise<boolean> {
  try {
    const res = await fetch("https://slack.com/api/reactions.remove", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: opts.channel,
        timestamp: opts.timestamp,
        name: opts.name,
      }),
    });

    const data = await res.json() as { ok: boolean; error?: string };
    if (!data.ok) {
      // "no_reaction" is not an error — idempotent behavior
      if (data.error === "no_reaction") return true;
      console.warn(`[slack-utils] removeReaction failed: ${data.error}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[slack-utils] removeReaction error:", err);
    return false;
  }
}
