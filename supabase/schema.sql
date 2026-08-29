-- ===========================================================================
-- Tally - schema
--
-- One shared database. Every merchant is a row, not a deployment.
-- Every table below carries merchant_id and every query is scoped by it.
--
-- Columns marked [core] are from the product spec. Columns marked [+] are
-- additions the Section 6 use cases require - each one is annotated with the
-- use case that forced it. Nothing here is speculative.
-- ===========================================================================

create extension if not exists pgcrypto;

-- --- merchants -------------------------------------------------------------
-- Credentials live here, encrypted, one row per merchant. Never in .env.
create table if not exists merchants (
  id                    uuid primary key default gen_random_uuid(),
  business_name         text        not null,

  -- AES-256-GCM ciphertext, format: v1:<iv>:<tag>:<ciphertext> (all base64).
  -- Written only by the onboarding flow, read only by the acting worker.
  razorpay_key_id       text        not null,
  razorpay_key_secret   text        not null,

  -- Verifies inbound Razorpay webhook signatures. Plaintext by necessity: it
  -- is HMAC'd on every webhook, and it is a shared secret with Razorpay rather
  -- than a credential that can act on the merchant's behalf.
  webhook_secret        text        not null,

  whatsapp_number       text,                    -- encrypted, nullable
  voice_number          text,                    -- encrypted, nullable

  -- Compliance window. Local wall-clock times, interpreted in `timezone`.
  contact_window_start  time        not null default '08:00',
  contact_window_end    time        not null default '19:00',
  timezone              text        not null default 'Asia/Kolkata',  -- [+] window is meaningless without it

  max_attempts          int         not null default 3,
  channels_enabled      text[]      not null default array['email','whatsapp','voice'],

  active                boolean     not null default true,  -- [+] pause a merchant without deleting them
  created_at            timestamptz not null default now(),

  constraint merchants_channels_valid check (
    channels_enabled <@ array['email','whatsapp','voice']::text[]
  ),
  constraint merchants_max_attempts_sane check (max_attempts between 1 and 10)
);

-- --- customers -------------------------------------------------------------
create table if not exists customers (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid not null references merchants(id) on delete cascade,
  name         text,
  email        text,
  phone        text,
  opted_out    boolean     not null default false,
  created_at   timestamptz not null default now(),

  -- A customer must be reachable somehow, or there is nothing to recover with.
  constraint customers_contactable check (email is not null or phone is not null)
);

-- Identity is per-merchant: the same human at two merchants is two rows, and
-- neither merchant can infer the other's customer list.
create unique index if not exists customers_merchant_email_key
  on customers (merchant_id, lower(email)) where email is not null;
create unique index if not exists customers_merchant_phone_key
  on customers (merchant_id, phone) where phone is not null;

-- --- events ----------------------------------------------------------------
create table if not exists events (
  id             uuid primary key default gen_random_uuid(),
  merchant_id    uuid not null references merchants(id) on delete cascade,
  customer_id    uuid          references customers(id) on delete set null,

  type           text not null,
  reason         text,                 -- classified root cause, e.g. insufficient_funds
  amount         bigint,               -- paise. integer money only, never float.
  currency       text not null default 'INR',
  status         text not null default 'queued',
  due_date       date,

  -- Worker claim fields - the SKIP LOCKED pattern writes these.
  claimed_by     text,
  claimed_at     timestamptz,

  -- [+] use case 16: duplicate webhook deliveries must never double-create.
  provider_event_id text,
  -- [+] use cases 5, 7, 8: retries are scheduled, not immediate. This is the
  -- salary-date / promise-to-pay / mandate-sequencer clock.
  next_attempt_at   timestamptz,
  -- [+] stopping rules (attempt caps) need a counter that survives restarts.
  attempts          int  not null default 0,
  -- [+] audit: *why* the agent stopped, not just that it did.
  stop_reason       text,
  -- [+] recovery rate needs the recovered figure separate from the attempted one.
  recovered_amount  bigint,
  -- [+] raw provider payload + derived context (order id, card network, ...)
  metadata          jsonb not null default '{}'::jsonb,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint events_type_valid check (type in (
    'payment_failed', 'subscription_failed', 'cart_abandoned',
    'promise_to_pay', 'receivable_overdue', 'mandate_retry'
  )),
  constraint events_status_valid check (status in (
    'queued', 'processing', 'recovered', 'unrecoverable', 'stopped'
  )),
  constraint events_amount_nonneg check (amount is null or amount >= 0)
);

-- Idempotency. Razorpay retries webhook deliveries; this makes a replay a
-- no-op insert rather than a second dunning message to the same customer.
create unique index if not exists events_merchant_provider_event_key
  on events (merchant_id, provider_event_id) where provider_event_id is not null;

-- The worker's hot path: find claimable work, cheaply.
create index if not exists events_claimable_idx
  on events (merchant_id, created_at) where status = 'queued';
create index if not exists events_next_attempt_idx
  on events (next_attempt_at) where status = 'queued' and next_attempt_at is not null;
