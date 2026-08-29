/**
 * Run the worker locally, once or in a loop.
 *
 *   npm run worker            one tick
 *   npm run worker -- --watch tick every 15s until interrupted
 *
 * This is the same code path Vercel Cron drives in production.
 */
import { runWorker } from "../src/lib/agent/worker";

const watch = process.argv.includes("--watch");
const batch = Number(
  process.argv.find((a) => a.startsWith("--batch="))?.split("=")[1] ?? 20,
);

async function tick() {
  const report = await runWorker({ batchSize: batch });
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(
    `[${stamp}] claimed=${report.claimed} sent=${report.sent} ` +
      `scheduled=${report.scheduled} stopped=${report.stopped} ` +
      `escalated=${report.escalated} failed=${report.failed} ` +
      `(${report.durationMs}ms)`,
  );
  for (const e of report.errors) console.log(`         ! ${e.eventId}: ${e.error}`);
}

async function main() {
  await tick();
  if (!watch) return;
  console.log("watching - Ctrl-C to stop");
  setInterval(() => {
    tick().catch((err) => console.error("tick failed:", err.message ?? err));
  }, 15_000);
}

main().catch((err) => {
  console.error("Worker failed:", err.message ?? err);
  process.exit(1);
});
