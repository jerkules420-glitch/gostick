// src/controllers/admin.js — admin-only operations
const { spawn } = require('child_process');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const printify = require('../services/printify');
const emailSvc = require('../services/email');
const { fetchCatalog, invalidateCatalog } = require('./products');
const printifyCatalog = require('../services/printifyCatalog');
const productMappings = require('../services/productMappings');

const fullSyncProgress = {
  active: false,
  startedAt: null,
  message: 'Idle',
  lastLines: [],
};

function updateFullSyncProgress(message, line) {
  fullSyncProgress.active = true;
  fullSyncProgress.message = message;
  if (line) {
    fullSyncProgress.lastLines = [...fullSyncProgress.lastLines.slice(-9), line];
  }
}

function resetFullSyncProgress(message = 'Idle') {
  fullSyncProgress.active = false;
  fullSyncProgress.startedAt = null;
  fullSyncProgress.message = message;
  fullSyncProgress.lastLines = [];
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (options.onStdout) options.onStdout(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (options.onStderr) options.onStderr(text);
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr, code });
      reject(new Error(stderr.trim() || stdout.trim() || `Command failed with exit code ${code}`));
    });
  });
}

async function canReachCdp(url) {
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(url, { signal: controller.signal, method: 'GET' }).catch(() => null);
    clearTimeout(timeout);
    return Boolean(response && response.ok);
  } catch {
    return false;
  }
}

const prisma = new PrismaClient();

// ─── Dashboard ────────────────────────────────────────────────────────────────

// GET /api/admin/stats
async function getStats(req, res) {
  const [totalUsers, totalOrders, recentOrders, revenue] = await Promise.all([
    prisma.user.count({ where: { role: 'CUSTOMER' } }),
    prisma.order.count(),
    prisma.order.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { items: true },
    }),
    prisma.order.aggregate({
      _sum: { total: true },
      where: { status: { notIn: ['CANCELLED', 'REFUNDED'] } },
    }),
  ]);

  const pendingOrders = await prisma.order.count({ where: { status: 'PENDING' } });

  return res.json({
    totalUsers,
    totalOrders,
    pendingOrders,
    totalRevenue: revenue._sum.total || 0,
    recentOrders,
  });
}

// ─── Users ────────────────────────────────────────────────────────────────────

// GET /api/admin/users
async function listUsers(req, res) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    }),
    prisma.user.count(),
  ]);

  return res.json({ users, total, page, pages: Math.ceil(total / limit) });
}

// PATCH /api/admin/users/:id/role
async function updateUserRole(req, res) {
  const { role } = req.body;
  if (!['CUSTOMER', 'ADMIN'].includes(role)) {
    return res.status(422).json({ error: 'Invalid role.' });
  }
  // Prevent self-demotion
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot change your own role.' });
  }
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: { role },
    select: { id: true, email: true, name: true, role: true },
  });
  return res.json({ user });
}

// DELETE /api/admin/users/:id
async function deleteUser(req, res) {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'User not found.' });
  await prisma.user.delete({ where: { id: req.params.id } });
  return res.json({ message: 'User deleted.' });
}

// ─── Orders ───────────────────────────────────────────────────────────────────

// GET /api/admin/orders
async function listOrders(req, res) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  const skip = (page - 1) * limit;
  const status = req.query.status || undefined;

  const where = status ? { status } : {};

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { items: true, user: { select: { email: true, name: true } } },
    }),
    prisma.order.count({ where }),
  ]);

  return res.json({ orders, total, page, pages: Math.ceil(total / limit) });
}

// GET /api/admin/orders/:id
async function getOrder(req, res) {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { items: true, user: { select: { email: true, name: true } } },
  });
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  return res.json({ order });
}

// PATCH /api/admin/orders/:id/status
async function updateOrderStatus(req, res) {
  const { status, trackingNumber, trackingUrl } = req.body;
  const validStatuses = ['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'];
  if (!validStatuses.includes(status)) {
    return res.status(422).json({ error: 'Invalid status.' });
  }

  const updates = { status };
  if (trackingNumber) updates.trackingNumber = trackingNumber;
  if (trackingUrl) updates.trackingUrl = trackingUrl;

  const order = await prisma.order.update({
    where: { id: req.params.id },
    data: updates,
    include: { items: true },
  });

  // Send shipping email when marked as shipped
  if (status === 'SHIPPED' && order.email) {
    emailSvc.sendShippingUpdate(order.email, order).catch(() => {});
  }

  return res.json({ order });
}

// ─── Products (Printify sync) ─────────────────────────────────────────────────

// GET /api/admin/printify/products
async function listPrintifyProducts(req, res) {
  try {
    const products = [];
    let page = 1;
    let lastPage = 1;
    do {
      const result = await printify.listProducts(page, 50);
      products.push(...result.data);
      lastPage = result.last_page;
      page += 1;
    } while (page <= lastPage);
    return res.json({ data: products, total: products.length, fallback: false });
  } catch (err) {
    console.error('[admin] listPrintifyProducts error', err.message);
    try {
      const catalog = await fetchCatalog();
      const mappings = productMappings.all();
      const products = catalog
        .filter((product) => mappings[product.id]?.printifyProductId)
        .map((product) => {
          const mapping = mappings[product.id];
          return {
            id: mapping.printifyProductId,
            title: product.pname,
            images: [{ src: product.image }],
            variants: [{ id: mapping.variantId, is_enabled: true }],
            visible: true,
          };
        });
      return res.json({ data: products, total: products.length, fallback: true });
    } catch (fallbackError) {
      console.error('[admin] local Printify fallback error', fallbackError.message);
      return res.status(502).json({ error: 'Could not load Printify products.' });
    }
  }
}

