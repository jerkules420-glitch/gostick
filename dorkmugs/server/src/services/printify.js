// src/services/printify.js — Printify REST API client
const axios = require('axios');
const config = require('../config');

const client = axios.create({
  baseURL: config.printify.baseUrl,
  headers: {
    Authorization: `Bearer ${config.printify.apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'GoStick-Store/1.0',
  },
  timeout: 15000,
});

const SHOP_ID = config.printify.shopId;

// ─── Products ────────────────────────────────────────────────────────────────

/** List all published products in the Printify shop */
async function listProducts(page = 1, limit = 50) {
  const { data } = await client.get(`/shops/${SHOP_ID}/products.json`, {
    params: { page, limit },
  });
  return data; // { data: [...], last_page, current_page, total }
}

/** Get a single product by Printify product ID */
async function getProduct(productId) {
  const { data } = await client.get(`/shops/${SHOP_ID}/products/${productId}.json`);
  return data;
}

async function uploadImage(fileName, url) {
  const { data } = await client.post('/uploads/images.json', {
    file_name: fileName,
    url,
  });
  return data;
}

async function createProduct(payload) {
  const { data } = await client.post(`/shops/${SHOP_ID}/products.json`, payload);
  return data;
}

async function updateProduct(productId, payload) {
  const { data } = await client.put(`/shops/${SHOP_ID}/products/${productId}.json`, payload);
  return data;
}

async function deleteProduct(productId) {
  const { data } = await client.delete(`/shops/${SHOP_ID}/products/${productId}.json`);
  return data;
}

async function markPublishingSucceeded(productId, external) {
  const { data } = await client.post(
    `/shops/${SHOP_ID}/products/${productId}/publishing_succeeded.json`,
    { external }
  );
  return data;
}

// ─── Orders ──────────────────────────────────────────────────────────────────

/**
 * Create a Printify order.
 * @param {object} orderPayload — see https://developers.printify.com/#orders
 * Example line_items entry:
 *   { print_provider_id, blueprint_id, variant_id, print_areas: { front: url }, quantity }
 */
async function createOrder(orderPayload) {
  const { data } = await client.post(`/shops/${SHOP_ID}/orders.json`, orderPayload);
  return data;
}

/** Retrieve a Printify order */
async function getOrder(printifyOrderId) {
  const { data } = await client.get(`/shops/${SHOP_ID}/orders/${printifyOrderId}.json`);
  return data;
}

/** Send a Printify order to production (submit for printing) */
async function sendOrderToProduction(printifyOrderId) {
  const { data } = await client.post(
    `/shops/${SHOP_ID}/orders/${printifyOrderId}/send_to_production.json`
  );
  return data;
}

/** Cancel a Printify order (only if not yet in production) */
async function cancelOrder(printifyOrderId) {
  const { data } = await client.post(
    `/shops/${SHOP_ID}/orders/${printifyOrderId}/cancel.json`
  );
  return data;
}

// ─── Shipping ────────────────────────────────────────────────────────────────

/** Calculate shipping cost for a set of line items */
async function calculateShipping(addressTo, lineItems) {
  const { data } = await client.post(`/shops/${SHOP_ID}/orders/shipping.json`, {
    address_to: addressTo,
    line_items: lineItems,
  });
  return data;
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/** Register a Printify webhook for a given topic */
async function registerWebhook(topic, url) {
  const { data } = await client.post(`/shops/${SHOP_ID}/webhooks.json`, { topic, url });
  return data;
}

/** List registered webhooks */
async function listWebhooks() {
  const { data } = await client.get(`/shops/${SHOP_ID}/webhooks.json`);
  return data;
}

module.exports = {
  listProducts,
  getProduct,
  uploadImage,
  createProduct,
  updateProduct,
  deleteProduct,
  markPublishingSucceeded,
  createOrder,
  getOrder,
  sendOrderToProduction,
  cancelOrder,
  calculateShipping,
  registerWebhook,
  listWebhooks,
};
