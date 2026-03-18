# Agent Plugin Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable ticket agents to load plugins from target repos so skills like `/simplify` work in headless agent sessions.

**Architecture:** After cloning the target repo, read its `.claude/settings.json` to discover `enabledPlugins`. Shallow-clone the marketplace repo(s) once per agent session, resolve each plugin to its local directory, and pass them to the Agent SDK via `plugins: [{ type: "local", path: "..." }]`. All marketplace clones happen in parallel with no caching layers.

**Tech Stack:** Bun/TypeScript, Agent SDK `plugins` option, git shallow clone

---

### Task 1: Create `plugins.ts` — plugin resolution module

**Files:**
- Create: `agent/src/plugins.ts`
- Test: `agent/src/plugins.test.ts`

**Step 1: Write the failing tests**

```typescript
// agent/src/plugins.test.ts
import { describe, it, expect } from "bun:test";
import { parseEnabledPlugins, resolvePluginPaths } from "./plugins";

describe("parseEnabledPlugins", () => {
  it("extracts enabled plugins from settings", () => {
    const settings = {
      enabledPlugins: {
        "code-review@claude-plugins-official": true,
        "superpowers@claude-plugins-official": true,
        "disabled-plugin@claude-plugins-official": false,
      },
    };
    const result = parseEnabledPlugins(settings);
    expect(result).toEqual([
      { name: "code-review", marketplace: "claude-plugins-official" },
      { name: "superpowers", marketplace: "claude-plugins-official" },
    ]);
  });

  it("returns empty array when no enabledPlugins", () => {
    expect(parseEnabledPlugins({})).toEqual([]);
    expect(parseEnabledPlugins({ permissions: {} })).toEqual([]);
  });

  it("handles plugins without marketplace qualifier", () => {
    const settings = {
      enabledPlugins: { "my-local-plugin": true },
    };
    const result = parseEnabledPlugins(settings);
    expect(result).toEqual([
      { name: "my-local-plugin", marketplace: null },
    ]);
  });
});

describe("resolvePluginPaths", () => {
  it("resolves plugins to marketplace clone paths", () => {
    const plugins = [
      { name: "code-review", marketplace: "claude-plugins-official" },
      { name: "superpowers", marketplace: "claude-plugins-official" },
    ];
    const cloneDir = "/tmp/marketplaces";
    const result = resolvePluginPaths(plugins, cloneDir);
    expect(result).toEqual([
      { type: "local", path: "/tmp/marketplaces/claude-plugins-official/plugins/code-review" },
      { type: "local", path: "/tmp/marketplaces/claude-plugins-official/plugins/superpowers" },
    ]);
  });

  it("skips plugins without a marketplace", () => {
    const plugins = [
      { name: "local-only", marketplace: null },
    ];
    const result = resolvePluginPaths(plugins, "/tmp/marketplaces");
    expect(result).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(resolvePluginPaths([], "/tmp/m")).toEqual([]);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd agent && bun test src/plugins.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// agent/src/plugins.ts
/**
 * Plugin resolution for headless agent sessions.
 *
 * Reads enabledPlugins from a target repo's .claude/settings.json,
 * clones the marketplace repo(s), and resolves plugin directory paths
 * for the Agent SDK `plugins` option.
 */

export interface PluginRef {
  name: string;
  marketplace: string | null;
}

export interface PluginPath {
  type: "local";
  path: string;
}

/** Known marketplace repos — maps marketplace name to GitHub org/repo. */
const MARKETPLACE_REPOS: Record<string, string> = {
  "claude-plugins-official": "anthropics/claude-plugins-official",
};

/**
 * Parse enabledPlugins from a settings.json object.
 * Returns only plugins that are set to `true`.
 */
export function parseEnabledPlugins(
  settings: Record<string, unknown>,
): PluginRef[] {
  const enabled = settings.enabledPlugins as Record<string, boolean> | undefined;
  if (!enabled || typeof enabled !== "object") return [];

  return Object.entries(enabled)
    .filter(([, v]) => v === true)
    .map(([key]) => {
      const atIndex = key.indexOf("@");
      if (atIndex === -1) return { name: key, marketplace: null };
      return {
        name: key.slice(0, atIndex),
        marketplace: key.slice(atIndex + 1),
      };
    });
}

/**
 * Resolve plugin refs to local filesystem paths within cloned marketplace dirs.
 * Plugins without a known marketplace are skipped (logged as warnings).
 */
export function resolvePluginPaths(
  plugins: PluginRef[],
  marketplaceCloneDir: string,
): PluginPath[] {
  return plugins
    .filter((p) => p.marketplace !== null && p.marketplace in MARKETPLACE_REPOS)
    .map((p) => ({
      type: "local" as const,
      path: `${marketplaceCloneDir}/${p.marketplace}/plugins/${p.name}`,
    }));
}

/**
 * Clone marketplace repos needed by the given plugins.
 * Uses shallow clone (depth=1) for speed. Clones each marketplace only once.
 */
export async function cloneMarketplaces(
  plugins: PluginRef[],
  cloneDir: string,
): Promise<void> {
  const needed = new Set(
    plugins
      .map((p) => p.marketplace)
      .filter((m): m is string => m !== null && m in MARKETPLACE_REPOS),
  );

  if (needed.size === 0) return;

  await Promise.all(
    [...needed].map(async (marketplace) => {
      const repo = MARKETPLACE_REPOS[marketplace];
      const dest = `${cloneDir}/${marketplace}`;
      console.log(`[Plugins] Shallow-cloning ${repo} → ${dest}`);
      const proc = Bun.spawn([
        "git", "clone", "--depth", "1", "--single-branch",
        `https://github.com/${repo}.git`,
        dest,
      ]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = proc.stderr ? await new Response(proc.stderr).text() : "unknown error";
        console.error(`[Plugins] Failed to clone ${repo}: ${stderr}`);
        throw new Error(`Failed to clone marketplace ${marketplace}: exit ${exitCode}`);
      }
      console.log(`[Plugins] Cloned ${marketplace} successfully`);
    }),
  );
}

