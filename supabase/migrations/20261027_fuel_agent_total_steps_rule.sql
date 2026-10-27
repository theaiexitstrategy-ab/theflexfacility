-- Fuel Agent: proof must show TOTAL steps.
--
-- Real test photos showed a StairMaster console reports steps per MINUTE
-- (next to the circular-arrows icon) unless the display is switched to
-- total steps, and an Apple Watch workout summary shows time, distance and
-- pace with no step count at all. Neither has a number the agent can count,
-- so the first rule now says exactly what the photo has to show.
--
-- Idempotent: replaces rules.items[0] only while it still has the old text.

update public.fuel_challenges
set rules = jsonb_set(
  rules, '{items,0}',
  to_jsonb('Log each day with proof that shows your TOTAL STEPS: a photo of the stair machine with the display switched to total steps, or a screenshot of the day''s Steps in your watch or phone health app (Apple Health/Fitness, Garmin, Fitbit, Samsung and others). Steps per minute, time, calories, distance or pace alone do not count.'::text)
)
where client_id = 'flex-facility'
  and slug = 'november-stair-steps-2026'
  and rules->'items'->>0 like 'Log each day with a photo of the stair machine display%';
