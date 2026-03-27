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
      const logSpy = spyOn(console, "log").mockImplementation(() => {});

      // Use /tmp for temp files
      const tmpDir = `/tmp/.claude-test-transcripts-${Date.now()}`;
      const tmpFile = `${tmpDir}/test-session.jsonl`;
      const fileContent = '{"type":"test"}\n';

      try {
        await Bun.spawn(["mkdir", "-p", tmpDir]).exited;
        await Bun.write(tmpFile, fileContent);

        manager.findAllTranscripts = async () => [tmpFile];

        // IMPORTANT: Bun.file().text() uses globalThis.fetch internally on some
        // platforms. Mock fetch AFTER file write and use mockImplementation that
        // passes through file:// URLs so Bun.file().text() still works.
        const originalFetch = globalThis.fetch;
        const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: any) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.includes("upload-transcript")) {
            fetchCalls.push({ url, init });
            return new Response("ok", { status: 200 });
          }
          // Pass through non-upload calls (including Bun internal file reads)
          return originalFetch(input, init);
        }) as typeof fetch);

        // First upload — should upload (content length > 0, prev size = 0)
        await manager.upload();
        expect(fetchCalls.length).toBe(1);
        expect(fetchCalls[0].url).toBe("https://worker.example.com/api/internal/upload-transcript");
        const body = JSON.parse(fetchCalls[0].init?.body as string);
        expect(body.taskUUID).toBe("ticket-uuid-5678");
        expect(body.r2Key).toBe(`test-uuid-1234-test-session.jsonl`);

        // Second upload — same content, should skip
        const countBefore = fetchCalls.length;
        await manager.upload();
        expect(fetchCalls.length).toBe(countBefore);

        // Third upload with force — should upload despite same size
        await manager.upload(true);
        expect(fetchCalls.length).toBe(countBefore + 1);

        fetchSpy.mockRestore();
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

        manager.findAllTranscripts = async () => [tmpFile];

        const originalFetch = globalThis.fetch;
        const uploadCalls: string[] = [];
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: any) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.includes("upload-transcript")) {
            uploadCalls.push(url);
            return new Response("ok", { status: 200 });
          }
          return originalFetch(input, init);
        }) as typeof fetch);

        // First upload
        await manager.upload();
        expect(uploadCalls.length).toBe(1);

        // Append data — content length changes
        fetchSpy.mockRestore();
        await Bun.write(tmpFile, '{"type":"first"}\n{"type":"second"}\n');
        const fetchSpy2 = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: any) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.includes("upload-transcript")) {
            uploadCalls.push(url);
            return new Response("ok", { status: 200 });
          }
          return originalFetch(input, init);
        }) as typeof fetch);

        await manager.upload();
        expect(uploadCalls.length).toBe(2);

        fetchSpy2.mockRestore();
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

        manager.findAllTranscripts = async () => [tmpFile];

        const originalFetch = globalThis.fetch;
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: any) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.includes("upload-transcript")) {
            return new Response("Internal Server Error", { status: 500 });
          }
          return originalFetch(input, init);
        }) as typeof fetch);

        await manager.upload();
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Transcript upload failed for fail.jsonl: 500"),
        );

        fetchSpy.mockRestore();
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

        manager.findAllTranscripts = async () => [tmpFile];

        const originalFetch = globalThis.fetch;
        let capturedInit: RequestInit | undefined;
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any, init?: any) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.includes("upload-transcript")) {
            capturedInit = init;
            return new Response("ok", { status: 200 });
          }
          return originalFetch(input, init);
        }) as typeof fetch);

        await manager.upload();
        expect(capturedInit).toBeDefined();
        expect(capturedInit!.method).toBe("POST");
        expect((capturedInit!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
        expect((capturedInit!.headers as Record<string, string>)["X-Internal-Key"]).toBe("test-api-key");

        fetchSpy.mockRestore();
      } finally {
        logSpy.mockRestore();
        await Bun.spawn(["rm", "-rf", tmpDir]).exited;
      }
    });
  });
});
