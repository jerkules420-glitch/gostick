// src/server.js — GoStick HTTP server entry point
require('dotenv').config();
const app = require('./app');
const config = require('./config');
const { fetchCatalog, invalidateCatalog } = require('./controllers/products');
const printifyCatalog = require('./services/printifyCatalog');

const PORT = config.port;

async function synchronizePrintify() {
  if (!config.printify.autoSync || !config.printify.apiKey || !config.printify.shopId) return;
  try {
    const products = await fetchCatalog();
    const result = await printifyCatalog.runSync(products, { limit: config.printify.syncBatchSize });
    if (result.created || result.updated) invalidateCatalog();
    console.log(
      `[printify-sync] complete: ${result.created} created, ${result.updated || 0} updated, ` +
      `${result.failed} failed, ` +
      `${result.total} catalog products`
    );
  } catch (error) {
    console.error('[printify-sync] scheduler error:', error.message);
  }
}

app.listen(PORT, () => {
  console.log(`[server] GoStick store running on http://localhost:${PORT}`);
  console.log(`[server] Environment: ${config.env}`);
  synchronizePrintify();
  const timer = setInterval(synchronizePrintify, config.printify.syncIntervalMs);
  timer.unref();
});
