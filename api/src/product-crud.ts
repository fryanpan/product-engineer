/**
 * Product registry and settings CRUD operations.
 *
 * Extracted from Orchestrator — each function returns a Response directly
 * since these are thin HTTP CRUD wrappers.
 */

import type { SqlExec } from "./db";
import { setSetting, getProductConfig, getAllProductConfigs } from "./db";

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export function listProducts(sql: SqlExec): Response {
  return Response.json({ products: getAllProductConfigs(sql) });
}

export function getProduct(sql: SqlExec, slug: string): Response {
  if (!slug) {
    return Response.json({ error: "Missing slug" }, { status: 400 });
  }

  const config = getProductConfig(sql, slug);
  if (!config) {
    return Response.json({ error: "Product not found" }, { status: 404 });
  }

  return Response.json({ product: config });
}

export function createProduct(
  sql: SqlExec,
  slug: string,
  config: unknown,
): Response {
  if (!slug || !config) {
    return Response.json({ error: "Missing slug or config" }, { status: 400 });
  }

  try {
    sql.exec(
      "INSERT INTO products (slug, config) VALUES (?, ?)",
      slug,
      JSON.stringify(config),
    );
    return Response.json({ ok: true, slug });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint")) {
      return Response.json({ error: "Product already exists" }, { status: 409 });
    }
    return Response.json({ error: message }, { status: 500 });
  }
}

export function updateProduct(
  sql: SqlExec,
  slug: string,
  config: unknown,
): Response {
  if (!slug) {
    return Response.json({ error: "Missing slug" }, { status: 400 });
  }
  if (!config) {
    return Response.json({ error: "Missing config" }, { status: 400 });
  }

  sql.exec(
    "UPDATE products SET config = ?, updated_at = datetime('now') WHERE slug = ?",
    JSON.stringify(config),
    slug,
  );

  const rows = sql.exec(
    "SELECT changes() as count",
  ).toArray() as Array<{ count: number }>;

  if (rows[0].count === 0) {
    return Response.json({ error: "Product not found" }, { status: 404 });
  }

  return Response.json({ ok: true, slug });
}

export function deleteProduct(sql: SqlExec, slug: string): Response {
  if (!slug) {
    return Response.json({ error: "Missing slug" }, { status: 400 });
  }

  sql.exec("DELETE FROM products WHERE slug = ?", slug);

  const rows = sql.exec(
    "SELECT changes() as count",
  ).toArray() as Array<{ count: number }>;

  if (rows[0].count === 0) {
    return Response.json({ error: "Product not found" }, { status: 404 });
  }

  return Response.json({ ok: true, slug });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function listSettings(sql: SqlExec): Response {
  const rows = sql.exec(
    "SELECT key, value FROM settings ORDER BY key",
  ).toArray() as Array<{ key: string; value: string }>;

  const settings = rows.reduce((acc, row) => {
    acc[row.key] = row.value;
    return acc;
  }, {} as Record<string, string>);

  return Response.json({ settings });
}

export function updateSetting(
  sql: SqlExec,
  key: string,
  value: string,
): Response {
  if (!key) {
    return Response.json({ error: "Missing key" }, { status: 400 });
  }
  if (value === undefined || value === null) {
    return Response.json({ error: "Missing value" }, { status: 400 });
  }

  setSetting(sql, key, value);

  return Response.json({ ok: true, key, value });
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export function seedProducts(
  sql: SqlExec,
  registry: {
    linear_team_id?: string;
    linear_app_user_id?: string;
    conductor_channel?: string;
    cloudflare_ai_gateway?: { account_id: string; gateway_id: string };
    products: Record<string, unknown>;
  },
): Response {
  let productsCreated = 0;
  let productsUpdated = 0;
  let settingsUpdated = 0;

  // Insert global settings
  const settingsToUpsert: [string, string][] = [];
  if (registry.linear_team_id) settingsToUpsert.push(["linear_team_id", registry.linear_team_id]);
  if (registry.linear_app_user_id) settingsToUpsert.push(["linear_app_user_id", registry.linear_app_user_id]);
  if (registry.conductor_channel) settingsToUpsert.push(["conductor_channel", registry.conductor_channel]);
  if (registry.cloudflare_ai_gateway) settingsToUpsert.push(["cloudflare_ai_gateway", JSON.stringify(registry.cloudflare_ai_gateway)]);

  for (const [key, value] of settingsToUpsert) {
    setSetting(sql, key, value);
    settingsUpdated++;
  }

  // Upsert products
  for (const [slug, config] of Object.entries(registry.products)) {
    sql.exec(
      `INSERT INTO products (slug, config) VALUES (?, ?)
       ON CONFLICT(slug) DO UPDATE SET config = excluded.config, updated_at = datetime('now')`,
      slug,
      JSON.stringify(config),
    );
    // Count as created or updated based on whether rows changed
    const changes = sql.exec("SELECT changes() as count").toArray() as Array<{ count: number }>;
    if (changes[0].count > 0) productsCreated++;
  }

  return Response.json({
    ok: true,
    products_created: productsCreated,
    products_updated: productsUpdated,
    settings_updated: settingsUpdated,
  });
}