// POST /api/admin/printify/orders/:printifyOrderId/send
async function sendPrintifyOrderToProduction(req, res) {
  try {
    const result = await printify.sendOrderToProduction(req.params.printifyOrderId);
    return res.json(result);
  } catch (err) {
    console.error('[admin] sendOrderToProduction error', err.message);
    return res.status(502).json({ error: 'Could not send order to production.' });
  }
}

async function syncPrintifyCatalog(req, res) {
  try {
    const products = await fetchCatalog();
    const limit = Math.min(200, Math.max(1, parseInt(req.body?.limit, 10) || products.length));
    const result = await printifyCatalog.runSync(products, { limit });
    invalidateCatalog();
    return res.json(result);
  } catch (err) {
    console.error('[admin] syncPrintifyCatalog error', err.message);
    return res.status(502).json({ error: 'Could not synchronize Printify products.' });
  }
}

async function runFullStickerSync(req, res) {
  try {
    const repoRoot = path.resolve(__dirname, '../../../..');
    const scriptPath = path.join(repoRoot, 'scrape_stickers.py');
    const pythonCommand = process.env.PYTHON || process.env.PYTHON3 || 'python';
    const limit = Math.min(200, Math.max(1, parseInt(req.body?.limit, 10) || 200));
    const cdpUrl = process.env.CDP_URL || 'http://127.0.0.1:9222';

    if (!process.env.CLOUDINARY_URL) {
      return res.status(400).json({ error: 'CLOUDINARY_URL is required before running the full sticker sync.' });
    }

    fullSyncProgress.active = true;
    fullSyncProgress.startedAt = new Date().toISOString();
    fullSyncProgress.message = 'Checking browser availability…';
    fullSyncProgress.lastLines = [];

    const useCdp = await canReachCdp(cdpUrl);
    const args = [
      scriptPath,
      '--start-page', '1',
      '--end-page', '233',
      '--output', 'output',
      '--requests-per-minute', '6',
      '--request-jitter', '2',
      '--challenge-cooldown', '180',
      '--upload-cloudinary',
      '--cloudinary-folder', 'gostick.gg/stickers',
    ];
    if (useCdp) {
      args.push('--cdp-url', cdpUrl);
      updateFullSyncProgress('Verified Chrome detected at ' + cdpUrl + '. Starting scraper…', 'Verified Chrome detected at ' + cdpUrl + '.');
      console.log(`[admin] starting full sticker sync with verified Chrome at ${cdpUrl}`);
    } else {
      args.push('--headless');
      updateFullSyncProgress('No verified Chrome CDP endpoint was reachable. Falling back to headless mode…', 'No verified Chrome CDP endpoint found; using headless mode.');
      console.log('[admin] starting full sticker sync in headless mode because no verified Chrome CDP endpoint was reachable.');
    }

    const onLine = (text, streamName) => {
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        if (!line) continue;
        const trimmed = line.length > 240 ? line.slice(0, 240) + '…' : line;
        updateFullSyncProgress(trimmed, `${streamName}: ${trimmed}`);
      }
    };

    await runCommand(pythonCommand, args, {
      cwd: repoRoot,
      env: process.env,
      onStdout: (text) => onLine(text, 'stdout'),
      onStderr: (text) => onLine(text, 'stderr'),
    });

    updateFullSyncProgress('Scraper finished. Refreshing storefront catalog…', 'Scraper finished. Refreshing storefront catalog.');
    const products = await fetchCatalog();
    invalidateCatalog();

    updateFullSyncProgress('Syncing Printify catalog…', 'Syncing Printify catalog.');
    const result = await printifyCatalog.runSync(products, { limit });

    updateFullSyncProgress('Full sticker sync complete.', 'Full sticker sync complete.');

    return res.json({
      ok: true,
      catalogCount: products.length,
      printify: result,
      message: 'Scrape, Cloudinary upload, storefront catalog refresh, and Printify sync completed.',
    });
  } catch (err) {
    const message = err && err.message ? err.message : 'Unknown full sticker sync error.';
    updateFullSyncProgress('Full sticker sync failed: ' + message, 'Full sticker sync failed: ' + message);
    console.error('[admin] fullStickerSync error', message);
    return res.status(502).json({
      error: message,
      details: message,
    });
  }
}

function getFullSyncStatus(_req, res) {
  return res.json({
    active: fullSyncProgress.active,
    startedAt: fullSyncProgress.startedAt,
    message: fullSyncProgress.message,
    lastLines: fullSyncProgress.lastLines,
  });
}

function getPrintifySyncStatus(_req, res) {
  const mappings = productMappings.all();
  const values = Object.values(mappings);
  return res.json({
    total: values.length,
    ready: values.filter((item) => item.printifyProductId && item.variantId).length,
    failed: values.filter((item) => item.status === 'failed').length,
    products: mappings,
  });
}

module.exports = {
  getStats,
  listUsers,
  updateUserRole,
  deleteUser,
  listOrders,
  getOrder,
  updateOrderStatus,
  listPrintifyProducts,
  sendPrintifyOrderToProduction,
  syncPrintifyCatalog,
  runFullStickerSync,
  getFullSyncStatus,
  getPrintifySyncStatus,
};
