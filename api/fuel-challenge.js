// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Fuel Agent challenges for /fuel/agent. ONE serverless function, routed on
// ?action= and method, to stay under the Vercel Hobby 12-function limit.
//
// Public (the page):
//   GET  ?action=challenge&slug=           config + effective status + countdown instants
//   GET  ?action=leaderboard&slug=         Top 10 + coach row + participant count (CDN 30s)
//   POST ?action=join                      { slug, first_name, last_name, email, phone?, consent }
//   POST ?action=resend-link               { slug, email } — emails a fresh private link
//   POST ?action=upload-url                { t, filename, mime } → one-time signed upload URL
//   POST ?action=submit-entry              { t, entry_date, source, claimed_steps, image_path }
//   GET  ?action=me&t=                     own entries, statuses, rank, gap to the coach
//   POST ?action=agent-chat                { slug, t?, messages:[{role,content}] }
//
// Cron (Vercel daily cron, Authorization: Bearer CRON_SECRET):
//   GET  ?action=cron-daily                status by date, leaderboard snapshot,
//                                          needs_final_review, eligible rewards
//
// Portal (Authorization: Bearer PORTAL_API_KEY):
//   GET  ?action=admin-queue&slug=         entries waiting on the coach, with signed image URLs
//   POST ?action=admin-review              { entry_id, decision: approve|reject, counted_steps?, note?, reviewed_by? }
//   POST ?action=admin-manual-entry        { participant_id, entry_date, steps, note?, reviewed_by? }
//   POST ?action=admin-disqualify          { participant_id, reason }
//   POST ?action=admin-issue-reward        { reward_id, issued_by? } → issues + emails "You beat …!"
//
// Identity: joining creates a participant and a random token; only its
// sha256 is stored. The token rides in the private link (/fuel/agent/me?t=)
// and in the browser's localStorage.
//
// Photos never pass through this function (Vercel caps bodies at 4.5 MB):
// the browser PUTs straight to Supabase Storage with a signed upload URL,
// then submit-entry downloads the object server-side to verify it.
//
// Data: the GoElev8.AI Supabase project. Every query filters by client_id.
//
// REQUIRED ENV (Vercel):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY (ANTHROPIC_MODEL optional)
//   FORWARDEMAIL_API_KEY
//   CRON_SECRET          ← NEW (Vercel sends it on cron requests)
//   PORTAL_API_KEY       (existing; the portal's admin calls)

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { TENANT } = require('../lib/fuel/tenant');
const { verifyStepImage, checkWindow, sniffMime } = require('../lib/fuel/verifyStepImage');
const { askText, ClaudeError } = require('../lib/fuel/claude');
const { sendWelcomeEmail, sendRewardEmail } = require('../lib/fuel/challengeEmails');
const { localDate, startOfDay, endOfDay, shortDate, isIsoDate } = require('../lib/fuel/time');

const CLIENT_ID = TENANT.clientId;
const BUCKET = 'fuel-step-proofs';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heic', 'image/webp': 'webp' };
const SOURCES = ['stair_machine_photo', 'watch_screenshot', 'phone_app_screenshot'];
const JOINS_PER_IP_HOUR = 3;
const DEFAULT_DAILY_SUBMISSIONS = 6;
const UPLOAD_URLS_PER_DAY = 20;
const CHATS_PER_IP_HOUR = 30;
const STATUS_ORDER = ['draft', 'upcoming', 'live', 'judging', 'complete'];
const PUBLIC_CHALLENGE_COLS = 'id, client_id, slug, title, subtitle, challenge_type, start_date, end_date, timezone, log_grace_hours, final_upload_deadline, coach_participant_id, reward_title, reward_cap, daily_step_cap, status, rules, hero_copy';

// ─── Helpers ─────────────────────────────────────────────────────────

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (code, message) => new HttpError(400, code, message);

