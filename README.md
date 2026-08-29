# Tally

An AI revenue recovery agent for Razorpay merchants. A business connects its
own Razorpay keys once; from then on Tally listens for failed payments, works
out *why* each one failed, and recovers it over email, WhatsApp, or a phone
call — inside guardrails the merchant sets.

Multi-tenant from the first commit: one engine, one database, one row per
merchant. 300 merchants is 300 rows, not 300 deployments.

---

## Quick start

```bash
npm install
cp .env.example .env          # fill in what you have; see "Configuration"
npm run stack:up              # local Postgres + PostgREST in Docker
npm run dev
```

Then open `/docs` for the setup guide and `/onboarding` to connect a business.

Against a real Supabase project instead of the local stack:

```bash
npm run db:push               # applies supabase/schema.sql
npm run dev
```

---

## How it works

```
Razorpay webhook  ─►  /api/webhooks/razorpay/[merchantId]
                        verify signature (that merchant's secret)
                        classify the failure reason
                        write one row to `events`, respond 200
                        (no sending, no model calls — Razorpay retries
                         anything slow, and a slow webhook is how a bad
                         afternoon becomes a retry storm)

Customer replies ►  /api/webhooks/whatsapp
                        verify Twilio signature (reject forgeries)
                        "STOP"            -> opt out, stop every open event
                        "I'll pay Friday" -> tracked promise_to_pay + due date
                        "already paid"    -> flag for a human
                        every reply logged to the same audit trail

Vercel Cron ─────►  /api/cron/worker  ─►  runWorker()
                        claim_events()   FOR UPDATE SKIP LOCKED,
                                         round-robin across merchants
                        preflight()      hard stops, before any tokens
                        decide()         the model picks the intervention
                        clamp()          guardrails constrain the choice
                        dispatch()       email / WhatsApp / voice
                        recordAction()   the audit trail, always
```

The agent proposes; the guardrails dispose. No prompt can talk Tally into
messaging someone who opted out, retrying a card that physically cannot work,
or calling a customer at 3am — those are decisions in code, not in the model.

### Why the reason matters

The whole product is that a failed payment is not one thing:

| Cause | What Tally does |
|---|---|
| Insufficient funds | Waits for a likely salary-credit date (1st / 7th / 15th). Retrying tonight fails again. |
| Expired or blocked card | Never retries. Asks for a different payment method. |
| Gateway timeout / bank down | Retries quietly and apologises. Never implies the customer was declined. |
| OTP not completed | A fresh link, immediately. No explanation demanded. |
| International decline | Suggests a domestic card or UPI, not a plain retry. |
| Risk / fraud flag | Stops automating. Escalates to a human. |

---

## Configuration

Two kinds of credential, kept strictly separate:

**Platform-level** (`.env`) — what Tally itself needs to run. See
`.env.example` for the annotated list.

**Per-merchant** — a merchant's own Razorpay keys, WhatsApp number, and contact
preferences. Entered through the onboarding UI, encrypted with AES-256-GCM, and
stored in their `merchants` row. Never in `.env`, never shared between
merchants.

Credential ciphertext is bound to the column it belongs to (AES-GCM additional
authenticated data), so a ciphertext cannot be moved from `razorpay_key_id`
onto `razorpay_key_secret` and still decrypt.

Nothing reads the environment at import time. A missing variable surfaces when
the feature that needs it runs, naming exactly which variable is missing —
an unconfigured voice channel does not stop email from working.

---

## The model backend

The decision engine runs on either Claude or Gemini. Nothing else in the
codebase changes when you switch — the guardrails, worker and audit trail only
depend on getting back a schema-valid decision.

```
TALLY_LLM_PROVIDER=gemini      # or "anthropic"; if unset, whichever key is set
GEMINI_API_KEY=...             # GEMINI_MODEL defaults to gemini-3.5-flash
ANTHROPIC_API_KEY=...          # ANTHROPIC_MODEL defaults to claude-opus-5
```

Every response is validated against the same Zod schema before it reaches the
guardrails, so a model returning valid JSON of the wrong shape is rejected
rather than acted on. Transient upstream failures (429, 5xx, network) are
retried with backoff; permanent ones (400, bad key) are not. If a provider is
unreachable or unconfigured, decisions fall back to templates keyed off the root
cause — recovery keeps working, it just stops being clever.

Model notes, learned the hard way:
- Gemini's Pro tiers are quota-limited on free keys (429), and the `-latest`
  aliases return 503 under load. `gemini-3.5-flash` is the reliable default.
