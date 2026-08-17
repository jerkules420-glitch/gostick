// src/controllers/checkout.js — creates a Stripe Checkout Session and returns the hosted URL
const { validationResult } = require('express-validator');
const stripeSvc = require('../services/stripe');
const config = require('../config');
const productMappings = require('../services/productMappings');
const { fetchCatalog } = require('./products');
const { priceOrder } = require('../services/pricing');

async function resolveCheckoutItems(items) {
  const catalog = await fetchCatalog();
  const catalogById = new Map(catalog.map((product) => [product.id, product]));

  return items.map((item) => {
    const id = String(item.id || '');
    const mapping = productMappings.get(id);
    const product = catalogById.get(id);
    return {
      id,
      name: product?.pname || '',
      price: product ? Math.round(product.price * 100) : 0,
      qty: Math.max(1, parseInt(item.qty, 10) || 1),
      image: product?.image,
      printifyProductId: mapping?.printifyProductId,
      variantId: mapping?.variantId ? String(mapping.variantId) : undefined,
    };
  });
}

/**
 * POST /api/checkout
 * Body: {
 *   items: [{
 *     name: string,
 *     price: number,   // in cents (e.g. 2499 for $24.99)
 *     qty: number,
 *     image?: string,
 *     printifyProductId?: string,
 *     variantId?: string,
 *   }]
 * }
 * Returns: { url }  — Stripe hosted checkout URL
 */
async function createCheckout(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { items, shippingZone } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(422).json({ error: 'Cart is empty.' });
  }

  // Resolve commercial and fulfillment data from trusted server-side sources.
  const sanitised = await resolveCheckoutItems(items);

  const unavailable = sanitised.filter(
    (item) => !item.name || !item.price || !item.printifyProductId || !item.variantId
  );
  if (unavailable.length) {
    return res.status(409).json({
      error: `Print fulfillment is still being prepared for ${unavailable.length} item(s).`,
    });
  }

  const pricing = priceOrder(sanitised, shippingZone);

  // Metadata stored on session — used by the Stripe webhook to create the Printify order
  const metadata = {
    items: JSON.stringify(
      pricing.items.map((i) => ({
        printifyProductId: i.printifyProductId,
        variantId: i.variantId,
        qty: i.qty,
      }))
    ),
    shippingZone,
    discountRate: String(pricing.discountRate),
    userId: req.user?.id || '',
    userEmail: req.user?.email || '',
  };

  // Append session_id placeholder so success page can display order info
  const successUrl = config.stripe.successUrl + '?session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl = config.stripe.cancelUrl;
  const customerEmail = req.user?.email || undefined;

  try {
    const session = await stripeSvc.createCheckoutSession(
      pricing.items,
      metadata,
      successUrl,
      cancelUrl,
      customerEmail,
      pricing.shippingZone,
      pricing.shipping
    );
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout] createCheckout error', err.message);
    return res.status(502).json({ error: 'Could not create checkout. Please try again.' });
  }
}

module.exports = { createCheckout, resolveCheckoutItems };
