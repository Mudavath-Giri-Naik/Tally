import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

import {
  DEFAULT_STORE_CONFIG,
  openStoreConfig,
  parseStoreConfig,
  sealStoreConfig,
  storeUrl,
} from "../src/lib/mcp/store";
import { handleMessage } from "../src/lib/mcp/server";

const ctx = {
  businessName: "Acme",
  store: DEFAULT_STORE_CONFIG,
  razorpay: () => ({ keyId: "rzp_test_x", keySecret: "y" }),
};

test("sealed config round-trips and is bound to its merchant", () => {
  const t = sealStoreConfig("m1", DEFAULT_STORE_CONFIG);
  assert.deepEqual(openStoreConfig("m1", t), DEFAULT_STORE_CONFIG);
  assert.equal(openStoreConfig("m2", t), null);
  assert.equal(openStoreConfig("m1", t.slice(0, -4) + "AAAA"), null);
  assert.equal(openStoreConfig("m1", "garbage"), null);
});

test("store config rejects unsafe addresses and paths", () => {
  for (const base_url of ["http://x.com", "https://localhost", "https://127.0.0.1", "https://10.0.0.5", "nope"]) {
    assert.throws(() => parseStoreConfig({ base_url }));
  }
  assert.throws(() => parseStoreConfig({ base_url: "https://a.com", products_path: "//evil.com/x" }));
  assert.throws(() => parseStoreConfig({ base_url: "https://a.com", product_path: "/api/p" }));
  assert.equal(parseStoreConfig({ base_url: "https://a.com/ignored" }).base_url, "https://a.com");
});

test("storeUrl stays on the store's origin", () => {
  assert.equal(storeUrl(DEFAULT_STORE_CONFIG, "/api/products/:id", "a/b").pathname, "/api/products/a%2Fb");
});

test("protocol basics", async () => {
  const init = await handleMessage(ctx, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal((init!.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  assert.equal(await handleMessage(ctx, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await handleMessage(ctx, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal((list!.result as { tools: unknown[] }).tools.length, 5);
  const bad = await handleMessage(ctx, { jsonrpc: "2.0", id: 3, method: "nope" });
  assert.equal((bad!.error as { code: number }).code, -32601);
});

test("create_order validates before touching the network", async () => {
  const r = await handleMessage(ctx, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_order", arguments: { product_id: "x" } } });
  assert.equal((r!.result as { isError: boolean }).isError, true);
});
