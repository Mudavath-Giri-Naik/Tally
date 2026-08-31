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

  -- [+] Workflows: which of the four kinds of recovery this merchant runs.
  -- Chosen at onboarding from their business type, editable in settings. The
  -- default is all four - a merchant who never chose is better served by Tally
  -- chasing something it need not have than by silently ignoring real lost
  -- revenue. See src/lib/workflows.ts, which owns the mapping from an event to
  -- one of these.
  workflows_enabled     text[]      not null default array[
    'checkout_abandonment','failed_payment','subscription_autopay','overdue_invoice'
  ],

  -- Which model backend this business runs on. Null means the platform
  -- default, so an existing merchant keeps working without being migrated.
  ai_provider           text,
  -- The model within that provider. Worth choosing separately: quotas are
  -- counted per model, so moving to a different one is a way out of a
  -- throttle rather than merely a matter of taste.
  ai_model              text,

  active                boolean     not null default true,  -- [+] pause a merchant without deleting them
  created_at            timestamptz not null default now(),

  constraint merchants_channels_valid check (
    channels_enabled <@ array['email','whatsapp','voice']::text[]
  ),
  constraint merchants_workflows_valid check (
    workflows_enabled <@ array[
      'checkout_abandonment','failed_payment','subscription_autopay','overdue_invoice'
    ]::text[]
  ),
  constraint merchants_max_attempts_sane check (max_attempts between 1 and 10)
);

-- Workflows, for a database created before this column existed. This has to
-- run here, above everything that reads it: `create table if not exists`
-- leaves an already-deployed table untouched, so on an existing database the
-- column arrives only from this line. Backfilling all four keeps behaviour
-- identical across the migration - every category stays on until the merchant
-- chooses otherwise.
alter table merchants add column if not exists workflows_enabled text[] not null default array[
  'checkout_abandonment','failed_payment','subscription_autopay','overdue_invoice'
];

-- Same treatment for an already-deployed database: the create block above
-- never runs on an existing table, so the column arrives from here.
alter table merchants add column if not exists ai_provider text;
alter table merchants add column if not exists ai_model text;

-- The check constraint needs the same treatment, and cannot ride along on the
-- alter above: on an existing table the constraint declared in the create
-- block never runs, so without this an already-deployed database would accept
-- any string at all in that column. Postgres has no `add constraint if not
-- exists`, hence the guard.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'merchants_workflows_valid'
  ) then
    alter table merchants add constraint merchants_workflows_valid check (
      workflows_enabled <@ array[
        'checkout_abandonment','failed_payment','subscription_autopay','overdue_invoice'
      ]::text[]
    );
  end if;
end $$;

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


-- --- ai_keys ---------------------------------------------------------------
-- The model credentials, as a pool rather than one environment variable.
--
-- Platform-level, not per-merchant: a merchant's Razorpay keys are theirs and
-- move their money, but an inference key is the operator's own cost and is
-- shared across every tenant. What a merchant chooses is the *provider*
-- (merchants.ai_provider), not the key.
--
-- Several keys per provider is the point. Free tiers are rate-limited per
-- project, so one key is one ceiling; when a key is throttled the pool moves
-- to the next rather than degrading to templates, and only falls through to
-- another provider when a whole provider is spent.
create table if not exists ai_keys (
  id            uuid primary key default gen_random_uuid(),
  provider      text        not null,
  -- A human label, e.g. "groq personal" - so an exhausted key is identifiable
  -- without decrypting anything.
  label         text        not null,
  -- AES-256-GCM, same scheme and same encryption key as merchant credentials.
  api_key       text        not null,
  -- Overrides the provider's default model when set.
  model         text,
  -- Lower is tried first. Ties break on created_at.
  priority      int         not null default 100,
  active        boolean     not null default true,
  -- Set when the provider says it is out of quota. The key is skipped until
  -- this passes, so a throttled key stops being retried on every request but
  -- comes back on its own rather than needing a human to re-enable it.
  cooldown_until timestamptz,
  -- Why it was last put in cooldown, kept for the operator to read.
  last_error    text,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),

  constraint ai_keys_provider_valid check (provider in ('groq', 'gemini', 'anthropic'))
);

