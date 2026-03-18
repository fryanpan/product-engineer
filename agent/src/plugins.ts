/**
 * Plugin resolution for headless agent sessions.
 *
 * Reads enabledPlugins from a target repo's .claude/settings.json,
 * clones the marketplace repo(s), reads marketplace.json to discover
 * plugin sources (local dirs or external git URLs), clones as needed,
 * and resolves plugin directory paths for the Agent SDK `plugins` option.
 */

export interface PluginRef {
  name: string;
  marketplace: string | null;
}

export interface PluginPath {
  type: "local";
  path: string;
}

/** Marketplace plugin entry from marketplace.json */
interface MarketplaceEntry {
  name: string;
  source: string | { source: string; url: string };
}

/** Known marketplace short names to full GitHub repo paths. */
const KNOWN_MARKETPLACES: Record<string, string> = {
  "claude-plugins-official": "anthropics/claude-plugins-official",
};

/**
 * Parse enabledPlugins from a .claude/settings.json object.
 * Extracts entries where value is `true`, parses "name@marketplace" format.
 */
export function parseEnabledPlugins(
  settings: Record<string, unknown>,
): PluginRef[] {
  const enabled = settings.enabledPlugins;
  if (!enabled || typeof enabled !== "object") return [];

  const result: PluginRef[] = [];
  for (const [key, value] of Object.entries(
    enabled as Record<string, unknown>,
  )) {
    if (value !== true) continue;

    const atIndex = key.indexOf("@");
    if (atIndex === -1) {
      result.push({ name: key, marketplace: null });
    } else {
      result.push({
        name: key.slice(0, atIndex),
        marketplace: key.slice(atIndex + 1),
      });
    }
  }
  return result;
}

/**
 * Shallow-clone a git repo. Returns true on success, false on failure.
 */
async function shallowClone(repoUrl: string, targetDir: string): Promise<boolean> {
  const markerFile = Bun.file(`${targetDir}/.git/HEAD`);
  if (await markerFile.exists()) return true;

  console.log(`[Plugins] Shallow-cloning ${repoUrl} → ${targetDir}`);
  const proc = Bun.spawn([
    "git", "clone", "--depth", "1", "--single-branch",
    repoUrl, targetDir,
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = proc.stderr ? await new Response(proc.stderr).text() : "unknown error";
    console.error(`[Plugins] Failed to clone ${repoUrl}: ${stderr}`);
    return false;
  }
  console.log(`[Plugins] Cloned ${repoUrl} successfully`);
  return true;
}

/**
 * Read marketplace.json from a cloned marketplace repo and build a map
 * of plugin name → source info.
 */
async function readMarketplaceIndex(
  marketplaceDir: string,
): Promise<Map<string, MarketplaceEntry>> {
  const index = new Map<string, MarketplaceEntry>();
  const manifestPath = `${marketplaceDir}/.claude-plugin/marketplace.json`;
  const file = Bun.file(manifestPath);
  if (!(await file.exists())) return index;

  try {
    const manifest = await file.json();
    const plugins = manifest.plugins as MarketplaceEntry[] | undefined;
    if (!plugins) return index;
    for (const entry of plugins) {
      index.set(entry.name, entry);
    }
  } catch (err) {
    console.warn(`[Plugins] Failed to parse marketplace.json: ${err}`);
  }
  return index;
}

/**
 * Clone marketplace repos and URL-sourced plugins in parallel.
 * Returns a map of plugin name → resolved local path.
 */
export async function cloneAndResolvePlugins(
  plugins: PluginRef[],
  cloneDir: string,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

  // Group plugins by marketplace
  const byMarketplace = new Map<string, PluginRef[]>();
  for (const plugin of plugins) {
    if (!plugin.marketplace || !KNOWN_MARKETPLACES[plugin.marketplace]) continue;
    const list = byMarketplace.get(plugin.marketplace) || [];
    list.push(plugin);
    byMarketplace.set(plugin.marketplace, list);
  }

  // Phase 1: Clone marketplace repos in parallel
  const marketplaceClones = [...byMarketplace.keys()].map(async (marketplace) => {
    const repoPath = KNOWN_MARKETPLACES[marketplace];
    const targetDir = `${cloneDir}/${marketplace}`;
    const ok = await shallowClone(`https://github.com/${repoPath}.git`, targetDir);
    return { marketplace, targetDir, ok };
  });
  const cloneResults = await Promise.all(marketplaceClones);

  // Phase 2: Read marketplace.json indexes, identify URL-sourced plugins
  const urlClones: Promise<void>[] = [];

  for (const { marketplace, targetDir, ok } of cloneResults) {
    if (!ok) continue;
    const pluginsNeeded = byMarketplace.get(marketplace) || [];
    const index = await readMarketplaceIndex(targetDir);

    for (const plugin of pluginsNeeded) {
      const entry = index.get(plugin.name);

      if (!entry) {
        console.warn(`[Plugins] Plugin "${plugin.name}" not found in ${marketplace} marketplace.json`);
        continue;
      }

      const source = entry.source;

      if (typeof source === "string") {
        // Local source — resolve relative to marketplace dir
        // source is like "./plugins/code-review" or "./external_plugins/context7"
        const localPath = `${targetDir}/${source.replace(/^\.\//, "")}`;
        resolved.set(plugin.name, localPath);
      } else if (source && typeof source === "object" && source.url) {
        // URL source — need to clone separately
        const pluginDir = `${cloneDir}/url-plugins/${plugin.name}`;
        urlClones.push(
          shallowClone(source.url, pluginDir).then((ok) => {
            if (ok) resolved.set(plugin.name, pluginDir);
          }),
        );
      }
    }
  }

  // Phase 3: Clone URL-sourced plugins in parallel
  if (urlClones.length > 0) {
    await Promise.all(urlClones);
  }

  return resolved;
}

/**
 * High-level orchestrator: reads settings, clones marketplaces + URL-sourced plugins,
 * resolves and validates plugin paths for the Agent SDK.
 * Non-fatal — returns [] on any error.
 */
export async function loadPlugins(repoDir: string): Promise<PluginPath[]> {
  try {
    const settingsPath = `${repoDir}/.claude/settings.json`;
    const settingsFile = Bun.file(settingsPath);
    if (!(await settingsFile.exists())) {
      console.log("[Plugins] No .claude/settings.json found — skipping plugin loading");
      return [];
    }

    const settings = await settingsFile.json();
    const plugins = parseEnabledPlugins(settings);
    if (plugins.length === 0) {
      console.log("[Plugins] No enabledPlugins in settings.json");
      return [];
    }

    console.log(`[Plugins] Found ${plugins.length} enabled plugins: ${plugins.map((p) => `${p.name}@${p.marketplace}`).join(", ")}`);

    const cloneDir = "/tmp/marketplaces";
    const resolved = await cloneAndResolvePlugins(plugins, cloneDir);

    // Validate each resolved path has a plugin manifest
    const validated: PluginPath[] = [];
    for (const [name, path] of resolved) {
      const pluginJson = Bun.file(`${path}/.claude-plugin/plugin.json`);
      if (await pluginJson.exists()) {
        validated.push({ type: "local", path });
      } else {
        console.warn(`[Plugins] Plugin "${name}" at ${path} missing .claude-plugin/plugin.json — skipping`);
      }
    }

    console.log(`[Plugins] Resolved ${validated.length}/${plugins.length} plugin paths`);
    return validated;
  } catch (err) {
    console.error("[Plugins] Plugin loading failed:", err);
    return [];
  }
}