function body(req) {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
  return b && typeof b === 'object' ? b : {};
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

// Keyed so a leaked table can't be reversed by hashing all IPv4s.
function ipHash(req) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || 'fuel-agent';
  return crypto.createHmac('sha256', key).update(clientIp(req)).digest('hex').slice(0, 32);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const steps = (n) => Number(n || 0).toLocaleString('en-US');

function secretMatches(given, expected) {
  if (!given || !expected) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function cleanName(v) {
  const s = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// Same normalization as /api/bootcamp and /api/trainer-apply.
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (String(raw).trim().startsWith('+')) return '+' + digits;
  return null;
}

// Status by date, never moving backwards from what's stored (so the coach
// can close a challenge early). 'draft' is only ever set by hand.
function effectiveStatus(ch, now = new Date()) {
  if (ch.status === 'draft') return 'draft';
  const tz = ch.timezone;
  const deadline = new Date(ch.final_upload_deadline);
  let byDate;
  if (now < startOfDay(ch.start_date, tz)) byDate = 'upcoming';
  else if (now < endOfDay(ch.end_date, tz)) byDate = 'live';
  else if (now < new Date(deadline.getTime() + 24 * 3600_000)) byDate = 'judging';
  else byDate = 'complete';
  return STATUS_ORDER[Math.max(STATUS_ORDER.indexOf(byDate), STATUS_ORDER.indexOf(ch.status))];
}

async function loadChallenge(supabase, slug) {
  if (!slug || typeof slug !== 'string') throw bad('missing_slug');
  const { data, error } = await supabase
    .from('fuel_challenges').select(PUBLIC_CHALLENGE_COLS)
    .eq('client_id', CLIENT_ID).eq('slug', slug).maybeSingle();
  if (error) throw new Error('challenge lookup: ' + error.message);
  if (!data || data.status === 'draft') throw new HttpError(404, 'challenge_not_found');
  return data;
}

async function loadChallengeById(supabase, id) {
  const { data, error } = await supabase
    .from('fuel_challenges').select(PUBLIC_CHALLENGE_COLS)
    .eq('client_id', CLIENT_ID).eq('id', id).maybeSingle();
  if (error) throw new Error('challenge lookup: ' + error.message);
  if (!data) throw new HttpError(404, 'challenge_not_found');
  return data;
}

// Token → participant + challenge, or 401.
async function auth(supabase, token) {
  if (!token || typeof token !== 'string' || token.length > 100) throw new HttpError(401, 'signed_out');
  const { data: participant, error } = await supabase
    .from('fuel_challenge_participants')
    .select('id, client_id, challenge_id, first_name, display_name, email, is_coach, status')
    .eq('client_id', CLIENT_ID).eq('access_token_hash', sha256(token)).maybeSingle();
  if (error) throw new Error('participant lookup: ' + error.message);
  if (!participant) throw new HttpError(401, 'signed_out');
  const challenge = await loadChallengeById(supabase, participant.challenge_id);
  return { participant, challenge };
}

async function logEvent(supabase, row) {
  const { error } = await supabase.from('fuel_agent_events').insert({ client_id: CLIENT_ID, ...row });
  if (error) console.error('[fuel-challenge] event insert failed:', row.event_type, error.message);
}

async function countEvents(supabase, filters, since) {
  let q = supabase.from('fuel_agent_events').select('id', { count: 'exact', head: true })
    .eq('client_id', CLIENT_ID).gte('created_at', since.toISOString());
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  const { count, error } = await q;
  if (error) throw new Error('rate limit count: ' + error.message);
  return count || 0;
}

function publicChallenge(ch, now = new Date()) {
  const tz = ch.timezone;
  return {
    slug: ch.slug,
    title: ch.title,
    subtitle: ch.subtitle,
    challenge_type: ch.challenge_type,
    start_date: ch.start_date,
    end_date: ch.end_date,
    timezone: tz,
    log_grace_hours: ch.log_grace_hours,
    final_upload_deadline: ch.final_upload_deadline,
    reward_title: ch.reward_title,
    daily_step_cap: ch.daily_step_cap,
    status: effectiveStatus(ch, now),
    rules: ch.rules,
    hero_copy: ch.hero_copy,
    today: localDate(now, tz),
    starts_at: startOfDay(ch.start_date, tz).toISOString(),
    ends_at: endOfDay(ch.end_date, tz).toISOString(),
    now: now.toISOString(),
  };
}

// The leaderboard view, read with the service role and scoped by client.
async function leaderboardRows(supabase, challenge) {
  const { data, error } = await supabase
    .from('fuel_challenge_leaderboard')
    .select('participant_id, display_name, is_coach, total_counted_steps, days_logged, last_entry_at, rank, coach_total, beats_coach')
    .eq('client_id', CLIENT_ID).eq('challenge_id', challenge.id)
    .order('is_coach', { ascending: false })
    .order('rank', { ascending: true, nullsFirst: true })
    .limit(5000);
  if (error) throw new Error('leaderboard: ' + error.message);
  return data;
}

async function standingFor(supabase, challenge, participantId) {
  const { data, error } = await supabase
    .from('fuel_challenge_leaderboard')
    .select('participant_id, display_name, is_coach, total_counted_steps, days_logged, rank, coach_total, beats_coach')
    .eq('client_id', CLIENT_ID).eq('challenge_id', challenge.id).eq('participant_id', participantId)
    .maybeSingle();
  if (error) throw new Error('standing: ' + error.message);
  if (!data) return null;
  const total = Number(data.total_counted_steps || 0);
  const coachTotal = data.coach_total == null ? null : Number(data.coach_total);
  return {
    total,
    rank: data.rank,
    days_logged: data.days_logged,
    is_coach: data.is_coach,
    coach_total: coachTotal,
    beats_coach: !!data.beats_coach,
    // Steps needed to pass the coach (strictly more), or the lead.
    gap_to_coach: coachTotal == null || data.is_coach ? null : coachTotal - total,
  };
}

// ─── Router ──────────────────────────────────────────────────────────

const ROUTES = {
  'GET challenge': handleChallenge,
  'GET leaderboard': handleLeaderboard,
  'POST join': handleJoin,
  'POST resend-link': handleResendLink,
  'POST upload-url': handleUploadUrl,
  'POST submit-entry': handleSubmitEntry,
  'GET me': handleMe,
  'POST agent-chat': handleAgentChat,
  'GET cron-daily': handleCronDaily,
  'GET admin-queue': admin(handleAdminQueue),
  'POST admin-review': admin(handleAdminReview),
  'POST admin-manual-entry': admin(handleAdminManualEntry),
  'POST admin-disqualify': admin(handleAdminDisqualify),
  'POST admin-issue-reward': admin(handleAdminIssueReward),
};

module.exports = async function handler(req, res) {
  const action = String(req.query?.action || '');
  const route = ROUTES[`${req.method} ${action}`];
  if (!route) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method_or_action_not_allowed' });
  }
  if (!['GET challenge', 'GET leaderboard'].includes(`${req.method} ${action}`)) {
    res.setHeader('Cache-Control', 'no-store');
  }
  const supabase = getSupabase();
  if (!supabase) return res.status(500).json({ ok: false, error: 'supabase_env_missing' });
  try {
    return await route(req, res, supabase);
  } catch (e) {
    if (e instanceof HttpError) {
      return res.status(e.status).json({ ok: false, error: e.code, message: e.message !== e.code ? e.message : undefined });
    }
    console.error(`[fuel-challenge] ${action} failed:`, e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
};

function admin(fn) {
  return (req, res, supabase) => {
    if (!secretMatches(bearer(req), process.env.PORTAL_API_KEY)) throw new HttpError(401, 'unauthorized');
    return fn(req, res, supabase);
  };
}

// ─── Public: challenge + leaderboard ─────────────────────────────────

async function handleChallenge(req, res, supabase) {
  const challenge = await loadChallenge(supabase, req.query.slug);
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=60');
  return res.status(200).json({ ok: true, challenge: publicChallenge(challenge) });
}

async function handleLeaderboard(req, res, supabase) {
  const challenge = await loadChallenge(supabase, req.query.slug);
  const status = effectiveStatus(challenge);
  const rows = await leaderboardRows(supabase, challenge);
  const safe = (r) => ({
    display_name: r.display_name,
    total: Number(r.total_counted_steps || 0),
    rank: r.rank,
    days_logged: r.days_logged,
    is_coach: r.is_coach,
    beats_coach: !!r.beats_coach,
  });
  const coach = rows.find((r) => r.is_coach);
  const players = rows.filter((r) => !r.is_coach);
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=30');
  return res.status(200).json({
    ok: true,
    status,
    coach: coach ? safe(coach) : null,
    // Before launch everyone is at zero; the page shows a placeholder.
    top: status === 'upcoming' ? [] : players.filter((r) => r.rank != null && r.rank <= 10).map(safe),
    participants: players.length,
    beating_coach: players.filter((r) => r.beats_coach).length,
    updated_at: new Date().toISOString(),
  });
}

// ─── Public: join + link ─────────────────────────────────────────────

async function handleJoin(req, res, supabase) {
  const b = body(req);
  const challenge = await loadChallenge(supabase, b.slug);
  const status = effectiveStatus(challenge);
  if (!['upcoming', 'live'].includes(status)) throw bad('joins_closed', 'This challenge is closed to new players.');

  const first = cleanName(b.first_name);
  const last = cleanName(b.last_name);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 254);
  const phone = b.phone ? toE164(b.phone) : null;
  if (!first) throw bad('missing_first_name', 'Enter your first name.');
  if (!last) throw bad('missing_last_name', 'Enter your last name.');
  if (!isEmail(email)) throw bad('invalid_email', 'Enter a valid email.');
  if (b.phone && !phone) throw bad('invalid_phone', 'Enter a valid phone number, or leave it blank.');
  if (b.consent !== true) throw bad('consent_required', 'Check the box to agree to the challenge rules.');

  const ip = ipHash(req);
  const { count: recentJoins, error: rlErr } = await supabase
    .from('fuel_challenge_participants').select('id', { count: 'exact', head: true })
    .eq('client_id', CLIENT_ID).eq('join_ip_hash', ip)
    .gte('created_at', new Date(Date.now() - 3600_000).toISOString());
  if (rlErr) throw new Error('join rate limit: ' + rlErr.message);
  if ((recentJoins || 0) >= JOINS_PER_IP_HOUR) {
    throw new HttpError(429, 'rate_limited', 'Too many sign-ups from this device. Try again in an hour.');
  }

  const { data: existing } = await supabase
    .from('fuel_challenge_participants').select('id')
    .eq('client_id', CLIENT_ID).eq('challenge_id', challenge.id).eq('email', email).maybeSingle();
  if (existing) {
    // Never hand a token to whoever typed the email; mail it instead.
    await emailFreshLink(supabase, challenge, existing.id);
    return res.status(200).json({ ok: true, existing: true, emailed: true });
  }

  const token = newToken();
  const row = {
    client_id: CLIENT_ID,
    challenge_id: challenge.id,
    fuel_profile_id: await findFuelProfile(supabase, email),
    first_name: first,
    last_name: last,
    email,
    phone,
    display_name: `${first} ${last.charAt(0).toUpperCase()}.`,
    access_token_hash: sha256(token),
    join_ip_hash: ip,
    consent_at: new Date().toISOString(),
  };
  const { data: participant, error } = await supabase
    .from('fuel_challenge_participants').insert(row)
    .select('id, first_name, email, display_name').single();
  if (error) {
    if (error.code === '23505') {
      return res.status(200).json({ ok: true, existing: true, emailed: false });
    }
    throw new Error('participant insert: ' + error.message);
  }

  await logEvent(supabase, {
    challenge_id: challenge.id, participant_id: participant.id, event_type: 'join',
    payload: { linked_fuel_profile: !!row.fuel_profile_id },
  });
  const link = `${TENANT.siteUrl}${TENANT.agentPath}/me?t=${encodeURIComponent(token)}`;
  let emailed = true;
  try {
    await sendWelcomeEmail({ participant, challenge, link });
  } catch (e) {
    emailed = false;
    console.error('[fuel-challenge] welcome email failed:', e.message);
  }
  return res.status(200).json({ ok: true, token, display_name: participant.display_name, emailed });
}

// Links the participant to their Flex Fuel profile when the GoElev8.AI
// project has the Fuel module and the email matches. Best effort.
async function findFuelProfile(supabase, email) {
  try {
    const { data: tenant } = await supabase.from('clients').select('id').eq('slug', CLIENT_ID).maybeSingle();
    if (!tenant?.id) return null;
    const { data, error } = await supabase.from('fuel_clients').select('id')
      .eq('tenant_id', tenant.id).ilike('email', email.replace(/[%_\\]/g, (c) => '\\' + c)).eq('status', 'active').limit(1);
    if (error) return null;
    return data?.[0]?.id || null;
  } catch {
    return null;
  }
}

async function emailFreshLink(supabase, challenge, participantId) {
  const token = newToken();
  const { data: participant, error } = await supabase
    .from('fuel_challenge_participants')
    .update({ access_token_hash: sha256(token) })
    .eq('client_id', CLIENT_ID).eq('id', participantId)
    .select('id, first_name, email').single();
  if (error) throw new Error('token rotate: ' + error.message);
  const link = `${TENANT.siteUrl}${TENANT.agentPath}/me?t=${encodeURIComponent(token)}`;
  await logEvent(supabase, { challenge_id: challenge.id, participant_id: participantId, event_type: 'link_emailed', payload: {} });
  try {
    await sendWelcomeEmail({ participant, challenge, link });
  } catch (e) {
    console.error('[fuel-challenge] link email failed:', e.message);
  }
}

async function handleResendLink(req, res, supabase) {
  const b = body(req);
  const challenge = await loadChallenge(supabase, b.slug);
  const email = String(b.email || '').trim().toLowerCase();
  if (!isEmail(email)) throw bad('invalid_email', 'Enter a valid email.');
  const ip = ipHash(req);
  const since = new Date(Date.now() - 3600_000);
  if (await countEvents(supabase, { event_type: 'resend_request', challenge_id: challenge.id }, since) >= 200
    || await countRecentByIp(supabase, 'resend_request', ip, since) >= JOINS_PER_IP_HOUR) {
    throw new HttpError(429, 'rate_limited', 'Too many requests. Try again in an hour.');
  }
  await logEvent(supabase, { challenge_id: challenge.id, event_type: 'resend_request', payload: { ip_hash: ip } });
  const { data: p } = await supabase
    .from('fuel_challenge_participants').select('id, status')
    .eq('client_id', CLIENT_ID).eq('challenge_id', challenge.id).eq('email', email).maybeSingle();
  if (p && p.status === 'active') await emailFreshLink(supabase, challenge, p.id);
  // Same answer either way, so this can't be used to test who's in.
  return res.status(200).json({ ok: true, message: "If that email is in the challenge, a new link is on its way. It replaces your old link." });
}

async function countRecentByIp(supabase, eventType, ip, since) {
  const { count, error } = await supabase
    .from('fuel_agent_events').select('id', { count: 'exact', head: true })
    .eq('client_id', CLIENT_ID).eq('event_type', eventType)
    .eq('payload->>ip_hash', ip).gte('created_at', since.toISOString());
  if (error) throw new Error('rate limit count: ' + error.message);
  return count || 0;
}

// ─── Public: upload + submit ─────────────────────────────────────────

async function handleUploadUrl(req, res, supabase) {
  const b = body(req);
  const { participant, challenge } = await auth(supabase, b.t);
  if (participant.status !== 'active') throw new HttpError(403, 'not_active', "Your account can't log steps right now.");
  if (new Date(challenge.final_upload_deadline) <= new Date()) throw bad('deadline_passed', 'Uploads are closed for this challenge.');
  const ext = MIME_EXT[String(b.mime || '').toLowerCase()];
  if (!ext) throw bad('unsupported_type', 'Use a JPG, PNG, HEIC or WebP image.');

  const since = new Date(Date.now() - 24 * 3600_000);
  if (await countEvents(supabase, { event_type: 'upload_url', participant_id: participant.id }, since) >= UPLOAD_URLS_PER_DAY) {
    throw new HttpError(429, 'rate_limited', "You've hit today's upload limit. Try again tomorrow.");
  }

  const path = `${CLIENT_ID}/${challenge.id}/${participant.id}/${crypto.randomUUID()}.${ext}`;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) throw new Error('signed upload url: ' + error.message);
  await logEvent(supabase, { challenge_id: challenge.id, participant_id: participant.id, event_type: 'upload_url', payload: { ext } });
  return res.status(200).json({ ok: true, upload_url: data.signedUrl, path });
}

const WINDOW_MESSAGES = {
  deadline_passed: 'Uploads are closed. The final deadline has passed.',
  outside_challenge: "That date isn't part of the challenge.",
  future_date: "You can't log a day that hasn't happened yet.",
  grace_expired: "That day's logging window has closed.",
};

async function handleSubmitEntry(req, res, supabase) {
  const b = body(req);
  const { participant, challenge } = await auth(supabase, b.t);
  if (participant.status !== 'active') throw new HttpError(403, 'not_active', "Your account can't log steps right now.");
  const now = new Date();
  const tz = challenge.timezone;

  const entryDate = String(b.entry_date || '');
  const source = String(b.source || '');
  const claimed = Number(b.claimed_steps);
  const imagePath = String(b.image_path || '');
  if (!isIsoDate(entryDate)) throw bad('invalid_date', 'Pick the day you are logging.');
  if (!SOURCES.includes(source)) throw bad('invalid_source', 'Pick where the photo is from.');
  if (!Number.isInteger(claimed) || claimed < 1 || claimed > 1_000_000) throw bad('invalid_steps', 'Enter your steps as a whole number.');
  if (!imagePath.startsWith(`${CLIENT_ID}/${challenge.id}/${participant.id}/`) || imagePath.includes('..')) {
    throw bad('invalid_image', 'Upload your photo again.');
  }

  const win = checkWindow(challenge, entryDate, now);
  if (!win.ok) throw bad(win.reason, WINDOW_MESSAGES[win.reason]);

  const maxDaily = Number(challenge.rules?.max_daily_submissions) || DEFAULT_DAILY_SUBMISSIONS;
  const { count: today, error: cErr } = await supabase
    .from('fuel_step_entries').select('id', { count: 'exact', head: true })
    .eq('client_id', CLIENT_ID).eq('participant_id', participant.id)
    .gte('created_at', startOfDay(localDate(now, tz), tz).toISOString());
  if (cErr) throw new Error('submission count: ' + cErr.message);
  if ((today || 0) >= maxDaily) {
    throw new HttpError(429, 'rate_limited', `That's ${maxDaily} uploads today, the daily max. Try again tomorrow.`);
  }

  const { data: blob, error: dlErr } = await supabase.storage.from(BUCKET).download(imagePath);
  if (dlErr || !blob) throw bad('image_missing', "We couldn't find your photo. Upload it again.");
  const image = Buffer.from(await blob.arrayBuffer());
  if (image.length > MAX_IMAGE_BYTES) throw bad('image_too_large', 'That photo is too large. Try a screenshot instead.');
  if (!sniffMime(image)) throw bad('not_an_image', "That file isn't a photo we can read.");

  const result = await verifyStepImage({
    supabase, challenge, participant,
    entry: { entry_date: entryDate, source, claimed_steps: claimed, image_path: imagePath },
    image, now,
  });

  const { data: entry, error: insErr } = await supabase.from('fuel_step_entries').insert({
    client_id: CLIENT_ID,
    challenge_id: challenge.id,
    participant_id: participant.id,
    entry_date: entryDate,
    claimed_steps: claimed,
    extracted_steps: result.extracted_steps,
    counted_steps: result.counted_steps,
    source,
    image_path: imagePath,
    image_sha256: result.image_sha256,
    image_phash: result.image_phash,
    exif: result.exif,
    c2pa: result.c2pa,
    ai_analysis: result.ai_analysis,
    authenticity_score: result.score,
    authenticity_flags: result.flags,
    verification_status: result.status,
    submitted_ip_hash: ipHash(req),
    user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
  }).select('id').single();
  if (insErr) {
    if (insErr.code === '23505') throw bad('already_submitted', 'That photo was already submitted.');
    throw new Error('entry insert: ' + insErr.message);
  }

  await logEvent(supabase, {
    challenge_id: challenge.id, participant_id: participant.id, entry_id: entry.id,
    event_type: 'entry_verified',
    payload: { status: result.status, score: result.score, flags: result.flags, hard_flags: result.hard_flags, claimed, suggested_steps: result.suggested_steps, reasoning: result.reasoning },
  });

  const standing = await standingFor(supabase, challenge, participant.id);
  const reply = agentReply({ challenge, participant, entryDate, claimed, status: result.status, standing });
  return res.status(200).json({
    ok: true,
    entry: { id: entry.id, entry_date: entryDate, claimed_steps: claimed, status: neutralStatus(result.status) },
    standing,
    reply,
  });
}

// What the participant sees. Never which check fired.
function neutralStatus(s) {
  return { auto_approved: 'counted', approved: 'counted', pending_review: 'checking', rejected: 'not_counted' }[s] || 'checking';
}

function agentReply({ challenge, participant, entryDate, claimed, status, standing }) {
  const coach = challenge.hero_copy?.coach_name || 'the coach';
  const day = shortDate(entryDate);
  if (status !== 'auto_approved') {
    return `Got it. ${coach}'s team will double-check this photo before it counts. You'll see it on your page.`;
  }
  const head = `Logged ${steps(claimed)} steps for ${day} 💪🏾`;
  if (!standing) return head;
  if (participant.is_coach) return `${head} Your total is ${steps(standing.total)}. That's the number to beat.`;
  const rank = standing.rank ? ` You're #${standing.rank}.` : '';
  if (standing.coach_total == null) return `${head}${rank}`;
  if (standing.beats_coach) {
    return `${head}${rank} You're ${steps(-standing.gap_to_coach)} ahead of ${coach} 🔥 Keep it there.`;
  }
  if (standing.gap_to_coach === 0) return `${head}${rank} You're tied with ${coach}. One more step and you pass him.`;
  return `${head}${rank} ${coach}'s at ${steps(standing.coach_total)}, so you're ${steps(standing.gap_to_coach)} behind.`;
}

// ─── Public: me ──────────────────────────────────────────────────────

async function handleMe(req, res, supabase) {
  const { participant, challenge } = await auth(supabase, req.query.t);
  const { data: entries, error } = await supabase
    .from('fuel_step_entries')
    .select('id, entry_date, claimed_steps, counted_steps, source, verification_status, created_at')
    .eq('client_id', CLIENT_ID).eq('participant_id', participant.id)
    .order('entry_date', { ascending: false }).order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error('entries: ' + error.message);
  const standing = await standingFor(supabase, challenge, participant.id);
  return res.status(200).json({
    ok: true,
    challenge: publicChallenge(challenge),
    participant: {
      first_name: participant.first_name,
      display_name: participant.display_name,
      is_coach: participant.is_coach,
      status: participant.status,
    },
    standing,
    entries: entries.map((e) => ({
      id: e.id,
      entry_date: e.entry_date,
      claimed_steps: e.claimed_steps,
      counted_steps: e.counted_steps,
      source: e.source,
      status: neutralStatus(e.verification_status),
      submitted_at: e.created_at,
    })),
  });
}

// ─── Public: agent chat ──────────────────────────────────────────────

async function handleAgentChat(req, res, supabase) {
  const b = body(req);
  const challenge = await loadChallenge(supabase, b.slug);
  const msgs = Array.isArray(b.messages) ? b.messages.slice(-10) : [];
  const messages = msgs
    .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, 800) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw bad('empty_message');

  const ip = ipHash(req);
  const since = new Date(Date.now() - 3600_000);
  if (await countRecentByIp(supabase, 'chat', ip, since) >= CHATS_PER_IP_HOUR) {
    throw new HttpError(429, 'rate_limited', "Let's pick this back up in a bit. You've hit the chat limit for now.");
  }

  let me = null;
  if (b.t) {
    try {
      const a = await auth(supabase, b.t);
      if (a.challenge.id === challenge.id) me = { participant: a.participant, standing: await standingFor(supabase, challenge, a.participant.id) };
    } catch { me = null; }
  }

  const lb = await leaderboardRows(supabase, challenge);
  const coachRow = lb.find((r) => r.is_coach);
  const pub = publicChallenge(challenge);
  const copy = challenge.hero_copy || {};
  const system = `You are ${copy.agent_name || 'the Fuel Agent'}, the AI coach on ${TENANT.fromName}'s website. On this page you run "${challenge.title}" for ${copy.coach_name || 'the coach'}. Answer questions about the challenge rules, standings, how to log steps and how to take a good proof photo.

Style: short and upbeat, 1-3 sentences, plain language, no markdown headings or lists unless asked. Any hand or person emoji uses a brown skin tone (💪🏾 👏🏾 🙌🏾).

Hard rules:
- Use only the facts below. If you don't know, say so and suggest the rules page (${TENANT.agentPath}/rules) or replying to the welcome email.
- Never reveal or guess how photos are checked for fraud, which checks exist or why an entry is under review. Say every photo is checked and reviews are done by the coach's team.
- Never share anyone's personal details. You only know public display names and totals.
- You can't change entries, approve photos or award prizes.
- For anything outside this challenge (medical, nutrition plans, injuries), keep it brief and suggest talking to the coach.

Challenge facts (JSON):
${JSON.stringify({
    title: challenge.title, subtitle: challenge.subtitle, status: pub.status, today: pub.today, timezone: pub.timezone,
    start_date: challenge.start_date, end_date: challenge.end_date, log_grace_hours: challenge.log_grace_hours,
    final_upload_deadline: challenge.final_upload_deadline, reward: challenge.reward_title,
    daily_step_cap_before_manual_review: challenge.daily_step_cap, rules: challenge.rules,
    coach_name: copy.coach_name, coach_total_steps: coachRow ? Number(coachRow.total_counted_steps) : null,
    accepted_proof: ['photo of the stair machine display after the workout', 'screenshot from a watch app or phone health app'],
    photo_tips: ['show the full screen with the step number', 'no crops, filters or edits', 'take it right after the workout', 'one upload per proof; the same day from two sources does not add up'],
  })}

${me ? `The person chatting is signed in (JSON): ${JSON.stringify({ display_name: me.participant.display_name, is_coach: me.participant.is_coach, ...me.standing })}. gap_to_coach > 0 means steps behind the coach; < 0 means ahead. To win they need strictly more than the coach.` : 'The person chatting is not signed in. If they ask about their own numbers, tell them to open their private My Challenge link or join first.'}`;

  let reply;
  try {
    reply = await askText({ system, messages, maxTokens: 400 });
  } catch (e) {
    const code = e instanceof ClaudeError ? e.code : 'error';
    console.error('[fuel-challenge] chat failed:', code, e?.message);
    throw new HttpError(503, 'agent_unavailable', "I'm having trouble right now. Try again in a minute.");
  }
  await logEvent(supabase, {
    challenge_id: challenge.id, participant_id: me?.participant.id || null, event_type: 'chat',
    payload: { ip_hash: ip, turns: messages.length },
  });
  return res.status(200).json({ ok: true, reply });
}

