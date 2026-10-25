-- Fuel Agent challenges (first one: the November Stair-Step Challenge).
--
-- Runs in the GoElev8.AI Supabase project (bnkoqybkmwtrlorhowyv), next to
-- public.clients and the Flex Fuel tables. Same multi-tenant shape as
-- bootcamp_signups: every table carries client_id (the clients.slug,
-- default 'flex-facility'), indexed, and every API query filters on it.
-- Nothing tenant-specific lives in code: dates, caps, reward and copy are
-- columns on fuel_challenges.
--
-- Access: RLS is on everywhere with no policies, so only the service role
-- (api/fuel-challenge.js, the portal) reads or writes the tables. The public
-- gets exactly one thing: fuel_challenge_leaderboard_public, a projection
-- with display names and totals — no emails, phones, last names or images.
--
-- Photos: private bucket fuel-step-proofs, path
-- {client_id}/{challenge_id}/{participant_id}/{uuid}.{ext}. No storage
-- policies; the browser uploads with a one-time signed upload URL and never
-- reads the bucket.
--
-- Idempotent — safe to run twice.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.fuel_agent_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Challenges
-- ---------------------------------------------------------------------------
create table if not exists public.fuel_challenges (
  id                     uuid primary key default gen_random_uuid(),
  client_id              text not null default 'flex-facility',
  slug                   text not null,
  title                  text not null,
  subtitle               text,
  challenge_type         text not null default 'steps' check (challenge_type in ('steps')),
  start_date             date not null,
  end_date               date not null,
  timezone               text not null default 'America/Chicago',
  -- How long after a day ends that day can still be logged.
  log_grace_hours        int  not null default 36 check (log_grace_hours between 0 and 168),
  final_upload_deadline  timestamptz not null,
  -- The benchmark (FK added below, after participants exists).
  coach_participant_id   uuid,
  reward_title           text,
  reward_cap             int check (reward_cap is null or reward_cap >= 0),
  -- Above this many steps in a day, the entry goes to manual review.
  daily_step_cap         int  not null default 60000 check (daily_step_cap > 0),
  status                 text not null default 'draft'
                           check (status in ('draft','upcoming','live','judging','complete')),
  rules                  jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  hero_copy              jsonb not null default '{}'::jsonb check (jsonb_typeof(hero_copy) = 'object'),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (client_id, slug),
  check (end_date >= start_date)
);
create index if not exists fuel_challenges_client_idx on public.fuel_challenges (client_id, status);
drop trigger if exists fuel_challenges_touch on public.fuel_challenges;
create trigger fuel_challenges_touch before update on public.fuel_challenges
  for each row execute function public.fuel_agent_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Participants
