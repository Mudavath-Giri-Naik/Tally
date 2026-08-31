/**
 * "Is this model actually working?"
 *
 * A real call to the configured backend, not a config inspection. Whether a
 * provider answers depends on things no amount of validation can see - a key
 * that was revoked this morning, a model name that was renamed, a quota that
 * ran out an hour ago - and every one of those looks identical to a correct
 * setup right up until a customer is waiting on it.
 *
 * The call is deliberately trivial and its answer thrown away. What is being
 * measured is whether a round trip happens at all, and how long it takes.
 */
import { NextResponse } from "next/server";
import { getMerchant } from "@/lib/merchants";
import { providerFor } from "@/lib/agent/rotating";
import { explainFailure } from "@/lib/agent/admin-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ merchantId: string }> },
): Promise<NextResponse> {
  const { merchantId } = await params;

  const merchant = await getMerchant(merchantId).catch(() => null);
  if (!merchant) {
    return NextResponse.json({ error: "No such business." }, { status: 404 });
  }

  // The provider and model being tested are the ones about to be saved, so a
  // merchant can check a choice before committing to it rather than saving a
  // broken one and discovering it from a customer.
  let body: { provider?: unknown; model?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body means "test what is saved", which is a fair question too.
  }

  const candidate = {
    ai_provider:
      typeof body.provider === "string" && body.provider !== ""
        ? body.provider
        : merchant.ai_provider,
    ai_model:
      typeof body.model === "string" && body.model !== "" ? body.model : merchant.ai_model,
  };

  const provider = await providerFor(candidate);
  if (!provider) {
    return NextResponse.json({
      ok: false,
      error:
        "No key is configured for that provider. Add one to the pool, or set it in the environment.",
    });
  }

  const started = Date.now();
  try {
    // summarise() is the cheapest of the four shapes - two short fields - so
    // a health check costs the least tokens of anything the agent can do.
    await provider.summarise(
      "You are checking that this connection works. Reply with a one-word summary.",
      "The customer said hello. Summarise in one word and set needs_human to false.",
    );
    return NextResponse.json({
      ok: true,
      provider: provider.name,
      model: provider.model,
      ms: Date.now() - started,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      ok: false,
      provider: provider.name,
      model: provider.model,
      ms: Date.now() - started,
      error: explainFailure(raw),
    });
  }
}