create index if not exists ai_keys_pick
  on ai_keys (provider, priority, created_at) where active;

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
  -- [+] admin overrides (see "Pause outreach" / "Snooze until a date"): these
  -- suppress the worker's claim without touching status or stop_reason, so
  -- the case still reads as whatever it was - just not contacted right now.
  paused            boolean not null default false,
  hold_until        timestamptz,

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

-- Admin overrides, for a database created before these columns existed. Same
-- reason as the merchants alter above, and same hard requirement about where
-- it sits: claim_events below filters on both of these, so it cannot be
-- created until they are guaranteed to be there.
alter table events add column if not exists paused     boolean not null default false;
alter table events add column if not exists hold_until timestamptz;

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
      -- Admin overrides: "pause outreach" and "snooze until a date" both
      -- suppress the worker without touching status, so they are checked
      -- here rather than by giving them their own event status.
      and not e.paused
      and (e.hold_until is null or e.hold_until <= now())
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
      --
      -- The name is the exception, and takes the incoming value instead: it
      -- is a display label, not an identity key, and the name someone gave
      -- on the order that just failed is the one to address them by. Keeping
      -- the first one forever - which coalesce(name, ...) did - meant a
      -- customer who reordered under a corrected spelling, a married name,
      -- or a different person on the same phone was chased under a stale
      -- name for good. Email and phone deliberately keep gap-fill semantics:
      -- those carry the unique indexes, so overwriting one can collide with
      -- another customer's row rather than merely looking wrong.
      update customers
         set email = coalesce(email, p_customer_email),
             phone = coalesce(phone, p_customer_phone),
             name  = coalesce(p_customer_name, name)
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
-- The two-argument form is replaced rather than overloaded: an upper bound is
-- what makes "and how does that compare with the period before it?" a question
-- this function can answer, and keeping both signatures would make the
-- PostgREST call ambiguous.
drop function if exists merchant_stats(uuid, timestamptz);
create or replace function merchant_stats(
  p_merchant_id uuid,
  p_since       timestamptz default now() - interval '30 days',
  -- Null means "up to now, whenever now is". Only the *previous* period needs
  -- a real upper bound; giving the current one a bound computed from the
  -- application's clock drops any event the database timestamped a fraction of
  -- a second ahead of it, which is exactly what happens when the two run on
  -- different machines.
  p_until       timestamptz default null
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
    -- Money the agent gave up on for good. `stopped` is excluded: that is a
    -- pause a human can undo, not a write-off.
    'amount_unrecoverable',
      coalesce(sum(amount) filter (where status = 'unrecoverable'), 0),
    'recovery_rate',
      case when count(*) filter (where status <> 'queued') = 0 then 0
           else round(
             100.0 * count(*) filter (where status = 'recovered')
                   / count(*) filter (where status <> 'queued'), 1)
      end
  )
  from events
  where merchant_id = p_merchant_id
    and created_at >= p_since
    and (p_until is null or created_at < p_until);
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

-- ===========================================================================
-- Dashboard addressing: the URL slug
--
-- A merchant reaches their dashboard at /dashboard/<slug>, not
-- /dashboard/<uuid>. A business that just typed its name should see that name
-- in the address bar; a uuid is a database detail leaking into the product.
--
-- The slug is generated by a trigger rather than by the application, so every
-- write path gets one - the onboarding API, a seed script, a psql insert in a
-- test. Uniqueness is enforced by the index, and the trigger resolves a clash
-- by suffixing, so two businesses called "Sharma Traders" both get a working
-- address instead of the second one failing to onboard.
-- ===========================================================================
alter table merchants add column if not exists slug text;


