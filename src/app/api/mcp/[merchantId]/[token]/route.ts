/**
 * A merchant's MCP endpoint: /api/mcp/<merchantId>/<sealed store config>.
 *
 * The sealed config is the credential - see lib/mcp/store.ts. The merchant row
 * is loaded on every call, so a deleted or paused business stops answering.
 */
import { NextResponse } from "next/server";
import { getMerchant, razorpayCredentials } from "@/lib/merchants";
import { openStoreConfig } from "@/lib/mcp/store";
import { handleMessage, type McpContext } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
};

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: CORS });

type Params = { params: Promise<{ merchantId: string; token: string }> };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  // No server-initiated stream; the spec lets a server decline with 405.
  return new NextResponse(null, { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } });
}

export async function POST(request: Request, { params }: Params) {
  const { merchantId, token } = await params;

  const store = openStoreConfig(merchantId, token);
  if (!store) return json({ error: "Invalid MCP link." }, 404);

  let merchant;
  try {
    merchant = await getMerchant(merchantId);
  } catch {
    return json({ error: "Could not load this business." }, 500);
  }
  if (!merchant || !merchant.active) return json({ error: "Invalid MCP link." }, 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  const ctx: McpContext = {
    businessName: merchant.business_name,
    store,
    razorpay: () => razorpayCredentials(merchant),
  };

  const messages = Array.isArray(body) ? body : [body];
  const out: unknown[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const r = await handleMessage(ctx, m as Record<string, unknown>);
    if (r) out.push(r);
  }
  if (out.length === 0) return new NextResponse(null, { status: 202, headers: CORS });
  return json(Array.isArray(body) ? out : out[0]);
}
