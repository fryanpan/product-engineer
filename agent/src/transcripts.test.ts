import { describe, test, expect, beforeEach, mock, afterEach, spyOn } from "bun:test";
import { TranscriptManager, type TranscriptManagerConfig } from "./transcripts";

const defaultConfig: TranscriptManagerConfig = {
  agentUuid: "test-uuid-1234",
  workerUrl: "https://worker.example.com",
  apiKey: "test-api-key",
  taskUUID: "ticket-uuid-5678",
};

describe("TranscriptManager", () => {
  let manager: TranscriptManager;

  beforeEach(() => {
    manager = new TranscriptManager(defaultConfig);
  });

  describe("constructor", () => {
    test("creates instance with provided config", () => {
      expect(manager).toBeInstanceOf(TranscriptManager);
    });

    test("initializes with empty uploaded sizes map", () => {
      expect(manager.getUploadedSizes().size).toBe(0);
    });
  });

  describe("getTranscriptDir", () => {
    test("returns path based on HOME and cwd with slashes replaced by dashes", () => {
      const dir = manager.getTranscriptDir();
      const home = process.env.HOME || "/home/agent";
      const expectedCwd = process.cwd().replace(/\//g, "-");
      expect(dir).toBe(`${home}/.claude/projects/${expectedCwd}`);
    });

    test("uses /home/agent as fallback when HOME is unset", () => {
      const originalHome = process.env.HOME;
      delete process.env.HOME;
      try {
        const dir = manager.getTranscriptDir();
        expect(dir).toStartWith("/home/agent/.claude/projects/");
      } finally {
        process.env.HOME = originalHome;
      }
    });

    test("replaces all slashes in cwd", () => {
      // The cwd will have slashes — verify they're all replaced
      const dir = manager.getTranscriptDir();
      const projectsPart = dir.split("/.claude/projects/")[1];
      expect(projectsPart).not.toContain("/");
    });
  });

  describe("findAllTranscripts", () => {
    test("returns empty array when transcript dir doesn't exist", async () => {
      // The default transcript dir won't exist in test env
      const result = await manager.findAllTranscripts();
      expect(result).toEqual([]);
    });
  });

  describe("upload", () => {
    test("handles no transcript files gracefully", async () => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      try {
        await manager.upload();
        // Should log "No transcript files found"
        expect(logSpy).toHaveBeenCalledWith(
          "[Agent] No transcript files found to upload"
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    test("force parameter is accepted", async () => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      try {
        // Should not throw with force=true
        await manager.upload(true);
        expect(logSpy).toHaveBeenCalledWith(
          "[Agent] No transcript files found to upload"
        );
      } finally {
        logSpy.mockRestore();
      }
    });
  });

  describe("uploaded size tracking", () => {
    test("getUploadedSizes returns the internal map", () => {
      const sizes = manager.getUploadedSizes();
      expect(sizes).toBeInstanceOf(Map);
    });

    test("separate instances have independent size tracking", () => {
      const manager2 = new TranscriptManager(defaultConfig);
      // Manually verify they're separate maps
      manager.getUploadedSizes().set("/fake/path.jsonl", 100);
      expect(manager2.getUploadedSizes().has("/fake/path.jsonl")).toBe(false);
    });
  });

  describe("upload with mocked findAllTranscripts", () => {
    // IMPORTANT: Bun.file().text() uses globalThis.fetch internally on CI.
    // We CANNOT mock globalThis.fetch — it breaks file reading. Instead, use
    // a real local HTTP server that captures upload requests.

    let testServer: ReturnType<typeof Bun.serve>;
    let serverUrl: string;
    let uploadRequests: Array<{ body: string; headers: Record<string, string> }>;
    let serverStatus: number;

    beforeEach(() => {
      uploadRequests = [];
      serverStatus = 200;
      testServer = Bun.serve({
        port: 0,
        fetch: async (req) => {
          if (req.url.includes("upload-transcript")) {
            const body = await req.text();
            const headers: Record<string, string> = {};
            req.headers.forEach((v, k) => { headers[k] = v; });
            uploadRequests.push({ body, headers });
            return new Response("ok", { status: serverStatus });
          }
          return new Response("not found", { status: 404 });
        },
      });
      serverUrl = `http://localhost:${testServer.port}`;
    });

    afterEach(() => {
      testServer.stop(true);
    });

    test("skips files with unchanged size", async () => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      const tmpDir = `/tmp/.claude-test-transcripts-${Date.now()}`;
      const tmpFile = `${tmpDir}/test-session.jsonl`;

      try {
        await Bun.spawn(["mkdir", "-p", tmpDir]).exited;
        await Bun.write(tmpFile, '{"type":"test"}\n');

        const localManager = new TranscriptManager({ ...defaultConfig, workerUrl: serverUrl });
        localManager.findAllTranscripts = async () => [tmpFile];

        // First upload — should upload
        await localManager.upload();
        expect(uploadRequests.length).toBe(1);
        const body = JSON.parse(uploadRequests[0].body);
        expect(body.taskUUID).toBe("ticket-uuid-5678");
        expect(body.r2Key).toBe("test-uuid-1234-test-session.jsonl");

        // Second upload — same content, should skip
        await localManager.upload();
        expect(uploadRequests.length).toBe(1);

        // Third upload with force — should upload despite same size
        await localManager.upload(true);
        expect(uploadRequests.length).toBe(2);
      } finally {
        logSpy.mockRestore();
        await Bun.spawn(["rm", "-rf", tmpDir]).exited;
      }
    });

    test("re-uploads when file size changes", async () => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      const tmpDir = `/tmp/.claude-test-transcripts-reupload-${Date.now()}`;
      const tmpFile = `${tmpDir}/growing.jsonl`;

      try {
        await Bun.spawn(["mkdir", "-p", tmpDir]).exited;
        await Bun.write(tmpFile, '{"type":"first"}\n');

        const localManager = new TranscriptManager({ ...defaultConfig, workerUrl: serverUrl });
        localManager.findAllTranscripts = async () => [tmpFile];

        await localManager.upload();
        expect(uploadRequests.length).toBe(1);

        // Append data — content length changes
        await Bun.write(tmpFile, '{"type":"first"}\n{"type":"second"}\n');
        await localManager.upload();
        expect(uploadRequests.length).toBe(2);
      } finally {
        logSpy.mockRestore();
        await Bun.spawn(["rm", "-rf", tmpDir]).exited;
      }
    });

    test("handles upload failure gracefully", async () => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const tmpDir = `/tmp/.claude-test-transcripts-fail-${Date.now()}`;
      const tmpFile = `${tmpDir}/fail.jsonl`;

      try {
        await Bun.spawn(["mkdir", "-p", tmpDir]).exited;
        await Bun.write(tmpFile, '{"type":"test"}\n');

        serverStatus = 500;
        const localManager = new TranscriptManager({ ...defaultConfig, workerUrl: serverUrl });
        localManager.findAllTranscripts = async () => [tmpFile];

        await localManager.upload();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Transcript upload failed for fail.jsonl: 500"),
        );
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        await Bun.spawn(["rm", "-rf", tmpDir]).exited;
      }
    });

    test("sends correct headers including X-Internal-Key", async () => {
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      const tmpDir = `/tmp/.claude-test-transcripts-headers-${Date.now()}`;
      const tmpFile = `${tmpDir}/headers-test.jsonl`;

      try {
        await Bun.spawn(["mkdir", "-p", tmpDir]).exited;
        await Bun.write(tmpFile, '{"type":"test"}\n');

        const localManager = new TranscriptManager({ ...defaultConfig, workerUrl: serverUrl });
        localManager.findAllTranscripts = async () => [tmpFile];

        await localManager.upload();
        expect(uploadRequests.length).toBe(1);
        expect(uploadRequests[0].headers["content-type"]).toBe("application/json");
        expect(uploadRequests[0].headers["x-internal-key"]).toBe("test-api-key");
      } finally {
        logSpy.mockRestore();
        await Bun.spawn(["rm", "-rf", tmpDir]).exited;
      }
    });
  });
});
