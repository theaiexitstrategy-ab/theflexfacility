-- ROQ N FLEX Bootcamp reservations taken at /bootcamp on theflexfacility.com.
--
-- Its own table (rather than reusing public.orders) because a seat
-- reservation carries a signed waiver and no product/size/color, and the
-- portal surfaces it under its own "Bootcamp Signups" tab. Same
-- multi-tenant shape as trainer_applications: client_id defaults to
-- 'flex-facility' and RLS is on with no policies, so only service_role
-- (used by /api/bootcamp and the portal API) can read or write.

create table if not exists public.bootcamp_signups (
  id uuid primary key default gen_random_uuid(),
  client_id text not null default 'flex-facility',
  name text not null,
  phone text not null,
  email text not null,
  -- Gate on the front end AND here: a reservation may not exist without
  -- an accepted waiver.
  waiver_accepted boolean not null default false,
  -- Set when the Checkout Session is created; the webhook matches on it.
  -- UNIQUE so a Stripe retry can never fan out into duplicate rows.
  stripe_session_id text unique,
  -- pending → paid (checkout.session.completed)
  --         → failed (checkout.session.async_payment_failed)
  --         → expired (checkout.session.expired)
  payment_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint bootcamp_signups_waiver_required check (waiver_accepted = true)
);

create index if not exists bootcamp_signups_client_created_idx
  on public.bootcamp_signups (client_id, created_at desc);

create index if not exists bootcamp_signups_status_idx
  on public.bootcamp_signups (client_id, payment_status);

alter table public.bootcamp_signups enable row level security;