create or replace function slugify(p_text text) returns text
language sql immutable
as $fn$
  -- Lowercase, non-alphanumerics collapse to a single hyphen, trimmed. Empty
  -- input (a name written entirely in a non-Latin script) yields '', which the
  -- caller replaces with a fallback rather than producing a bare '-'.
  select trim(both '-' from
    regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'));
$fn$;

create or replace function merchants_assign_slug() returns trigger
language plpgsql
as $fn$
declare
  base      text;
  candidate text;
  n         int := 1;
begin
  -- An explicitly supplied slug is honoured; the unique index is what rejects
  -- a bad one. This trigger only fills the gap.
  if new.slug is not null and new.slug <> '' then
    return new;
  end if;

  base := slugify(new.business_name);
  if base = '' then
    base := 'merchant';
  end if;
  -- A long business name would otherwise make an unwieldy URL.
  base := left(base, 48);
  candidate := base;

  -- A loop rather than catching the unique violation, because the insert that
  -- would fail is a merchant's onboarding request - they must never see it.
  while exists (
    select 1 from merchants
     where slug = candidate and id is distinct from new.id
  ) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;

  new.slug := candidate;
  return new;
end;
$fn$;

drop trigger if exists merchants_assign_slug_trg on merchants;
create trigger merchants_assign_slug_trg
  before insert or update of business_name on merchants
  for each row execute function merchants_assign_slug();

-- Backfill rows that predate the column, reusing the trigger rather than
-- reimplementing the dedupe: a no-op update fires it.
do $backfill$
declare
  r record;
begin
  for r in select id from merchants where slug is null or slug = '' loop
    update merchants set business_name = business_name where id = r.id;
  end loop;
end
$backfill$;

create unique index if not exists merchants_slug_key on merchants (slug);

-- ===========================================================================
-- Dashboard aggregations
--
-- Same rule as the reporting functions above: every one takes a merchant id
-- and filters on it, and there is no unscoped variant.
-- ===========================================================================

-- The recovery timeline. One row per day even when nothing happened, because
-- a chart with the quiet days missing is a misleading chart - the
-- generate_series left join is what puts the zeroes back.
create or replace function merchant_daily_series(
  p_merchant_id uuid,
  p_days        int default 14
) returns table (
  day               date,
  events            bigint,
  recovered         bigint,
  amount_recovered  bigint,
  amount_at_risk    bigint
)
language sql stable
as $fn$
  with days as (
    select generate_series(
      (current_date - (p_days - 1))::date, current_date, interval '1 day'
    )::date as day
  )
  select d.day,
         count(e.id)                                              as events,
         count(e.id) filter (where e.status = 'recovered')         as recovered,
         coalesce(sum(coalesce(e.recovered_amount, e.amount))
                  filter (where e.status = 'recovered'), 0)        as amount_recovered,
         coalesce(sum(e.amount)
                  filter (where e.status <> 'recovered'), 0)       as amount_at_risk
  from days d
  left join events e
    on e.merchant_id = p_merchant_id
   and e.created_at >= d.day
   and e.created_at <  d.day + 1
  group by d.day
  order by d.day;
$fn$;

-- The customer list with each customer's history folded in. A merchant reads
-- this to answer "who keeps failing", so the repeat count and the opt-out flag
-- matter more here than the contact details do.
create or replace function merchant_customers(
  p_merchant_id uuid,
  p_limit       int default 100
) returns table (
  id                uuid,
  name              text,
  email             text,
  phone             text,
  opted_out         boolean,
  created_at        timestamptz,
  total_events      bigint,
  recovered         bigint,
  open_events       bigint,
  amount_recovered  bigint,
  amount_at_risk    bigint,
  last_event_at     timestamptz
)
language sql stable
as $fn$
  select c.id, c.name, c.email, c.phone, c.opted_out, c.created_at,
         count(e.id)                                                     as total_events,
         count(e.id) filter (where e.status = 'recovered')                as recovered,
         count(e.id) filter (where e.status in ('queued','processing'))   as open_events,
         coalesce(sum(coalesce(e.recovered_amount, e.amount))
                  filter (where e.status = 'recovered'), 0)               as amount_recovered,
         coalesce(sum(e.amount)
                  filter (where e.status in ('queued','processing')), 0)  as amount_at_risk,
         max(e.created_at)                                                as last_event_at
  from customers c
  left join events e on e.customer_id = c.id and e.merchant_id = c.merchant_id
  where c.merchant_id = p_merchant_id
  group by c.id
  order by max(e.created_at) desc nulls last, c.created_at desc
  limit p_limit;
$fn$;

-- How the agent's decisions broke down. Feeds the activity summary without
-- pulling the whole audit trail across the wire to count it in JavaScript.
create or replace function merchant_action_summary(
  p_merchant_id uuid,
  p_since       timestamptz default now() - interval '30 days'
) returns table (
  outcome  text,
  count    bigint
)
language sql stable
as $fn$
  select a.outcome, count(*) as count
  from actions a
  where a.merchant_id = p_merchant_id
    and a.created_at >= p_since
  group by a.outcome
  order by count desc;
$fn$;

-- ===========================================================================
-- Conversations awaiting a summary
--
-- A conversation is not a table. Every turn is already an action row - the
-- audit trail has to contain what was said either way - so a conversation is
-- just "the messages for one customer since the last summary written about
-- them". Deriving it here beats keeping a second copy of the truth in sync.
--
-- A thread qualifies once it has gone quiet: summarising mid-exchange would
-- produce a summary of half a conversation and then need rewriting.
-- ===========================================================================
create or replace function conversations_to_summarise(
  p_idle_seconds int default 900,
  p_limit        int default 10
) returns table (
  merchant_id    uuid,
  customer_id    uuid,
  anchor_event   uuid,
  message_count  bigint,
  first_at       timestamptz,
  last_at        timestamptz
)
language sql stable
as $fn$
  with turns as (
    select a.merchant_id,
           e.customer_id,
           a.event_id,
           a.created_at,
           a.message
    from actions a
    join events e on e.id = a.event_id
    where a.message is not null
      and e.customer_id is not null
      -- Only the conversational rows: the outbound dunning copy the worker
      -- sends is not part of a back-and-forth and reads oddly in a summary.
      and (a.message like '[inbound] %' or a.message like '[reply] %')
  ),
  -- When each customer was last summarised. Anything before that is done.
  summarised as (
    select e.customer_id, max(a.created_at) as summarised_at
    from actions a
    join events e on e.id = a.event_id
    where a.message like '[conversation] %'
    group by e.customer_id
  )
  select t.merchant_id,
         t.customer_id,
         -- The event the newest turn was attached to, so the summary lands
         -- beside the recovery the conversation was actually about.
         (array_agg(t.event_id order by t.created_at desc))[1] as anchor_event,
         count(*)          as message_count,
         min(t.created_at) as first_at,
         max(t.created_at) as last_at
  from turns t
  left join summarised s on s.customer_id = t.customer_id
  where (s.summarised_at is null or t.created_at > s.summarised_at)
  group by t.merchant_id, t.customer_id
  having max(t.created_at) < now() - make_interval(secs => p_idle_seconds)
     -- One turn is not a conversation; the action row already says it all.
     and count(*) > 1
  order by max(t.created_at)
  limit p_limit;
$fn$;

-- ===========================================================================
-- The recovery board
--
-- One row per event, already carrying the status a merchant reads it by. The
-- six statuses are derived here rather than in the UI because they are a fact
-- about the data, not a rendering choice - the same derivation has to hold for
-- the table, the tab counts and the metric cards, and three copies of a case
-- expression is three chances to disagree.
--
-- Order matters and is the product's, not SQL's: recovered, then opted out,
-- then handed to a human, then escalated to voice, then stopped for any other
-- reason, and anything still moving is chasing.
-- ===========================================================================
-- Dropped rather than replaced: a column added to the result of a
-- returns-table function is a change of return type, which create or replace
-- refuses. The body is quoted, so nothing depends on it at creation time.
drop function if exists merchant_board(uuid, timestamptz);
drop function if exists merchant_board(uuid, timestamptz, timestamptz);
-- The current signature, dropped for the same reason as the two above:
-- adding a column to the returns table changes the return type, and
-- `create or replace` refuses that outright rather than adapting.
drop function if exists merchant_board(uuid, timestamptz, timestamptz, uuid);
create or replace function merchant_board(
  p_merchant_id uuid,
  p_since       timestamptz default now() - interval '90 days',
  -- Null means "up to now". A bound taken from the application's clock would
  -- drop a row the database stamped a fraction of a second later.
  p_until       timestamptz default null,
  -- [+] admin overrides: look up one event by id regardless of when it
  -- happened, so a kebab-menu action can validate against the same status
  -- this function would show on the board - one derivation, not two that
  -- could drift apart. Sidesteps p_since/p_until entirely when set.
  p_event_id    uuid default null
) returns table (
  event_id       uuid,
  customer_id    uuid,
  customer_name  text,
  -- Where a message would actually go. Shown on each attempt so "sent" can
  -- be checked against the number or address it went to - the difference
  -- between a delivery that failed and one that reached the wrong person.
  customer_email text,
  customer_phone text,
  amount         bigint,
  reason         text,
  status         text,
  attempts       int,
  max_attempts   int,
  failed_on      timestamptz,
  recovered_at   timestamptz,
  last_channel   text,
  -- Every channel that actually reached them, in the order it was first
  -- used. last_channel answers "where did we get to"; a case worked over
  -- email and then WhatsApp was showing only the second, so the table could
  -- not show that the escalation had happened at all.
  channels_used  text[],
  -- The event's own type (payment_failed, cart_abandoned, ...). Fixed at six
  -- values by the events_type_valid check constraint - this is what "Active
  -- workflows" on the dashboard counts distinct occurrences of.
  event_type     text,
  paused         boolean,
  hold_until     timestamptz,
  next_attempt_at timestamptz,
  -- Why the agent stopped, carried to the table so "Needs human" can say
  -- which kind. Fraud, three failed cycles and an admin escalation all land
  -- in that one bucket and all want a different response from the merchant.
  stop_reason    text,
  -- Razorpay's own order id. Two failures for the same customer and amount
  -- are otherwise indistinguishable on screen, and "which order was this?"
  -- is the first thing anyone asks.
  order_id       text
)
language sql stable
as $fn$
  with latest_channel as (
    -- The most recent action that named a channel, whatever became of it.
    -- This drives the voice escalation status: a call was placed, and that is
    -- an escalation whether or not it connected.
    select distinct on (a.event_id) a.event_id, a.channel
    from actions a
    where a.merchant_id = p_merchant_id
      and a.channel is not null
    order by a.event_id, a.created_at desc
  ),
  channels_used as (
    -- Ordered by when each channel first landed, not alphabetically: the
    -- sequence is the point - email first, then WhatsApp, then a call.
    select t.event_id, array_agg(t.channel order by t.first_at) as channels
    from (
      select a.event_id, a.channel, min(a.created_at) as first_at
      from actions a
      where a.merchant_id = p_merchant_id
        and a.channel is not null
        and a.outcome in ('sent', 'delivered')
      group by a.event_id, a.channel
    ) t
    group by t.event_id
  ),
  reached as (
    -- The last channel that actually landed. Deliberately narrower than the
    -- one above: an attempt the provider rejected did not reach anybody, and
    -- a column headed "channel" that showed it would be answering "what did
    -- we try" while appearing to answer "what worked".
    select distinct on (a.event_id) a.event_id, a.channel
    from actions a
    where a.merchant_id = p_merchant_id
      and a.channel is not null
      and a.outcome in ('sent', 'delivered')
    order by a.event_id, a.created_at desc
  )
  select e.id,
         c.id,
         -- The name given on this order, falling back to the customer record.
         -- The record holds one name and it is the latest, so joining it
         -- alone made every past case re-label itself when someone reordered
         -- under a different name.
         coalesce(e.metadata->>'customer_name', c.name),
         -- Same reasoning as the name: what was given on this order, falling
         -- back to the customer record. Identity is still shared - one email
         -- or phone is one customer - but the board shows the details that
         -- order actually carried rather than the most recent ones.
         coalesce(e.metadata->>'customer_email', c.email),
         coalesce(e.metadata->>'customer_phone', c.phone),
         e.amount,
         coalesce(e.reason, 'unknown'),
         case
           when e.status = 'recovered' then 'recovered'
           when coalesce(c.opted_out, false) then 'opted_out'
           -- [+] admin overrides: flag as disputed / written off take priority
           -- over the generic 'stopped' bucket below, same mechanism as the
           -- pre-existing needs_human carve-out - a distinct stop_reason.
           when e.status in ('stopped', 'unrecoverable')
            and e.stop_reason = 'admin_disputed'
             then 'disputed'
           when e.status in ('stopped', 'unrecoverable')
            and e.stop_reason = 'admin_written_off'
             then 'written_off'
           when e.status in ('stopped', 'unrecoverable')
            and e.stop_reason in ('risk_flagged', 'repeat_failure_across_cycles', 'admin_escalated', 'customer_claims_paid')
             then 'needs_human'
           when lc.channel = 'voice' then 'escalated_voice'
           when e.status in ('stopped', 'unrecoverable') then 'stopped'
           else 'chasing'
         end as status,
         e.attempts,
         m.max_attempts,
         e.created_at,
         case when e.status = 'recovered' then e.updated_at end,
         rc.channel,
         coalesce(cu.channels, '{}')::text[],
         e.type,
         e.paused,
         e.hold_until,
         e.next_attempt_at,
         e.stop_reason,
         e.metadata->>'order_id'
  from events e
  join merchants m on m.id = e.merchant_id
  left join customers c on c.id = e.customer_id
  left join latest_channel lc on lc.event_id = e.id
  left join reached rc on rc.event_id = e.id
  left join channels_used cu on cu.event_id = e.id
  where e.merchant_id = p_merchant_id
    and (p_event_id is not null or e.created_at >= p_since)
    and (p_event_id is not null or p_until is null or e.created_at < p_until)
    and (p_event_id is null or e.id = p_event_id)
  order by e.created_at desc;
$fn$;

-- Every figure on the dashboard for one window, in one round trip. The card
-- deltas need the window before this one too, so the whole thing is computed
-- twice against different bounds rather than by two round trips.
drop function if exists merchant_board_metrics(uuid, timestamptz);
create or replace function merchant_board_metrics(
  p_merchant_id uuid,
  p_since       timestamptz default now() - interval '7 days',
  p_until       timestamptz default null
) returns jsonb
language sql stable
as $fn$
  with board as (
    select * from merchant_board(p_merchant_id, p_since, p_until)
  ),
  -- Compliance and "interventions sent" are both about messages that actually
  -- went out, so a withheld decision counts towards neither.
  sent as (
    select (a.sent_at at time zone m.timezone)::time as local_time,
           m.contact_window_start,
           m.contact_window_end
    from actions a
    join merchants m on m.id = a.merchant_id
    where a.merchant_id = p_merchant_id
      and a.sent_at is not null
      and a.channel is not null
      and a.outcome in ('sent', 'delivered')
      and a.created_at >= p_since
      and (p_until is null or a.created_at < p_until)
  ),
  causes as (
    select reason, count(*) as n
    from board
    where status <> 'recovered'
    group by reason
    order by n desc, reason
    limit 3
  )
  select jsonb_build_object(
    'total_events',      (select count(*) from board),
    'recovered_count',   (select count(*) from board where status = 'recovered'),
    'amount_total',      (select coalesce(sum(amount), 0) from board),
    'amount_recovered',  (select coalesce(sum(amount), 0) from board where status = 'recovered'),
    -- Money still chaseable: open work only, not what was written off.
    'amount_at_risk',
      (select coalesce(sum(amount), 0) from board
        where status in ('chasing', 'escalated_voice', 'needs_human')),
    -- Written off is excluded from both sides of this fraction: it is a
    -- business decision to stop chasing, not a failed recovery attempt, and
    -- should not move the rate in either direction.
    'recovery_rate',
      (select case when count(*) = 0 then 0
              else round(100.0 * count(*) filter (where status = 'recovered') / count(*))
              end from board where status <> 'written_off'),
    'avg_recovery_seconds',
      (select round(avg(extract(epoch from (recovered_at - failed_on))))
         from board where status = 'recovered' and recovered_at is not null),
    'sent_total',        (select count(*) from sent),
    'sent_in_window',
      (select count(*) from sent
        where local_time >= contact_window_start and local_time <= contact_window_end),
    'needs_human',       (select count(*) from board where status = 'needs_human'),
    'escalated_voice',   (select count(*) from board where status = 'escalated_voice'),
    'stopped',           (select count(*) from board where status in ('stopped','opted_out')),
    'promise_active',
      (select count(*) from events
        where merchant_id = p_merchant_id
          and type = 'promise_to_pay'
          and status in ('queued', 'processing')),
    'top_causes',
      (select coalesce(jsonb_agg(jsonb_build_object('reason', reason, 'count', n)), '[]'::jsonb)
         from causes)
  );
$fn$;

-- One row per day in the window, including the days nothing happened - a
-- sparkline with the quiet days missing is a sparkline of the wrong shape.
create or replace function merchant_board_series(
  p_merchant_id uuid,
  p_since       timestamptz default now() - interval '7 days',
  p_until       timestamptz default null
) returns table (
  day               date,
  events            bigint,
  recovered         bigint,
  amount_recovered  bigint,
  amount_at_risk    bigint,
  sent              bigint,
  sent_in_window    bigint
)
language sql stable
as $fn$
  with bounds as (
    select p_since::date as from_day,
           (coalesce(p_until, now()) - interval '1 microsecond')::date as to_day
  ),
  days as (
    select generate_series(
      (select from_day from bounds), (select to_day from bounds), interval '1 day'
    )::date as day
  ),
  ev as (
    select e.created_at::date as day,
           count(*) as events,
           count(*) filter (where e.status = 'recovered') as recovered,
           coalesce(sum(coalesce(e.recovered_amount, e.amount))
                    filter (where e.status = 'recovered'), 0) as amount_recovered,
           coalesce(sum(e.amount)
                    filter (where e.status <> 'recovered'), 0) as amount_at_risk
    from events e
    where e.merchant_id = p_merchant_id
      and e.created_at >= p_since
      and (p_until is null or e.created_at < p_until)
    group by 1
  ),
  ac as (
    select a.created_at::date as day,
           count(*) as sent,
           count(*) filter (
             where (a.sent_at at time zone m.timezone)::time
                     between m.contact_window_start and m.contact_window_end
           ) as sent_in_window
    from actions a
    join merchants m on m.id = a.merchant_id
    where a.merchant_id = p_merchant_id
      and a.sent_at is not null
      and a.channel is not null
      and a.outcome in ('sent', 'delivered')
      and a.created_at >= p_since
      and (p_until is null or a.created_at < p_until)
    group by 1
  )
  select d.day,
         coalesce(ev.events, 0),
         coalesce(ev.recovered, 0),
         coalesce(ev.amount_recovered, 0),
         coalesce(ev.amount_at_risk, 0),
         coalesce(ac.sent, 0),
         coalesce(ac.sent_in_window, 0)
  from days d
  left join ev on ev.day = d.day
  left join ac on ac.day = d.day
  order by d.day;
$fn$;

-- Which channel is actually recovering money, not merely being used. The
-- denominator is events contacted on that channel, so a channel used twice on
-- one event does not flatter its own rate.
create or replace function merchant_channel_recovery(
  p_merchant_id uuid,
  p_since       timestamptz default now() - interval '7 days',
  p_until       timestamptz default null
) returns table (
  channel    text,
  sent       bigint,
  reached    bigint,
  recovered  bigint
)
language sql stable
as $fn$
  with touched as (
    select a.channel, a.event_id, e.status
    from actions a
    join events e on e.id = a.event_id
    where a.merchant_id = p_merchant_id
      and a.channel is not null
      and a.outcome in ('sent', 'delivered')
      and a.created_at >= p_since
      and (p_until is null or a.created_at < p_until)
  )
  select c.channel,
         (select count(*) from touched t where t.channel = c.channel)                as sent,
         (select count(distinct t.event_id) from touched t where t.channel = c.channel) as reached,
         (select count(distinct t.event_id) from touched t
           where t.channel = c.channel and t.status = 'recovered')                   as recovered
  from (values ('email'), ('whatsapp'), ('voice')) as c(channel);
$fn$;

-- What the agent has done today, for the sidebar. Deliberately its own
-- function: the widget is about right now, not about the selected window.
create or replace function merchant_today(
  p_merchant_id uuid
) returns jsonb
language sql stable
as $fn$
  with m as (select timezone from merchants where id = p_merchant_id),
  bounds as (
    select (date_trunc('day', now() at time zone (select timezone from m))
            at time zone (select timezone from m)) as day_start
  )
  select jsonb_build_object(
    'interventions_today',
      (select count(*) from actions
        where merchant_id = p_merchant_id
          and sent_at is not null
          and channel is not null
          and outcome in ('sent','delivered')
          and created_at >= (select day_start from bounds)),
    'events_today',
      (select count(*) from events
        where merchant_id = p_merchant_id
          and created_at >= (select day_start from bounds)),
    'recovered_today',
      (select count(*) from events
        where merchant_id = p_merchant_id
          and status = 'recovered'
          and updated_at >= (select day_start from bounds))
  );
$fn$;

-- The timeline behind one row. Ordered oldest first, because a timeline read
-- newest-first is a list, not a story.
drop function if exists event_timeline(uuid, uuid);
create or replace function event_timeline(
  p_merchant_id uuid,
  p_event_id    uuid
) returns table (
  id          uuid,
  created_at  timestamptz,
  sent_at     timestamptz,
  channel     text,
  outcome     text,
  message     text,
  intervention text,
  rationale   text,
  guardrail   text,
  in_window   boolean,
  -- [+] admin overrides: which one this row was, so the detail panel can
  -- render it as a distinct "admin action" card instead of a generic
  -- automated no-channel decision.
  admin_action text,
  -- Who decided this step: the model, or a rule that overrode it. The
  -- distinction is the whole point of the guardrails, and a timeline that
  -- shows the outcome without showing which of the two produced it cannot
  -- answer "did the agent choose this, or was it made to?".
  source      text,
  -- What the provider said back. Carries the provider's id on a success and
  -- its error text on a failure - and the failure is the case that matters:
  -- "Failed" with the reason withheld is not something a merchant can act on.
  response    text
)
language sql stable
as $fn$
  select a.id,
         a.created_at,
         a.sent_at,
         a.channel,
         a.outcome,
         a.message,
         a.decision->>'intervention',
         a.decision->>'rationale',
         a.decision->>'guardrail',
         -- Null for anything that was never sent: an action with no send time
         -- is neither compliant nor non-compliant.
         case when a.sent_at is null or a.channel is null then null
              else (a.sent_at at time zone m.timezone)::time
                     between m.contact_window_start and m.contact_window_end
         end,
         a.decision->>'admin_action',
         a.decision->>'source',
         a.response
  from actions a
  join merchants m on m.id = a.merchant_id
  where a.merchant_id = p_merchant_id
    and (
      a.event_id = p_event_id
      -- The conversation belongs to the customer, not to one case.
      --
      -- A WhatsApp thread is one thread: the customer answers the person,
      -- not the invoice. An inbound reply is filed against whichever of
      -- their cases was most recent, so a merchant looking at any of the
      -- others saw our messages with their replies missing - which reads as
      -- the customer ignoring us. Their side of it now appears on every case
      -- of theirs, because that is where it is true.
      or (
        (a.message like '[inbound] %' or a.message like '[reply] %')
        and a.event_id in (
          select e2.id from events e2
          where e2.customer_id = (
            select e1.customer_id from events e1 where e1.id = p_event_id
          )
          and e2.customer_id is not null
        )
      )
    )
  order by a.created_at;
$fn$;

-- ===========================================================================
-- Realtime
--
-- The dashboard streams changes rather than polling. Only the two tables the
-- board is built from are published - merchants and customers change rarely
-- enough that a refresh on the next event is soon enough, and every row that
-- crosses this publication is one more thing to filter by tenant.
--
-- Guarded because adding a table twice raises, and this file is applied
-- repeatedly by design.
-- ===========================================================================
do $realtime$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events'
    ) then
      alter publication supabase_realtime add table events;
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'actions'
    ) then
      alter publication supabase_realtime add table actions;
    end if;
  end if;
end
$realtime$;

-- --- Row Level Security ----------------------------------------------------
-- Tally's server acts with the service-role key, which bypasses RLS. Enabling
-- RLS with no policies means a leaked anon/publishable key reads nothing at
-- all, rather than reading every merchant's data.
alter table merchants enable row level security;
alter table customers enable row level security;
alter table events    enable row level security;
alter table actions   enable row level security;
