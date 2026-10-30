/**
 * A merchant's storefront endpoints, as the MCP server needs them.
 *
 * There is no table for these. The configuration is sealed (AES-256-GCM, the
 * same key as every other credential) into the MCP link itself, so the link is
 * both the address and the proof of access, and nobody can edit it into
 * pointing the server somewhere else. The merchant row is still checked on
 * every call, so deleting or pausing a business switches its link off.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { decrypt, encrypt } from "../crypto";
import { requireEnv } from "../env";

import { DEFAULT_STORE_CONFIG, type StoreConfig } from "./store-defaults";

export { DEFAULT_STORE_CONFIG, type StoreConfig };

export class StoreConfigError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = "StoreConfigError";
    this.field = field;
  }
}

const PATH_FIELDS = [
  "products_path",
  "product_path",
  "orders_path",
  "order_status_path",
] as const;

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    );
  }
  return false;
}

/** Validate untrusted input into a StoreConfig, or throw naming the field. */
export function parseStoreConfig(input: unknown): StoreConfig {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string, fallback: string) =>
    typeof raw[k] === "string" && (raw[k] as string).trim() ? (raw[k] as string).trim() : fallback;

  const baseRaw = str("base_url", "");
  let base: URL;
  try {
    base = new URL(baseRaw);
  } catch {
    throw new StoreConfigError("store_base_url", "Enter your store's address, like https://yourstore.com.");
  }
  if (base.protocol !== "https:") {
    throw new StoreConfigError("store_base_url", "The store address must start with https://.");
  }
  if (isPrivateHost(base.hostname)) {
    throw new StoreConfigError("store_base_url", "That address is not reachable from the internet.");
  }

  const cfg: StoreConfig = {
    base_url: base.origin,
    products_path: str("products_path", DEFAULT_STORE_CONFIG.products_path),
    product_path: str("product_path", DEFAULT_STORE_CONFIG.product_path),
    orders_path: str("orders_path", DEFAULT_STORE_CONFIG.orders_path),
    order_status_path: str("order_status_path", DEFAULT_STORE_CONFIG.order_status_path),
  };
  for (const f of PATH_FIELDS) {
    const v = cfg[f];
    if (!v.startsWith("/") || v.startsWith("//") || v.length > 200) {
      throw new StoreConfigError(`store_${f}`, "Must be a path starting with a single /, like /api/products.");
    }
  }
  for (const f of ["product_path", "order_status_path"] as const) {
    if (!cfg[f].includes(":id")) {
      throw new StoreConfigError(`store_${f}`, "Must contain :id where the id goes, like /api/products/:id.");
    }
  }
  return cfg;
}

/** Resolve a path against the store, never leaving the store's origin. */
export function storeUrl(cfg: StoreConfig, path: string, id?: string): URL {
  const p = id === undefined ? path : path.replace(":id", encodeURIComponent(id));
  const url = new URL(p, cfg.base_url);
  if (url.origin !== new URL(cfg.base_url).origin) {
    throw new Error("Refusing to call outside the configured store.");
  }
  return url;
}

/**
 * The short form of a link: a token derived from the merchant id, with the
 * endpoints read from the merchant row. Unforgeable without the server key,
 * and recomputable, so Settings can show the link again at any time.
 */
export function shortToken(merchantId: string): string {
  const key = Buffer.from(
    requireEnv("CREDENTIAL_ENCRYPTION_KEY", "signing MCP links"),
    "base64",
  );
  return createHmac("sha256", key)
    .update(`mcp-link:${merchantId}`)
    .digest("base64url")
    .slice(0, 32);
}

export function isShortToken(token: string): boolean {
  return token.length === 32;
}

export function verifyShortToken(merchantId: string, token: string): boolean {
  const a = Buffer.from(shortToken(merchantId));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The link for a business whose endpoints are stored on its row. */
export function shortMcpUrl(baseUrl: string, merchantId: string): string {
  return `${baseUrl}/api/mcp/${merchantId}/${shortToken(merchantId)}`;
}

export function sealStoreConfig(merchantId: string, cfg: StoreConfig): string {
  const payload = JSON.stringify({ m: merchantId, c: cfg });
  return Buffer.from(encrypt(payload, "mcp_store_config")).toString("base64url");
}

/** The config in a link for this merchant, or null if forged / for another. */
export function openStoreConfig(merchantId: string, token: string): StoreConfig | null {
  try {
    const parsed = JSON.parse(
      decrypt(Buffer.from(token, "base64url").toString("utf8"), "mcp_store_config"),
    ) as { m?: string; c?: unknown };
    if (parsed.m !== merchantId) return null;
    return parseStoreConfig(parsed.c);
  } catch {
    return null;
  }
}
