import { describe, test, expect, mock } from "bun:test";
import { resolveTranscriptKey, resolveResumeSessionId } from "./resume";
import type { TaskEvent } from "./config";

const baseEvent: TaskEvent = {
  type: "slack_reply",
  source: "slack",
  taskUUID: "task-uuid-123",
  product: "test-product",
  payload: {},
};

describe("resolveTranscriptKey", () => {
  test("returns event key when provided", async () => {
    const event = { ...baseEvent, resumeTranscriptR2Key: "event-key.jsonl" };
    const key = await resolveTranscriptKey(event, "https://worker.example.com", "task-uuid-123", "api-key");
    expect(key).toBe("event-key.jsonl");
  });

  test("falls back to conductor DB when event has no key", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ transcript_r2_key: "db-key.jsonl" }), { status: 200 }),
    );
    const key = await resolveTranscriptKey(baseEvent, "https://worker.example.com", "task-uuid-123", "api-key", fetchFn);
    expect(key).toBe("db-key.jsonl");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://worker.example.com/api/conductor/task-status/task-uuid-123",
      expect.objectContaining({ headers: { "X-Internal-Key": "api-key" } }),
    );
  });

  test("returns undefined when conductor DB has no key", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ transcript_r2_key: null }), { status: 200 }),
    );
    const key = await resolveTranscriptKey(baseEvent, "https://worker.example.com", "task-uuid-123", "api-key", fetchFn);
    expect(key).toBeUndefined();
  });

  test("returns undefined when conductor DB fetch fails", async () => {
    const fetchFn = mock(async () => { throw new Error("network error"); });
    const key = await resolveTranscriptKey(baseEvent, "https://worker.example.com", "task-uuid-123", "api-key", fetchFn);
    expect(key).toBeUndefined();
  });

  test("returns undefined when conductor returns non-ok response", async () => {
    const fetchFn = mock(async () => new Response("", { status: 500 }));
    const key = await resolveTranscriptKey(baseEvent, "https://worker.example.com", "task-uuid-123", "api-key", fetchFn);
    expect(key).toBeUndefined();
  });

  test("event key takes precedence over conductor DB", async () => {
    const fetchFn = mock(async () =>
      new Response(JSON.stringify({ transcript_r2_key: "db-key.jsonl" }), { status: 200 }),
    );
    const event = { ...baseEvent, resumeTranscriptR2Key: "event-key.jsonl" };
    const key = await resolveTranscriptKey(event, "https://worker.example.com", "task-uuid-123", "api-key", fetchFn);
    expect(key).toBe("event-key.jsonl");
    // Should NOT hit the conductor DB when event has a key
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("resolveResumeSessionId", () => {
  test("returns downloaded session ID from transcript", async () => {
    const transcriptMgr = { download: mock(async (_key: string) => "session-abc-123") };
    const sessionId = await resolveResumeSessionId("some-key.jsonl", transcriptMgr);
    expect(sessionId).toBe("session-abc-123");
    expect(transcriptMgr.download).toHaveBeenCalledWith("some-key.jsonl");
  });

  test("returns undefined when download returns null", async () => {
    const transcriptMgr = { download: mock(async (_key: string) => null) };
    const sessionId = await resolveResumeSessionId("bad-key.jsonl", transcriptMgr);
    expect(sessionId).toBeUndefined();
  });

  test("returns undefined when download returns empty string", async () => {
    const transcriptMgr = { download: mock(async (_key: string) => "") };
    const sessionId = await resolveResumeSessionId("bad-key.jsonl", transcriptMgr);
    expect(sessionId).toBeUndefined();
  });
});
