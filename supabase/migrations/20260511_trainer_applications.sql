-- Trainer applications submitted via /trainers on theflexfacility.com.
-- Lives in its own table (separate from public.applications, which holds
-- artist applications) so the portal can surface trainer leads under a
-- dedicated tab with no risk of crossing wires with the funnel pipeline.

create table if not exists public.trainer_applications (
  id uuid primary key default gen_random_uuid(),
  client_id text not null default 'flex-facility',
  full_name text not null,
  email text not null,
  phone text not null,
  specialty text not null,
  certifications text,
  years_experience text,
  why_flex text,
  status text not null default 'new',
  created_at timestamptz not null default now()
);

create index if not exists trainer_applications_client_created_idx
  on public.trainer_applications (client_id, created_at desc);

-- RLS enabled; only service_role (used by both /api/trainer-apply and the
-- portal API) can read/write. Matches the rest of the schema and satisfies
-- the rls_disabled advisory.
alter table public.trainer_applications enable row level security;
