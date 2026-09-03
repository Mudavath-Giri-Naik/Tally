/**
 * Evidence: did it work, and did it behave.
 *
 * Everything on this page is a fresh read against Postgres, in parallel. It is
 * deliberately not fed from the dashboard payload the other pages share: this
 * page's whole claim is that it checks the rows rather than trusting a number
 * something else computed, and reusing a cached aggregate here would quietly
 * make that untrue.
 */
import { notFound } from "next/navigation";

import { resolveMerchant } from "@/lib/merchants";
import { rangeDays } from "@/lib/board";
import {
  merchantCauses,
  merchantInvariants,
  merchantLift,
  merchantSendHours,
  merchantSpend,
} from "@/lib/evidence";
import { Evidence } from "@/components/evidence";

export const dynamic = "force-dynamic";

export default async function EvidencePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const merchant = await resolveMerchant(slug).catch(() => null);
  if (!merchant) notFound();

  const raw = Array.isArray(sp.range) ? sp.range[0] : sp.range;
  // Thirty days rather than the board's seven. A control arm needs volume
  // before it says anything, and a compliance record covering one week is not
  // the one anybody asks for.
  const days = sp.range ? rangeDays(raw) : 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const window = {
    start: merchant.contact_window_start,
    end: merchant.contact_window_end,
  };

  const [lift, spend, causes, invariants, hours] = await Promise.all([
    merchantLift(merchant.id, since),
    merchantSpend(merchant.id, since),
    merchantCauses(merchant.id, since),
    merchantInvariants(merchant.id, since),
    merchantSendHours(merchant.id, since, window),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Evidence</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Whether the recovery is real, and whether the rules held, over the
          last {days} days. Checked against the records themselves.
        </p>
      </div>

      <Evidence
        lift={lift}
        spend={spend}
        causes={causes}
        invariants={invariants}
        hours={hours}
        window={window}
        timezone={merchant.timezone}
      />
    </div>
  );
}
