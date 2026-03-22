'use strict';

const { query, withTransaction } = require('../config/db');
const { AppError, ok, created, genRef } = require('../utils/response');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// POST /wallet/deposit  — admin approves a manual deposit
// ---------------------------------------------------------------------------
async function createDeposit(req, res, next) {
  try {
    const { amount, method, note } = req.body;
    const userId = req.user.id;

    const depositRef = genRef('DEP', 10);

    await query(
      `INSERT INTO deposits (deposit_ref, user_id, amount, method, note, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [depositRef, userId, amount, method, note || null]
    );

    logger.info('Deposit created: %s user=%d amount=%d', depositRef, userId, amount);
    return created(res, { deposit_ref: depositRef, status: 'pending' },
      'Yêu cầu nạp tiền đã ghi nhận, chờ admin duyệt.');
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /admin/deposits/:id/approve  — admin approves deposit
// ---------------------------------------------------------------------------
async function approveDeposit(req, res, next) {
  try {
    const depId   = parseInt(req.params.id);
    const adminId = req.user.id;

    await withTransaction(async (conn) => {
      // Lock deposit row
      const [depRows] = await conn.execute(
        "SELECT id, user_id, amount, status FROM deposits WHERE id = ? FOR UPDATE",
        [depId]
      );
      if (!depRows.length) throw AppError.notFound('Giao dịch không tồn tại.');
      const dep = depRows[0];
      if (dep.status !== 'pending') throw AppError.conflict('Giao dịch đã xử lý.');

      // First deposit bonus
      const [userRows] = await conn.execute(
        'SELECT balance, first_dep FROM users WHERE id = ? FOR UPDATE',
        [dep.user_id]
      );
      const user = userRows[0];
      const [[settingRow]] = await conn.execute(
        "SELECT `value` FROM settings WHERE `key` = 'first_dep_bonus_pct' LIMIT 1"
      );
      const bonusPct = parseInt(settingRow?.value || '0');
      const bonus    = user.first_dep && bonusPct > 0 ? Math.round(dep.amount * bonusPct / 100) : 0;
      const total    = dep.amount + bonus;
      const balAfter = user.balance + total;

      await conn.execute(
        'UPDATE users SET balance = ?, first_dep = 0, updated_at = NOW() WHERE id = ?',
        [balAfter, dep.user_id]
      );
      await conn.execute(
        `UPDATE deposits SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?`,
        [adminId, depId]
      );
      await conn.execute(
        `INSERT INTO transactions
           (user_id, type, amount, direction, balance_before, balance_after, ref_id, description)
         VALUES (?, 'deposit', ?, 'credit', ?, ?, ?, ?)`,
        [dep.user_id, dep.amount, user.balance, balAfter, dep.deposit_ref || 'DEP-' + depId,
          'Nạp tiền được duyệt' + (bonus > 0 ? ` + Bonus ${bonus}đ` : '')]
      );
    });

    return ok(res, null, 'Đã duyệt nạp tiền.');
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /admin/deposits/:id/reject
// ---------------------------------------------------------------------------
async function rejectDeposit(req, res, next) {
  try {
    const depId   = parseInt(req.params.id);
    const { note } = req.body;

    const [rows] = await query(
      "SELECT id, status FROM deposits WHERE id = ? LIMIT 1", [depId]
    );
    if (!rows.length) throw AppError.notFound();
    if (rows[0].status !== 'pending') throw AppError.conflict('Đã xử lý.');

    await query(
      "UPDATE deposits SET status = 'rejected', note = ?, approved_at = NOW() WHERE id = ?",
      [note || null, depId]
    );
    return ok(res, null, 'Đã từ chối giao dịch.');
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /wallet/deposits  — user's deposit history
// ---------------------------------------------------------------------------
async function myDeposits(req, res, next) {
  try {
    const page   = Math.max(1, parseInt(req.query.page  || '1'));
    const limit  = Math.min(50, parseInt(req.query.limit || '20'));
    const offset = (page - 1) * limit;

    const [rows] = await query(
      `SELECT id, deposit_ref, amount, method, status, note, created_at
       FROM deposits WHERE user_id = ?
       ORDER BY id DESC LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );
    return ok(res, rows);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /admin/deposits  — all deposits
// ---------------------------------------------------------------------------
async function adminListDeposits(req, res, next) {
  try {
    const { status } = req.query;
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(100, parseInt(req.query.limit || '30'));
    const offset = (page - 1) * limit;

    let where = '1=1'; const params = [];
    if (status) { where += ' AND d.status = ?'; params.push(status); }

    const [rows] = await query(
      `SELECT d.id, d.deposit_ref, d.user_id, u.username, d.amount,
              d.method, d.status, d.note, d.created_at
       FROM deposits d JOIN users u ON u.id = d.user_id
       WHERE ${where}
       ORDER BY d.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return ok(res, rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { createDeposit, approveDeposit, rejectDeposit, myDeposits, adminListDeposits };