// ─── Cron ────────────────────────────────────────────────────────────

async function handleCronDaily(req, res, supabase) {
  if (!secretMatches(bearer(req), process.env.CRON_SECRET)) throw new HttpError(401, 'unauthorized');
  const now = new Date();
  const { data: challenges, error } = await supabase
    .from('fuel_challenges').select(PUBLIC_CHALLENGE_COLS)
    .eq('client_id', CLIENT_ID).in('status', ['upcoming', 'live', 'judging']);
  if (error) throw new Error('challenges: ' + error.message);

  const report = [];
  for (const ch of challenges) {
    const next = effectiveStatus(ch, now);
    if (next !== ch.status) {
      await supabase.from('fuel_challenges').update({ status: next }).eq('client_id', CLIENT_ID).eq('id', ch.id);
      await logEvent(supabase, { challenge_id: ch.id, event_type: 'status_change', payload: { from: ch.status, to: next } });
      ch.status = next;
    }
    const rows = await leaderboardRows(supabase, ch);
    const players = rows.filter((r) => !r.is_coach);
    const coach = rows.find((r) => r.is_coach);

    await logEvent(supabase, {
      challenge_id: ch.id, event_type: 'leaderboard_snapshot',
      payload: {
        status: next, date: localDate(now, ch.timezone),
        coach_total: coach ? Number(coach.total_counted_steps) : null,
        participants: players.length,
        top: players.filter((r) => r.rank != null && r.rank <= 10).map((r) => ({
          participant_id: r.participant_id, display_name: r.display_name, rank: r.rank,
          total: Number(r.total_counted_steps), days_logged: r.days_logged, beats_coach: r.beats_coach,
        })),
      },
    });

    const reviewIds = await markFinalReview(supabase, ch, players);
    const rewards = ['judging', 'complete'].includes(next) ? await syncRewards(supabase, ch, players) : null;
    report.push({ slug: ch.slug, status: next, participants: players.length, needs_final_review: reviewIds.length, rewards });
  }
  return res.status(200).json({ ok: true, ran_at: now.toISOString(), challenges: report });
}

