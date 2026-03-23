import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import type { RoleConfig } from "./role-config";

// Track spawned commands and written files for assertions
let spawnCalls: { cmd: string[]; exitCode: number; stdout?: string }[] = [];
let writtenFiles: Map<string, string>;
let globResults: string[];
let fileContents: Map<string, string>;

// Stub Bun.spawn
const originalSpawn = Bun.spawn;
function mockSpawn(cmd: string[]) {
  // Find matching mock entry by command prefix
  const entry = spawnCalls.find(
    (e) => JSON.stringify(e.cmd) === JSON.stringify(cmd),
  );
  const exitCode = entry?.exitCode ?? 0;
  const stdout = entry?.stdout ?? "";

  return {
    exited: Promise.resolve(exitCode),
    stdout: new Response(stdout).body,
    stderr: new Response("").body,
  };
}

// Stub Bun.write
const originalWrite = Bun.write;
async function mockWrite(path: string, content: string) {
  writtenFiles.set(path, content);
  return content.length;
}

// Stub Bun.file
const originalFile = Bun.file;
function mockFile(path: string) {
  return {
    text: async () => fileContents.get(path) ?? "",
    exists: async () => fileContents.has(path),
    json: async () => JSON.parse(fileContents.get(path) ?? "{}"),
  };
}

// Stub Bun.Glob
class MockGlob {
  pattern: string;
  constructor(pattern: string) {
    this.pattern = pattern;
  }
  *scan(_opts: { cwd: string }) {
    for (const entry of globResults) {
      yield entry;
    }
  }
}

// We need to apply mocks before importing the module under test.
// Use a lazy import pattern so mocks are in place.
let injectSkills: typeof import("./workspace-setup").injectSkills;
let checkAndCheckoutWorkBranch: typeof import("./workspace-setup").checkAndCheckoutWorkBranch;
let setupWorkspace: typeof import("./workspace-setup").setupWorkspace;

beforeEach(async () => {
  spawnCalls = [];
  writtenFiles = new Map();
  globResults = [];
  fileContents = new Map();

  // Apply stubs
  // @ts-ignore - overriding for test
  Bun.spawn = mockSpawn;
  // @ts-ignore
  Bun.write = mockWrite;
  // @ts-ignore
  Bun.file = mockFile;
  // @ts-ignore
  Bun.Glob = MockGlob;

  // Re-import to get fresh module with mocks
  const mod = await import("./workspace-setup");
  injectSkills = mod.injectSkills;
  checkAndCheckoutWorkBranch = mod.checkAndCheckoutWorkBranch;
  setupWorkspace = mod.setupWorkspace;
});

function makeRoleConfig(overrides: Partial<RoleConfig> = {}): RoleConfig {
  return {
    role: "ticket-agent",
    isProjectLead: false,
    isConductor: false,
    maxTurns: 200,
    sessionTimeoutMs: 7200000,
    idleTimeoutMs: 300000,
    persistAfterSession: false,
    exitOnError: true,
    peRepoRequired: false,
    peRepo: "fryanpan/product-engineer",
    ...overrides,
  };
}

// ─── injectSkills ────────────────────────────────────────────────────────────

describe("injectSkills", () => {
  it("copies entire skill folders into target directory", async () => {
    globResults = ["product-engineer/SKILL.md", "task-retro/SKILL.md"];

    // Register expected spawn calls for cp -r (whole folder copy)
    spawnCalls.push({
      cmd: ["cp", "-r", "/app/src/skills/product-engineer", "/target/.claude/skills/product-engineer"],
      exitCode: 0,
    });
    spawnCalls.push({
      cmd: ["cp", "-r", "/app/src/skills/task-retro", "/target/.claude/skills/task-retro"],
      exitCode: 0,
    });

    const names = await injectSkills("/target/.claude/skills");

    expect(names).toEqual(["product-engineer", "task-retro"]);
  });

  it("uses custom source directory when provided", async () => {
    globResults = ["my-skill/SKILL.md"];

    spawnCalls.push({
      cmd: ["cp", "-r", "/custom/skills/my-skill", "/out/my-skill"],
      exitCode: 0,
    });

    const names = await injectSkills("/out", "/custom/skills");

    expect(names).toEqual(["my-skill"]);
  });

  it("returns empty array when no skills found", async () => {
    globResults = [];
    const names = await injectSkills("/target/.claude/skills");
    expect(names).toEqual([]);
  });
});

