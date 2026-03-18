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

/** Known marketplace short names to full GitHub repo paths. */
const KNOWN_MARKETPLACES: Record<string, string> = {
  "claude-plugins-official": "anthropics/claude-plugins-official",
};

/**
 * Parse enabledPlugins from a .claude/settings.json object.
 * Extracts entries where value is `true`, parses "name@marketplace" format.
 */
export function parseEnabledPlugins(
  settings: Record<string, unknown>
): PluginRef[] {
  const enabled = settings.enabledPlugins;
  if (!enabled || typeof enabled !== "object") return [];

  const result: PluginRef[] = [];
  for (const [key, value] of Object.entries(
    enabled as Record<string, unknown>
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
 * Map PluginRef[] to PluginPath[] by constructing paths within cloned marketplace dirs.
 * Skips plugins without a known marketplace.
 */
export function resolvePluginPaths(
  plugins: PluginRef[],
  cloneDir: string
): PluginPath[] {
  const result: PluginPath[] = [];
  for (const plugin of plugins) {
    if (!plugin.marketplace || !KNOWN_MARKETPLACES[plugin.marketplace])
      continue;
    result.push({
      type: "local",
      path: `${cloneDir}/${plugin.marketplace}/plugins/${plugin.name}`,
    });
  }
  return result;
}

/**
 * Shallow-clone each unique marketplace repo in parallel.
 */
export async function cloneMarketplaces(
  plugins: PluginRef[],
  cloneDir: string,
): Promise<void> {
  const marketplaces = new Set<string>();
  for (const plugin of plugins) {
    if (plugin.marketplace && KNOWN_MARKETPLACES[plugin.marketplace]) {
      marketplaces.add(plugin.marketplace);
    }
  }

  if (marketplaces.size === 0) return;

  await Promise.all(
    [...marketplaces].map(async (marketplace) => {
      const repoPath = KNOWN_MARKETPLACES[marketplace];
      const targetDir = `${cloneDir}/${marketplace}`;

      // Skip if already cloned (e.g., container restart)
      const markerFile = Bun.file(`${targetDir}/.git/HEAD`);
      if (await markerFile.exists()) return;

      console.log(`[Plugins] Shallow-cloning ${repoPath} → ${targetDir}`);
      const proc = Bun.spawn([
        "git", "clone", "--depth", "1", "--single-branch",
        `https://github.com/${repoPath}.git`,
        targetDir,
      ]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = proc.stderr ? await new Response(proc.stderr).text() : "unknown error";
        console.error(`[Plugins] Failed to clone ${repoPath}: ${stderr}`);
        throw new Error(`Failed to clone marketplace ${marketplace}: exit ${exitCode}`);
      }
      console.log(`[Plugins] Cloned ${marketplace} successfully`);
    }),
  );
}

/**
 * High-level orchestrator: reads settings, clones marketplaces, resolves plugin paths.
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
    await cloneMarketplaces(plugins, cloneDir);

    const paths = resolvePluginPaths(plugins, cloneDir);

    // Validate each path — check plugins/ first, fall back to external_plugins/
    const validated: PluginPath[] = [];
    for (const p of paths) {
      const pluginJson = Bun.file(`${p.path}/.claude-plugin/plugin.json`);
      if (await pluginJson.exists()) {
        validated.push(p);
        continue;
      }

      // Fall back: swap plugins/ for external_plugins/
      const fallbackPath = p.path.replace("/plugins/", "/external_plugins/");
      const fallbackJson = Bun.file(`${fallbackPath}/.claude-plugin/plugin.json`);
      if (await fallbackJson.exists()) {
        validated.push({ type: "local", path: fallbackPath });
      } else {
        console.warn(`[Plugins] Plugin dir not found: ${p.path} (also checked external_plugins/)`);
      }
    }

    console.log(`[Plugins] Resolved ${validated.length} plugin paths`);
    return validated;
  } catch (err) {
    console.error("[Plugins] Plugin loading failed:", err);
    return [];
  }
}
