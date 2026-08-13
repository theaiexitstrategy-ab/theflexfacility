// ROQ N FLEX Bootcamp reservations for /bootcamp.
//
// ONE serverless function, two actions on ?action=, to stay under the
// Vercel Hobby 12-function limit (this repo is at 4 of 12 with this file):
//
//   POST /api/bootcamp?action=create-checkout
//     Body: { name, phone, email, waiver_accepted }
//     Inserts a pending bootcamp_signups row, creates a $10 Stripe
//     Checkout Session against Kenny's connected account, stamps the
//     session id on the row, returns the hosted-checkout URL.
//
//   POST /api/bootcamp?action=webhook
//     Stripe webhook receiver for the BOOTCAMP endpoint. On
//     checkout.session.completed flips payment_status -> 'paid' and then
//     sends both confirmations (email via ForwardEmail.net, SMS via
//     Twilio). Marks 'expired'/'failed' on the matching session events.
//     Always 200s so Stripe stops retrying.
//
// The success page reuses the existing /api/verify-session function
// rather than adding a third action here.
//
// IMPORTANT — bodyParser is disabled file-wide so the webhook can read
// the raw body for signature verification; create-checkout parses JSON
// itself via readJsonBody().
//
// FEE LOGIC — see lib/platform-config.js. Same shape as merch
// (application_fee_amount = customerFee + platformFee, so the customer
// fee never lands in Kenny's balance), but parameterized for events:
// the customer pays Stripe's real processing cost instead of merch's
// flat $3, and the platform rate is BOOTCAMP_PLATFORM_FEE_PCT (10%),
// which is a separate constant from the merch rate on purpose.
//
//   $10.00 ticket + $0.61 processing = $10.61 charged
//   application_fee_amount = $0.61 + $1.00 = $1.61 → GoElev8
//   Kenny nets $9.00 (90% of list)
//
// REQUIRED ENV (Vercel):
//   STRIPE_SECRET_KEY
//   STRIPE_BOOTCAMP_WEBHOOK_SECRET  (falls back to STRIPE_WEBHOOK_SECRET)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   FORWARDEMAIL_API_KEY            ← NEW, must be added before launch
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   COACH_KENNY_PHONE               (optional — owner alert)

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const {
  BOOTCAMP_EVENT,
  calcProcessingFee,
  calcEventPlatformFee,
  calcEventCustomerTotal,
} = require('../lib/platform-config');

const CLIENT_ID = 'flex-facility';
const SITE_URL = 'https://theflexfacility.com';
const FROM_EMAIL = 'info@theflexfacility.com';
const FROM_NAME = 'The Flex Facility';

module.exports.config = {
  api: { bodyParser: false },
};

// ─── Helpers ─────────────────────────────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); } catch { return {}; }
}

function getQuery(req) {
  if (req.query) return req.query;
  try {
    const u = new URL(req.url, 'http://x');
    return Object.fromEntries(u.searchParams.entries());
  } catch {
    return {};
  }
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Same normalization as /api/trainer-apply so both surfaces store phones
// in one format.
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (String(raw).trim().startsWith('+')) return '+' + digits;
  return null;
}

function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
}

function fmtUsd(cents) {
  return (cents / 100).toFixed(2);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ─── Router ──────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  try {
    const action = getQuery(req).action;

    if (action === 'create-checkout' && req.method === 'POST') {
      return handleCreateCheckout(req, res);
    }
    if (action === 'webhook' && req.method === 'POST') {
      return handleWebhook(req, res);
    }
    res.setHeader('Allow', 'POST');
    return res.status(405).json({
      success: false,
      error: 'method_or_action_not_allowed',
      hint: 'Use ?action=create-checkout (POST) | webhook (POST)',
    });
  } catch (e) {
    console.error('[bootcamp] uncaught:', e);
    return res.status(500).json({
      success: false,
      error: 'unhandled',
      detail: e?.message || String(e),
    });
  }
};

// ─── action=create-checkout ──────────────────────────────────────────

