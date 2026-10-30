/**
 * A per-merchant MCP server (Streamable HTTP, JSON-RPC 2.0, stateless).
 *
 * Written against the protocol directly rather than an SDK: every request is
 * independent, there is no session to hold on a serverless host, and the whole
 * surface is five tools. It speaks to the merchant's own storefront with the
 * endpoints they gave us, and takes payment with the merchant's own Razorpay
 * keys.
 */
import { randomUUID } from "node:crypto";
import { storeUrl, type StoreConfig } from "./store";
import type { RazorpayCredentials } from "../merchants";

export interface McpContext {
  businessName: string;
  store: StoreConfig;
  razorpay: () => RazorpayCredentials;
}

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const FETCH_TIMEOUT_MS = 15_000;
const MAX_QTY = 20;

type Json = Record<string, unknown>;

const TOOLS = [
  {
    name: "search_products",
    description:
      "List products in the store. All filters are optional and can be combined. Prices are in paise (100 paise = ₹1).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text match on name/description." },
        size: { type: "string", description: "e.g. S, M, L" },
        color: { type: "string", description: "e.g. Black" },
        max_price: { type: "integer", description: "Maximum price in paise (₹2000 = 200000)." },
        include_sold_out: { type: "boolean" },
      },
    },
  },
  {
    name: "get_product",
    description: "Get one product, with its live stock.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string" } },
      required: ["product_id"],
    },
  },
  {
    name: "check_stock",
    description: "Check live stock for a product. Call right before ordering.",
    inputSchema: {
      type: "object",
      properties: { product_id: { type: "string" } },
      required: ["product_id"],
    },
  },
  {
    name: "create_order",
    description:
      "Place an order and get a Razorpay payment link. Nothing is charged until the customer opens the link and pays. Confirm product, quantity and the customer's details with them first.",
    inputSchema: {
      type: "object",
      properties: {
        product_id: { type: "string" },
        customer_name: { type: "string" },
        customer_email: { type: "string" },
        quantity: { type: "integer", minimum: 1, maximum: MAX_QTY },
      },
      required: ["product_id", "customer_name", "customer_email"],
    },
  },
  {
    name: "get_order_status",
    description: "Look up an order's status by its id.",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
];

async function call(url: URL, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json", ...(init?.headers ?? {}) },
  });
  const raw = (await res.text()).slice(0, 200_000);
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON body, passed through as text */
  }
  return { status: res.status, body };
}

/** Many storefronts wrap payloads as { ok, data }. Unwrap, or fail with its message. */
function unwrap(r: { status: number; body: unknown }): unknown {
  const b = r.body as Json | string;
  if (r.status >= 400 || (b && typeof b === "object" && b.ok === false)) {
    const err = b && typeof b === "object" ? (b.error as Json | string | undefined) : undefined;
    const msg = typeof err === "string" ? err : (err?.message as string | undefined);
    throw new Error(msg ?? `Store returned HTTP ${r.status}.`);
  }
  return b && typeof b === "object" && "data" in b ? b.data : b;
}

function pickProduct(d: unknown): Json {
  const o = (d ?? {}) as Json;
  return ((o.product as Json | undefined) ?? o) as Json;
}