/**
 * High-level: read settings.json from the cloned repo, clone marketplaces,
 * return resolved plugin paths for the Agent SDK.
 */
export async function loadPlugins(
  repoDir: string,
): Promise<PluginPath[]> {
  const settingsPath = `${repoDir}/.claude/settings.json`;
  const file = Bun.file(settingsPath);
  if (!(await file.exists())) {
    console.log("[Plugins] No .claude/settings.json found — skipping plugin loading");
    return [];
  }

  let settings: Record<string, unknown>;
  try {
    settings = await file.json();
  } catch (err) {
    console.error(`[Plugins] Failed to parse ${settingsPath}:`, err);
    return [];
  }

  const plugins = parseEnabledPlugins(settings);
  if (plugins.length === 0) {
    console.log("[Plugins] No enabledPlugins in settings.json");
    return [];
  }

  console.log(`[Plugins] Found ${plugins.length} enabled plugins: ${plugins.map((p) => `${p.name}@${p.marketplace}`).join(", ")}`);

  const cloneDir = "/tmp/marketplaces";
  await cloneMarketplaces(plugins, cloneDir);

  const paths = resolvePluginPaths(plugins, cloneDir);

  // Validate that plugin dirs actually exist
  const validated: PluginPath[] = [];
  for (const p of paths) {
    const pluginDir = Bun.file(`${p.path}/.claude-plugin/plugin.json`);
    if (await pluginDir.exists()) {
      validated.push(p);
    } else {
      // Try external_plugins/ as fallback
      const altPath = p.path.replace("/plugins/", "/external_plugins/");
      const altDir = Bun.file(`${altPath}/.claude-plugin/plugin.json`);
      if (await altDir.exists()) {
        validated.push({ type: "local", path: altPath });
      } else {
        console.warn(`[Plugins] Plugin dir not found: ${p.path} (also checked external_plugins/)`);
      }
    }
  }

  console.log(`[Plugins] Resolved ${validated.length} plugin paths`);
  return validated;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd agent && bun test src/plugins.test.ts`
Expected: PASS (unit tests for parse/resolve; clone tests are integration)

**Step 5: Commit**

```bash
git add agent/src/plugins.ts agent/src/plugins.test.ts
git commit -m "feat: add plugin resolution module for headless agent sessions"
```

---

### Task 2: Integrate plugin loading into agent startup

**Files:**
- Modify: `agent/src/server.ts` (cloneRepos + startSession)

**Step 1: Add import and state variable**

At the top of `server.ts`, add import:
```typescript
import { loadPlugins, type PluginPath } from "./plugins";
```

Add state variable near other state vars (~line 367):
```typescript
let loadedPlugins: PluginPath[] = [];
```

**Step 2: Call loadPlugins after cloneRepos**

In `cloneRepos()`, after `repoCloned = true` (~line 462), add:
```typescript
  // Load plugins from the target repo's .claude/settings.json
  const primaryRepo = config.repos[0].split("/").pop()!;
  phoneHome("loading_plugins");
  try {
    loadedPlugins = await loadPlugins(`/workspace/${primaryRepo}`);
    if (loadedPlugins.length > 0) {
      phoneHome(`plugins_loaded count=${loadedPlugins.length} names=${loadedPlugins.map(p => p.path.split("/").pop()).join(",")}`);
    }
  } catch (err) {
    console.error("[Agent] Plugin loading failed (non-fatal):", err);
    phoneHome("plugins_failed");
    // Continue without plugins — agent can still work, just missing plugin skills
  }
```

Note: `primaryRepo` is already computed above — extract it to avoid duplication. Move the `primaryRepo` variable declaration to before `process.chdir()` and reuse it.

**Step 3: Pass plugins to Agent SDK query options**

In `startSession()`, in the `queryOptions` object (~line 517), add the `plugins` field:
```typescript
  const queryOptions: any = {
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["project"],
    maxTurns: 200,
    permissionMode: "bypassPermissions",
    mcpServers: { "pe-tools": toolServer, ...externalMcpServers },
    plugins: loadedPlugins.length > 0 ? loadedPlugins : undefined,
    executable: "node",
    // ... rest unchanged
  };
```

**Step 4: Run existing tests to ensure no regressions**

Run: `cd agent && bun test`
Expected: All existing tests PASS

**Step 5: Commit**

```bash
git add agent/src/server.ts
git commit -m "feat: integrate plugin loading into agent startup flow"
```

---

### Task 3: Add git to the agent container (verify it's already there)

**Files:**
- Verify: `agent/Dockerfile`

**Step 1: Verify git is installed**

The Dockerfile already installs git (`apt-get install -y git`). The shallow clone in `cloneMarketplaces` uses `git clone --depth 1` which should work. No Dockerfile changes needed.

The `.netrc` file configured in `cloneRepos()` provides GitHub auth — marketplace repos are public, so auth isn't required, but it won't hurt.

**Step 2: Verify — no action needed, just confirm**

Run: `grep "git" agent/Dockerfile`
Expected: git is already in the apt-get install line

---

### Task 4: Update architecture docs

**Files:**
- Modify: `CLAUDE.md` (root — architecture section)
- Modify: `docs/process/learnings.md`

**Step 1: Add plugin loading to CLAUDE.md architecture section**

In the "How It Works > TicketAgent" section, add a note about plugin loading:

```markdown
### Plugin Loading
After cloning the target repo, the agent reads `.claude/settings.json` to discover `enabledPlugins`. Marketplace repos (e.g., `anthropics/claude-plugins-official`) are shallow-cloned to `/tmp/marketplaces/`, and each plugin directory is resolved and passed to the Agent SDK via `plugins: [{ type: "local", path: "..." }]`. This enables the agent to use plugin skills like `/simplify`, `/code-review`, etc.

Plugin loading is non-fatal — if marketplace cloning fails, the agent continues without plugins.
```

**Step 2: Add learning to learnings.md**

```markdown
## Agent SDK (Plugins in Headless Mode)
- `settingSources: ["project"]` loads CLAUDE.md, rules, and skills from the repo, but does NOT load `enabledPlugins` from `.claude/settings.json`. Plugins must be passed explicitly via the `plugins` option.
- The SDK `plugins` option only supports `{ type: "local", path: "..." }` — no marketplace resolution. The agent must clone marketplace repos and resolve paths itself.
- `claude plugin install` requires the full CLI with OAuth login — not usable in headless containers. Instead, shallow-clone the marketplace GitHub repo directly.
- Marketplace plugins from `claude-plugins-official` live in `plugins/<name>/` or `external_plugins/<name>/` in the `anthropics/claude-plugins-official` repo.
- Plugin loading should be non-fatal: if cloning fails, the agent continues without plugin skills.
```

**Step 3: Commit**

```bash
git add CLAUDE.md docs/process/learnings.md
git commit -m "docs: document agent plugin loading architecture and learnings"
```

---

### Task 5: Manual verification

**Step 1: Run all agent tests**

Run: `cd agent && bun test`
Expected: All tests PASS

**Step 2: Verify plugin resolution logic end-to-end**

Write a quick integration test (or run manually) that:
1. Creates a temp dir with a mock `.claude/settings.json` containing `enabledPlugins`
2. Calls `parseEnabledPlugins` + `resolvePluginPaths`
3. Verifies correct output

**Step 3: Check marketplace repo structure matches expectations**

Run: `gh api repos/anthropics/claude-plugins-official/contents/plugins --jq '.[].name'`
Expected: lists plugin directories including `code-review`, `superpowers`, `code-simplifier`, etc.

Verify the plugin manifest exists:
Run: `gh api repos/anthropics/claude-plugins-official/contents/plugins/code-review/.claude-plugin/plugin.json`
Expected: 200 OK with plugin manifest

**Step 4: Commit any test fixes**

```bash
git add -A
git commit -m "test: verify plugin resolution end-to-end"
```