// Top 10 or beating the coach → every auto-approved (or still pending)
// entry needs the coach's confirmation before a reward can be issued.
async function markFinalReview(supabase, ch, players) {
  const watched = players.filter((r) => (r.rank != null && r.rank <= 10) || r.beats_coach).map((r) => r.participant_id);
  let needs = [];
  if (watched.length) {
    const { data, error } = await supabase
      .from('fuel_step_entries').select('participant_id')
      .eq('client_id', CLIENT_ID).eq('challenge_id', ch.id)
      .in('participant_id', watched).in('verification_status', ['auto_approved', 'pending_review']);
    if (error) throw new Error('final review scan: ' + error.message);
    needs = [...new Set(data.map((d) => d.participant_id))];
  }
  const { error: clearErr } = await supabase
    .from('fuel_challenge_participants').update({ needs_final_review: false })
    .eq('client_id', CLIENT_ID).eq('challenge_id', ch.id).eq('needs_final_review', true)
    .not('id', 'in', `(${needs.length ? needs.join(',') : '00000000-0000-0000-0000-000000000000'})`);
  if (clearErr) throw new Error('final review clear: ' + clearErr.message);
  if (needs.length) {
    const { error: setErr } = await supabase
      .from('fuel_challenge_participants').update({ needs_final_review: true })
      .eq('client_id', CLIENT_ID).eq('challenge_id', ch.id).in('id', needs);
    if (setErr) throw new Error('final review set: ' + setErr.message);
  }
  return needs;
}

