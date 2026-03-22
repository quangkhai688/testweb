'use strict';

const { query, withTransaction } = require('../config/db');
const { AppError, ok, created, genRef } = require('../utils/response');
const { approveCommission, getAffRate } = require('../services/affiliate.service');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// USER: GET /affiliate/dashboard
// ─────────────────────────────────────────────────────────────────────────────
async function dashboard(req, res, next) {
  try {
    const userId   = req.user.id;
    const username = req.user.username;

    const [[user]] = await query(
      'SELECT aff_rev, aff_pending FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    // Referral count
    const [[{ refCount }]] = await query(
      'SELECT COUNT(*) AS refCount FROM users WHERE ref_by = ?',
      [username]
    );

    // How many referrals have deposited at least once
    const [[{ depositorCount }]] = await query(
      `SELECT COUNT(DISTINCT u.id) AS depositorCount
       FROM   users u
       JOIN   deposits d ON d.user_id = u.id AND d.status = 'approved'
       WHERE  u.ref_by = ?`,
      [username]
    );

    // Total orders from referrals
    const [[{ refOrders, refRevenue }]] = await query(
      `SELECT COUNT(*) AS refOrders, IFNULL(SUM(o.price_paid),0) AS refRevenue
       FROM   orders o
       JOIN   users  u ON u.id = o.user_id
       WHERE  u.ref_by = ? AND o.status = 'success'`,
      [username]
    );

    // Click log count
    const [[{ clicks }]] = await query(
      'SELECT COUNT(*) AS clicks FROM aff_clicks WHERE ref_user = ?',
      [username]
    );

    // Commission breakdown
    const [commSummary] = await query(
      `SELECT status, SUM(amount) AS total, COUNT(*) AS cnt
       FROM   aff_commissions
       WHERE  affiliate_user_id = ?
       GROUP  BY status`,
      [userId]
    );

    // Withdrawals
    const [wdSummary] = await query(
      `SELECT status, SUM(amount) AS total, COUNT(*) AS cnt
       FROM   withdrawals WHERE user_id = ? GROUP BY status`,
      [userId]
    );

    const approved = commSummary.find(r => r.status === 'approved')?.total || 0;
    const pending  = commSummary.find(r => r.status === 'pending')?.total  || 0;
    const wdDone   = wdSummary.find(r => r.status === 'approved')?.total   || 0;
    const wdPend   = wdSummary.find(r => r.status === 'pending')?.total    || 0;
    const withdrawable = Math.max(0, approved - wdDone - wdPend);

    return ok(res, {
      rate:          getAffRate(refCount),
      ref_count:     refCount,
      depositors:    depositorCount,
      clicks,
      ref_orders:    refOrders,
      ref_revenue:   refRevenue,
      aff_rev:       user.aff_rev,
      comm_pending:  pending,
      comm_approved: approved,
      withdrawn:     wdDone,
      wd_pending:    wdPend,
      withdrawable,
      ref_link:      `${process.env.FRONTEND_URL || ''}/?ref=${username}`,
    });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// USER: POST /affiliate/withdraw
// ─────────────────────────────────────────────────────────────────────────────
async function requestWithdrawal(req, res, next) {
  try {
    const userId = req.user.id;
    const { amount, method, bank_name, bank_account, bank_owner, phone, note } = req.body;

    // Check withdrawable balance
    const [[u]] = await query(
      'SELECT aff_rev FROM users WHERE id = ? LIMIT 1', [userId]
    );
    const [wdRows] = await query(
      "SELECT SUM(amount) AS total FROM withdrawals WHERE user_id = ? AND status IN ('pending','approved')",
      [userId]
    );
    const alreadyUsed  = wdRows[0].total || 0;
    const withdrawable = Math.max(0, u.aff_rev - alreadyUsed);

    if (amount > withdrawable)
      throw AppError.badRequest(`Số dư khả dụng chỉ còn ${withdrawable}đ.`);
    if (amount < 100000)
      throw AppError.badRequest('Rút tối thiểu 100,000đ.');

    const wdRef = genRef('WD', 10);
    await query(
      `INSERT INTO withdrawals
         (wd_ref, user_id, amount, method, bank_name, bank_account, bank_owner, phone, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [wdRef, userId, amount, method, bank_name || null, bank_account || null,
       bank_owner || null, phone || null, note || null]
    );

    logger.info('Withdrawal requested: %s user=%d amount=%d', wdRef, userId, amount);

    // Telegram notify admin (non-blocking)
    notifyAdminWithdrawal(wdRef, req.user.username, amount, method, bank_account || phone)
      .catch(() => {});

    return created(res, {
      wd_ref:   wdRef,
      amount,
      status:   'pending',
      message:  'Yêu cầu rút tiền đã gửi. Xử lý trong 1–3 ngày làm việc.',
    });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// USER: GET /affiliate/withdrawals
// ─────────────────────────────────────────────────────────────────────────────
async function myWithdrawals(req, res, next) {
  try {
    const [rows] = await query(
      `SELECT wd_ref, amount, method, bank_name, bank_account, bank_owner, phone,
              status, reject_reason, created_at, approved_at
       FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
      [req.user.id]
    );
    return ok(res, rows);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// USER: GET /affiliate/commissions
// ─────────────────────────────────────────────────────────────────────────────
async function myCommissions(req, res, next) {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(50, parseInt(req.query.limit || '20'));
    const [rows] = await query(
      `SELECT c.comm_ref, c.amount, c.rate, c.first_dep_bonus, c.status,
              c.auto_approve_at, c.approved_at, c.note, c.created_at,
              u.username AS buyer
       FROM   aff_commissions c
       JOIN   users u ON u.id = c.buyer_user_id
       WHERE  c.affiliate_user_id = ?
       ORDER  BY c.id DESC LIMIT ? OFFSET ?`,
      [req.user.id, limit, (page - 1) * limit]
    );
    return ok(res, rows);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: GET /admin/affiliate/list
// ─────────────────────────────────────────────────────────────────────────────
async function adminList(req, res, next) {
  try {
    const q            = req.query.q            || '';
    const statusFilter = req.query.status       || '';
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(100, parseInt(req.query.limit || '30'));
    const offset = (page - 1) * limit;

    let where = 'ref_count > 0'; const params = [];
    if (q) { where += ' AND username LIKE ?'; params.push(`%${q}%`); }
    if (statusFilter === 'fraud')     where += ' AND fraud_flag = 1';
    if (statusFilter === 'blacklist') where += ' AND aff_blacklist = 1';
    if (statusFilter === 'ok')        where += ' AND fraud_flag = 0 AND aff_blacklist = 0';

    const [rows] = await query(
      `SELECT
         u.id, u.username, u.email, u.aff_rev, u.aff_pending,
         u.fraud_flag, u.fraud_reasons, u.aff_blacklist,
         u.created_at,
         (SELECT COUNT(*) FROM users r WHERE r.ref_by = u.username) AS ref_count,
         (SELECT COUNT(*) FROM aff_clicks c WHERE c.ref_user = u.username) AS click_count,
         (SELECT COUNT(*) FROM orders o JOIN users b ON b.id = o.user_id
          WHERE b.ref_by = u.username AND o.status = 'success') AS order_count,
         (SELECT IFNULL(SUM(c.amount),0) FROM aff_commissions c
          WHERE c.affiliate_user_id = u.id AND c.status = 'approved') AS comm_approved,
         (SELECT IFNULL(SUM(c.amount),0) FROM aff_commissions c
          WHERE c.affiliate_user_id = u.id AND c.status = 'pending') AS comm_pending
       FROM   users u
       HAVING ${where}
       ORDER  BY comm_approved DESC
       LIMIT  ? OFFSET ?`,
      [...params, limit, offset]
    );

    return ok(res, rows);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: GET /admin/affiliate/commissions
// ─────────────────────────────────────────────────────────────────────────────
async function adminCommissions(req, res, next) {
  try {
    const { status, user } = req.query;
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(100, parseInt(req.query.limit || '30'));
    const offset = (page - 1) * limit;

    let where = '1=1'; const params = [];
    if (status) { where += ' AND c.status = ?'; params.push(status); }
    if (user)   { where += ' AND (aff.username = ? OR buyer.username = ?)'; params.push(user, user); }

    const [rows] = await query(
      `SELECT c.id, c.comm_ref, c.amount, c.rate, c.first_dep_bonus,
              c.status, c.auto_approve_at, c.approved_at, c.note, c.created_at,
              aff.username   AS affiliate,
              buyer.username AS buyer,
              o.order_ref
       FROM   aff_commissions c
       JOIN   users   aff   ON aff.id   = c.affiliate_user_id
       JOIN   users   buyer ON buyer.id = c.buyer_user_id
       JOIN   orders  o     ON o.id     = c.order_id
       WHERE  ${where}
       ORDER  BY c.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await query(
      `SELECT COUNT(*) AS total FROM aff_commissions c
       JOIN users aff   ON aff.id   = c.affiliate_user_id
       JOIN users buyer ON buyer.id = c.buyer_user_id
       WHERE ${where}`,
      params
    );

    return ok(res, { commissions: rows, pagination: { page, limit, total } });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: POST /admin/affiliate/commissions/:id/approve
// ─────────────────────────────────────────────────────────────────────────────
async function adminApproveComm(req, res, next) {
  try {
    const commId = parseInt(req.params.id);
    const amount = await approveCommission(commId, req.user.id);
    if (amount === null) return ok(res, null, 'Đã xử lý hoặc bị hủy do gian lận.');
    return ok(res, { amount }, `Đã duyệt hoa hồng ${amount}đ.`);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: POST /admin/affiliate/commissions/:id/reject
// ─────────────────────────────────────────────────────────────────────────────
async function adminRejectComm(req, res, next) {
  try {
    const commId = parseInt(req.params.id);
    const note   = req.body.note || '';

    await withTransaction(async (conn) => {
      const [[comm]] = await conn.execute(
        'SELECT id, affiliate_user_id, amount, status FROM aff_commissions WHERE id = ? FOR UPDATE',
        [commId]
      );
      if (!comm) throw AppError.notFound('Không tìm thấy commission.');
      if (comm.status !== 'pending') throw AppError.conflict('Đã xử lý rồi.');

      await conn.execute(
        "UPDATE aff_commissions SET status = 'rejected', note = ?, approved_at = NOW(), approved_by = ? WHERE id = ?",
        [note, req.user.id, commId]
      );
      await conn.execute(
        'UPDATE users SET aff_pending = GREATEST(0, aff_pending - ?) WHERE id = ?',
        [comm.amount, comm.affiliate_user_id]
      );
    });
    return ok(res, null, 'Đã từ chối hoa hồng.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: GET /admin/affiliate/withdrawals
// ─────────────────────────────────────────────────────────────────────────────
async function adminWithdrawals(req, res, next) {
  try {
    const { status } = req.query;
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(100, parseInt(req.query.limit || '30'));
    const offset = (page - 1) * limit;

    let where = '1=1'; const params = [];
    if (status) { where += ' AND w.status = ?'; params.push(status); }

    const [rows] = await query(
      `SELECT w.id, w.wd_ref, w.amount, w.method,
              w.bank_name, w.bank_account, w.bank_owner, w.phone,
              w.status, w.note, w.reject_reason, w.created_at,
              u.username, u.email
       FROM   withdrawals w
       JOIN   users u ON u.id = w.user_id
       WHERE  ${where}
       ORDER  BY w.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ pendingCount }]] = await query(
      "SELECT COUNT(*) AS pendingCount FROM withdrawals WHERE status = 'pending'"
    );

    return ok(res, { withdrawals: rows, pending_count: pendingCount });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: POST /admin/affiliate/withdrawals/:id/approve
// ─────────────────────────────────────────────────────────────────────────────
async function adminApproveWithdrawal(req, res, next) {
  try {
    const wdId    = parseInt(req.params.id);
    const adminId = req.user.id;

    await withTransaction(async (conn) => {
      const [[wd]] = await conn.execute(
        'SELECT id, user_id, amount, status FROM withdrawals WHERE id = ? FOR UPDATE',
        [wdId]
      );
      if (!wd) throw AppError.notFound();
      if (wd.status !== 'pending') throw AppError.conflict('Đã xử lý rồi.');

      await conn.execute(
        "UPDATE withdrawals SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?",
        [adminId, wdId]
      );
      // Deduct aff_rev so user can't re-request the same money
      await conn.execute(
        'UPDATE users SET aff_rev = GREATEST(0, aff_rev - ?) WHERE id = ?',
        [wd.amount, wd.user_id]
      );
      await conn.execute(
        `INSERT INTO transactions
           (user_id, type, amount, direction, balance_before, balance_after, ref_id, description)
         SELECT ?, 'withdrawal', ?, 'debit', balance, balance, ?, 'Rút hoa hồng đã duyệt'
         FROM   users WHERE id = ?`,
        [wd.user_id, wd.amount, 'WD-' + wdId, wd.user_id]
      );
    });

    return ok(res, null, 'Đã duyệt rút tiền.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: POST /admin/affiliate/withdrawals/:id/reject
// ─────────────────────────────────────────────────────────────────────────────
async function adminRejectWithdrawal(req, res, next) {
  try {
    const wdId  = parseInt(req.params.id);
    const reason = req.body.reason || '';

    const [[wd]] = await query('SELECT id, status FROM withdrawals WHERE id = ? LIMIT 1', [wdId]);
    if (!wd) throw AppError.notFound();
    if (wd.status !== 'pending') throw AppError.conflict('Đã xử lý rồi.');

    await query(
      "UPDATE withdrawals SET status = 'rejected', reject_reason = ?, rejected_at = NOW() WHERE id = ?",
      [reason, wdId]
    );
    return ok(res, null, 'Đã từ chối yêu cầu rút tiền.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: Fraud management
// ─────────────────────────────────────────────────────────────────────────────
async function adminFraudList(req, res, next) {
  try {
    const [rows] = await query(
      `SELECT u.id, u.username, u.email, u.fraud_flag, u.fraud_reasons,
              u.aff_blacklist, u.fingerprint, u.created_at, u.ref_by,
              (SELECT COUNT(*) FROM aff_clicks c WHERE c.ref_user = u.username) AS clicks,
              (SELECT COUNT(*) FROM users r WHERE r.fingerprint = u.fingerprint AND r.id != u.id) AS fp_dupes
       FROM users u
       WHERE fraud_flag = 1 OR aff_blacklist = 1
       ORDER BY u.created_at DESC`
    );

    // Fingerprint groups with multiple accounts
    const [fpGroups] = await query(
      `SELECT fingerprint, COUNT(*) AS cnt, GROUP_CONCAT(username ORDER BY id SEPARATOR ', ') AS usernames
       FROM users
       WHERE fingerprint IS NOT NULL
       GROUP BY fingerprint
       HAVING cnt > 1`
    );

    return ok(res, { flagged: rows, fingerprint_groups: fpGroups });
  } catch (err) { next(err); }
}

async function adminBlacklist(req, res, next) {
  try {
    const userId = parseInt(req.params.id);
    const { reason } = req.body;

    const [[u]] = await query('SELECT id, username FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!u) throw AppError.notFound();
    if (u.username === 'admin') throw AppError.forbidden('Không thể blacklist tài khoản admin.');

    await withTransaction(async (conn) => {
      await conn.execute(
        'UPDATE users SET aff_blacklist = 1, updated_at = NOW() WHERE id = ?', [userId]
      );
      // Cancel all pending commissions
      await conn.execute(
        "UPDATE aff_commissions SET status = 'cancelled', note = ? WHERE affiliate_user_id = ? AND status = 'pending'",
        ['Admin blacklist: ' + (reason || ''), userId]
      );
    });

    logger.info('User blacklisted from affiliate: id=%d by admin=%d', userId, req.user.id);
    return ok(res, null, `Đã blacklist affiliate: ${u.username}`);
  } catch (err) { next(err); }
}

async function adminUnblacklist(req, res, next) {
  try {
    const userId = parseInt(req.params.id);
    await query('UPDATE users SET aff_blacklist = 0 WHERE id = ?', [userId]);
    return ok(res, null, 'Đã bỏ blacklist.');
  } catch (err) { next(err); }
}

async function adminClearFraudFlag(req, res, next) {
  try {
    const userId = parseInt(req.params.id);
    await query(
      'UPDATE users SET fraud_flag = 0, fraud_reasons = NULL WHERE id = ?',
      [userId]
    );
    return ok(res, null, 'Đã xóa fraud flag.');
  } catch (err) { next(err); }
}

async function adminRunFraudScan(req, res, next) {
  try {
    let flagged = 0;

    // 1. Find fingerprint duplicates
    const [fpGroups] = await query(
      `SELECT fingerprint, GROUP_CONCAT(id ORDER BY id) AS ids
       FROM users WHERE fingerprint IS NOT NULL
       GROUP BY fingerprint HAVING COUNT(*) > 1`
    );

    for (const group of fpGroups) {
      const ids    = group.ids.split(',').map(Number);
      const others = ids.slice(1); // keep first registration clean
      for (const uid of others) {
        const [[u]] = await query(
          'SELECT fraud_flag, fraud_reasons FROM users WHERE id = ? LIMIT 1', [uid]
        );
        const reasons = JSON.parse(u.fraud_reasons || '[]');
        const msg = `Trùng thiết bị với ${ids[0]}`;
        if (!reasons.includes(msg)) reasons.push(msg);
        await query(
          'UPDATE users SET fraud_flag = 1, fraud_reasons = ? WHERE id = ?',
          [JSON.stringify(reasons), uid]
        );
        flagged++;
      }
    }

    // 2. High click / zero order flag
    const [highClickers] = await query(
      `SELECT c.ref_user, COUNT(*) AS clicks
       FROM aff_clicks c
       GROUP BY c.ref_user
       HAVING clicks > 20`
    );
    for (const row of highClickers) {
      const [[{ orders }]] = await query(
        `SELECT COUNT(*) AS orders FROM orders o
         JOIN users u ON u.id = o.user_id
         WHERE u.ref_by = ? AND o.status = 'success'`,
        [row.ref_user]
      );
      if (orders === 0) {
        const [[u]] = await query(
          'SELECT id, fraud_reasons FROM users WHERE username = ? LIMIT 1', [row.ref_user]
        );
        if (u) {
          const reasons = JSON.parse(u.fraud_reasons || '[]');
          const msg = `Click bất thường: ${row.clicks} clicks, 0 đơn hàng`;
          if (!reasons.includes(msg)) {
            reasons.push(msg);
            await query(
              'UPDATE users SET fraud_flag = 1, fraud_reasons = ? WHERE id = ?',
              [JSON.stringify(reasons), u.id]
            );
            flagged++;
          }
        }
      }
    }

    return ok(res, { flagged }, `Đã quét: ${flagged} trường hợp nghi ngờ.`);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: notify admin via Telegram
// ─────────────────────────────────────────────────────────────────────────────
async function notifyAdminWithdrawal(wdRef, username, amount, method, account) {
  const [[tok]]  = await query("SELECT `value` FROM settings WHERE `key` = 'tg_bot_token' LIMIT 1");
  const [[cid]]  = await query("SELECT `value` FROM settings WHERE `key` = 'tg_chat_id'   LIMIT 1");
  if (!tok?.value || !cid?.value) return;

  const fmt = n => Number(n).toLocaleString('vi-VN');
  const text = `💸 YÊU CẦU RÚT TIỀN MỚI\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📋 Mã: ${wdRef}\n` +
    `👤 User: ${username}\n` +
    `💰 Số tiền: ${fmt(amount)}đ\n` +
    `🏦 Phương thức: ${method}\n` +
    `📌 Tài khoản: ${account || '—'}\n` +
    `━━━━━━━━━━━━━━━\n` +
    `Vào Admin → Rút tiền để duyệt.`;

  const https = require('https');
  const body  = JSON.stringify({ chat_id: cid.value, text });
  const opts  = {
    hostname: 'api.telegram.org',
    path:     `/bot${tok.value}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  return new Promise((resolve) => {
    const r = https.request(opts, resolve);
    r.on('error', () => resolve());
    r.write(body); r.end();
  });
}

module.exports = {
  dashboard, requestWithdrawal, myWithdrawals, myCommissions,
  adminList, adminCommissions, adminApproveComm, adminRejectComm,
  adminWithdrawals, adminApproveWithdrawal, adminRejectWithdrawal,
  adminFraudList, adminBlacklist, adminUnblacklist, adminClearFraudFlag, adminRunFraudScan,
};
