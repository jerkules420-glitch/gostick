const cloudinary = require('cloudinary').v2;
const config = require('../config');
const printify = require('./printify');
const mappings = require('./productMappings');

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key: config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
  secure: true,
});

let activeSync = null;

function printableArtworkUrl(product) {
  if (product.format === 'png' || product.format === 'jpg' || product.format === 'jpeg') {
    return product.image;
  }
  return cloudinary.url(product.cloudinaryPublicId, {
    secure: true,
    format: 'png',
    transformation: [{ width: 1800, crop: 'limit', fetch_format: 'png' }],
  });
}

function errorDetails(error) {
  const response = error.response;
  if (!response) return error.message;
  return `${response.status}: ${JSON.stringify(response.data)}`;
}

async function ensureProduct(product) {
  const existing = mappings.get(product.id);
  const requiresReplacement = Boolean(
    existing?.printifyProductId &&
    (existing.blueprintId !== config.printify.blueprintId ||
      existing.providerId !== config.printify.providerId ||
      existing.variantId !== config.printify.variantId)
  );
  if (existing?.printifyProductId && existing?.variantId && !requiresReplacement) {
    if (existing.retailPrice !== config.printify.retailPrice) {
      const current = await printify.getProduct(existing.printifyProductId);
      await printify.updateProduct(existing.printifyProductId, {
        variants: current.variants.map((variant) => ({
          id: variant.id,
          price: variant.id === config.printify.variantId
            ? config.printify.retailPrice
            : variant.price,
          is_enabled: variant.is_enabled,
          is_default: variant.id === config.printify.variantId,
        })),
      });
      const mapping = mappings.set(product.id, {
        retailPrice: config.printify.retailPrice,
        status: 'wired',
        error: null,
      });
      return { status: 'updated', slug: product.id, mapping };
    }
    return { status: 'existing', slug: product.id, mapping: existing };
  }

  let imageId = existing?.printifyImageId;
  try {
    if (!imageId) {
      const uploaded = await printify.uploadImage(
        `${product.id}.png`,
        printableArtworkUrl(product)
      );
      imageId = uploaded.id;
      mappings.set(product.id, {
        printifyImageId: imageId,
        sourceImage: product.image,
        status: 'image-uploaded',
      });
    }

    const created = await printify.createProduct({
      title: product.pname,
      description: product.description,
      blueprint_id: config.printify.blueprintId,
      print_provider_id: config.printify.providerId,
      tags: ['gostick-auto', 'CS2', 'sticker'],
      variants: [{
        id: config.printify.variantId,
        price: config.printify.retailPrice,
        is_enabled: true,
        is_default: true,
      }],
      print_areas: [{
        variant_ids: [config.printify.variantId],
        placeholders: [{
          position: 'front',
          images: [{
            id: imageId,
            x: 0.5,
            y: 0.5,
            scale: config.printify.artworkScale,
            angle: 0,
          }],
        }],
      }],
    });

    await printify.markPublishingSucceeded(created.id, {
      id: product.id,
      handle: `${config.printify.siteUrl}/item.html?id=${encodeURIComponent(product.id)}`,
    });

    const previousProductId = requiresReplacement ? existing.printifyProductId : null;
    const mapping = mappings.set(product.id, {
      printifyImageId: imageId,
      printifyProductId: String(created.id),
      variantId: config.printify.variantId,
      blueprintId: config.printify.blueprintId,
      providerId: config.printify.providerId,
      retailPrice: config.printify.retailPrice,
      status: 'wired',
      error: null,
      replacedProductId: previousProductId,
    });

    if (previousProductId && previousProductId !== String(created.id)) {
      try {
        await printify.deleteProduct(previousProductId);
        mappings.set(product.id, { replacedProductDeleted: true });
      } catch (deleteError) {
        console.warn(
          `[printify-sync] replacement wired but old product ${previousProductId} ` +
          `could not be deleted: ${errorDetails(deleteError)}`
        );
        mappings.set(product.id, { replacementDeleteError: errorDetails(deleteError) });
      }
    }
    return {
      status: requiresReplacement ? 'replaced' : 'created',
      slug: product.id,
      mapping,
    };
  } catch (error) {
    mappings.set(product.id, { status: 'failed', error: errorDetails(error) });
    throw error;
  }
}

async function runSync(products, options = {}) {
  if (activeSync) return activeSync;
  const limit = Number.isFinite(options.limit) ? options.limit : products.length;
  activeSync = (async () => {
    const results = [];
    const candidates = products.filter((product) => {
      const mapping = mappings.get(product.id);
      return !mapping?.printifyProductId ||
        mapping.retailPrice !== config.printify.retailPrice ||
        mapping.blueprintId !== config.printify.blueprintId ||
        mapping.providerId !== config.printify.providerId ||
        mapping.variantId !== config.printify.variantId;
    });
    for (const product of candidates.slice(0, limit)) {
      try {
        const result = await ensureProduct(product);
        results.push(result);
        console.log(`[printify-sync] ${result.status}: ${product.pname}`);
      } catch (error) {
        results.push({ status: 'failed', slug: product.id, error: errorDetails(error) });
        console.error(`[printify-sync] failed: ${product.pname}: ${errorDetails(error)}`);
      }
    }
    return {
      total: products.length,
      attempted: results.length,
      created: results.filter((item) => item.status === 'created').length,
      updated: results.filter((item) => item.status === 'updated').length,
      replaced: results.filter((item) => item.status === 'replaced').length,
      failed: results.filter((item) => item.status === 'failed').length,
      results,
    };
  })();

  try {
    return await activeSync;
  } finally {
    activeSync = null;
  }
}

module.exports = { ensureProduct, runSync, printableArtworkUrl };