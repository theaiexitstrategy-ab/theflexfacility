// Payments serverless function for theflexfacility.com.
//
// Single file, three actions routed via ?action= query string. Done this
// way to stay well under the Vercel Hobby 12-function limit:
//
//   POST /api/payments?action=create-checkout
//     Body: { product_key, size?, color?, customer_name, customer_email,
//             customer_phone }
//     Looks up the Flex Facility's connected Stripe account, computes
//     fees from lib/platform-config.js, inserts a pending orders row,
//     creates a Stripe Checkout Session with two line items
//     (list price + transaction fee), and returns the hosted-checkout URL.
//
//   POST /api/payments?action=webhook
//     Stripe webhook receiver. Verifies the Stripe-Signature header
//     against STRIPE_WEBHOOK_SECRET, then on payment_intent.succeeded
//     flips the order row to 'paid', writes a platform_fees row, and
//     fires SMS to Coach Kenny + the customer. On payment_intent.payment_failed
//     flips the order to 'failed'. Always 200s back so Stripe stops retrying.
//
//   GET  /api/payments?action=connect-status&client_id=flex-facility
//     Returns { connected, charges_enabled, payouts_enabled, account_id }
//     for the given client. Used by /merch to gate the Order button and by
//     the portal to show connection status.
//
// IMPORTANT — bodyParser is disabled file-wide so the webhook can read
// the raw body for signature verification. Other actions parse JSON
// manually via readJsonBody().
//
// FEE LOGIC — see lib/platform-config.js. The spec's worked example
// requires application_fee_amount = platformFee + transactionFee so the
// customer's transaction fee stays on the platform side (covers Stripe's
// processing fee). Kenny's net payout = listPrice - platformFee.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const {
  PRODUCTS: HARDCODED_PRODUCTS,
  PLATFORM_FEE_PCT,
  PROCESSING_FEE_CENTS,
  calcTransactionFee,
  calcPlatformFee,
  calcProcessingFee,
  calcCustomerTotal,
} = require('../lib/platform-config');

