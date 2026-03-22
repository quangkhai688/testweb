'use strict';

require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const compression  = require('compression');
const morgan       = require('morgan');

const logger       = require('./utils/logger');
const { ping }     = require('./config/db');
const routes       = require('./routes/index');
const errorHandler = require('./middleware/errorHandler');
const { registerCronJobs } = require('./services/cron.service');

// ─────────────────────────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());
app.set('trust proxy', 1);   // Required for rate-limiter behind nginx/reverse proxy

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(compression());

// ── HTTP request logging ──────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.http(msg.trim()) },
  skip: (req) => req.url === '/health',
}));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1', routes);

// 404 for unmatched routes
app.use((_req, res) => {
  res.status(404).json({ ok: false, message: 'Route không tồn tại.', code: 'NOT_FOUND' });
});

// ── Global error handler (must be last) ──────────────────────────────────────
app.use(errorHandler);

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    // Verify DB connection before accepting traffic
    await ping();
    logger.info('Database connection: OK');

    app.listen(PORT, () => {
      logger.info('Mod Zone API listening on port %d  [%s]', PORT, process.env.NODE_ENV || 'development');
    });

    // Start background jobs
    registerCronJobs();

  } catch (err) {
    logger.error('Boot failed: %s', err.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => { logger.info('SIGTERM received — shutting down'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT received  — shutting down'); process.exit(0); });

// Unhandled promise rejections / exceptions → log + exit
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection: %s', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception: %s\n%s', err.message, err.stack);
  process.exit(1);
});

boot();

module.exports = app; // for testing
