import { describe, test, expect, beforeEach } from "bun:test";
import { Hono } from "hono";

/**
 * Tests for the upload-transcript endpoint's associatedTaskUUID feature.
 *
 * Since the route is defined inline in index.ts (not a separate module),
 * we recreate a minimal version of the route here that mirrors the production logic.
 */

// Track calls to the mock conductor
let conductorCalls: { url: string; body: unknown }[] = [];

// Track calls to the mock R2 bucket
let r2Puts: { key: string; metadata: unknown }[] = [];

function timingSafeEqual(a: string, b: string): boolean {
  return a === b; // Simplified for testing
}

function makeApp() {
  const app = new Hono<{
    Bindings: {
      API_KEY: string;
      TRANSCRIPTS: { put: (key: string, body: string, opts: unknown) => Promise<void> };
      CONDUCTOR: {
        idFromName: (name: string) => string;
        get: (id: string) => { fetch: (req: Request) => Promise<Response> };
      };
    };
  }>();

  app.post("/api/internal/upload-transcript", async (c) => {
    const key = c.req.header("X-Internal-Key");
    if (!key || !timingSafeEqual(key, c.env.API_KEY)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = await c.req.json<{
      taskUUID: string;
      r2Key: string;
      transcript: string;
      associatedTaskUUID?: string;
    }>();
    const { taskUUID, associatedTaskUUID } = body;
    const { r2Key, transcript } = body;

    if (!taskUUID) {
      return c.json({ error: "Missing taskUUID" }, 400);
    }

    try {
      await c.env.TRANSCRIPTS.put(r2Key, transcript, {
        httpMetadata: { contentType: "application/x-ndjson" },
        customMetadata: { taskUUID, uploadedAt: new Date().toISOString() },
      });

      const id = c.env.CONDUCTOR.idFromName("main");
      const conductor = c.env.CONDUCTOR.get(id);
      await conductor.fetch(new Request("http://internal/ticket/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskUUID, transcript_r2_key: r2Key }),
      }));

      if (associatedTaskUUID && associatedTaskUUID !== taskUUID) {
        await conductor.fetch(new Request("http://internal/ticket/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskUUID: associatedTaskUUID, transcript_r2_key: r2Key }),
        }));
        console.log(`[Worker] Transcript also associated with task=${associatedTaskUUID}`);
      }

      return c.json({ ok: true, r2Key });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  return app;
}

function makeEnv() {
  return {
    API_KEY: "test-api-key",
    TRANSCRIPTS: {
      put: async (key: string, _body: string, opts: unknown) => {
        r2Puts.push({ key, metadata: opts });
      },
    },
    CONDUCTOR: {
      idFromName: (_name: string) => "mock-id",
      get: (_id: string) => ({
        fetch: async (req: Request) => {
          const url = new URL(req.url);
          const body = await req.json();
          conductorCalls.push({ url: url.pathname, body });
          return Response.json({ ok: true });
        },
      }),
    },
  };
}

describe("upload-transcript endpoint", () => {
  let app: ReturnType<typeof makeApp>;

  beforeEach(() => {
    conductorCalls = [];
    r2Puts = [];
    app = makeApp();
  });

  async function postUpload(body: unknown, apiKey = "test-api-key") {
    return app.request(
      "/api/internal/upload-transcript",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": apiKey,
        },
        body: JSON.stringify(body),
      },
      makeEnv(),
    );
  }

  test("basic upload without associatedTaskUUID sends one conductor call", async () => {
    const res = await postUpload({
      taskUUID: "task-123",
      r2Key: "key-abc",
      transcript: '{"line":1}\n',
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, r2Key: "key-abc" });

    // Only one conductor call (for the primary task)
    expect(conductorCalls.length).toBe(1);
    expect(conductorCalls[0].body).toEqual({
      taskUUID: "task-123",
      transcript_r2_key: "key-abc",
    });
  });

  test("upload with associatedTaskUUID sends two conductor calls", async () => {
    const res = await postUpload({
      taskUUID: "project-lead-myapp",
      r2Key: "key-def",
      transcript: '{"line":1}\n',
      associatedTaskUUID: "child-task-456",
    });

    expect(res.status).toBe(200);

    // Two conductor calls: one for the primary, one for the associated
    expect(conductorCalls.length).toBe(2);
    expect(conductorCalls[0].body).toEqual({
      taskUUID: "project-lead-myapp",
      transcript_r2_key: "key-def",
    });
    expect(conductorCalls[1].body).toEqual({
      taskUUID: "child-task-456",
      transcript_r2_key: "key-def",
    });
  });

  test("upload with associatedTaskUUID same as taskUUID sends only one conductor call", async () => {
    const res = await postUpload({
      taskUUID: "task-123",
      r2Key: "key-ghi",
      transcript: '{"line":1}\n',
      associatedTaskUUID: "task-123", // Same as taskUUID
    });

    expect(res.status).toBe(200);

    // Only one call — the guard prevents a duplicate
    expect(conductorCalls.length).toBe(1);
    expect(conductorCalls[0].body).toEqual({
      taskUUID: "task-123",
      transcript_r2_key: "key-ghi",
    });
  });

  test("upload without associatedTaskUUID field sends only one conductor call", async () => {
    const res = await postUpload({
      taskUUID: "task-789",
      r2Key: "key-jkl",
      transcript: '{"line":1}\n',
      // No associatedTaskUUID at all
    });

    expect(res.status).toBe(200);
    expect(conductorCalls.length).toBe(1);
  });

  test("rejects unauthorized requests", async () => {
    const res = await postUpload(
      { taskUUID: "task-123", r2Key: "k", transcript: "t" },
      "wrong-key",
    );
    expect(res.status).toBe(401);
    expect(conductorCalls.length).toBe(0);
  });

  test("rejects requests without taskUUID", async () => {
    const res = await postUpload({
      r2Key: "k",
      transcript: "t",
    });
    expect(res.status).toBe(400);
    expect(conductorCalls.length).toBe(0);
  });

  test("R2 put is called with correct key and metadata", async () => {
    await postUpload({
      taskUUID: "task-123",
      r2Key: "my-r2-key",
      transcript: '{"data":true}\n',
    });

    expect(r2Puts.length).toBe(1);
    expect(r2Puts[0].key).toBe("my-r2-key");
    expect(r2Puts[0].metadata).toEqual({
      httpMetadata: { contentType: "application/x-ndjson" },
      customMetadata: { taskUUID: "task-123", uploadedAt: expect.any(String) },
    });
  });
});