async function handleCreateCheckout(req, res) {
  const body = await readJsonBody(req);
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone = toE164(body.phone);
  const waiverAccepted = body.waiver_accepted === true || body.waiver_accepted === 'true';

  if (!name) return res.status(400).json({ success: false, error: 'missing_name' });
  if (!isEmail(email)) return res.status(400).json({ success: false, error: 'invalid_email' });
  if (!phone) return res.status(400).json({ success: false, error: 'invalid_phone' });
  // Server-side gate as well as the checkbox: no reservation exists
  // without an accepted waiver (the table CHECK constraint backs this up).
  if (!waiverAccepted) return res.status(400).json({ success: false, error: 'waiver_required' });

  const listPrice = BOOTCAMP_EVENT.listPriceCents;
  const processingFee = calcProcessingFee(listPrice);
  const platformFee = calcEventPlatformFee(listPrice);
  const totalCharge = calcEventCustomerTotal(listPrice);

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ success: false, error: 'supabase_env_missing' });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ success: false, error: 'stripe_env_missing', missing: ['STRIPE_SECRET_KEY'] });
  }

  // Connected-account lookup mirrors /api/payments: clients row is the
  // current source of truth (written by the portal's Stripe OAuth
  // callback), stripe_connect_accounts is the legacy fallback.
  let stripeAccountId = null;
  const { data: clientRow, error: clientErr } = await supabase
    .from('clients')
    .select('stripe_connected_account_id')
    .eq('slug', CLIENT_ID)
    .maybeSingle();
  if (clientErr) {
    console.error('[bootcamp] clients lookup failed:', clientErr);
    return res.status(500).json({ success: false, error: 'account_lookup_failed', detail: clientErr.message });
  }
  if (clientRow?.stripe_connected_account_id) {
    stripeAccountId = clientRow.stripe_connected_account_id;
  } else {
    const { data: legacy } = await supabase
      .from('stripe_connect_accounts')
      .select('stripe_account_id, onboarding_complete')
      .eq('client_id', CLIENT_ID)
      .maybeSingle();
    if (legacy?.onboarding_complete && legacy?.stripe_account_id) {
      stripeAccountId = legacy.stripe_account_id;
    }
  }
  if (!stripeAccountId) {
    return res.status(400).json({
      success: false,
      error: 'stripe_not_connected',
      detail: 'Stripe not connected for this account. Open the portal Settings tab and click Connect Stripe.',
    });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  // Verify live so a restricted account fails cleanly here instead of
  // mid-checkout.
  let acct;
  try {
    acct = await stripe.accounts.retrieve(stripeAccountId);
  } catch (e) {
    return res.status(400).json({
      success: false,
      error: 'stripe_account_unreachable',
      detail: e?.message || 'Could not load Stripe account',
    });
  }
  if (!acct.charges_enabled) {
    return res.status(400).json({
      success: false,
      error: 'charges_not_enabled',
      detail: 'The connected Stripe account isn\'t cleared to accept charges yet.',
    });
  }

  // Insert pending first so the Checkout Session can carry the row id in
  // metadata — that id is what the webhook matches on.
  const { data: signup, error: insertErr } = await supabase
    .from('bootcamp_signups')
    .insert({
      client_id: CLIENT_ID,
      name,
      phone,
      email,
      waiver_accepted: true,
      payment_status: 'pending',
    })
    .select('id')
    .single();

  if (insertErr) {
    console.error('[bootcamp] signup insert failed:', insertErr);
    return res.status(500).json({ success: false, error: 'signup_insert_failed', detail: insertErr.message });
  }

  // See the fee note at the top of this file: routing both the customer's
  // processing fee and the platform's 10% through application_fee_amount
  // leaves Kenny with exactly list − platformFee.
  const applicationFeeAmount = processingFee + platformFee;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${BOOTCAMP_EVENT.name} — Seat Reservation`,
              description: `${BOOTCAMP_EVENT.dateLabel} · ${BOOTCAMP_EVENT.timeLabel} · ${BOOTCAMP_EVENT.venueLine1}, ${BOOTCAMP_EVENT.venueLine2}`,
            },
            unit_amount: listPrice,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Card processing fee' },
            unit_amount: processingFee,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFeeAmount,
        transfer_data: { destination: stripeAccountId },
        metadata: { signup_id: signup.id, client_id: CLIENT_ID, event_key: BOOTCAMP_EVENT.key },
      },
      customer_email: email,
      success_url: `${SITE_URL}/bootcamp?reserved=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/bootcamp?canceled=1`,
      metadata: { signup_id: signup.id, client_id: CLIENT_ID, event_key: BOOTCAMP_EVENT.key },
    });
  } catch (e) {
    console.error('[bootcamp] stripe checkout create failed:', e);
    return res.status(500).json({ success: false, error: 'stripe_checkout_failed', detail: e?.message });
  }

  // Non-fatal: the webhook matches on metadata.signup_id, so a failed
  // stamp here costs us the session id column, not the reservation.
  const { error: stampErr } = await supabase
    .from('bootcamp_signups')
    .update({ stripe_session_id: session.id, updated_at: new Date().toISOString() })
    .eq('id', signup.id);
  if (stampErr) console.warn('[bootcamp] session id stamp failed (non-fatal):', stampErr.message);

  return res.status(200).json({
    success: true,
    url: session.url,
    signup_id: signup.id,
    total_cents: totalCharge,
  });
}

// ─── action=webhook ──────────────────────────────────────────────────

async function handleWebhook(req, res) {
  const webhookSecret = process.env.STRIPE_BOOTCAMP_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET;
  if (!process.env.STRIPE_SECRET_KEY || !webhookSecret) {
    console.error('[bootcamp] webhook env vars missing');
    return res.status(500).json({ error: 'stripe_env_missing' });
  }

  const raw = await readRawBody(req);
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], webhookSecret);
  } catch (e) {
    console.error('[bootcamp] webhook signature verify failed:', e.message);
    return res.status(400).json({ error: 'invalid_signature' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    console.error('[bootcamp] supabase env missing during webhook for event', event.id);
    return res.status(200).json({ received: true, warn: 'supabase_env_missing' });
  }

  const session = event.data.object;
  // Only bootcamp sessions carry event_key — ignore anything else that
  // reaches this endpoint (e.g. a merch webhook pointed here by mistake).
  if (session?.metadata?.event_key && session.metadata.event_key !== BOOTCAMP_EVENT.key) {
    return res.status(200).json({ received: true, ignored: 'other_event_key' });
  }

  if (event.type === 'checkout.session.completed') {
    await onCheckoutCompleted(session, supabase);
    return res.status(200).json({ received: true });
  }

  if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    const status = event.type === 'checkout.session.expired' ? 'expired' : 'failed';
    await updateSignup(supabase, session, { payment_status: status });
    return res.status(200).json({ received: true });
  }

  return res.status(200).json({ received: true, ignored: event.type });
}

// Match on metadata.signup_id, falling back to the stamped session id.
function signupQuery(supabase, session) {
  const q = supabase.from('bootcamp_signups');
  const signupId = session?.metadata?.signup_id;
  return signupId ? { q, column: 'id', value: signupId } : { q, column: 'stripe_session_id', value: session?.id };
}

async function updateSignup(supabase, session, patch) {
  const { q, column, value } = signupQuery(supabase, session);
  if (!value) return null;
  const { data, error } = await q
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq(column, value)
    .select('*');
  if (error) {
    console.error('[bootcamp] signup update failed:', error);
    return null;
  }
  return data;
}

async function onCheckoutCompleted(session, supabase) {
  // Stripe can deliver the same event more than once. Constraining the
  // update to rows that aren't already paid means a redelivery updates
  // zero rows — which is exactly the signal to skip the confirmations
  // rather than texting and emailing someone twice.
  const { q, column, value } = signupQuery(supabase, session);
  if (!value) {
    console.warn('[bootcamp] completed session with no signup reference:', session?.id);
    return;
  }

  const { data: rows, error } = await q
    .update({
      payment_status: 'paid',
      stripe_session_id: session.id,
      updated_at: new Date().toISOString(),
    })
    .eq(column, value)
    .neq('payment_status', 'paid')
    .select('*');

  if (error) {
    console.error('[bootcamp] mark-paid failed:', error);
    return;
  }
  if (!rows || rows.length === 0) {
    console.log('[bootcamp] session already processed, skipping confirmations:', session.id);
    return;
  }

  const signup = rows[0];

  // Confirmations are best-effort — the paid row is the source of truth
  // and Stripe must always get its 200.
  await Promise.all([
    sendConfirmationEmail(signup).catch((e) => console.error('[bootcamp] email failed:', e.message)),
    sendConfirmationSms(signup).catch((e) => console.error('[bootcamp] SMS failed:', e.message)),
  ]);
}

// ─── Confirmation email (ForwardEmail.net) ───────────────────────────
//
// theflexfacility.com is already connected to ForwardEmail.net, so this
// posts to their REST API instead of running SendGrid. Auth is HTTP
// Basic with the API key as the username and an empty password.

async function sendConfirmationEmail(signup) {
  const apiKey = process.env.FORWARDEMAIL_API_KEY;
  if (!apiKey) {
    console.warn('[bootcamp] FORWARDEMAIL_API_KEY not set — skipping confirmation email');
    return;
  }

  const firstName = signup.name.trim().split(/\s+/)[0];
  const e = BOOTCAMP_EVENT;
  const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(`${e.venueLine1}, ${e.venueLine2}`)}`;

  const text = [
    `You're in, ${firstName}!`,
    '',
    `Your seat at the ${e.name} is reserved — $10 reservation paid.`,
    '',
    `WHEN:  ${e.dateLabel} at ${e.timeLabel}`,
    `WHERE: ${e.venueLine1}, ${e.venueLine2}`,
    `MAP:   ${mapsUrl}`,
    '',
    'Includes a full body workout and post workout goodies.',
    '',
    'Questions? Just reply to this email.',
    '',
    '— The Flex Facility',
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#0d0d0d;font-family:Arial,Helvetica,sans-serif;color:#f5f5f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d0d;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#141414;border:1px solid rgba(200,168,75,0.3);border-radius:16px;overflow:hidden;">
        <tr><td style="background:#c8a84b;padding:20px 28px;">
          <div style="font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#0d0d0d;font-weight:bold;">Reservation Confirmed</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <h1 style="margin:0 0 6px;font-size:24px;color:#c8a84b;">You're in, ${escapeHtml(firstName)}!</h1>
          <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#ccc;">
            Your seat at the <strong style="color:#f5f5f5;">${escapeHtml(e.name)}</strong> is reserved.
            <strong style="color:#c8a84b;">$10 reservation paid.</strong>
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(200,168,75,0.07);border:1px solid rgba(200,168,75,0.2);border-radius:12px;">
            <tr><td style="padding:18px 20px;">
              <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8a8a8a;">When</div>
              <div style="font-size:16px;color:#f5f5f5;padding:4px 0 14px;">${escapeHtml(e.dateLabel)} · ${escapeHtml(e.timeLabel)}</div>
              <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8a8a8a;">Where</div>
              <div style="font-size:16px;color:#f5f5f5;padding:4px 0 2px;">${escapeHtml(e.venueLine1)}<br>${escapeHtml(e.venueLine2)}</div>
              <a href="${mapsUrl}" style="font-size:13px;color:#c8a84b;">Open in Maps &rarr;</a>
            </td></tr>
          </table>
          <p style="margin:22px 0 0;font-size:14px;line-height:1.6;color:#ccc;">
            Includes a <strong style="color:#f5f5f5;">full body workout</strong> and <strong style="color:#f5f5f5;">post workout goodies</strong>.
          </p>
          <p style="margin:18px 0 0;font-size:13px;color:#8a8a8a;">Questions? Just reply to this email.</p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid rgba(255,255,255,0.08);font-size:11px;color:#666;">
          The Flex Facility · ${escapeHtml(e.venueLine1)}, ${escapeHtml(e.venueLine2)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const params = new URLSearchParams({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: signup.email,
    subject: `You're in — ${e.name}, ${e.dateLabel}`,
    text,
    html,
  });

  const r = await fetch('https://api.forwardemail.net/v1/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`forwardemail ${r.status}: ${detail.slice(0, 200)}`);
  }
}

// ─── Confirmation SMS (Twilio) ───────────────────────────────────────

async function sendConfirmationSms(signup) {
  const fromNumber = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
  if (!fromNumber || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('[bootcamp] Twilio env incomplete — skipping confirmation SMS');
    return;
  }

  const sms = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const e = BOOTCAMP_EVENT;
  const firstName = signup.name.trim().split(/\s+/)[0];

  const sends = [
    sms.messages.create({
      from: fromNumber,
      to: signup.phone,
      body:
        `You're in, ${firstName}! ${e.name} — ${e.dateLabel}, ${e.timeLabel}. ` +
        `${e.venueLine1}, ${e.venueLine2}. $10 reservation paid. ` +
        `Full body workout + post workout goodies. Reply STOP to opt out.`,
    }),
  ];

  const kennyTo = toE164(process.env.COACH_KENNY_PHONE);
  if (kennyTo) {
    const net = fmtUsd(BOOTCAMP_EVENT.listPriceCents - calcEventPlatformFee(BOOTCAMP_EVENT.listPriceCents));
    sends.push(
      sms.messages.create({
        from: fromNumber,
        to: kennyTo,
        body: `New bootcamp reservation: ${signup.name} (${signup.phone}). You net $${net}. Full list in your portal.`,
      }).catch((err) => console.error('[bootcamp] kenny SMS failed:', err.message))
    );
  }

  await Promise.all(sends);
}
