# Deploying Tally to Vercel

Tally is a standard Next.js app, so the deploy itself is unremarkable. Three
things about *this* app are easy to get wrong, and each one fails quietly
rather than loudly:

1. `TALLY_PUBLIC_URL` must match the real domain, or Twilio replies 403 and
   merchants are handed the wrong webhook URL.
2. The Hobby plan runs cron **once per day**, which is not often enough for a
   recovery agent. Use an external scheduler.
3. The Hobby plan caps a function at **60 seconds**, so the worker batch is
   sized to fit rather than being allowed to run long.

---

## 1. Deploy

The repo is already on GitHub, so importing it is the shortest path.

**Dashboard:** vercel.com/new → import `Mudavath-Giri-Naik/Tally` → Deploy.
Framework, build command and output directory are all detected; change nothing.

**Or the CLI:**

```bash
npm i -g vercel
vercel login
vercel link          # connect this folder to a Vercel project
vercel               # preview deploy
```

The first deploy will build fine and then behave oddly at runtime, because no
environment variables exist yet. That is expected — the next step fixes it.

## 2. Push the environment variables

Twenty-odd variables is too many to paste by hand:

```bash
bash scripts/vercel-env.sh production
```

This reads `.env` and skips the variables that are local-only (`SUPABASE_DB_URL`,
and the `MANDATE_*` / `SWASEEKH_*` seed keys — real merchants enter their own
Razorpay keys through the onboarding UI).

Or add them in the dashboard under **Settings → Environment Variables**.

## 3. Fix `TALLY_PUBLIC_URL`, then redeploy

This is the chicken-and-egg step. You do not know the domain until after the
first deploy, and several things read it:

- the Twilio signature check on `/api/webhooks/whatsapp`
- the per-merchant Razorpay webhook URL shown after onboarding
- dashboard links

```bash
vercel env rm TALLY_PUBLIC_URL production --yes
printf 'https://your-app.vercel.app' | vercel env add TALLY_PUBLIC_URL production
vercel --prod
```

No trailing slash. Use your custom domain if you have one — whatever you paste
into Twilio and Razorpay must be the same host.

## 4. Point Twilio at the deployment

Twilio Console → Messaging → Try it out → **WhatsApp Sandbox Settings**:

| Field | Value |
|---|---|
| When a message comes in | `https://your-app.vercel.app/api/webhooks/whatsapp` |
| Method | `POST` |

Send `STOP` from a phone that has joined the sandbox, then check the customer
row — `opted_out` should flip to `true` and their open events should stop. A
403 here almost always means `TALLY_PUBLIC_URL` does not match the URL you
pasted.

## 5. Point Razorpay at the deployment

Each merchant gets their own URL, shown on their dashboard and after onboarding:

```
https://your-app.vercel.app/api/webhooks/razorpay/<merchant-id>
```

Because the URL is derived from `TALLY_PUBLIC_URL` at render time, existing
merchants pick up the new domain automatically — but anyone who already pasted
a localhost URL into Razorpay needs to update it there.

---

## The cron problem

`vercel.json` ships with an hourly schedule, because **Vercel's Hobby plan only
permits one cron execution per day** and a more frequent schedule is rejected at
deploy time. Hourly is the compromise that deploys everywhere; neither is fast
enough for real recovery work.

**On Pro**, edit `vercel.json` to run every minute and raise the batch:

```json
{ "path": "/api/cron/worker?batch=20", "schedule": "* * * * *" }
```

and raise `maxDuration` in `src/app/api/cron/worker/route.ts` from `60` to `300`.

**On Hobby**, leave the Vercel cron as a safety net and drive the worker from a
free external scheduler instead — [cron-job.org](https://cron-job.org),
GitHub Actions, or any uptime pinger:

```
URL:     https://your-app.vercel.app/api/cron/worker?batch=5
Method:  GET
Header:  Authorization: Bearer <your CRON_SECRET>
Every:   1 minute
```

The endpoint is protected by `CRON_SECRET` and is safe to call concurrently —
`claim_events` uses `FOR UPDATE SKIP LOCKED`, so two overlapping runs never
process the same event twice.

### Why the batch is only 5

Each event costs roughly 7–9 seconds end to end: one model call, a Razorpay
payment-link creation, and a send. Five fits inside the 60-second Hobby ceiling
with room to spare; twenty would be cut off around event seven.

Being cut off is not data loss — interrupted events stay in `processing` and
`reclaim_stale_events` returns them to the queue after five minutes — but it
wastes a run. Size the batch to the timeout.

---

## Verifying the deployment

```bash
# 1. the app is up
curl -s -o /dev/null -w '%{http_code}\n' https://your-app.vercel.app/

# 2. the inbound endpoint is listening
curl -s https://your-app.vercel.app/api/webhooks/whatsapp

# 3. it rejects unsigned requests (must be 403 — if this returns 200, stop
#    and check TWILIO_AUTH_TOKEN is set in Vercel)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://your-app.vercel.app/api/webhooks/whatsapp \
  -d 'From=whatsapp:+919999999999&Body=STOP'

# 4. the worker runs
curl -s -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.vercel.app/api/cron/worker
```

The worker returns its report as JSON, so a healthy tick with nothing to do
looks like `{"claimed":0,...}` rather than an error.

---

## Things that will catch you out

- **A 403 from the WhatsApp endpoint** is nearly always `TALLY_PUBLIC_URL`
  disagreeing with the URL configured in Twilio. They must match exactly,
  including `https://` and no trailing slash.
- **Environment variables are per-environment.** Setting them for Production
  does not set them for Preview, so preview deploys will behave as though
  nothing is configured.
- **Changing an environment variable does not redeploy.** Run `vercel --prod`
  again, or the running deployment keeps the old value.
- **`CREDENTIAL_ENCRYPTION_KEY` must be identical** to the one used when a
  merchant onboarded. Deploy a different key and every stored Razorpay
  credential becomes undecryptable, and the dashboard shows
  "unreadable - key rotated".
- **Recovery numbers stay at zero** unless `order.paid` and
  `subscription.charged` are subscribed in Razorpay. Tally only counts a
  recovery when the provider confirms payment, never when a message was sent.