-- Reclaiming events abandoned by a worker that died mid-flight.
create index if not exists events_processing_idx
  on events (claimed_at) where status = 'processing';
-- [+] use case 13: "what else is open for this customer right now?"
create index if not exists events_customer_open_idx
  on events (customer_id, status) where customer_id is not null;
create index if not exists events_merchant_created_idx
  on events (merchant_id, created_at desc);

-- --- actions ---------------------------------------------------------------
-- The audit trail. One row per thing the agent actually did, including the
-- decisions where it deliberately did nothing.
create table if not exists actions (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references events(id) on delete cascade,
  -- [+] denormalized so per-merchant dashboard stats never need a join fan-out,
  -- and so an action can never be read outside its tenant by mistake.
  merchant_id uuid not null references merchants(id) on delete cascade,

  channel     text,                  -- email | whatsapp | voice | null (no-op decisions)
  message     text,
  sent_at     timestamptz,
  response    text,
  outcome     text not null default 'pending',

  -- [+] the "why". Full decision record: reason, chosen channel, rationale,
  -- which rule fired, which model produced it.
  decision    jsonb,
  created_at  timestamptz not null default now(),

  constraint actions_channel_valid check (
    channel is null or channel in ('email','whatsapp','voice')
  ),
  constraint actions_outcome_valid check (outcome in (
    'pending','sent','delivered','failed','skipped','no_action','escalated'
  ))
);

create index if not exists actions_event_idx on actions (event_id, created_at);
create index if not exists actions_merchant_idx on actions (merchant_id, created_at desc);

-- ===========================================================================
-- The worker claim: FOR UPDATE SKIP LOCKED, round-robin across merchants.
--
-- Two properties this must have, both load-bearing:
--
--  1. No double-processing. SKIP LOCKED steps over rows another worker holds
--     instead of blocking on them. The outer `status = 'queued'` predicate is
--     NOT redundant with the one in `candidates`: under READ COMMITTED,
--     Postgres re-evaluates the outer qual against the *new* row version after
--     the lock is acquired (EvalPlanQual). Without it, a row a concurrent
--     worker already claimed and committed would slip through, because the
--     CTE's predicate was evaluated against the older snapshot.
--
--  2. Fairness. row_number() partitioned by merchant_id, ordered by rn first,
--     interleaves merchants: every merchant's oldest event is served before
--     anyone's second. One merchant dumping 500 failures cannot starve the
--     other 299.
-- ===========================================================================
create or replace function claim_events(p_worker text, p_limit int default 20)
returns setof events
language sql
as $fn$
  with candidates as (
    select e.id,
           row_number() over (
             partition by e.merchant_id
             order by e.created_at, e.id
           ) as rn
    from events e
    join merchants m on m.id = e.merchant_id
    where e.status = 'queued'
      and m.active
      and (e.next_attempt_at is null or e.next_attempt_at <= now())
  ),
  locked as (
    select e.id
    from events e
    join candidates c on c.id = e.id
    where e.status = 'queued'          -- see note 1 above: do not remove
    order by c.rn, e.created_at
    limit p_limit
    for update of e skip locked
  )
  update events t
     set status     = 'processing',
         claimed_by = p_worker,
         claimed_at = now(),
         updated_at = now()
    from locked l
   where t.id = l.id
  returning t.*;
$fn$;

-- ===========================================================================
-- Webhook ingestion, as one atomic step.
--
-- This is a database function rather than a few client calls for two reasons:
--
--  1. The unique indexes it needs to conflict against are *partial*
--     (`where email is not null`). PostgREST cannot express the predicate an
--     ON CONFLICT arbiter needs for those, so the insert has to happen where
--     real SQL can be written.
--  2. Resolving the customer and creating the event must be one transaction.
--     Razorpay delivers the same webhook more than once and often in parallel;
--     doing this in two client round-trips races with itself and produces
--     duplicate customers.
--
-- Returns the event either way. On a replay it returns the *existing* row, so
-- the caller cannot tell the difference and the customer is never messaged
-- twice (use case 16).
-- ===========================================================================
create or replace function ingest_event(
  p_merchant_id       uuid,
  p_provider_event_id text,
  p_type              text,
  p_reason            text,
  p_amount            bigint,
  p_currency          text,
  p_due_date          date,
  p_customer_name     text,
  p_customer_email    text,
  p_customer_phone    text,
  p_metadata          jsonb
) returns events
language plpgsql
as $fn$
declare
  v_customer_id uuid;
  v_event       events;