// ─── checkAndCheckoutWorkBranch ──────────────────────────────────────────────

describe("checkAndCheckoutWorkBranch", () => {
  it("checks out ticket branch when found on remote", async () => {
    const uuid = "abc-123";
    spawnCalls.push({
      cmd: ["git", "ls-remote", "--heads", "origin", `ticket/${uuid}`],
      exitCode: 0,
      stdout: "deadbeef refs/heads/ticket/abc-123\n",
    });
    spawnCalls.push({
      cmd: ["git", "checkout", `ticket/${uuid}`],
      exitCode: 0,
    });

    const branch = await checkAndCheckoutWorkBranch(uuid);
    expect(branch).toBe("ticket/abc-123");
  });

  it("falls back to feedback branch if ticket branch not found", async () => {
    const uuid = "def-456";
    // ticket/ branch not found
    spawnCalls.push({
      cmd: ["git", "ls-remote", "--heads", "origin", `ticket/${uuid}`],
      exitCode: 0,
      stdout: "",
    });
    // feedback/ branch found
    spawnCalls.push({
      cmd: ["git", "ls-remote", "--heads", "origin", `feedback/${uuid}`],
      exitCode: 0,
      stdout: "cafebabe refs/heads/feedback/def-456\n",
    });
    spawnCalls.push({
      cmd: ["git", "checkout", `feedback/${uuid}`],
      exitCode: 0,
    });

    const branch = await checkAndCheckoutWorkBranch(uuid);
    expect(branch).toBe("feedback/def-456");
  });

  it("creates tracking branch when local checkout fails", async () => {
    const uuid = "ghi-789";
    spawnCalls.push({
      cmd: ["git", "ls-remote", "--heads", "origin", `ticket/${uuid}`],
      exitCode: 0,
      stdout: "abcd1234 refs/heads/ticket/ghi-789\n",
    });
    // Local checkout fails (branch doesn't exist locally)
    spawnCalls.push({
      cmd: ["git", "checkout", `ticket/${uuid}`],
      exitCode: 1,
    });
    // Create tracking branch
    spawnCalls.push({
      cmd: ["git", "checkout", "-b", `ticket/${uuid}`, `origin/ticket/${uuid}`],
      exitCode: 0,
    });

    const branch = await checkAndCheckoutWorkBranch(uuid);
    expect(branch).toBe("ticket/ghi-789");
  });

  it("returns null when no branch found", async () => {
    const uuid = "none-000";
    spawnCalls.push({
      cmd: ["git", "ls-remote", "--heads", "origin", `ticket/${uuid}`],
      exitCode: 0,
      stdout: "",
    });
    spawnCalls.push({
      cmd: ["git", "ls-remote", "--heads", "origin", `feedback/${uuid}`],
      exitCode: 0,
      stdout: "",
    });

    const branch = await checkAndCheckoutWorkBranch(uuid);
    expect(branch).toBeNull();
  });
});

// ─── setupWorkspace ──────────────────────────────────────────────────────────

