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
    test("skips files with unchanged size", async () => {
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("ok", { status: 200 })
      );
      const logSpy = spyOn(console, "log").mockImplementation(() => {});

      // Create a temp file to test with
      const tmpDir = `${process.env.HOME || "/tmp"}/.claude-test-transcripts-${Date.now()}`;
      await Bun.spawn(["mkdir", "-p", tmpDir]).exited;
      const tmpFile = `${tmpDir}/test-session.jsonl`;
      await Bun.write(tmpFile, '{"type":"test"}\n');

      // Mock findAllTranscripts to return our temp file
      const origFind = manager.findAllTranscripts.bind(manager);
      manager.findAllTranscripts = async () => [tmpFile];

      try {
        // First upload — should upload
        await manager.upload();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const firstCall = fetchSpy.mock.calls[0];
        expect(firstCall[0]).toBe("https://worker.example.com/api/internal/upload-transcript");
        const body = JSON.parse((firstCall[1] as RequestInit).body as string);
        expect(body.taskUUID).toBe("ticket-uuid-5678");
        expect(body.r2Key).toBe(`test-uuid-1234-test-session.jsonl`);

        // Second upload — same size, should skip
        // Explicitly verify the size was recorded, then check no new upload happens
        const file = Bun.file(tmpFile);
        expect(manager.getUploadedSizes().get(tmpFile)).toBe(file.size);
        fetchSpy.mockClear();
        await manager.upload();
        const uploadCalls = fetchSpy.mock.calls.filter(
          (c) => typeof c[0] === "string" && c[0].includes("upload-transcript"),
        );
        expect(uploadCalls.length).toBe(0);

        // Third upload with force — should upload despite same size
        fetchSpy.mockClear();
        await manager.upload(true);
        const forceCalls = fetchSpy.mock.calls.filter(
          (c) => typeof c[0] === "string" && c[0].includes("upload-transcript"),
        );
        expect(forceCalls.length).toBe(1);
      } finally {
        fetchSpy.mockRestore();
        logSpy.mockRestore();
        await Bun.spawn(["rm", "-rf", tmpDir]).exited;
      }
    });

    test("re-uploads when file size changes", async () => {
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("ok", { status: 200 })
      );
      const logSpy = spyOn(console, "log").mockImplementation(() => {});

      const tmpDir = `${process.env.HOME || "/tmp"}/.claude-test-transcripts-${Date.now()}`;
      await Bun.spawn(["mkdir", "-p", tmpDir]).exited;
      const tmpFile = `${tmpDir}/growing.jsonl`;
      await Bun.write(tmpFile, '{"type":"first"}\n');

      manager.findAllTranscripts = async () => [tmpFile];

      try {
        // First upload
        await manager.upload();
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Append data — size changes
        await Bun.write(tmpFile, '{"type":"first"}\n{"type":"second"}\n');
        fetchSpy.mockClear();
        await manager.upload();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
        logSpy.mockRestore();
        await Bun.spawn(["rm", "-rf", tmpDir]).exited;
      }
    });

    test("handles upload failure gracefully", async () => {
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Internal Server Error", { status: 500 })
      );
      const logSpy = spyOn(console, "log").mockImplementation(() => {});
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});

      const tmpDir = `${process.env.HOME || "/tmp"}/.claude-test-transcripts-${Date.now()}`;
      await Bun.spawn(["mkdir", "-p", tmpDir]).exited;
      const tmpFile = `${tmpDir}/fail.jsonl`;
      await Bun.write(tmpFile, '{"type":"test"}\n');

      manager.findAllTranscripts = async () => [tmpFile];

      try {
        // Should not throw
        await manager.upload();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Transcript upload failed for fail.jsonl: 500"),
        );
      } finally {
        fetchSpy.mockRestore();
        logSpy.mockRestore();
        errorSpy.mockRestore();
        await Bun.spawn(["rm", "-rf", tmpDir]).exited;
      }
    });

    test("sends correct headers including X-Internal-Key", async () => {
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("ok", { status: 200 })
      );
      const logSpy = spyOn(console, "log").mockImplementation(() => {});

      const tmpDir = `${process.env.HOME || "/tmp"}/.claude-test-transcripts-${Date.now()}`;
      await Bun.spawn(["mkdir", "-p", tmpDir]).exited;
      const tmpFile = `${tmpDir}/headers-test.jsonl`;
      await Bun.write(tmpFile, '{"type":"test"}\n');

      manager.findAllTranscripts = async () => [tmpFile];

      try {
        await manager.upload();
        const callOpts = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(callOpts.method).toBe("POST");
        expect((callOpts.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
        expect((callOpts.headers as Record<string, string>)["X-Internal-Key"]).toBe("test-api-key");
      } finally {
        fetchSpy.mockRestore();
        logSpy.mockRestore();
        await Bun.spawn(["rm", "-rf", tmpDir]).exited;
      }
    });
  });
});
