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
};