begin
  -- Resolve or create the customer, always scoped to this merchant.
  if p_customer_email is not null or p_customer_phone is not null then
    insert into customers (merchant_id, name, email, phone)
    values (p_merchant_id, p_customer_name, p_customer_email, p_customer_phone)
    on conflict do nothing
    returning id into v_customer_id;

    if v_customer_id is null then
      -- Lost the race, or the customer already existed. Find them.
      select id into v_customer_id
        from customers
       where merchant_id = p_merchant_id
         and ( (p_customer_email is not null and lower(email) = lower(p_customer_email))
            or (p_customer_phone is not null and phone = p_customer_phone) )
       limit 1;

      -- Fill in a detail we did not have before (phone arrives with a UPI
      -- failure, email with a card one - same person, one row).
      update customers
         set email = coalesce(email, p_customer_email),
             phone = coalesce(phone, p_customer_phone),
             name  = coalesce(name,  p_customer_name)
       where id = v_customer_id;
    end if;
  end if;

  insert into events (
    merchant_id, customer_id, type, reason, amount, currency,
    due_date, provider_event_id, metadata
  ) values (
    p_merchant_id, v_customer_id, p_type, p_reason, p_amount,
    coalesce(p_currency, 'INR'), p_due_date, p_provider_event_id,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (merchant_id, provider_event_id)
    where provider_event_id is not null
    do nothing
  returning * into v_event;

  if v_event.id is null then
    -- Replay. Hand back the row we already have.
    select * into v_event
      from events
     where merchant_id = p_merchant_id
       and provider_event_id = p_provider_event_id;
  end if;

  return v_event;
end
$fn$;

-- A worker that dies mid-event leaves the row in 'processing' forever.
-- Put it back on the queue once its claim has gone stale.
create or replace function reclaim_stale_events(p_older_than_seconds int default 300)
returns setof events
language sql
as $fn$
  update events t
     set status     = 'queued',
         claimed_by = null,
         claimed_at = null,
         updated_at = now()
   where t.id in (
     select e.id from events e
      where e.status = 'processing'
        and e.claimed_at < now() - make_interval(secs => p_older_than_seconds)
      for update of e skip locked
   )
  returning t.*;
$fn$;

-- ===========================================================================
-- Dashboard aggregation.
--
-- These are database functions because PostgREST cannot express GROUP BY, and
-- pulling every event to the application to count them in JavaScript stops
-- working at exactly the point a merchant is successful enough to care.
--
-- All three take a merchant id and filter on it. There is no unscoped variant,
-- deliberately - a reporting query is the easiest place to leak another
-- tenant's numbers.
-- ===========================================================================
create or replace function merchant_stats(
  p_merchant_id uuid,
  p_since       timestamptz default now() - interval '30 days'
) returns jsonb
language sql stable
as $fn$
  select jsonb_build_object(
    'total_events',   count(*),
    'recovered',      count(*) filter (where status = 'recovered'),
    'open',           count(*) filter (where status in ('queued','processing')),
    'stopped',        count(*) filter (where status = 'stopped'),
    'unrecoverable',  count(*) filter (where status = 'unrecoverable'),
    -- Money still chaseable, and money actually returned. `recovered_amount`
    -- falls back to the original amount when the provider did not tell us a
    -- figure, which is the common case for a full payment.
    'amount_at_risk',
      coalesce(sum(amount) filter (where status in ('queued','processing')), 0),
    'amount_recovered',
      coalesce(sum(coalesce(recovered_amount, amount)) filter (where status = 'recovered'), 0),
    'recovery_rate',
      case when count(*) filter (where status <> 'queued') = 0 then 0
           else round(
             100.0 * count(*) filter (where status = 'recovered')
                   / count(*) filter (where status <> 'queued'), 1)
      end
  )
  from events
  where merchant_id = p_merchant_id
    and created_at >= p_since;
$fn$;

-- "Most common failure reasons this week" - the root-cause insight.
create or replace function merchant_failure_reasons(
  p_merchant_id uuid,
  p_since       timestamptz default now() - interval '7 days'
) returns table (
  reason         text,
  event_count    bigint,
  amount_total   bigint,
  recovered_count bigint
)
language sql stable
as $fn$
  select coalesce(e.reason, 'unknown') as reason,
         count(*)                       as event_count,
         coalesce(sum(e.amount), 0)     as amount_total,
         count(*) filter (where e.status = 'recovered') as recovered_count
  from events e
  where e.merchant_id = p_merchant_id
    and e.created_at >= p_since
  group by 1
  order by event_count desc, amount_total desc;
$fn$;

-- Which channels are actually working, per merchant.
create or replace function merchant_channel_performance(
  p_merchant_id uuid,
  p_since       timestamptz default now() - interval '30 days'
) returns table (
  channel     text,
  sent        bigint,
  failed      bigint,
  recovered   bigint
)
language sql stable
as $fn$
  select a.channel,
         count(*) filter (where a.outcome in ('sent','delivered'))    as sent,
         count(*) filter (where a.outcome = 'failed')                 as failed,
         count(distinct e.id) filter (where e.status = 'recovered')   as recovered
  from actions a
  join events e on e.id = a.event_id
  where a.merchant_id = p_merchant_id
    and a.channel is not null
    and a.created_at >= p_since
  group by a.channel
  order by sent desc;
$fn$;

-- --- Row Level Security ----------------------------------------------------
-- Tally's server acts with the service-role key, which bypasses RLS. Enabling
-- RLS with no policies means a leaked anon/publishable key reads nothing at
-- all, rather than reading every merchant's data.
alter table merchants enable row level security;
alter table customers enable row level security;
alter table events    enable row level security;
alter table actions   enable row level security;