// Eligible rewards for everyone beating the coach (best ranks first when
// reward_cap is set); eligible rows that no longer qualify are revoked.
// Issued/redeemed rewards are never touched here.
async function syncRewards(supabase, ch, players) {
  let winners = players.filter((r) => r.beats_coach).sort((a, b) => a.rank - b.rank);
  if (ch.reward_cap != null) winners = winners.slice(0, ch.reward_cap);
  const winnerIds = new Set(winners.map((w) => w.participant_id));

  const { data: existing, error } = await supabase
    .from('fuel_rewards').select('id, participant_id, status')
    .eq('client_id', CLIENT_ID).eq('challenge_id', ch.id).eq('reward_type', 'bootcamp_pass');
  if (error) throw new Error('rewards: ' + error.message);
  const have = new Map(existing.map((r) => [r.participant_id, r]));

  const created = [];
  const revoked = [];
  for (const w of winners) {
    const r = have.get(w.participant_id);
    if (!r) {
      const { error: insErr } = await supabase.from('fuel_rewards').insert({
        client_id: CLIENT_ID, challenge_id: ch.id, participant_id: w.participant_id,
        reward_type: 'bootcamp_pass', status: 'eligible',
      });
      if (insErr && insErr.code !== '23505') throw new Error('reward insert: ' + insErr.message);
      created.push(w.participant_id);
    } else if (r.status === 'revoked') {
      await supabase.from('fuel_rewards').update({ status: 'eligible', notes: null }).eq('id', r.id).eq('client_id', CLIENT_ID);
      created.push(w.participant_id);
    }
  }
  for (const r of existing) {
    if (r.status === 'eligible' && !winnerIds.has(r.participant_id)) {
      await supabase.from('fuel_rewards').update({ status: 'revoked', notes: 'No longer ahead of the coach at cron check.' })
        .eq('id', r.id).eq('client_id', CLIENT_ID);
      revoked.push(r.participant_id);
    }
  }
  if (created.length || revoked.length) {
    await logEvent(supabase, { challenge_id: ch.id, event_type: 'rewards_synced', payload: { eligible_added: created, revoked } });
  }
  return { eligible: winners.length, added: created.length, revoked: revoked.length };
}