// Fetch the live product catalog from the GoElev8 portal so Kenny's
// price edits + new products in the portal Merch tab take effect on
// the very next checkout without redeploying this site. The
// hardcoded HARDCODED_PRODUCTS map from lib/platform-config.js stays
// as a fallback so checkout never breaks on a portal outage.
const PORTAL_URL = (process.env.PORTAL_SYNC_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');
const PORTAL_SLUG = 'flex-facility';

async function fetchPortalProducts() {
  try {
    const r = await fetch(`${PORTAL_URL}/api/external/products?slug=${PORTAL_SLUG}`, {
      headers: { 'Cache-Control': 'no-cache' }
    });
    if (!r.ok) return null;
    const data = await r.json();
    const products = data.products || [];
    if (!products.length) return null;
    // Build a map shaped like HARDCODED_PRODUCTS so the rest of the
    // handler doesn't have to branch on the source.
    const map = {};
    for (const p of products) {
      if (!p.key || !Number.isFinite(p.price_cents)) continue;
      map[p.key] = {
        name: p.name || (HARDCODED_PRODUCTS[p.key]?.name) || p.key,
        listPriceCents: p.price_cents,
        type: HARDCODED_PRODUCTS[p.key]?.type || 'merch'
      };
    }
    return Object.keys(map).length ? map : null;
  } catch (err) {
    console.warn('[payments] portal product fetch failed (using hardcoded):', err.message);
    return null;
  }
}

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

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function getQuery(req) {
  // Vercel injects req.query, but be defensive when bodyParser is off
  // and the runtime hasn't populated it.
  if (req.query) return req.query;
  try {
    const u = new URL(req.url, 'http://x');
    return Object.fromEntries(u.searchParams.entries());
  } catch {
    return {};
  }
}

function fmtUsd(cents) {
  return (cents / 100).toFixed(2);
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
    if (action === 'connect-status' && req.method === 'GET') {
      return handleConnectStatus(req, res);
    }
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).json({
      success: false,
      error: 'method_or_action_not_allowed',
      hint: 'Use ?action=create-checkout (POST) | webhook (POST) | connect-status (GET)',
    });
  } catch (e) {
    console.error('[payments] uncaught:', e);
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

  // Hardcoded — this is the single-tenant flex marketing site. The
  // portal's create-checkout (when we add other tenants) would resolve
  // client_id from session, never trust the client.
  const client_id = 'flex-facility';

  const { product_key, size, color, customer_name, customer_email, customer_phone } = body;

  // Merge live portal catalog over the hardcoded fallback. Portal
  // wins on any key it provides; missing keys still resolve via the
  // hardcoded map so an outage doesn't 400 a known product.
  const portalProducts = await fetchPortalProducts();
  const PRODUCTS = { ...HARDCODED_PRODUCTS, ...(portalProducts || {}) };

  if (!product_key || !PRODUCTS[product_key]) {
    return res.status(400).json({ success: false, error: 'invalid_product_key', valid: Object.keys(PRODUCTS) });
  }
  if (!customer_name || !customer_email || !customer_phone) {
    return res.status(400).json({ success: false, error: 'missing_customer_info' });
  }

  const product = PRODUCTS[product_key];
  const listPrice = product.listPriceCents;
  const txFee = calcTransactionFee(listPrice);
  const platformFee = calcPlatformFee(listPrice);
  const processingFee = calcProcessingFee(listPrice);
  const totalCharge = calcCustomerTotal(listPrice);

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ success: false, error: 'supabase_env_missing' });
  }

  // Look up the connected Stripe account for this tenant.
  //
  // Two storage locations exist historically:
  //   1. clients.stripe_connected_account_id  — written by the
  //      portal's OAuth callback (current source of truth)
  //   2. stripe_connect_accounts table         — legacy seeded by the
  //      old Express-onboarding flow
  //
  // We check clients FIRST because that's where new connections land
  // (after the OAuth Connect Stripe flow Kenny clicked through). Fall
  // back to stripe_connect_accounts only if the clients column is
  // empty — covers projects that never migrated to the OAuth flow.
  //
  // charges_enabled is verified live against Stripe instead of trusting
  // a possibly-stale row, so a tenant that disabled their account in
  // Stripe Dashboard still blocks checkout cleanly.
  let stripeAccountId = null;
  const { data: clientRow, error: clientErr } = await supabase
    .from('clients')
    .select('stripe_connected_account_id')
    .eq('slug', client_id)
    .maybeSingle();
  if (clientErr) {
    console.error('[payments] clients lookup failed:', clientErr);
    return res.status(500).json({ success: false, error: 'account_lookup_failed', detail: clientErr.message });
  }
  if (clientRow?.stripe_connected_account_id) {
    stripeAccountId = clientRow.stripe_connected_account_id;
  } else {
    // Fallback: legacy stripe_connect_accounts row.
    const { data: legacy } = await supabase
      .from('stripe_connect_accounts')
      .select('stripe_account_id, charges_enabled, onboarding_complete')
      .eq('client_id', client_id)
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

  // Verify charges_enabled live so a disconnected/restricted account
  // doesn't slip through. Stripe SDK throws on bad account ids; we
  // catch + surface a clean error.
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ success: false, error: 'stripe_env_missing', missing: ['STRIPE_SECRET_KEY'] });
  }
  const stripeForVerify = Stripe(process.env.STRIPE_SECRET_KEY);
  let acct;
  try {
    acct = await stripeForVerify.accounts.retrieve(stripeAccountId);
  } catch (e) {
    return res.status(400).json({
      success: false,
      error: 'stripe_account_unreachable',
      detail: e?.message || 'Could not load Stripe account',
      account_id: stripeAccountId,
    });
  }
  if (!acct.charges_enabled) {
    return res.status(400).json({
      success: false,
      error: 'charges_not_enabled',
      detail: 'Your connected Stripe account exists but isn\'t cleared to accept charges yet. Finish any pending verification in your Stripe Dashboard, then try again.',
      account_id: stripeAccountId,
    });
  }
  const account = { stripe_account_id: stripeAccountId, charges_enabled: true };

  // Insert pending order row up front so we have an id to thread into
  // Stripe metadata. The webhook will flip status -> 'paid' and write
  // the matching platform_fees row. Tolerant of a missing
  // processing_fee_cents column (pre-migration) — retries without it.
  const orderRow = {
    client_id,
    stripe_account_id: account.stripe_account_id,
    product_type: product.type,
    product_name: product.name,
    list_price_cents: listPrice,
    transaction_fee_cents: txFee,
    processing_fee_cents: processingFee,
    customer_total_cents: totalCharge,
    platform_fee_cents: platformFee,
    platform_fee_pct: PLATFORM_FEE_PCT,
    currency: 'usd',
    customer_name,
    customer_email,
    customer_phone,
    size: size || null,
    color: color || null,
    status: 'pending',
  };
  let { data: order, error: orderErr } = await supabase
    .from('orders').insert(orderRow).select('id').single();
  if (orderErr && /column .*processing_fee_cents.* does not exist/i.test(orderErr.message || '')) {
    const { processing_fee_cents: _drop, ...legacy } = orderRow;
    const retry = await supabase.from('orders').insert(legacy).select('id').single();
    order = retry.data; orderErr = retry.error;
  }

  if (orderErr) {
    console.error('[payments] order insert failed:', orderErr);
    return res.status(500).json({ success: false, error: 'order_insert_failed', detail: orderErr.message });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ success: false, error: 'stripe_env_missing', missing: ['STRIPE_SECRET_KEY'] });
  }
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  // application_fee_amount routes everything that should NOT hit Kenny's
  // connected account to GoElev8:
  //   txFee          → covers Stripe's processing cut
  //   platformFee    → GoElev8's 7% revenue share
  //   processingFee  → GoElev8's flat per-order fee ($3)
  // Net to Kenny    = totalCharge - applicationFeeAmount
  //                 = listPrice (unchanged from before — Kenny's payout
  //                              is not affected by the new $3 fee)
  const applicationFeeAmount = txFee + platformFee + processingFee;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: product.name },
            unit_amount: listPrice,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Transaction fee' },
            unit_amount: txFee,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Processing fee' },
            unit_amount: processingFee,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFeeAmount,
        transfer_data: { destination: account.stripe_account_id },
        metadata: { order_id: order.id, client_id },
      },
      customer_email,
      success_url: 'https://theflexfacility.com/merch?order=success',
      cancel_url: 'https://theflexfacility.com/merch',
      metadata: { order_id: order.id, client_id },
    });
  } catch (e) {
    console.error('[payments] stripe checkout create failed:', e);
    return res.status(500).json({ success: false, error: 'stripe_checkout_failed', detail: e?.message });
  }

  return res.status(200).json({ success: true, url: session.url, order_id: order.id });
}