function text(value: unknown, isError = false) {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

async function toolCall(ctx: McpContext, name: string, a: Json) {
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
  switch (name) {
    case "search_products": {
      const url = storeUrl(ctx.store, ctx.store.products_path);
      for (const k of ["size", "color"]) if (s(k)) url.searchParams.set(k, s(k));
      if (typeof a.max_price === "number") {
        url.searchParams.set("max_price", String(Math.round(a.max_price)));
      }
      if (a.include_sold_out === true) url.searchParams.set("include_sold_out", "true");
      const d = unwrap(await call(url)) as Json;
      let products = (Array.isArray(d) ? d : ((d.products as Json[] | undefined) ?? [])) as Json[];
      const q = s("query").toLowerCase();
      if (q) {
        products = products.filter((p) =>
          `${p.name ?? ""} ${p.description ?? ""}`.toLowerCase().includes(q),
        );
      }
      return text({ count: products.length, products });
    }
    case "get_product":
    case "check_stock": {
      if (!s("product_id")) return text("product_id is required.", true);
      const p = pickProduct(
        unwrap(await call(storeUrl(ctx.store, ctx.store.product_path, s("product_id")))),
      );
      return name === "get_product"
        ? text(p)
        : text({ id: p.id, name: p.name, stock_count: p.stock_count, status: p.status });
    }
    case "get_order_status": {
      if (!s("order_id")) return text("order_id is required.", true);
      return text(
        unwrap(await call(storeUrl(ctx.store, ctx.store.order_status_path, s("order_id")))),
      );
    }
    case "create_order":
      return createOrder(ctx, a);
    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

async function createOrder(ctx: McpContext, a: Json) {
  const productId = typeof a.product_id === "string" ? a.product_id.trim() : "";
  const customerName = typeof a.customer_name === "string" ? a.customer_name.trim() : "";
  const customerEmail = typeof a.customer_email === "string" ? a.customer_email.trim() : "";
  const quantity = a.quantity === undefined ? 1 : Number(a.quantity);
  if (!productId || !customerName || !/^\S+@\S+\.\S+$/.test(customerEmail)) {
    return text("product_id, customer_name and a valid customer_email are required.", true);
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
    return text(`quantity must be a whole number from 1 to ${MAX_QTY}.`, true);
  }

  // Read the price from the store itself, never from the caller.
  const product = pickProduct(
    unwrap(await call(storeUrl(ctx.store, ctx.store.product_path, productId))),
  );
  const price = Number(product.price);
  if (!Number.isFinite(price) || price <= 0) {
    return text("The store did not return a valid price for this product.", true);
  }
  if (typeof product.stock_count === "number" && product.stock_count < quantity) {
    return text(`Only ${product.stock_count} in stock.`, true);
  }

  const placed = unwrap(
    await call(storeUrl(ctx.store, ctx.store.orders_path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        product_id: productId,
        customer_name: customerName,
        customer_email: customerEmail,
        quantity,
      }),
    }),
  ) as Json;
  const order = ((placed.order as Json | undefined) ?? placed) as Json;
  const orderId = String(order.id ?? order.order_id ?? "");
  const amount = price * quantity;

  let paymentLink: string | null = null;
  let paymentError: string | null = null;
  try {
    const { keyId, keySecret } = ctx.razorpay();
    const res = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: "INR",
        description: `${quantity} x ${product.name ?? "item"} - ${ctx.businessName}`.slice(0, 2000),
        reference_id: `mcp_${(orderId || randomUUID()).replace(/-/g, "")}`.slice(0, 40),
        customer: { name: customerName, email: customerEmail },
        notes: { source: "tally_mcp", store_order_id: orderId },
        notify: { sms: false, email: false },
        reminder_enable: false,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const e = body.error as Json | undefined;
      throw new Error(`Razorpay ${res.status}: ${(e?.description as string) ?? "link creation failed"}`);
    }
    paymentLink = String(body.short_url);
  } catch (err) {
    paymentError = err instanceof Error ? err.message : String(err);
  }

  return text({
    order,
    amount_paise: amount,
    amount_display: `INR ${(amount / 100).toFixed(2)}`,
    payment_link: paymentLink,
    ...(paymentError
      ? {
          payment_error: paymentError,
          note: "The order was placed but the payment link could not be created.",
        }
      : { note: "Give the customer the payment link. Nothing is charged until they pay." }),
  });
}

/** Handle one JSON-RPC message. Returns null for notifications. */
export async function handleMessage(ctx: McpContext, msg: Json): Promise<Json | null> {
  const id = msg.id as string | number | undefined;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  if (id === undefined || id === null) return null; // notification
  const params = (msg.params ?? {}) as Json;

  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion as string;
      return reply({
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: `${ctx.businessName} (via Tally)`, version: "1.0.0" },
        instructions: `Tools for the ${ctx.businessName} storefront. Prices are in paise. create_order returns a Razorpay payment link; confirm details with the customer first.`,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(params.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        return reply(await toolCall(ctx, name, (params.arguments ?? {}) as Json));
      } catch (err) {
        return reply(text(err instanceof Error ? err.message : "Tool failed.", true));
      }
    }
    default:
      return fail(-32601, `Method not found: ${String(msg.method)}`);
  }
}
