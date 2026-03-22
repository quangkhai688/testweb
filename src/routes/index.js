'use strict';

const { Router } = require('express');
const rateLimit  = require('express-rate-limit');

const { authenticate, isAdmin, isSubAdmin } = require('../middleware/auth');
const { validate, rules }                   = require('../middleware/validate');

const authCtrl    = require('../controllers/auth.controller');
const userCtrl    = require('../controllers/user.controller');
const orderCtrl   = require('../controllers/order.controller');
const keyCtrl     = require('../controllers/key.controller');
const walletCtrl  = require('../controllers/wallet.controller');
const affCtrl     = require('../controllers/affiliate.controller');
const adminCtrl   = require('../controllers/admin.controller');

const router = Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { ok: false, message: 'Quá nhiều lần thử. Vui lòng đợi 15 phút.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const buyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { ok: false, message: 'Quá nhiều yêu cầu mua. Chờ 1 phút.' },
  keyGenerator: (req) => `buy_${req.user?.id || req.ip}`,
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
router.post('/auth/register', authLimiter, rules.register, validate, authCtrl.register);
router.post('/auth/login',    authLimiter, rules.login,    validate, authCtrl.login);

// ─────────────────────────────────────────────────────────────────────────────
// USER
// ─────────────────────────────────────────────────────────────────────────────
router.get('/user/profile',      authenticate, userCtrl.getProfile);
router.get('/user/transactions', authenticate, rules.pagination, validate, userCtrl.getTransactions);
router.get('/user/keys',         authenticate, userCtrl.getMyKeys);

// ─────────────────────────────────────────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────────────────────────────────────────
router.post('/orders/buy',            authenticate, buyLimiter, rules.buyKey, validate, orderCtrl.buyKey);
router.get ('/orders/my',             authenticate, rules.pagination, validate, orderCtrl.myOrders);
router.post('/orders/:id/activate',   authenticate, rules.idParam, validate, orderCtrl.activateKey);
router.post('/orders/:id/refund',     authenticate, isAdmin, rules.idParam, validate, orderCtrl.refundOrder);

// ─────────────────────────────────────────────────────────────────────────────
// WALLET / DEPOSITS
// ─────────────────────────────────────────────────────────────────────────────
router.post('/wallet/deposit',          authenticate, rules.deposit,  validate, walletCtrl.createDeposit);
router.get ('/wallet/deposits',         authenticate, walletCtrl.myDeposits);

// ─────────────────────────────────────────────────────────────────────────────
// AFFILIATE (user)
// ─────────────────────────────────────────────────────────────────────────────
router.get ('/affiliate/dashboard',    authenticate, affCtrl.dashboard);
router.get ('/affiliate/commissions',  authenticate, affCtrl.myCommissions);
router.post('/affiliate/withdraw',     authenticate, rules.withdrawal, validate, affCtrl.requestWithdrawal);
router.get ('/affiliate/withdrawals',  authenticate, affCtrl.myWithdrawals);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — Keys
// ─────────────────────────────────────────────────────────────────────────────
router.post  ('/admin/keys',          authenticate, isSubAdmin, rules.addKey,     validate, keyCtrl.addKey);
router.post  ('/admin/keys/bulk',     authenticate, isAdmin,    rules.addKeyBulk, validate, keyCtrl.addKeyBulk);
router.get   ('/admin/keys',          authenticate, isSubAdmin, keyCtrl.listKeys);
router.get   ('/admin/keys/stock',    authenticate, isSubAdmin, keyCtrl.stockSummary);
router.delete('/admin/keys/:id',      authenticate, isAdmin, rules.idParam, validate, keyCtrl.deleteKey);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — Orders
// ─────────────────────────────────────────────────────────────────────────────
router.get('/admin/orders',  authenticate, isSubAdmin, rules.pagination, validate, orderCtrl.myOrders);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — Deposits
// ─────────────────────────────────────────────────────────────────────────────
router.get ('/admin/deposits',           authenticate, isSubAdmin, walletCtrl.adminListDeposits);
router.post('/admin/deposits/:id/approve', authenticate, isSubAdmin, rules.idParam, validate, walletCtrl.approveDeposit);
router.post('/admin/deposits/:id/reject',  authenticate, isSubAdmin, rules.idParam, validate, walletCtrl.rejectDeposit);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — Affiliate management
// ─────────────────────────────────────────────────────────────────────────────
router.get ('/admin/affiliate/list',                       authenticate, isSubAdmin, affCtrl.adminList);
router.get ('/admin/affiliate/commissions',                authenticate, isSubAdmin, affCtrl.adminCommissions);
router.post('/admin/affiliate/commissions/:id/approve',    authenticate, isSubAdmin, rules.idParam, validate, affCtrl.adminApproveComm);
router.post('/admin/affiliate/commissions/:id/reject',     authenticate, isSubAdmin, rules.idParam, validate, affCtrl.adminRejectComm);
router.get ('/admin/affiliate/withdrawals',                authenticate, isSubAdmin, affCtrl.adminWithdrawals);
router.post('/admin/affiliate/withdrawals/:id/approve',    authenticate, isSubAdmin, rules.idParam, validate, affCtrl.adminApproveWithdrawal);
router.post('/admin/affiliate/withdrawals/:id/reject',     authenticate, isSubAdmin, rules.idParam, validate, affCtrl.adminRejectWithdrawal);

// Fraud management
router.get ('/admin/affiliate/fraud',          authenticate, isSubAdmin, affCtrl.adminFraudList);
router.post('/admin/affiliate/fraud/scan',     authenticate, isAdmin, affCtrl.adminRunFraudScan);
router.post('/admin/affiliate/:id/blacklist',  authenticate, isAdmin, affCtrl.adminBlacklist);
router.post('/admin/affiliate/:id/unblacklist',authenticate, isAdmin, affCtrl.adminUnblacklist);
router.post('/admin/affiliate/:id/clear-flag', authenticate, isAdmin, affCtrl.adminClearFraudFlag);

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — Dashboard, Users, Settings
// ─────────────────────────────────────────────────────────────────────────────
router.get  ('/admin/dashboard',       authenticate, isSubAdmin, adminCtrl.dashboard);
router.get  ('/admin/users',           authenticate, isSubAdmin, adminCtrl.listUsers);
router.patch('/admin/users/:id',       authenticate, isAdmin, rules.idParam, validate, adminCtrl.updateUser);
router.get  ('/admin/settings',        authenticate, isSubAdmin, adminCtrl.getSettings);
router.post ('/admin/settings',        authenticate, isAdmin, adminCtrl.updateSettings);
router.post ('/admin/report/send-now', authenticate, isAdmin, async (req, res, next) => {
  try {
    await adminCtrl.sendDailyReport();
    return require('../utils/response').ok(res, null, 'Đã gửi báo cáo Telegram.');
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GAMES catalog (public)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/games', async (req, res, next) => {
  try {
    const { query } = require('../config/db');
    const [games] = await query(
      `SELECT g.id, g.name, g.emoji, g.slug, g.apk_url,
              t.id AS tier_id, t.label, t.dur_days, t.price
       FROM games g JOIN game_tiers t ON t.game_id = g.id
       WHERE g.is_active = 1 AND t.is_active = 1
       ORDER BY g.sort_order, t.sort_order`
    );
    // Group tiers under games
    const map = {};
    for (const row of games) {
      if (!map[row.id]) map[row.id] = { id: row.id, name: row.name, emoji: row.emoji, slug: row.slug, apk_url: row.apk_url, tiers: [] };
      map[row.id].tiers.push({ id: row.tier_id, label: row.label, dur_days: row.dur_days, price: row.price });
    }
    return require('../utils/response').ok(res, Object.values(map));
  } catch (e) { next(e); }
});

// Health check
router.get('/health', async (req, res) => {
  try {
    await require('../config/db').ping();
    res.json({ ok: true, service: 'Mod Zone API', ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, message: 'Database unavailable' });
  }
});

module.exports = router;
