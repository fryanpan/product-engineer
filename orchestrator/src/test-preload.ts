/**
 * Test preload — mocks Cloudflare runtime modules that aren't available outside wrangler.
 * Referenced by bunfig.toml so it runs before any test file imports.
 */
import { mock } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

mock.module("@cloudflare/containers", () => ({
  Container: class Container {},
}));
