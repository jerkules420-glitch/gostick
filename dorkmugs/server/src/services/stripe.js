// src/services/stripe.js — Stripe Checkout Session creation + webhook verification
const Stripe = require('stripe');
const config = require('../config');

const stripe = Stripe(config.stripe.secretKey);

/**
 * Create a Stripe Checkout Session.
 *
 * @param {Array<{name:string, price:number, qty:number, image?:string}>} items
 *   price is in cents (integer).
 * @param {Object} metadata  Stored on the session; use for Printify order data.
 * @param {string} successUrl
 * @param {string} cancelUrl
 * @param {string} [customerEmail]
 * @returns {Promise<{id:string, url:string}>}
 */
function buildCheckoutSessionParams(
  items,
  metadata,
  successUrl,
  cancelUrl,
  customerEmail,
  shippingZone,
  shippingAmount
) {
  const lineItems = items.map((item) => ({
    price_data: {
      currency: 'usd',
      product_data: {
        name: item.name,
        ...(item.image ? { images: [item.image] } : {}),
      },
      unit_amount: Math.round(item.price), // already in cents
    },
    quantity: item.qty,
  }));

  const sessionParams = {
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: lineItems,
    shipping_address_collection: {
      allowed_countries: shippingZone.countries,
    },
    shipping_options: [{
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: shippingAmount, currency: 'usd' },
        display_name: shippingAmount === 0
          ? `Free shipping — ${shippingZone.label}`
          : `Standard shipping — ${shippingZone.label}`,
      },
    }],
    metadata,
    success_url: successUrl,
    cancel_url: cancelUrl,
  };

  if (customerEmail) sessionParams.customer_email = customerEmail;

  return sessionParams;
}

async function createCheckoutSession(
  items,
  metadata,
  successUrl,
  cancelUrl,
  customerEmail,
  shippingZone,
  shippingAmount
) {
  const sessionParams = buildCheckoutSessionParams(
    items,
    metadata,
    successUrl,
    cancelUrl,
    customerEmail,
    shippingZone,
    shippingAmount
  );

  const session = await stripe.checkout.sessions.create(sessionParams);
  return { id: session.id, url: session.url };
}

/**
 * Retrieve a completed session (with line_items expanded) — used in webhook.
 */
async function retrieveSession(sessionId) {
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['line_items'],
  });
}

/**
 * Verify Stripe webhook signature.
 * @param {Buffer} rawBody
 * @param {string} sig  Stripe-Signature header value
 * @returns {Object} Stripe event
 * @throws if signature invalid
 */
function constructEvent(rawBody, sig) {
  return stripe.webhooks.constructEvent(rawBody, sig, config.stripe.webhookSecret);
}

module.exports = {
  buildCheckoutSessionParams,
  createCheckoutSession,
  retrieveSession,
  constructEvent,
};
