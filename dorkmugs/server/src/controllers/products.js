// src/controllers/products.js — Cloudinary-backed sticker catalog
const config = require('../config');
const cloudinary = require('cloudinary').v2;
const productMappings = require('../services/productMappings');
const fs = require('fs');
const path = require('path');

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
  secure: true,
});

const snapshotPath = path.resolve(__dirname, '../../data/cloudinary-catalog.json');

function loadSnapshot() {
  try {
    const resources = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    return Array.isArray(resources) ? resources : [];
  } catch {
    return [];
  }
}

function writeSnapshot(resources) {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const temporary = `${snapshotPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(resources, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, snapshotPath);
}

function listCloudinaryResources(options) {
  return new Promise((resolve, reject) => {
    cloudinary.api.resources(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function productsFromResources(resources) {
  return resources
    .map(mapResource)
    .sort((left, right) => left.pname.localeCompare(right.pname));
}

const snapshotResources = loadSnapshot();
let catalogCache = { expiresAt: 0, products: productsFromResources(snapshotResources) };

function titleFromPublicId(publicId) {
  const slug = publicId.split('/').pop().replace(/^sticker-/, '');
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function mapResource(resource) {
  const slug = resource.public_id.split('/').pop();
  const name = resource.display_name && resource.display_name !== slug
    ? resource.display_name
    : titleFromPublicId(resource.public_id);
  const mapping = productMappings.get(slug);
  return {
    id: slug,
    handle: slug,
    pname: name,
    price: config.cloudinary.productPrice,
    image: resource.secure_url,
    rating: 5,
    collection: 'stickers',
    description: `${name} printed as a premium transparent outdoor die-cut vinyl sticker. Clear areas reveal the surface; lighter colors may appear muted on dark backgrounds.`,
    width: resource.width,
    height: resource.height,
    format: resource.format,
    bytes: resource.bytes,
    cloudinaryPublicId: resource.public_id,
    printifyProductId: mapping?.printifyProductId || '',
    variantId: mapping?.variantId ? String(mapping.variantId) : '',
    printifyReady: Boolean(mapping?.printifyProductId && mapping?.variantId),
  };
}

async function fetchCatalog() {
  if (catalogCache.expiresAt > Date.now()) return catalogCache.products;

  try {
    const resources = [];
    let nextCursor;
    do {
      const result = await listCloudinaryResources({
        type: 'upload',
        resource_type: 'image',
        prefix: `${config.cloudinary.folder.replace(/\/$/, '')}/`,
        max_results: 500,
        next_cursor: nextCursor,
      });
      resources.push(...result.resources);
      nextCursor = result.next_cursor;
    } while (nextCursor);

    const products = productsFromResources(resources);
    writeSnapshot(resources);
    catalogCache = { expiresAt: Date.now() + config.cloudinary.cacheMs, products };
    return products;
  } catch (error) {
    if (!catalogCache.products.length) throw error;
    catalogCache.expiresAt = Date.now() + Math.min(config.cloudinary.cacheMs, 30_000);
    console.warn(
      `[products] Cloudinary unavailable; serving ${catalogCache.products.length} cached products: ` +
      error.message
    );
    return catalogCache.products;
  }
}

function invalidateCatalog() {
  catalogCache.expiresAt = 0;
}

// GET /api/products
async function listProducts(req, res) {
  try {
    const products = await fetchCatalog();
    return res.json({ products, count: products.length });
  } catch (err) {
    console.error('[products] listProducts error', err.message);
    return res.status(502).json({ error: 'Could not load the sticker catalog.' });
  }
}

// GET /api/products/:id
async function getProduct(req, res) {
  try {
    const products = await fetchCatalog();
    const product = products.find((item) => item.handle === req.params.handle);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    return res.json({ product });
  } catch (err) {
    console.error('[products] getProduct error', err.message);
    return res.status(502).json({ error: 'Could not load the sticker.' });
  }
}

module.exports = {
  listProducts,
  getProduct,
  fetchCatalog,
  invalidateCatalog,
  listCloudinaryResources,
  productsFromResources,
  snapshotPath,
};
