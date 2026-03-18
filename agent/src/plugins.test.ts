import { describe, it, expect } from "bun:test";
import { parseEnabledPlugins, resolvePluginPaths } from "./plugins";

describe("parseEnabledPlugins", () => {
  it("extracts enabled plugins (true only, skips false)", () => {
    const settings = {
      enabledPlugins: {
        "my-plugin@claude-plugins-official": true,
        "disabled-plugin@claude-plugins-official": false,
        "another@claude-plugins-official": true,
      },
    };

    const result = parseEnabledPlugins(settings);

    expect(result).toEqual([
      { name: "my-plugin", marketplace: "claude-plugins-official" },
      { name: "another", marketplace: "claude-plugins-official" },
    ]);
  });

  it("returns empty array when no enabledPlugins", () => {
    expect(parseEnabledPlugins({})).toEqual([]);
    expect(parseEnabledPlugins({ enabledPlugins: {} })).toEqual([]);
  });

  it("handles plugins without marketplace qualifier (name only, no @)", () => {
    const settings = {
      enabledPlugins: {
        "standalone-plugin": true,
      },
    };

    const result = parseEnabledPlugins(settings);

    expect(result).toEqual([
      { name: "standalone-plugin", marketplace: null },
    ]);
  });
});

describe("resolvePluginPaths", () => {
  it("resolves plugins to correct marketplace paths", () => {
    const plugins = [
      { name: "my-plugin", marketplace: "claude-plugins-official" },
      { name: "other-plugin", marketplace: "claude-plugins-official" },
    ];

    const result = resolvePluginPaths(plugins, "/tmp/clones");

    expect(result).toEqual([
      {
        type: "local",
        path: "/tmp/clones/claude-plugins-official/plugins/my-plugin",
      },
      {
        type: "local",
        path: "/tmp/clones/claude-plugins-official/plugins/other-plugin",
      },
    ]);
  });

  it("skips plugins without a known marketplace", () => {
    const plugins = [
      { name: "my-plugin", marketplace: "unknown-marketplace" },
      { name: "standalone", marketplace: null },
    ];

    const result = resolvePluginPaths(plugins, "/tmp/clones");

    expect(result).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    const result = resolvePluginPaths([], "/tmp/clones");

    expect(result).toEqual([]);
  });
});