// ─── Portal ──────────────────────────────────────────────────────────

async function handleAdminQueue(req, res, supabase) {
  const challenge = await loadChallenge(supabase, req.query.slug);
  const { data: flagged, error: pErr } = await supabase
    .from('fuel_challenge_participants').select('id')
    .eq('client_id', CLIENT_ID).eq('challenge_id', challenge.id).eq('needs_final_review', true);
  if (pErr) throw new Error('queue participants: ' + pErr.message);
  const flaggedIds = flagged.map((p) => p.id);

  let q = supabase.from('fuel_step_entries')
    .select('id, participant_id, entry_date, claimed_steps, extracted_steps, counted_steps, source, image_path, authenticity_score, authenticity_flags, verification_status, ai_analysis, exif, c2pa, created_at, fuel_challenge_participants(display_name, first_name, last_name, email, is_coach, needs_final_review)')
    .eq('client_id', CLIENT_ID).eq('challenge_id', challenge.id)
    .order('created_at', { ascending: true }).limit(500);
  q = flaggedIds.length
    ? q.or(`verification_status.eq.pending_review,and(verification_status.eq.auto_approved,participant_id.in.(${flaggedIds.join(',')}))`)
    : q.eq('verification_status', 'pending_review');
  const { data: entries, error } = await q;
  if (error) throw new Error('queue: ' + error.message);

  const paths = entries.map((e) => e.image_path).filter(Boolean);
  const urls = {};
  if (paths.length) {
    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 600);
    for (const s of signed || []) if (s.path && s.signedUrl) urls[s.path] = s.signedUrl;
  }
  return res.status(200).json({
    ok: true,
    challenge: publicChallenge(challenge),
    entries: entries.map((e) => ({
      ...e,
      image_url: urls[e.image_path] || null,
      kind: e.verification_status === 'pending_review' ? 'review' : 'final_confirm',
    })),
  });
}