- On `@anthropic-ai/sdk` 0.71.x, structured output goes in the top-level
  `output_format`, **not** `output_config.format`. The parser reads the former;
  using the latter makes `parsed_output` silently null and sends every decision
  down the fallback path with no error.
- `betaZodOutputFormat` calls `z.toJSONSchema`, which is Zod 4 only. The SDK's
  peer range claims Zod 3.25 works; it does not.

---

## Tests

```bash
npm test          # unit: crypto, classification, guardrails, agent wiring, channels
npm run stack:up  # Docker Postgres + PostgREST
npm run test:db   # integration: concurrency, ingestion, the full pipeline, insights
```

The integration tests run against a real Postgres behind a real PostgREST, using
the real `@supabase/supabase-js` client. Only two things are faked: the model
endpoint (so decisions are deterministic) and the outbound transport (so a test
run does not message anyone).

Some things a mock cannot show you, so these are tested for real:

- **No double-claiming.** 200 events, 8 concurrent workers, every event claimed
  exactly once. The test is mutation-checked: deleting the `status = 'queued'`
  recheck in `claim_events` makes it fail with *"an event was claimed by two
  workers"*.
- **Idempotency.** Eight parallel deliveries of the same webhook produce one
  event and one customer.
- **Tenant isolation.** Two merchants processed concurrently; no action, event,
  or customer crosses the boundary.

---

## The batch run

```bash
npm run batch -- --dry-run --per-merchant=15   # records sends instead of making them
npm run batch                                   # real messages to real people
```

The invariant checks at the end are the point — it is easy to send a lot of
messages and much harder to prove none of them broke a rule. Every check queries
Postgres directly rather than trusting the worker's own report, because a worker
reporting a clean run is exactly what a bug would also look like.

---

## Layout

```
supabase/schema.sql        tables, the SKIP LOCKED claim, ingestion, aggregation
src/lib/
  crypto.ts                AES-256-GCM credential encryption, signature checks
  classify.ts              Razorpay failure -> root cause, and what fixes it
  merchants.ts             onboarding; the only module that touches credentials
  events.ts                event + action repository, always merchant-scoped
  razorpay.ts              webhook payload normalisation, retry links
  insights.ts              dashboard aggregation
  agent/
    rules.ts               guardrails: windows, caps, scheduling, the clamp
    prompt.ts              the decision prompt
    decide.ts              decision + template fallback
    providers/             Claude and Gemini backends behind one interface
    worker.ts              claim -> decide -> act -> record
  inbound.ts               understanding replies: opt-out, promise-to-pay
  channels/                email (Resend), whatsapp + voice (Twilio)
src/components/            dashboard UI: charts, filters, tables, forms
src/app/
  (marketing)/             landing, docs, onboarding - the pages with a top bar
  dashboard/[slug]/        the merchant dashboard, five sections, own sidebar
  api/                     onboarding, settings, webhooks, the cron tick
scripts/                   local stack, schema push, seed, worker, batch run
```

### The dashboard

A merchant lands on `/dashboard/<business-name>` after onboarding — the slug is
assigned by a database trigger, deduped if two businesses share a name, and the
old `/dashboard/<uuid>` links still resolve. Five sections:

| Section | Answers |
|---|---|
| Overview | Is the agent earning its keep? Money, trend, causes, recent decisions. |
| Events | Every recovery case, filterable by status and type, searchable by customer. |
| Customers | Who keeps failing, who has opted out, who has been recovered. |
| Agent activity | The full audit trail, including the actions it decided *against*. |
| Settings | Contact window, channels, attempt cap, pause switch, webhook URL. |

Every page is server-rendered and merchant-scoped; the only client code is the
hover layer on the charts, the filter row, and the settings form.

---

## Known limitations

- **Voice needs `TWILIO_PHONE_NUMBER`.** With it blank the channel reports
  itself unconfigured and the agent escalates to another channel instead.
- **WhatsApp uses the Twilio Sandbox.** A recipient must send the sandbox join
  code before they can receive anything. Fine for testing with people you know,
  not suitable for real customers. The production path — the merchant connecting
  their own WhatsApp Business sender — changes only the `from` resolution in
  `channels/whatsapp.ts`; it is documented but deliberately not built.
- **Voice is scripted text-to-speech**, not a conversation. A back-and-forth
  Hinglish agent is the upgrade path, not what ships here.
- **Contact-window arithmetic assumes a stable UTC offset.** Exact for
  `Asia/Kolkata` (no DST); in a DST zone it can be an hour out on the single
  transition night.
- **Cross-worker message coordination is time-bounded, not locked.** Two workers
  claiming a customer's two open events in the same instant is guarded by a
  six-hour recent-contact check rather than a per-customer lock.
