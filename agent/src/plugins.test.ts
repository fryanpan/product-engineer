import { describe, it, expect } from "bun:test";
import { parseEnabledPlugins } from "./plugins";

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

  it("ignores non-boolean values", () => {
    const settings = {
      enabledPlugins: {
        "good@marketplace": true,
        "stringy@marketplace": "true",
        "zero@marketplace": 0,
      },
    };

    const result = parseEnabledPlugins(settings);

    expect(result).toEqual([
      { name: "good", marketplace: "marketplace" },
    ]);
  });
});