describe("setupWorkspace", () => {
  it("ticket-agent: cwd is first target repo, no additionalDirs", async () => {
    const phoneHome = mock(() => {});
    globResults = [];

    // Register clone commands
    spawnCalls.push({
      cmd: ["git", "clone", "https://github.com/org/my-app.git", "/workspace/my-app"],
      exitCode: 0,
    });

    const result = await setupWorkspace({
      repos: ["org/my-app"],
      roleConfig: makeRoleConfig(),
      phoneHome,
    });

    expect(result.agentCwd).toBe("/workspace/my-app");
    expect(result.additionalDirs).toEqual([]);
    expect(phoneHome).toHaveBeenCalledWith("clone_done repo=my-app");
    expect(phoneHome).toHaveBeenCalledWith("loading_plugins");
  });

  it("project-lead: cwd is PE repo, additionalDirs are target repos", async () => {
    const phoneHome = mock(() => {});
    globResults = [];

    // PE repo clone
    spawnCalls.push({
      cmd: [
        "git", "clone",
        "https://github.com/fryanpan/product-engineer.git",
        "/workspace/product-engineer",
      ],
      exitCode: 0,
    });
    // Target repo clone
    spawnCalls.push({
      cmd: [
        "git", "clone",
        "https://github.com/org/target-app.git",
        "/workspace/target-app",
      ],
      exitCode: 0,
    });

    const result = await setupWorkspace({
      repos: ["org/target-app"],
      roleConfig: makeRoleConfig({
        role: "project-lead",
        isProjectLead: true,
        peRepo: "fryanpan/product-engineer",
        peRepoRequired: true,
      }),
      phoneHome,
    });

    expect(result.agentCwd).toBe("/workspace/product-engineer");
    expect(result.additionalDirs).toEqual(["/workspace/target-app"]);
  });

  it("project-lead: does not duplicate PE repo if already in repos list", async () => {
    const phoneHome = mock(() => {});
    globResults = [];

    spawnCalls.push({
      cmd: [
        "git", "clone",
        "https://github.com/fryanpan/product-engineer.git",
        "/workspace/product-engineer",
      ],
      exitCode: 0,
    });

    const result = await setupWorkspace({
      repos: ["fryanpan/product-engineer"],
      roleConfig: makeRoleConfig({
        role: "project-lead",
        isProjectLead: true,
        peRepo: "fryanpan/product-engineer",
      }),
      phoneHome,
    });

    expect(result.agentCwd).toBe("/workspace/product-engineer");
    // PE repo is in repos, but since it IS the PE repo, it's not an additional dir
    expect(result.additionalDirs).toEqual([]);
  });

  it("returns empty workspace when no repos configured", async () => {
    const phoneHome = mock(() => {});
    globResults = [];

    const result = await setupWorkspace({
      repos: [],
      roleConfig: makeRoleConfig(),
      phoneHome,
    });

    expect(result.agentCwd).toBe("/workspace");
    expect(result.additionalDirs).toEqual([]);
    expect(result.plugins).toEqual([]);
  });

  it("sets up .netrc when githubToken is provided", async () => {
    const phoneHome = mock(() => {});
    globResults = [];

    // chmod for .netrc
    spawnCalls.push({
      cmd: ["chmod", "600", "/home/agent/.netrc"],
      exitCode: 0,
    });
    // clone
    spawnCalls.push({
      cmd: ["git", "clone", "https://github.com/org/repo.git", "/workspace/repo"],
      exitCode: 0,
    });

    await setupWorkspace({
      repos: ["org/repo"],
      githubToken: "ghp_test123",
      roleConfig: makeRoleConfig(),
      phoneHome,
    });

    const netrcPath = `${process.env.HOME || "/home/agent"}/.netrc`;
    expect(writtenFiles.has(netrcPath)).toBe(true);
    expect(writtenFiles.get(netrcPath)).toContain("ghp_test123");
  });

  it("throws on invalid repo name", async () => {
    const phoneHome = mock(() => {});

    await expect(
      setupWorkspace({
        repos: ["org/bad repo name!"],
        roleConfig: makeRoleConfig(),
        phoneHome,
      }),
    ).rejects.toThrow("Invalid repo name");
  });
});
