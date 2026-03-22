'use strict';

const { query } = require('../config/db');
const { ok } = require('../utils/response');

// ---------------------------------------------------------------------------
// GET /user/profile
// ---------------------------------------------------------------------------
async function getProfile(req, res, next) {
  try {
    const [rows] = await query(
      `SELECT
         u.id, u.username, u.email, u.role,
         u.balance, u.aff_rev, u.aff_pending,
         u.ref_by, u.created_at, u.last_login_at,
         COUNT(DISTINCT o.id)  AS total_orders,
         IFNULL(SUM(o.price_paid), 0) AS total_spent
       FROM   users u
       LEFT   JOIN orders o ON o.user_id = u.id AND o.status = 'success'
       WHERE  u.id = ?
       GROUP  BY u.id`,
      [req.user.id]
    );

    // Count referrals
    const [[{ ref_count }]] = await query(
      "SELECT COUNT(*) AS ref_count FROM users WHERE ref_by = ?",
      [req.user.username]
    );

    return ok(res, { ...rows[0], ref_count });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /user/transactions
// ---------------------------------------------------------------------------
async function getTransactions(req, res, next) {
  try {
    const userId = req.user.id;
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(50,  parseInt(req.query.limit || '20'));
    const offset = (page - 1) * limit;

    const [rows] = await query(
      `SELECT id, type, amount, direction, balance_before, balance_after,
              ref_id, description, status, created_at
       FROM   transactions
       WHERE  user_id = ?
       ORDER  BY id DESC
       LIMIT  ? OFFSET ?`,
      [userId, limit, offset]
    );

    const [[{ total }]] = await query(
      'SELECT COUNT(*) AS total FROM transactions WHERE user_id = ?',
      [userId]
    );

    return ok(res, { transactions: rows, pagination: { page, limit, total } });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /user/keys  — user's purchased keys
// ---------------------------------------------------------------------------
async function getMyKeys(req, res, next) {
  try {
    const userId = req.user.id;
    const [rows] = await query(
      `SELECT
         k.code, k.status, k.activated_at, k.expires_at,
         o.id AS order_id, o.order_ref, o.game_id, o.tier_label,
         o.dur_days, o.price_paid, o.key_status, o.created_at AS purchased_at,
         g.name AS game_name, g.emoji
       FROM   orders o
       JOIN   \`keys\` k ON k.id = o.key_id
       JOIN   games    g ON g.id = o.game_id
       WHERE  o.user_id = ? AND o.status = 'success'
       ORDER  BY o.created_at DESC`,
      [userId]
    );
    return ok(res, rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { getProfile, getTransactions, getMyKeys };
