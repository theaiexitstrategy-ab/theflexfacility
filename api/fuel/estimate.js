// Flex Fuel (TEST) — meal estimate proxy for /fuel.
//
// POST /api/fuel/estimate
//   Headers: x-flex-code: <FLEX_FUEL_ACCESS_CODE>
//   Body:    { prompt: string, image?: base64 JPEG (raw or data: URL) }
//            { check: true }  → just validates the access code
//   → 200 the JSON object Claude returned (fences stripped, parsed)
//   → 4xx/5xx { error: <code>, message } — see ERRORS below
//
// The Anthropic key (ANTHROPIC_API_KEY) never leaves the server. Every
// request needs the shared test code, and each IP is held to RATE_LIMIT
// requests per hour (in memory, so per warm instance — fine for a
// two-person test, not a real quota).

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 1000;
const MAX_PROMPT_CHARS = 8000;
// The page resizes photos to 1280px JPEG first; this is a backstop well
// under Vercel's 4.5 MB request body limit.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 60 * 1000;

// error code → [status, message shown on the page]
const ERRORS = {
  missing_code: [401, 'Enter the Flex Fuel access code to continue.'],
  invalid_code: [401, "That access code isn't right. Check with Coach Kenny."],
  rate_limited: [429, 'Too many requests from this device. Try again in a little while.'],
  bad_request: [400, 'Something was wrong with that request. Try again.'],
  image_too_large: [413, 'That photo is too large. Try another one.'],
  image_rejected: [422, "That photo couldn't be read. Try another one."],
  not_configured: [503, "Flex Fuel isn't set up on the server yet."],
  busy: [503, 'The estimator is busy right now. Try again in a minute.'],
  timeout: [504, 'That took too long. Try again.'],
  refused: [422, "That one couldn't be estimated. Enter it yourself."],
  invalid_json: [502, "Couldn't read that one. Try again or type it."],
  upstream_error: [502, "Couldn't reach the estimator. Try again or type it."],
  method_not_allowed: [405, 'Use POST.'],
};

function fail(res, code, extra = {}) {
  const [status, message] = ERRORS[code];
  return res.status(status).json({ error: code, message, ...extra });
}

// ─── Access code ────────────────────────────────────────────────────
function codeMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// ─── Per-IP rate limit (sliding window, in memory) ──────────────────
const hits = new Map(); // ip -> [timestamps]
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}
function overLimit(ip, now = Date.now()) {
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return Math.ceil((recent[0] + RATE_WINDOW_MS - now) / 1000);
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) { // keep memory bounded on a long-lived instance
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k);
  }
  return 0;
}

// ─── Reply parsing ──────────────────────────────────────────────────
function parseReply(text) {
  const stripped = String(text).trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  // Prose around the object: take the outermost {...}.
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(stripped.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

function readImage(raw) {
  if (raw == null || raw === '') return { data: null };
  if (typeof raw !== 'string') return { error: 'bad_request' };
  const m = raw.match(/^data:([^;,]+);base64,(.*)$/s);
  const mediaType = m ? m[1] : 'image/jpeg';
  const data = (m ? m[2] : raw).replace(/\s+/g, '');
  if (mediaType !== 'image/jpeg') return { error: 'bad_request' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { error: 'bad_request' };
  if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) return { error: 'image_too_large' };
  return { data };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return fail(res, 'method_not_allowed');
    }

    const expected = process.env.FLEX_FUEL_ACCESS_CODE;
    if (!expected) return fail(res, 'not_configured');

    // Rate-limit before checking the code so the code can't be guessed fast.
    const wait = overLimit(clientIp(req));
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      return fail(res, 'rate_limited', { retry_after: wait });
    }

    const given = req.headers['x-flex-code'];
    if (!given) return fail(res, 'missing_code');
    if (!codeMatches(given, expected)) return fail(res, 'invalid_code');

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body || typeof body !== 'object') return fail(res, 'bad_request');

    if (body.check === true) return res.status(200).json({ ok: true });

    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > MAX_PROMPT_CHARS) return fail(res, 'bad_request');
    const image = readImage(body.image);
    if (image.error) return fail(res, image.error);

    if (!process.env.ANTHROPIC_API_KEY) return fail(res, 'not_configured');
    const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

    const content = [];
    if (image.data) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.data } });
    }
    content.push({ type: 'text', text: prompt });

    const params = {
      model,
      max_tokens: MAX_TOKENS,
      // A short JSON estimate doesn't need deep reasoning, and thinking
      // tokens count against the 1000-token cap.
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content }],
    };
    // Sonnet 5.5 can skip thinking entirely; other models reject this.
    if (model === 'claude-sonnet-5-5') params.thinking = { type: 'between_tools' };

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 50_000, maxRetries: 1 });

    let message;
    try {
      message = await client.messages.create(params);
    } catch (e) {
      if (e instanceof Anthropic.APIConnectionTimeoutError) return fail(res, 'timeout');
      if (e instanceof Anthropic.RateLimitError) return fail(res, 'busy');
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        console.error('[fuel] Anthropic auth error:', e.message);
        return fail(res, 'not_configured');
      }
      if (e instanceof Anthropic.BadRequestError) {
        console.error('[fuel] Anthropic 400:', e.message);
        return fail(res, image.data && /image/i.test(e.message) ? 'image_rejected' : 'upstream_error');
      }
      if (e instanceof Anthropic.APIError && e.status === 529) return fail(res, 'busy');
      console.error('[fuel] Anthropic error:', e?.status, e?.message);
      return fail(res, 'upstream_error');
    }

    if (message.stop_reason === 'refusal') return fail(res, 'refused');
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = parseReply(text);
    if (!parsed || typeof parsed !== 'object') {
      console.error('[fuel] unparseable reply, stop_reason:', message.stop_reason);
      return fail(res, 'invalid_json');
    }
    return res.status(200).json(parsed);
  } catch (e) {
    console.error('[fuel] uncaught:', e);
    return fail(res, 'upstream_error');
  }
};