-- ---------------------------------------------------------------------------
create table if not exists public.fuel_challenge_participants (
  id                   uuid primary key default gen_random_uuid(),
  client_id            text not null default 'flex-facility',
  challenge_id         uuid not null references public.fuel_challenges(id) on delete cascade,
  -- The person's Flex Fuel profile, when the join email matches one
  -- (FK to fuel_clients added below if that table exists in this project).
  fuel_profile_id      uuid,
  first_name           text not null check (length(first_name) between 1 and 40),
  last_name            text not null check (length(last_name) between 1 and 40),
  email                text not null check (length(email) <= 254),
  phone                text,
  -- Always "First L." — the only name the public ever sees.
  display_name         text not null check (length(display_name) between 1 and 48),
  is_coach             boolean not null default false,
  -- sha256 of the private "My Challenge" link token; the token itself is
  -- never stored.
  access_token_hash    text unique,
  join_ip_hash         text,
  consent_at           timestamptz,
  status               text not null default 'active' check (status in ('active','disqualified')),
  disqualified_reason  text,
  -- Set by cron-daily: Top 10 or beating the coach, with entries the coach
  -- has not re-confirmed yet. No reward is issued while this is true.
  needs_final_review   boolean not null default false,
  joined_at            timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists fuel_challenge_participants_email_uidx
  on public.fuel_challenge_participants (challenge_id, lower(email));
create index if not exists fuel_challenge_participants_client_idx
  on public.fuel_challenge_participants (client_id, challenge_id);
create index if not exists fuel_challenge_participants_ip_idx
  on public.fuel_challenge_participants (client_id, join_ip_hash, created_at);
create index if not exists fuel_challenge_participants_profile_idx
  on public.fuel_challenge_participants (fuel_profile_id) where fuel_profile_id is not null;
drop trigger if exists fuel_challenge_participants_touch on public.fuel_challenge_participants;
create trigger fuel_challenge_participants_touch before update on public.fuel_challenge_participants
  for each row execute function public.fuel_agent_touch_updated_at();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fuel_challenges_coach_fk') then
    alter table public.fuel_challenges
      add constraint fuel_challenges_coach_fk foreign key (coach_participant_id)
      references public.fuel_challenge_participants(id) on delete set null;
  end if;
  -- Link to Flex Fuel profiles only where the Fuel module is installed.
  if to_regclass('public.fuel_clients') is not null
     and not exists (select 1 from pg_constraint where conname = 'fuel_challenge_participants_profile_fk') then
    alter table public.fuel_challenge_participants
      add constraint fuel_challenge_participants_profile_fk foreign key (fuel_profile_id)
      references public.fuel_clients(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Step entries (one per upload)
-- ---------------------------------------------------------------------------
create table if not exists public.fuel_step_entries (
  id                    uuid primary key default gen_random_uuid(),
  client_id             text not null default 'flex-facility',
  challenge_id          uuid not null references public.fuel_challenges(id) on delete cascade,
  participant_id        uuid not null references public.fuel_challenge_participants(id) on delete cascade,
  entry_date            date not null,                 -- in the challenge timezone
  claimed_steps         int  not null check (claimed_steps between 0 and 1000000),
  extracted_steps       int,                           -- what the agent read off the image
  counted_steps         int,                           -- set only when approved
  source                text not null check (source in
                          ('stair_machine_photo','watch_screenshot','phone_app_screenshot','coach_manual')),
  image_path            text,
  image_sha256          text,
  image_phash           text,                          -- 64-bit dHash, 16 hex chars
  exif                  jsonb,
  c2pa                  jsonb,
  ai_analysis           jsonb,
  authenticity_score    int check (authenticity_score between 0 and 100),
  authenticity_flags    text[] not null default '{}',
  verification_status   text not null default 'pending_review'
                          check (verification_status in ('auto_approved','pending_review','approved','rejected')),
  reviewed_by           text,
  reviewed_at           timestamptz,
  review_note           text,
  submitted_ip_hash     text,
  user_agent            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (counted_steps is null or verification_status in ('auto_approved','approved'))
);
create index if not exists fuel_step_entries_day_idx
  on public.fuel_step_entries (challenge_id, participant_id, entry_date);
create index if not exists fuel_step_entries_sha_idx on public.fuel_step_entries (image_sha256);
create index if not exists fuel_step_entries_status_idx on public.fuel_step_entries (verification_status);
create index if not exists fuel_step_entries_client_idx
  on public.fuel_step_entries (client_id, challenge_id, created_at desc);
-- One entry per uploaded object.
create unique index if not exists fuel_step_entries_image_uidx
  on public.fuel_step_entries (image_path) where image_path is not null;
drop trigger if exists fuel_step_entries_touch on public.fuel_step_entries;
create trigger fuel_step_entries_touch before update on public.fuel_step_entries
  for each row execute function public.fuel_agent_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Rewards
-- ---------------------------------------------------------------------------
create table if not exists public.fuel_rewards (
  id               uuid primary key default gen_random_uuid(),
  client_id        text not null default 'flex-facility',
  challenge_id     uuid not null references public.fuel_challenges(id) on delete cascade,
  participant_id   uuid not null references public.fuel_challenge_participants(id) on delete cascade,
  reward_type      text not null default 'bootcamp_pass' check (reward_type in ('bootcamp_pass')),
  status           text not null default 'eligible' check (status in ('eligible','issued','redeemed','revoked')),
  redemption_code  text unique,
  issued_at        timestamptz,
  redeemed_at      timestamptz,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (challenge_id, participant_id, reward_type)
);
create index if not exists fuel_rewards_client_idx on public.fuel_rewards (client_id, challenge_id, status);
drop trigger if exists fuel_rewards_touch on public.fuel_rewards;
create trigger fuel_rewards_touch before update on public.fuel_rewards
  for each row execute function public.fuel_agent_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Agent audit log (every decision the agent makes)
-- ---------------------------------------------------------------------------
create table if not exists public.fuel_agent_events (
  id              uuid primary key default gen_random_uuid(),
  client_id       text not null default 'flex-facility',
  challenge_id    uuid references public.fuel_challenges(id) on delete cascade,
  participant_id  uuid references public.fuel_challenge_participants(id) on delete set null,
  entry_id        uuid references public.fuel_step_entries(id) on delete set null,
  event_type      text not null,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists fuel_agent_events_client_idx
  on public.fuel_agent_events (client_id, challenge_id, event_type, created_at desc);
create index if not exists fuel_agent_events_participant_idx
  on public.fuel_agent_events (participant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Leaderboard
-- ---------------------------------------------------------------------------
-- A day counts once: the MAX counted_steps per entry_date, because a watch
-- already counts the stair steps. Ties go to whoever reached the total
-- first (earliest last counted submission). The coach is the benchmark,
-- not a competitor: coach rows get no rank.
create or replace view public.fuel_challenge_leaderboard
with (security_invoker = true) as
with daily as (
  select e.client_id, e.challenge_id, e.participant_id, e.entry_date,
         max(e.counted_steps) as steps,
         max(e.created_at)    as last_at
  from public.fuel_step_entries e
  where e.verification_status in ('auto_approved','approved')
    and e.counted_steps is not null
  group by 1, 2, 3, 4
),
totals as (
  select p.client_id, p.challenge_id, p.id as participant_id, p.display_name, p.is_coach,
         coalesce(sum(d.steps), 0)::bigint as total_counted_steps,
         count(d.entry_date)::int          as days_logged,
         max(d.last_at)                    as last_entry_at
  from public.fuel_challenge_participants p
  left join daily d on d.participant_id = p.id and d.challenge_id = p.challenge_id
  where p.status = 'active'
  group by 1, 2, 3, 4, 5
),
coach as (
  select challenge_id, max(total_counted_steps) as coach_total
  from totals where is_coach
  group by 1
)
select t.client_id, t.challenge_id, t.participant_id, t.display_name, t.is_coach,
       t.total_counted_steps, t.days_logged, t.last_entry_at,
       case when t.is_coach then null else
         rank() over (partition by t.challenge_id, t.is_coach
                      order by t.total_counted_steps desc, t.last_entry_at asc nulls last)
       end::int as rank,
       c.coach_total,
       (c.coach_total is not null and not t.is_coach
        and t.total_counted_steps > c.coach_total) as beats_coach
from totals t
left join coach c on c.challenge_id = t.challenge_id;

-- Public projection. Runs with the owner's rights (no security_invoker) on
-- purpose: anon has no access to the base tables, only to these columns.
create or replace view public.fuel_challenge_leaderboard_public as
select l.client_id, ch.slug as challenge_slug, l.display_name,
       l.total_counted_steps as total, l.rank, l.days_logged, l.is_coach, l.beats_coach
from public.fuel_challenge_leaderboard l
join public.fuel_challenges ch on ch.id = l.challenge_id
where ch.status <> 'draft';

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------
alter table public.fuel_challenges              enable row level security;
alter table public.fuel_challenge_participants  enable row level security;
alter table public.fuel_step_entries            enable row level security;
alter table public.fuel_rewards                 enable row level security;
alter table public.fuel_agent_events            enable row level security;

revoke all on public.fuel_challenge_leaderboard from anon, authenticated;
revoke all on public.fuel_challenge_leaderboard_public from anon, authenticated;
grant select on public.fuel_challenge_leaderboard_public to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fuel-step-proofs', 'fuel-step-proofs', false, 26214400,
        array['image/jpeg','image/png','image/heic','image/heif','image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Seed: The Flex Facility's November Stair-Step Challenge + its benchmark.
-- Thanksgiving is Thu Nov 26, 2026, so the final deadline (Wed Nov 25 noon
-- CT) leaves winners known before boot camp.
-- ---------------------------------------------------------------------------
insert into public.fuel_challenges (
  client_id, slug, title, subtitle, challenge_type, start_date, end_date, timezone,
  log_grace_hours, final_upload_deadline, reward_title, reward_cap, daily_step_cap, status,
  rules, hero_copy
) values (
  'flex-facility', 'november-stair-steps-2026',
  'November Stair-Step Challenge',
  'Out-step Coach Kenny. Earn your way into Thanksgiving Boot Camp.',
  'steps', '2026-11-01', '2026-11-24', 'America/Chicago',
  36, '2026-11-25 12:00:00 America/Chicago',
  'Free pass to Coach Kenny''s Thanksgiving Boot Camp', null, 60000, 'upcoming',
  jsonb_build_object(
    'summary', 'Log your steps every day from Nov 1 to Nov 24. Finish with more total steps than Coach Kenny and you earn a free pass to his Thanksgiving Boot Camp.',
    'items', jsonb_build_array(
      'Log each day with a photo of the stair machine display after your workout, or a screenshot from your watch or phone health app (Apple Fitness/Health, Garmin, Fitbit, Samsung and others).',
      'One number counts per day: your best approved entry for that date. Logging the same day from two sources does not stack, because your watch already counts your stair steps.',
      'You can log a day until 36 hours after it ends. The last chance for every day is Wed Nov 25 at 12:00 PM Central.',
      'Show the full screen. No crops, no filters, no edits.',
      'Every photo is checked. Edited, reused or AI-made images do not count, and repeat offenders are removed from the challenge.',
      'Entries over 60,000 steps in a day, or far above your normal, are checked by hand before they count.',
      'Anyone in the Top 10 or ahead of Coach Kenny has every entry re-confirmed by Coach Kenny before a reward is issued.',
      'You must finish with MORE total steps than Coach Kenny (a tie does not win). Coach Kenny''s total is public all month.',
      'The leaderboard shows first name and last initial only. Photos, emails and phone numbers are never public.'
    ),
    'max_daily_submissions', 6
  ),
  jsonb_build_object(
    'agent_name', 'Flex Fuel Agent',
    'coach_name', 'Coach Kenny',
    'headline', 'Meet Your Flex Fuel Agent',
    'tagline', 'Your AI coach that tracks your fuel, runs Coach Kenny''s challenges, and keeps every leaderboard honest.',
    'primary_cta', 'Join the November Step Challenge',
    'secondary_cta', 'Already in? Log today''s steps',
    'reward_line', 'Out-step Coach Kenny → free pass to his Thanksgiving Boot Camp.',
    'benchmark_label', 'The Number to Beat',
    'beating_label', 'Beating Kenny 🔥',
    'reward_email_subject', 'You beat Coach Kenny! 🙌🏾'
  )
) on conflict (client_id, slug) do nothing;

-- The benchmark participant. The coach logs through the same flow; his
-- "My Challenge" link is emailed to this address with ?action=resend-link.
insert into public.fuel_challenge_participants (client_id, challenge_id, first_name, last_name, email, display_name, is_coach)
select 'flex-facility', ch.id, 'Kenny', 'Coach', 'kenny@flextraining.co', 'Coach Kenny', true
from public.fuel_challenges ch
where ch.client_id = 'flex-facility' and ch.slug = 'november-stair-steps-2026'
on conflict (challenge_id, (lower(email))) do nothing;

-- The first run of this file seeded the coach as info@theflexfacility.com.
-- Re-running it moves that row to Kenny's own address.
update public.fuel_challenge_participants p
set email = 'kenny@flextraining.co'
from public.fuel_challenges ch
where ch.client_id = 'flex-facility' and ch.slug = 'november-stair-steps-2026'
  and p.client_id = ch.client_id and p.challenge_id = ch.id and p.is_coach
  and lower(p.email) = 'info@theflexfacility.com'
  and not exists (
    select 1 from public.fuel_challenge_participants q
    where q.challenge_id = ch.id and lower(q.email) = 'kenny@flextraining.co'
  );

update public.fuel_challenges ch
set coach_participant_id = p.id
from public.fuel_challenge_participants p
where ch.client_id = 'flex-facility' and ch.slug = 'november-stair-steps-2026'
  and p.challenge_id = ch.id and p.is_coach and ch.coach_participant_id is null;
