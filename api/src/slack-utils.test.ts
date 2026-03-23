import { describe, it, expect, beforeEach, afterAll, mock } from "bun:test";
import { addReaction, removeReaction } from "./slack-utils";

// Mock fetch globally
const originalFetch = globalThis.fetch;

describe("slack-utils", () => {
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }))
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  // Restore after all tests
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  const baseOpts = {
    token: "xoxb-test-token",
    channel: "C12345",
    timestamp: "1234567890.123456",
    name: "eyes",
  };

  describe("addReaction", () => {
    it("calls reactions.add with correct params", async () => {
      const result = await addReaction(baseOpts);
      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://slack.com/api/reactions.add");
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body);
      expect(body.channel).toBe("C12345");
      expect(body.timestamp).toBe("1234567890.123456");
      expect(body.name).toBe("eyes");

      expect(opts.headers.Authorization).toBe("Bearer xoxb-test-token");
    });

    it("returns true on already_reacted (idempotent)", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: false, error: "already_reacted" }), {
          headers: { "Content-Type": "application/json" },
        }))
      );
      const result = await addReaction(baseOpts);
      expect(result).toBe(true);
    });

    it("returns false on other Slack API errors", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
          headers: { "Content-Type": "application/json" },
        }))
      );
      const result = await addReaction(baseOpts);
      expect(result).toBe(false);
    });

    it("returns false on network error", async () => {
      fetchMock.mockImplementation(() => Promise.reject(new Error("network error")));
      const result = await addReaction(baseOpts);
      expect(result).toBe(false);
    });
  });

  describe("removeReaction", () => {
    it("calls reactions.remove with correct params", async () => {
      const result = await removeReaction(baseOpts);
      expect(result).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, opts] = fetchMock.mock.calls[0];
      expect(url).toBe("https://slack.com/api/reactions.remove");
      expect(opts.method).toBe("POST");
    });

    it("returns true on no_reaction (idempotent)", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: false, error: "no_reaction" }), {
          headers: { "Content-Type": "application/json" },
        }))
      );
      const result = await removeReaction(baseOpts);
      expect(result).toBe(true);
    });

    it("returns false on other Slack API errors", async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
          headers: { "Content-Type": "application/json" },
        }))
      );
      const result = await removeReaction(baseOpts);
      expect(result).toBe(false);
    });

    it("returns false on network error", async () => {
      fetchMock.mockImplementation(() => Promise.reject(new Error("timeout")));
      const result = await removeReaction(baseOpts);
      expect(result).toBe(false);
    });
  });
});
