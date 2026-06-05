// Single source of truth for fee logic, platform constants, and the
// product catalog used by /api/payments and any future payment surface
// on theflexfacility.com. NEVER hardcode fee values anywhere else —
// import them from here.
//
// CommonJS to match the rest of this repo (api/verify-session.js,
// api/trainer-apply.js). flex-facility-portal mirrors this file in ESM.

const PLATFORM_FEE_PCT = 0.07;
const GO_ELEV8_STRIPE_ACCOUNT_ID = process.env.GO_ELEV8_STRIPE_ACCOUNT_ID;

// Flat per-order processing fee that goes to GoElev8 alongside the
// percent-based platform fee. Covers card-network overhead on small
// carts where 7% alone wouldn't pay for a transaction. Default $3.
const PROCESSING_FEE_CENTS = parseInt(process.env.PROCESSING_FEE_CENTS || '300', 10);

// Covers Stripe's 2.9% + $0.30 processing fee. Charged to the customer
// as a separate line item on top of the list price (NOT absorbed by
// the merchant).
function calcTransactionFee(listPriceCents) {
  return Math.round(listPriceCents * 0.029) + 30;
}

// 7% of the list price (not the grossed-up total). Passed to Stripe
// as part of application_fee_amount on the payment intent, deducted
// from the merchant's payout via Stripe Connect.
function calcPlatformFee(listPriceCents) {
  return Math.round(listPriceCents * PLATFORM_FEE_PCT);
}

// GoElev8's flat per-order processing fee. Always added to the customer
// total and routed to the platform via application_fee_amount.
function calcProcessingFee(_listPriceCents) {
  return PROCESSING_FEE_CENTS;
}

function calcCustomerTotal(listPriceCents) {
  return listPriceCents + calcTransactionFee(listPriceCents) + calcProcessingFee(listPriceCents);
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
  PROCESSING_FEE_CENTS,
  GO_ELEV8_STRIPE_ACCOUNT_ID,
  calcTransactionFee,
  calcPlatformFee,
  calcProcessingFee,
  calcCustomerTotal,
  PRODUCTS,
};