async function adminEntryChallenge(supabase, entryOrParticipant) {
  return loadChallengeById(supabase, entryOrParticipant.challenge_id);
}

async function handleAdminReview(req, res, supabase) {
  const b = body(req);
  const { data: entry, error } = await supabase.from('fuel_step_entries')
    .select('id, challenge_id, participant_id, claimed_steps, extracted_steps, verification_status')
    .eq('client_id', CLIENT_ID).eq('id', String(b.entry_id || '')).maybeSingle();
  if (error) throw new Error('entry lookup: ' + error.message);
  if (!entry) throw new HttpError(404, 'entry_not_found');
  if (!['approve', 'reject'].includes(b.decision)) throw bad('invalid_decision');

  let counted = null;
  if (b.decision === 'approve') {
    counted = b.counted_steps == null ? entry.claimed_steps : Number(b.counted_steps);
    if (!Number.isInteger(counted) || counted < 0 || counted > 1_000_000) throw bad('invalid_steps');
  }
  const reviewedBy = String(b.reviewed_by || 'coach').slice(0, 80);
  const patch = {
    verification_status: b.decision === 'approve' ? 'approved' : 'rejected',
    counted_steps: counted,
    reviewed_by: reviewedBy,
    reviewed_at: new Date().toISOString(),
    review_note: b.note ? String(b.note).slice(0, 500) : null,
  };
  const { error: upErr } = await supabase.from('fuel_step_entries').update(patch).eq('client_id', CLIENT_ID).eq('id', entry.id);
  if (upErr) throw new Error('review update: ' + upErr.message);
  await logEvent(supabase, {
    challenge_id: entry.challenge_id, participant_id: entry.participant_id, entry_id: entry.id,
    event_type: 'entry_reviewed', payload: { from: entry.verification_status, ...patch },
  });
  return res.status(200).json({ ok: true, entry_id: entry.id, status: patch.verification_status, counted_steps: counted });
}

