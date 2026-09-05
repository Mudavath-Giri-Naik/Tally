/**
 * One-command live demo trigger.
 *
 * Creates a single, realistic mandate failure for a real phone number and
 * immediately runs the worker over it, so the WhatsApp message goes out right
 * away on camera instead of waiting for the next cron tick.
 *
 *   npm run demo -- --merchant=Mandate --phone=+919876543210 --name="Asha"
 *
 * mandate_limit_exceeded is picked deliberately: it is never retryable, so
 * both the AI path and the templated fallback send an immediate message with
 * a real payment link, regardless of whether a model is configured - the one
 * thing this script cannot afford is silence on stage.
 */
import { listMerchants } from "../src/lib/merchants";
import { ingestEvent } from "../src/lib/events";
import { runWorker } from "../src/lib/agent/worker";
import { formatINR } from "../src/lib/types";

const args = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;
}

const merchantQuery = arg("merchant");
const phone = arg("phone");
const name = arg("name", "Demo Customer")!;
const email = arg("email");
const amount = Number(arg("amount", "149900"));

async function main() {
  if (!phone) {
    console.error("Usage: npm run demo -- --phone=+91XXXXXXXXXX [--merchant=Mandate] [--name=\"Asha\"] [--amount=149900]");
    process.exit(1);
  }

  const merchants = await listMerchants();
  if (merchants.length === 0) {
    console.error("No merchants connected. Run `npm run seed` or connect one in the UI first.");
    process.exit(1);
  }

  const merchant = merchantQuery
    ? merchants.find(
        (m) =>
          m.business_name.toLowerCase().includes(merchantQuery.toLowerCase()) ||
          m.slug.toLowerCase() === merchantQuery.toLowerCase(),
      )
    : merchants[0];

  if (!merchant) {
    console.error(
      `No merchant matching "${merchantQuery}". Connected: ${merchants.map((m) => m.business_name).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`\nMerchant   ${merchant.business_name}`);
  console.log(`Customer   ${name}  ${phone}`);
  console.log(`Amount     ${formatINR(amount)}`);
  console.log(`Cause      mandate_limit_exceeded (a real AutoPay/mandate failure)\n`);

  const event = await ingestEvent({
    merchantId: merchant.id,
    providerEventId: `demo_${Date.now()}`,
    type: "mandate_retry",
    reason: "mandate_limit_exceeded",
    amount,
    customerName: name,
    customerEmail: email ?? null,
    customerPhone: phone,
    metadata: { demo: true },
  });

  console.log(`Case created: ${event.id}`);
  console.log("Open the dashboard now - this is the moment it should appear.\n");
  console.log("Processing immediately (not waiting for the next cron tick)...\n");

  const report = await runWorker({ batchSize: 5 });
  console.log(
    `Done - sent=${report.sent} scheduled=${report.scheduled} ` +
      `stopped=${report.stopped} escalated=${report.escalated} failed=${report.failed}`,
  );
  if (report.errors.length > 0) {
    for (const e of report.errors) console.log(`  ! ${e.eventId}: ${e.error}`);
  }
  console.log("\nCheck WhatsApp now. Pay the link, then watch the case flip to Recovered.\n");
}

main().catch((err) => {
  console.error("Demo trigger failed:", err.message ?? err);
  process.exit(1);
});
