// src/app.js — Express application factory
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { apiLimiter } = require('./middleware/rateLimiter');

const app = express();
const localStorefrontOrigins = new Set([
  `http://127.0.0.1:${config.port}`,
  `http://localhost:${config.port}`,
]);

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      "img-src": [
        "'self'",
        'data:',
        'https://res.cloudinary.com',
        'https://images-api.printify.com',
      ],
      "script-src": ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      "style-src": ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      "font-src": ["'self'", 'data:', 'https://cdnjs.cloudflare.com'],
    },
  },
}));

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow no-origin requests (same-origin, Postman in dev)
      if (!origin) return cb(null, true);
      if (localStorefrontOrigins.has(origin)) return cb(null, true);
      if (config.allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Stripe-Signature'],
  })
);

// ─── Raw body for Stripe webhook signature verification ───────────────────────
app.use('/api/webhooks/stripe', (req, _res, next) => {
  let data = [];
  req.on('data', (chunk) => data.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(data);
    // Parse JSON after capturing raw bytes
    try { req.body = JSON.parse(req.rawBody.toString()); } catch { req.body = {}; }
    next();
  });
});

// ─── Body parsing (all other routes) ─────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ─── Cookies ─────────────────────────────────────────────────────────────────
app.use(cookieParser());

// ─── Logging ─────────────────────────────────────────────────────────────────
if (config.env !== 'test') {
  app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
app.use('/api', apiLimiter);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/products',  require('./routes/products'));
app.use('/api/checkout',  require('./routes/checkout'));
app.use('/api/orders',    require('./routes/orders'));
app.use('/api/admin',     require('./routes/admin'));
app.use('/api/webhooks',  require('./routes/webhooks'));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// ─── Storefront ──────────────────────────────────────────────────────────────
const storefrontRoot = path.resolve(__dirname, '../..');
app.use(express.static(storefrontRoot));
app.get('/', (_req, res) => res.sendFile(path.join(storefrontRoot, 'index.html')));

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

// ─── Error handler ────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

module.exports = app;
