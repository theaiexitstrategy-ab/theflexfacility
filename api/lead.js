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
//   GOELEV8_WEBHOOK_SECRET — shared secret the portal validates (required).
//                            Must match the same env var set on the portal
//                            project, since the portal verifies this value
//                            on every incoming webhook. Vercel → Settings →
//                            Environment Variables → add to Production,
//                            Preview, and Development scopes, then redeploy.
//   GOELEV8_SECRET         — legacy fallback name (optional; kept so older
//                            env var configurations still work)
//   GOELEV8_LEAD_URL       — override endpoint for staging (optional)
//
// Endpoints:
//   GET  /api/lead   → health check, returns { ok, portal_url, secret_configured, secret_length }
//                      Safe to call from the browser. Never echoes the secret itself.
//   POST /api/lead   → forwards the JSON body to the portal webhook. Injects
//                      the slug + secret server-side in THREE places (body field,
//                      x-goelev8-secret header, Authorization: Bearer) so the
//                      portal can validate whichever pattern it uses.
//   Response: forwards the portal's status + body verbatim, or 502 on upstream failure.

const PORTAL_URL = process.env.GOELEV8_LEAD_URL || 'https://portal.goelev8.ai/api/webhooks/lead';
const PORTAL_SECRET = process.env.GOELEV8_WEBHOOK_SECRET || process.env.GOELEV8_SECRET || '';

module.exports = async function handler(req, res) {
  // ── Health check: lets you verify from the browser that the env var is set
  //    without leaking its value. Hit GET https://<preview>.vercel.app/api/lead
  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      portal_url: PORTAL_URL,
      secret_configured: !!PORTAL_SECRET,
      secret_length: PORTAL_SECRET ? PORTAL_SECRET.length : 0,
      node_version: process.version
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
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

  // Field-name normalization: the client forms send `tag` (singular) but
  // the portal's Supabase handler reads `tags` (plural). Mirror the value
  // into both keys so whichever the portal's handler reaches for picks
  // it up. Harmless if the portal only cares about one of them.
  if (payload.tag && payload.tags === undefined) {
    payload.tags = payload.tag;
  }

  // Send the secret via THREE common patterns so whichever one the
  // portal validates will work. If the portal 401s with all three, the
  // secret value itself is wrong (not the transport mechanism).
  const headers = { 'Content-Type': 'application/json' };
  if (PORTAL_SECRET) {
    headers['x-goelev8-secret'] = PORTAL_SECRET;
    headers['Authorization'] = 'Bearer ' + PORTAL_SECRET;
  }

  console.log('[lead-proxy] →', PORTAL_URL, 'secret_configured:', !!PORTAL_SECRET, 'slug:', payload.slug, 'funnel:', payload.funnel || '(none)');

  // Schema-tolerant forwarding: if the portal's Supabase table is missing
  // a column we're sending (PostgREST returns
  // "Could not find the 'X' column of '<table>' in the schema cache"),
  // strip that column from the payload and retry. Repeats up to 10 times
  // so we surface every missing column in one pass through the logs.
  // The correct permanent fix is a portal-side migration that adds the
  // columns, or nests extras into a jsonb column — this retry loop is
  // a temporary bridge so leads keep flowing in the meantime.
  const MAX_RETRIES = 10;
  const strippedColumns = [];
  let current = payload;
  let upstream, text;

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      upstream = await fetch(PORTAL_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(current)
      });
      text = await upstream.text();

      // PostgREST schema-cache errors look like:
      //   {"error":"Could not find the 'funnel' column of 'leads' in the schema cache"}
      // Only retry on 4xx/5xx with that specific error shape.
      if (upstream.status >= 400 && attempt < MAX_RETRIES) {
        const m = /Could not find the '([^']+)' column/i.exec(text);
        if (m && m[1] && Object.prototype.hasOwnProperty.call(current, m[1])) {
          strippedColumns.push(m[1]);
          console.warn('[lead-proxy] portal missing column:', m[1], '— retrying without it (attempt', attempt + 1, 'of', MAX_RETRIES + ')');
          const next = Object.assign({}, current);
          delete next[m[1]];
          current = next;
          continue;
        }
      }
      break;
    }

    if (strippedColumns.length > 0) {
      console.warn('[lead-proxy] portal schema is missing these columns — fix on the portal side:', strippedColumns.join(', '));
    }

    console.log('[lead-proxy] ←', upstream.status, upstream.statusText, '—', text.slice(0, 300));
    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    // Expose the list of stripped columns in a response header so the
    // client-side diagnostics can surface it without parsing the body.
    if (strippedColumns.length > 0) {
      res.setHeader('x-lead-proxy-stripped', strippedColumns.join(','));
    }
    return res.send(text);
  } catch (err) {
    console.error('[lead-proxy] upstream failed', err && err.message);
    return res.status(502).json({
      error: 'Upstream failed',
      message: String((err && err.message) || err)
    });
  }
};
