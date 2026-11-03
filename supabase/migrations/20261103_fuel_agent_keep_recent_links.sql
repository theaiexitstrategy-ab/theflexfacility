-- Fuel Agent: a new "My Challenge" link no longer signs out the old ones.
--
-- Each "email me my link" used to replace access_token_hash, so a player
-- who joined in Instagram's browser and then opened the emailed link in
-- Safari (or asked twice) was signed out everywhere but the newest link.
-- When the email didn't go out at all, they were locked out completely.
--
-- prior_token_hashes keeps the last few hashes (newest first, the app
-- trims it to 4), and sign-in accepts the current one or any of these.
-- Additive and idempotent.

alter table public.fuel_challenge_participants
  add column if not exists prior_token_hashes text[] not null default '{}';

create index if not exists fuel_challenge_participants_prior_tokens_gin
  on public.fuel_challenge_participants using gin (prior_token_hashes);
