// Vercel serverless function — proxies lead submissions from
// theflexfacility.com client pages to the GoElev8 portal webhook.
//
// Why this exists:
//   portal.goelev8.ai/api/webhooks/lead does not currently return CORS
//   headers, so browsers block the cross-origin POST on the preflight.
//   Routing through this same-origin endpoint bypasses CORS entirely
//   and lets us keep the portal secret in a Vercel env var instead of
//   inlining it in public client HTML.
//
// Environment variables (set in Vercel project settings):
//   GOELEV8_SECRET   — shared secret the portal validates (required)
//   GOELEV8_LEAD_URL — override endpoint for staging (optional)
//
// Request:  POST /api/lead with JSON body { name, phone, email, funnel, tag, ... }
// Response: forwards the portal's status + body verbatim, or 502 on upstream failure.

const PORTAL_URL = process.env.GOELEV8_LEAD_URL || 'https://portal.goelev8.ai/api/webhooks/lead';
const PORTAL_SECRET = process.env.GOELEV8_SECRET || '';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel auto-parses JSON bodies when Content-Type is application/json.
  // Be defensive: some clients send text/plain to dodge browser preflight.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  // Server-side enrichment: the slug is fixed for this site and the
  // secret must never come from the client (clients can't be trusted).
  const payload = Object.assign({}, body, {
    slug: 'flex-facility',
    secret: PORTAL_SECRET,
    forwarded_at: new Date().toISOString(),
    forwarded_ip: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '',
    forwarded_ua: req.headers['user-agent'] || ''
  });
  // Clean any client-supplied secret so we never echo it back upstream
  // with a wrong value.
  delete payload.client_secret;

  try {
    const upstream = await fetch(PORTAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    return res.send(text);
  } catch (err) {
    console.error('[lead-proxy] upstream failed', err && err.message);
    return res.status(502).json({
      error: 'Upstream failed',
      message: String((err && err.message) || err)
    });
  }
};
