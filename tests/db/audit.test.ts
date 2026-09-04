/**
 * The Audit Trail's data layer, against the real database.
 *
 * `listActions` is the one place a merchant now reads a guardrail or clamp
 * reason - the customer detail panel no longer surfaces it inline - so the
 * things worth pinning down are: it never leaks another tenant's rows, its
 * filters narrow correctly, its pagination tells the truth about the total,
 * and the compliance badge lands on the right side of the window at both
 * edges once a real `sent_at` and a real merchant record are involved.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

const DB_URL =
  process.env.TEST_DB_URL ?? "postgres://postgres:tally@localhost:55432/tally";
const POSTGREST_PORT = Number(process.env.TEST_POSTGREST_PORT ?? 54331);

let pool: Pool;
let proxy: Server;

before(async () => {
  pool = new Pool({ connectionString: DB_URL, max: 8 });
  proxy = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/^\/rest\/v1/, "");
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: POSTGREST_PORT,
        path,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${POSTGREST_PORT}` },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 500, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(upstream);
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));

  process.env.SUPABASE_URL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.TEST_SERVICE_JWT ?? "";
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

after(async () => {
  await pool.end();
  await new Promise<void>((r) => proxy.close(() => r()));
});

import { listActions } from "../../src/lib/audit";
import type { Merchant } from "../../src/lib/types";

let mandateId: string;
let swaseekhId: string;
let mandate: Merchant;

async function seedMerchant(
  name: string,
  over: { window_start?: string; window_end?: string; timezone?: string } = {},
): Promise<Merchant> {
  const { rows } = await pool.query(
    `insert into merchants
       (business_name, razorpay_key_id, razorpay_key_secret, webhook_secret,
        contact_window_start, contact_window_end, timezone)
     values ($1,'enc','enc','w',$2,$3,$4) returning *`,
    [
      name,
      over.window_start ?? "08:00:00",
      over.window_end ?? "19:00:00",
      over.timezone ?? "Asia/Kolkata",
    ],
  );
  return rows[0] as Merchant;
}

async function seedCustomer(merchantId: string, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into customers (merchant_id, name, email)
     values ($1,$2,$3) returning id`,
    [merchantId, name, `${randomBytes(4).toString("hex")}@example.test`],
  );
  return rows[0].id;
}

async function seedEvent(merchantId: string, customerId: string | null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into events (merchant_id, customer_id, type, reason, amount)
     values ($1,$2,'payment_failed','insufficient_funds',100000) returning id`,
    [merchantId, customerId],
  );
  return rows[0].id;
}

async function seedAction(
  eventId: string,
  merchantId: string,
  over: {
    channel?: string | null;
    outcome?: string;
    sentAt?: string | null;
    createdAt?: string;
    decision?: Record<string, unknown> | null;
  } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into actions (event_id, merchant_id, channel, outcome, sent_at, created_at, decision)
     values ($1,$2,$3,$4,$5, coalesce($6::timestamptz, now()), $7) returning id`,
    [
      eventId,
      merchantId,
      over.channel ?? null,
      over.outcome ?? "sent",
      over.sentAt ?? null,
      over.createdAt ?? null,
      over.decision ? JSON.stringify(over.decision) : null,
    ],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await pool.query("truncate merchants, customers, events, actions cascade");
  mandate = await seedMerchant("Mandate");
  mandateId = mandate.id;
  swaseekhId = (await seedMerchant("Swaseekh")).id;
});

describe("tenant isolation", () => {
  test("never returns another merchant's rows", async () => {
    const theirEvent = await seedEvent(swaseekhId, await seedCustomer(swaseekhId, "Theirs"));
    await seedAction(theirEvent, swaseekhId, { channel: "email", outcome: "sent" });

    const page = await listActions(mandate);
    assert.equal(page.total, 0);
    assert.deepEqual(page.rows, []);
  });

  test("a guessed customer id from another tenant returns nothing", async () => {
    const theirCustomer = await seedCustomer(swaseekhId, "Theirs");
    const theirEvent = await seedEvent(swaseekhId, theirCustomer);
    await seedAction(theirEvent, swaseekhId, { channel: "email", outcome: "sent" });

    const page = await listActions(mandate, { customerId: theirCustomer });
    assert.equal(page.total, 0);
  });
});

describe("filters", () => {
  test("by customer", async () => {
    const asha = await seedCustomer(mandateId, "Asha");
    const bimal = await seedCustomer(mandateId, "Bimal");
    const ashaEvent = await seedEvent(mandateId, asha);
    const bimalEvent = await seedEvent(mandateId, bimal);
    await seedAction(ashaEvent, mandateId, { channel: "email", outcome: "sent" });
    await seedAction(bimalEvent, mandateId, { channel: "whatsapp", outcome: "sent" });

    const page = await listActions(mandate, { customerId: asha });
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].customer_name, "Asha");
  });

  test("by action type - sent covers a failed attempt too, not only a delivered one", async () => {
    const asha = await seedCustomer(mandateId, "Asha");
    const event = await seedEvent(mandateId, asha);
    await seedAction(event, mandateId, { channel: "email", outcome: "sent" });
    await seedAction(event, mandateId, { channel: "email", outcome: "failed" });
    await seedAction(event, mandateId, { channel: null, outcome: "skipped" });
    await seedAction(event, mandateId, { channel: null, outcome: "escalated" });
    await seedAction(event, mandateId, { channel: null, outcome: "no_action" });

    assert.equal((await listActions(mandate, { type: "sent" })).total, 2);
    assert.equal((await listActions(mandate, { type: "blocked" })).total, 1);
    assert.equal((await listActions(mandate, { type: "escalated" })).total, 1);
    assert.equal((await listActions(mandate, { type: "inaction" })).total, 1);
  });

  test("carries the guardrail reason and rationale straight off the decision column", async () => {
    const asha = await seedCustomer(mandateId, "Asha");
    const event = await seedEvent(mandateId, asha);
    await seedAction(event, mandateId, {
      channel: null,
      outcome: "skipped",
      decision: {
        root_cause: "unknown",
        intervention: "stop",
        channel: null,
        rationale: "Skipped - Overdue invoice recovery is switched off for this business.",
        source: "guardrail",
        guardrail: "workflow_disabled",
      },
    });

    const [row] = (await listActions(mandate)).rows;
    assert.equal(row.guardrail, "workflow_disabled");
    assert.match(row.rationale ?? "", /switched off/);
    assert.equal(row.channel, null, "an inaction row shows no channel");
  });
});

describe("pagination", () => {
  test("pages without lying about the total", async () => {
    const asha = await seedCustomer(mandateId, "Asha");
    const event = await seedEvent(mandateId, asha);
    for (let i = 0; i < 7; i++) {
      await seedAction(event, mandateId, {
        channel: "email",
        outcome: "sent",
        createdAt: new Date(Date.now() - i * 1000).toISOString(),
      });
    }

    const first = await listActions(mandate, { limit: 3, offset: 0 });
    assert.equal(first.rows.length, 3);
    assert.equal(first.total, 7, "the count is of the whole result, not the page");

    const last = await listActions(mandate, { limit: 3, offset: 6 });
    assert.equal(last.rows.length, 1);
  });

  test("orders most recent first", async () => {
    const asha = await seedCustomer(mandateId, "Asha");
    const event = await seedEvent(mandateId, asha);
    await seedAction(event, mandateId, {
      channel: "email",
      outcome: "sent",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await seedAction(event, mandateId, {
      channel: "whatsapp",
      outcome: "sent",
      createdAt: new Date().toISOString(),
    });

    const { rows } = await listActions(mandate);
    assert.equal(rows[0].channel, "whatsapp");
    assert.equal(rows[1].channel, "email");
  });
});

describe("the compliance badge, end to end", () => {
  test("a send stamped exactly on the opening minute passes", async () => {
    const asha = await seedCustomer(mandateId, "Asha");
    const event = await seedEvent(mandateId, asha);
    // Mandate's window is 08:00-19:00 Asia/Kolkata (UTC+5:30) - 02:30 UTC is
    // 08:00 IST exactly.
    const sentAt = "2026-06-15T02:30:00.000Z";
    await seedAction(event, mandateId, { channel: "email", outcome: "sent", sentAt });

    const [row] = (await listActions(mandate)).rows;
    assert.equal(row.in_window, true);
  });

  test("a send stamped exactly on the closing minute passes", async () => {
    const asha = await seedCustomer(mandateId, "Asha");
    const event = await seedEvent(mandateId, asha);
    // 13:30 UTC is 19:00 IST exactly.
    const sentAt = "2026-06-15T13:30:00.000Z";
    await seedAction(event, mandateId, { channel: "email", outcome: "sent", sentAt });

    const [row] = (await listActions(mandate)).rows;
    assert.equal(row.in_window, true);
  });

  test("a send one minute past either edge fails", async () => {
    const asha = await seedCustomer(mandateId, "Asha");
    const event = await seedEvent(mandateId, asha);
    await seedAction(event, mandateId, {
      channel: "email",
      outcome: "sent",
      sentAt: "2026-06-15T02:29:00.000Z", // 07:59 IST
    });
    await seedAction(event, mandateId, {
      channel: "email",
      outcome: "sent",
      sentAt: "2026-06-15T13:31:00.000Z", // 19:01 IST
    });

    const { rows } = await listActions(mandate);
    assert.ok(rows.every((r) => r.in_window === false));
  });

  test("an inaction row is neither compliant nor non-compliant", async () => {
    const asha = await seedCustomer(mandateId, "Asha");
    const event = await seedEvent(mandateId, asha);
    await seedAction(event, mandateId, { channel: null, outcome: "no_action", sentAt: null });

    const [row] = (await listActions(mandate)).rows;
    assert.equal(row.in_window, null);
  });

  test("honours a merchant that configured a different window", async () => {
    const narrow = await seedMerchant("Narrow", { window_start: "10:00:00", window_end: "12:00:00" });
    const cust = await seedCustomer(narrow.id, "Asha");
    const event = await seedEvent(narrow.id, cust);
    // 09:00 IST - inside Mandate's window, outside Narrow's.
    await seedAction(event, narrow.id, {
      channel: "email",
      outcome: "sent",
      sentAt: "2026-06-15T03:30:00.000Z",
    });

    const [row] = (await listActions(narrow)).rows;
    assert.equal(row.in_window, false);
  });
});