async function handleAdminManualEntry(req, res, supabase) {
  const b = body(req);
  const { data: p, error } = await supabase.from('fuel_challenge_participants')
    .select('id, challenge_id').eq('client_id', CLIENT_ID).eq('id', String(b.participant_id || '')).maybeSingle();
  if (error) throw new Error('participant lookup: ' + error.message);
  if (!p) throw new HttpError(404, 'participant_not_found');
  const ch = await adminEntryChallenge(supabase, p);
  const stepsN = Number(b.steps);
  if (!isIsoDate(b.entry_date) || b.entry_date < ch.start_date || b.entry_date > ch.end_date) throw bad('invalid_date');
  if (!Number.isInteger(stepsN) || stepsN < 0 || stepsN > 1_000_000) throw bad('invalid_steps');
  const reviewedBy = String(b.reviewed_by || 'coach').slice(0, 80);
  const { data: entry, error: insErr } = await supabase.from('fuel_step_entries').insert({
    client_id: CLIENT_ID, challenge_id: ch.id, participant_id: p.id, entry_date: b.entry_date,
    claimed_steps: stepsN, counted_steps: stepsN, source: 'coach_manual',
    verification_status: 'approved', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString(),
    review_note: b.note ? String(b.note).slice(0, 500) : null,
  }).select('id').single();
  if (insErr) throw new Error('manual entry: ' + insErr.message);
  await logEvent(supabase, {
    challenge_id: ch.id, participant_id: p.id, entry_id: entry.id, event_type: 'manual_entry',
    payload: { entry_date: b.entry_date, steps: stepsN, reviewed_by: reviewedBy },
  });
  return res.status(200).json({ ok: true, entry_id: entry.id });
}

async function handleAdminDisqualify(req, res, supabase) {
  const b = body(req);
  const reason = String(b.reason || '').trim().slice(0, 500);
  if (!reason) throw bad('missing_reason');
  const { data: p, error } = await supabase.from('fuel_challenge_participants')
    .update({ status: 'disqualified', disqualified_reason: reason })
    .eq('client_id', CLIENT_ID).eq('id', String(b.participant_id || ''))
    .select('id, challenge_id').maybeSingle();
  if (error) throw new Error('disqualify: ' + error.message);
  if (!p) throw new HttpError(404, 'participant_not_found');
  await supabase.from('fuel_rewards').update({ status: 'revoked', notes: 'Disqualified: ' + reason })
    .eq('client_id', CLIENT_ID).eq('participant_id', p.id).eq('status', 'eligible');
  await logEvent(supabase, { challenge_id: p.challenge_id, participant_id: p.id, event_type: 'disqualified', payload: { reason } });
  return res.status(200).json({ ok: true });
}

function redemptionCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const byte of bytes) s += alphabet[byte % alphabet.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

async function handleAdminIssueReward(req, res, supabase) {
  const b = body(req);
  const { data: reward, error } = await supabase.from('fuel_rewards')
    .select('id, challenge_id, participant_id, status, redemption_code')
    .eq('client_id', CLIENT_ID).eq('id', String(b.reward_id || '')).maybeSingle();
  if (error) throw new Error('reward lookup: ' + error.message);
  if (!reward) throw new HttpError(404, 'reward_not_found');
  if (reward.status !== 'eligible') throw bad('not_eligible', `Reward is ${reward.status}.`);

  const ch = await loadChallengeById(supabase, reward.challenge_id);
  if (!['judging', 'complete'].includes(effectiveStatus(ch))) throw bad('challenge_not_finished', 'Rewards are issued after the challenge ends.');

  const { data: participant } = await supabase.from('fuel_challenge_participants')
    .select('id, first_name, email, status').eq('client_id', CLIENT_ID).eq('id', reward.participant_id).single();
  if (participant.status !== 'active') throw bad('participant_disqualified');

  // Every entry must have been confirmed by the coach — nothing left that
  // only the agent approved, nothing still waiting.
  const { count: unconfirmed, error: uErr } = await supabase.from('fuel_step_entries')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', CLIENT_ID).eq('participant_id', participant.id)
    .in('verification_status', ['auto_approved', 'pending_review']);
  if (uErr) throw new Error('unconfirmed count: ' + uErr.message);
  if (unconfirmed) throw bad('needs_final_review', `${unconfirmed} entr${unconfirmed === 1 ? 'y needs' : 'ies need'} your confirmation first.`);

  const standing = await standingFor(supabase, ch, participant.id);
  if (!standing?.beats_coach) throw bad('not_ahead_of_coach', 'After review, this player is no longer ahead of the coach.');

  const code = reward.redemption_code || redemptionCode();
  const issuedBy = String(b.issued_by || 'coach').slice(0, 80);
  const { data: issued, error: upErr } = await supabase.from('fuel_rewards')
    .update({ status: 'issued', redemption_code: code, issued_at: new Date().toISOString(), notes: `Issued by ${issuedBy}` })
    .eq('client_id', CLIENT_ID).eq('id', reward.id).eq('status', 'eligible')
    .select('id, redemption_code').maybeSingle();
  if (upErr) throw new Error('reward issue: ' + upErr.message);
  if (!issued) throw bad('not_eligible', 'Reward was already issued.');

  let emailed = true;
  try {
    await sendRewardEmail({ participant, challenge: ch, reward: issued, totals: { total: standing.total, coach_total: standing.coach_total } });
  } catch (e) {
    emailed = false;
    console.error('[fuel-challenge] reward email failed:', e.message);
  }
  await logEvent(supabase, {
    challenge_id: ch.id, participant_id: participant.id, event_type: 'reward_issued',
    payload: { reward_id: reward.id, issued_by: issuedBy, emailed, total: standing.total, coach_total: standing.coach_total },
  });
  return res.status(200).json({ ok: true, reward_id: reward.id, redemption_code: code, emailed });
}
