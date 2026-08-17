// src/config/index.js — central config loaded from environment
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: true });

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

function cloudinaryCredentials() {
  const value = process.env.CLOUDINARY_URL || '';
  const match = value.match(/^cloudinary:\/\/<?([^:>]+)>?:<?([^@>]+)>?@(.+)$/);
  return match
    ? { apiKey: match[1], apiSecret: match[2], cloudName: match[3].replace(/[<>]/g, '') }
    : { apiKey: '', apiSecret: '', cloudName: '' };
}

const cloudinaryAuth = cloudinaryCredentials();

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 5000,

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
  },

  printify: {
    apiKey: process.env.PRINTIFY_API_KEY || '',
    shopId: process.env.PRINTIFY_SHOP_ID || '',
    baseUrl: process.env.PRINTIFY_BASE_URL || 'https://api.printify.com/v1',
    autoSync: process.env.PRINTIFY_AUTO_SYNC !== 'false',
    syncIntervalMs: parseInt(process.env.PRINTIFY_SYNC_INTERVAL_MS, 10) || 60_000,
    syncBatchSize: parseInt(process.env.PRINTIFY_SYNC_BATCH_SIZE, 10) || 50,
    blueprintId: parseInt(process.env.PRINTIFY_STICKER_BLUEPRINT_ID, 10) || 803,
    providerId: parseInt(process.env.PRINTIFY_STICKER_PROVIDER_ID, 10) || 73,
    variantId: parseInt(process.env.PRINTIFY_STICKER_VARIANT_ID, 10) || 75060,
    retailPrice: parseInt(process.env.PRINTIFY_STICKER_PRICE_CENTS, 10) || 899,
    artworkScale: parseFloat(process.env.PRINTIFY_ARTWORK_SCALE) || 0.9,
    siteUrl: (process.env.PUBLIC_STORE_URL || 'http://localhost:5000').replace(/\/$/, ''),
  },

  cloudinary: {
    ...cloudinaryAuth,
    folder: process.env.CLOUDINARY_STICKER_FOLDER || 'gostick.gg/stickers',
    productPrice: parseFloat(process.env.STICKER_PRICE) || 8.99,
    cacheMs: parseInt(process.env.CLOUDINARY_CATALOG_CACHE_MS, 10) || 60_000,
  },

  commerce: {
    discounts: [
      { minimumQuantity: 5, rate: 0.15 },
      { minimumQuantity: 3, rate: 0.10 },
    ],
    shippingZones: {
      US: { label: 'United States', countries: ['US'], amount: 599, freeThreshold: 4000 },
      CA: { label: 'Canada', countries: ['CA'], amount: 1099, freeThreshold: 7000 },
      INTL: { label: 'UK / Australia', countries: ['GB', 'AU'], amount: 1299, freeThreshold: 8000 },
    },
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    successUrl: process.env.STRIPE_SUCCESS_URL || 'http://localhost:3000/order-success.html',
    cancelUrl: process.env.STRIPE_CANCEL_URL || 'http://localhost:3000/index.html',
  },

  email: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'GoStick <noreply@gostick.gg>',
  },

  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
};
