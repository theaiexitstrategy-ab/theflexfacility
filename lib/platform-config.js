// Single source of truth for fee logic, platform constants, and the
// product catalog used by /api/payments and any future payment surface
// on theflexfacility.com. NEVER hardcode fee values anywhere else —
// import them from here.
//
// CommonJS to match the rest of this repo (api/verify-session.js,
// api/trainer-apply.js). flex-facility-portal mirrors this file in ESM.
//
// FEE MODEL — every checkout has exactly two fees beyond the list
// price:
//   1. SERVICE FEE  — flat $3 (SERVICE_FEE_CENTS), shown to the
//      customer at checkout. Covers Stripe's per-transaction processing
//      cost plus a small operational margin. Always stays on the
//      platform side via application_fee_amount.
//   2. PLATFORM FEE — 10% of the list price (PLATFORM_FEE_PCT). Also
//      stays on the platform side via application_fee_amount; this is
//      GoElev8's revenue share.
//
// Customer pays   = list + service fee.
// Kenny nets      = list − platformFee (= 90% of list).
// Platform gross  = service fee + platformFee, minus Stripe's actual
//                   per-transaction cost (deducted from the platform
//                   account by Stripe on destination charges).

const PLATFORM_FEE_PCT = 0.10;
const GO_ELEV8_STRIPE_ACCOUNT_ID = process.env.GO_ELEV8_STRIPE_ACCOUNT_ID;

// Flat per-order fee shown to the customer at checkout. Env var allows
// adjusting without redeploying code; default $3.
const SERVICE_FEE_CENTS = parseInt(process.env.SERVICE_FEE_CENTS || '300', 10);

// Service fee charged to the customer on top of the list price.
// Internal callers still use the calcTransactionFee name for backward
// compatibility with existing code paths; the customer-facing label
// is "Service fee".
function calcTransactionFee(_listPriceCents) {
  return SERVICE_FEE_CENTS;
}

// 10% of the list price (not the grossed-up total). Passed to Stripe
// as part of application_fee_amount on the payment intent, deducted
// from the merchant's payout via Stripe Connect.
function calcPlatformFee(listPriceCents) {
  return Math.round(listPriceCents * PLATFORM_FEE_PCT);
}

function calcCustomerTotal(listPriceCents) {
  return listPriceCents + calcTransactionFee(listPriceCents);
}

// ─── EVENTS (ROQ N FLEX Bootcamp — /bootcamp) ───────────────────────
//
// Events use the SAME two-fee structure as merch, but each fee is
// parameterized separately so the two surfaces can move independently:
//
//   1. PROCESSING FEE — Stripe's standard per-transaction cost
//      (2.9% + $0.30), grossed up so the platform still nets the full
//      platform fee after Stripe takes its cut. Merch charges a flat $3
//      instead; a flat $3 on a $10 ticket would be a 30% surcharge, so
//      events pass through the real processing cost.
//   2. PLATFORM FEE — BOOTCAMP_PLATFORM_FEE_PCT (10%) of the list price.
//      Deliberately its own constant, NOT PLATFORM_FEE_PCT, so changing
//      the merch rate never silently moves the event rate (or vice versa).
//
// On a $10 ticket: customer pays $10.61, Kenny nets $9.00,
// GoElev8 collects $1.61 gross ($1.00 after Stripe's ~$0.61).
const BOOTCAMP_PLATFORM_FEE_PCT = 0.10;
const STRIPE_PCT = 0.029;
const STRIPE_FIXED_CENTS = 30;

// Grossed up rather than a flat 2.9% + $0.30 of the list price: Stripe
// charges its percentage on the FULL amount charged (list + fee), so
// solving for the total is what actually leaves the platform whole.
function calcProcessingFee(listPriceCents) {
  const total = Math.ceil((listPriceCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PCT));
  return total - listPriceCents;
}

function calcEventPlatformFee(listPriceCents) {
  return Math.round(listPriceCents * BOOTCAMP_PLATFORM_FEE_PCT);
}

function calcEventCustomerTotal(listPriceCents) {
  return listPriceCents + calcProcessingFee(listPriceCents);
}

// Single source of truth for the event details rendered on /bootcamp,
// emailed in the confirmation, and texted in the SMS. Update here, not
// in three places.
const BOOTCAMP_EVENT = {
  key: 'roq-n-flex-bootcamp',
  name: 'ROQ N FLEX Bootcamp',
  listPriceCents: 1000,
  dateLabel: 'Saturday, August 15, 2026',
  timeLabel: '10:00 A.M',
  startsAtISO: '2026-08-15T10:00:00-05:00', // Earth City, MO — CDT
  venueLine1: '4132 Shoreline Dr Ste 1',
  venueLine2: 'Earth City, MO 63045',
  doorPriceLabel: '$10 at the door',
};

const PRODUCTS = {
  hoodie: {
    name: 'Flex Training Sleeveless Hoodie',
    listPriceCents: 4500,
    type: 'merch',
  },
  ebook: {
    name: 'Road to the Stage — Full Body Training Program',
    listPriceCents: 6500,
    type: 'ebook',
  },
};

module.exports = {
  PLATFORM_FEE_PCT,
  SERVICE_FEE_CENTS,
  GO_ELEV8_STRIPE_ACCOUNT_ID,
  calcTransactionFee,
  calcPlatformFee,
  calcCustomerTotal,
  PRODUCTS,
  // Events (/bootcamp) — separate fee knobs from merch on purpose.
  BOOTCAMP_PLATFORM_FEE_PCT,
  BOOTCAMP_EVENT,
  calcProcessingFee,
  calcEventPlatformFee,
  calcEventCustomerTotal,
};