// ─── action=webhook ──────────────────────────────────────────────────

async function handleWebhook(req, res) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[payments] webhook env vars missing');
    return res.status(500).json({ error: 'stripe_env_missing' });
  }

  const raw = await readRawBody(req);
  const signature = req.headers['stripe-signature'];
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[payments] webhook signature verify failed:', e.message);
    return res.status(400).json({ error: 'invalid_signature' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    // Ack to Stripe so it stops retrying — but log loudly. The row
    // won't reconcile until env is fixed and we either re-send the
    // event or run a reconciliation script.
    console.error('[payments] supabase env missing during webhook for event', event.id);
    return res.status(200).json({ received: true, warn: 'supabase_env_missing' });
  }

  if (event.type === 'payment_intent.succeeded') {
    await onPaymentSucceeded(event, supabase);
    return res.status(200).json({ received: true });
  }

  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const orderId = pi.metadata?.order_id;
    if (orderId) {
      await supabase
        .from('orders')
        .update({
          status: 'failed',
          stripe_payment_intent_id: pi.id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);
    }
    return res.status(200).json({ received: true });
  }

  // Acknowledge everything else (charge.succeeded, etc.) so Stripe stops retrying.
  return res.status(200).json({ received: true, ignored: event.type });
}

async function onPaymentSucceeded(event, supabase) {
  const pi = event.data.object;
  const orderId = pi.metadata?.order_id;
  if (!orderId) {
    console.warn('[payments] PI missing order_id metadata:', pi.id);
    return;
  }

  // Update the pending order row to paid + stamp the PI id.
  const { data: order, error: orderErr } = await supabase
    .from('orders')
    .update({
      status: 'paid',
      stripe_payment_intent_id: pi.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', orderId)
    .select('*')
    .single();

  if (orderErr || !order) {
    console.error('[payments] order update failed for', orderId, orderErr);
    return;
  }

  // Record the collected platform fee. The Stripe transfer id is on
  // pi.latest_charge.application_fee or the application fee resource —
  // not critical for first iteration; leave null and reconcile later.
  await supabase.from('platform_fees').insert({
    order_id: order.id,
    client_id: order.client_id,
    fee_amount_cents: order.platform_fee_cents,
    fee_pct: PLATFORM_FEE_PCT,
    go_elev8_stripe_account: process.env.GO_ELEV8_STRIPE_ACCOUNT_ID || null,
    status: 'collected',
  });

  // Mirror the paid order into the GoElev8 portal so Kenny sees it in
  // the Merch → Orders tab at portal.goelev8.ai (under the
  // flex-facility tenant). Best-effort — failure must never block
  // Stripe ack or the SMS notifications below.
  await syncOrderToPortal({ order, pi }).catch((err) => {
    console.warn('[payments] portal sync failed (non-fatal):', err.message);
  });

  // Notify Kenny + the customer. SMS failures are logged but never
  // bubble up — Stripe must always see a 200 here.
  try {
    const fromNumber = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
    const kennyTo = process.env.COACH_KENNY_PHONE; // TODO: migrate to a portal-side setting
    if (!fromNumber) return;
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return;

    const sms = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const listDollars = fmtUsd(order.list_price_cents);
    const kennyNetCents = order.list_price_cents - order.platform_fee_cents;
    const kennyNetDollars = fmtUsd(kennyNetCents);

    const sends = [];
    if (kennyTo) {
      sends.push(
        sms.messages
          .create({
            from: fromNumber,
            to: kennyTo,
            body: `💰 New order! ${order.product_name} – $${listDollars}. After fees you'll receive $${kennyNetDollars}. Check your portal.`,
          })
          .catch((e) => console.error('[payments] kenny SMS failed:', e.message))
      );
    }
    if (order.customer_phone) {
      sends.push(
        sms.messages
          .create({
            from: fromNumber,
            to: order.customer_phone,
            body: `✅ Order confirmed! ${order.product_name} is on its way. Questions? Reply to this message. – Flex Training 💪🏾`,
          })
          .catch((e) => console.error('[payments] customer SMS failed:', e.message))
      );
    }
    await Promise.all(sends);
  } catch (smsErr) {
    console.error('[payments] SMS block crashed (ignored):', smsErr.message);
  }
}

// ─── Portal sync (best-effort, post-payment) ────────────────────────
//
// POSTs a copy of the paid order to portal.goelev8.ai so Kenny can
// see it in the Merch → Orders tab. The portal keys orders to its
// own clients row via the Bearer token (clients.portal_api_key on
// the goelev8 portal Supabase). Idempotent at the receiving end via
// the stripe_payment_id UNIQUE constraint — a retry just no-ops.
//
// Set in Vercel env:
//   PORTAL_SYNC_URL   = https://portal.goelev8.ai
//   PORTAL_API_KEY    = flex_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//                       (issued in goelev8 portal Master Admin →
//                        Run Pending Migrations)

async function syncOrderToPortal({ order, pi }) {
  const baseUrl = (process.env.PORTAL_SYNC_URL || '').replace(/\/$/, '');
  const apiKey = process.env.PORTAL_API_KEY;
  if (!baseUrl || !apiKey) return;  // not configured → skip silently

  // The portal's order schema is multi-line-item; Flex orders today
  // are always single product. Wrap it in a one-item array so the
  // portal's display + per-item ledger still works.
  const payload = {
    customer_name:  order.customer_name,
    customer_email: order.customer_email,
    customer_phone: order.customer_phone,
    shipping: {},  // Flex orders are picked up at the gym — no ship-to
    items: [{
      product_id:  order.product_type,
      name:        order.product_name,
      color:       order.color,
      size:        order.size,
      quantity:    1,
      price_cents: order.list_price_cents,
    }],
    subtotal_cents:       order.list_price_cents,
    shipping_cents:       0,
    platform_fee_cents:   order.platform_fee_cents,
    processing_fee_cents: order.processing_fee_cents || 0,
    stripe_fee_cents:     order.transaction_fee_cents,
    total_cents:          order.customer_total_cents,
    stripe_payment_id:  pi.id,
    external_order_number: String(order.id),
  };

  const r = await fetch(`${baseUrl}/api/external/orders`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`portal ${r.status}: ${text.slice(0, 200)}`);
  }
}

// ─── action=connect-status ───────────────────────────────────────────

async function handleConnectStatus(req, res) {
  const q = getQuery(req);
  const client_id = q.client_id || 'flex-facility';

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ success: false, error: 'supabase_env_missing' });
  }

  // Read clients.stripe_connected_account_id first (current source of
  // truth — written by the GoElev8 portal's OAuth callback). Fall
  // back to the legacy stripe_connect_accounts table for projects
  // that pre-date the OAuth flow.
  let stripeAccountId = null;
  const { data: clientRow } = await supabase
    .from('clients').select('stripe_connected_account_id').eq('slug', client_id).maybeSingle();
  if (clientRow?.stripe_connected_account_id) {
    stripeAccountId = clientRow.stripe_connected_account_id;
  } else {
    const { data: legacy } = await supabase
      .from('stripe_connect_accounts').select('stripe_account_id').eq('client_id', client_id).maybeSingle();
    if (legacy?.stripe_account_id) stripeAccountId = legacy.stripe_account_id;
  }
  if (!stripeAccountId) return res.status(200).json({ connected: false });

  // Verify against Stripe so the response reflects the LIVE state of
  // the account (charges_enabled can flip if Stripe restricts an
  // account post-onboarding for a verification reason).
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(200).json({ connected: true, account_id: stripeAccountId, charges_enabled: false, payouts_enabled: false });
  }
  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const acct = await stripe.accounts.retrieve(stripeAccountId);
    return res.status(200).json({
      connected: true,
      charges_enabled: !!acct.charges_enabled,
      payouts_enabled: !!acct.payouts_enabled,
      account_id: acct.id,
    });
  } catch (e) {
    return res.status(200).json({
      connected: true,
      account_id: stripeAccountId,
      charges_enabled: false,
      payouts_enabled: false,
      verify_error: e?.message
    });
  }
}
