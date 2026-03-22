'use strict';

const { query } = require('../config/db');
const { ok } = require('../utils/response');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/dashboard
// ─────────────────────────────────────────────────────────────────────────────
async function dashboard(req, res, next) {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const ts = todayStart.toISOString().slice(0, 19).replace('T', ' ');

    const [[todayStats]] = await query(
      `SELECT
         IFNULL(SUM(price_paid),0) AS revenue,
         COUNT(*) AS orders
       FROM orders WHERE status = 'success' AND created_at >= ?`,
      [ts]
    );
    const [[depositStats]] = await query(
      `SELECT IFNULL(SUM(amount),0) AS total, COUNT(*) AS cnt
       FROM deposits WHERE status = 'approved' AND created_at >= ?`,
      [ts]
    );
    const [[totalStats]] = await query(
      `SELECT IFNULL(SUM(price_paid),0) AS revenue, COUNT(*) AS orders
       FROM orders WHERE status = 'success'`
    );
    const [[userStats]] = await query('SELECT COUNT(*) AS total FROM users');
    const [[newUsers]] = await query(
      'SELECT COUNT(*) AS cnt FROM users WHERE created_at >= ?', [ts]
    );
    const [[commPending]] = await query(
      "SELECT COUNT(*) AS cnt, IFNULL(SUM(amount),0) AS total FROM aff_commissions WHERE status = 'pending'"
    );
    const [[wdPending]] = await query(
      "SELECT COUNT(*) AS cnt, IFNULL(SUM(amount),0) AS total FROM withdrawals WHERE status = 'pending'"
    );

    // 7-day revenue chart
    const [chart] = await query(
      `SELECT DATE(created_at) AS day, IFNULL(SUM(price_paid),0) AS rev
       FROM orders WHERE status = 'success' AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at) ORDER BY day ASC`
    );

    return ok(res, {
      today: {
        revenue:  todayStats.revenue,
        orders:   todayStats.orders,
        deposits: depositStats.total,
        new_users: newUsers.cnt,
      },
      total: {
        revenue: totalStats.revenue,
        orders:  totalStats.orders,
        users:   userStats.total,
      },
      pending: {
        commissions: { count: commPending.cnt, amount: commPending.total },
        withdrawals:  { count: wdPending.cnt,  amount: wdPending.total  },
      },
      chart,
    });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/users
// ─────────────────────────────────────────────────────────────────────────────
async function listUsers(req, res, next) {
  try {
    const q     = req.query.q    || '';
    const role  = req.query.role || '';
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(100, parseInt(req.query.limit || '30'));
    const offset = (page - 1) * limit;

    let where = '1=1'; const params = [];
    if (q)    { where += ' AND (u.username LIKE ? OR u.email LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
    if (role) { where += ' AND u.role = ?'; params.push(role); }

    const [rows] = await query(
      `SELECT u.id, u.username, u.email, u.role, u.balance, u.aff_rev,
              u.fraud_flag, u.aff_blacklist, u.locked, u.created_at, u.last_login_at,
              COUNT(DISTINCT o.id) AS orders
       FROM   users u
       LEFT   JOIN orders o ON o.user_id = u.id
       WHERE  ${where}
       GROUP  BY u.id
       ORDER  BY u.id DESC
       LIMIT  ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await query(
      `SELECT COUNT(*) AS total FROM users u WHERE ${where}`, params
    );

    return ok(res, { users: rows, pagination: { page, limit, total } });
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /admin/users/:id  — adjust balance / role / lock
// ─────────────────────────────────────────────────────────────────────────────
async function updateUser(req, res, next) {
  try {
    const userId = parseInt(req.params.id);
    const { balance_delta, role, locked } = req.body;

    const [[u]] = await query('SELECT id, balance, username FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!u) { return next(require('../utils/response').AppError.notFound()); }

    const sets = []; const params = [];

    if (balance_delta !== undefined) {
      const newBal = Math.max(0, u.balance + parseInt(balance_delta));
      sets.push('balance = ?'); params.push(newBal);
      // Write ledger entry
      await query(
        `INSERT INTO transactions
           (user_id, type, amount, direction, balance_before, balance_after, description)
         VALUES (?, 'deposit', ?, ?, ?, ?, ?)`,
        [
          userId,
          Math.abs(balance_delta),
          balance_delta > 0 ? 'credit' : 'debit',
          u.balance, newBal,
          (balance_delta > 0 ? 'Admin cộng tiền' : 'Admin trừ tiền') + ` (${balance_delta > 0 ? '+' : ''}${balance_delta}đ)`,
        ]
      );
    }
    if (role    !== undefined) { sets.push('role = ?');   params.push(role); }
    if (locked  !== undefined) { sets.push('locked = ?'); params.push(locked ? 1 : 0); }

    if (!sets.length) return ok(res, null, 'Không có gì thay đổi.');

    sets.push('updated_at = NOW()');
    await query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, userId]);

    return ok(res, null, 'Đã cập nhật người dùng.');
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /admin/settings  — update key-value settings
// ─────────────────────────────────────────────────────────────────────────────
async function updateSettings(req, res, next) {
  try {
    const allowed = [
      'spin_enabled', 'bypass_enabled', 'first_dep_bonus_pct',
      'aff_auto_approve_hrs', 'tg_bot_token', 'tg_chat_id',
      'tg_daily_report', 'tg_full_report',
    ];
    for (const [k, v] of Object.entries(req.body)) {
      if (!allowed.includes(k)) continue;
      await query(
        "INSERT INTO settings (`key`, `value`) VALUES (?,?) ON DUPLICATE KEY UPDATE `value` = ?",
        [k, String(v), String(v)]
      );
    }
    return ok(res, null, 'Đã lưu cài đặt.');
  } catch (err) { next(err); }
}

async function getSettings(req, res, next) {
  try {
    const [rows] = await query('SELECT `key`, `value` FROM settings');
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return ok(res, settings);
  } catch (err) { next(err); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram Daily Report (called by cron)
// ─────────────────────────────────────────────────────────────────────────────
async function sendDailyReport() {
  try {
    const [[tok]] = await query("SELECT `value` FROM settings WHERE `key`='tg_bot_token' LIMIT 1");
    const [[cid]] = await query("SELECT `value` FROM settings WHERE `key`='tg_chat_id'   LIMIT 1");
    const [[rpt]] = await query("SELECT `value` FROM settings WHERE `key`='tg_daily_report' LIMIT 1");
    const [[full]] = await query("SELECT `value` FROM settings WHERE `key`='tg_full_report'  LIMIT 1");
    if (!tok?.value || !cid?.value || rpt?.value !== '1') return;

    const today = new Date().toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const ts    = new Date(); ts.setHours(0, 0, 0, 0);
    const tsStr = ts.toISOString().slice(0, 19).replace('T', ' ');
    const fmt   = n => Number(n).toLocaleString('vi-VN');

    const [[rev]]  = await query(
      "SELECT IFNULL(SUM(price_paid),0) AS r, COUNT(*) AS c FROM orders WHERE status='success' AND created_at>=?", [tsStr]);
    const [[dep]]  = await query(
      "SELECT IFNULL(SUM(amount),0) AS r FROM deposits WHERE status='approved' AND created_at>=?", [tsStr]);
    const [[comm]] = await query(
      "SELECT IFNULL(SUM(amount),0) AS r FROM aff_commissions WHERE status='approved' AND created_at>=?", [tsStr]);
    const [[nu]]   = await query("SELECT COUNT(*) AS c FROM users WHERE created_at>=?", [tsStr]);

    let text = `\uD83D\uDCCA B\u00C1O C\u00C1O MOD ZONE \u2014 ${today}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n`;
    text += `\uD83D\uDCB0 Doanh thu: ${fmt(rev.r)}\u0111\n`;
    text += `\uD83D\uDED2 \u0110\u01A1n h\u00E0ng: ${rev.c}\n`;

    if (full?.value === '1') {
      text += `\uD83D\uDCB3 N\u1EA1p ti\u1EC1n: ${fmt(dep.r)}\u0111\n`;
      text += `\uD83D\uDD17 Hoa h\u1ED3ng affiliate: ${fmt(comm.r)}\u0111\n`;
      text += `\uD83D\uDC64 Ng\u01B0\u1EDDi d\u00F9ng m\u1EDBi: ${nu.c}\n`;

      const [top3] = await query(
        `SELECT u.username, SUM(c.amount) AS total
         FROM aff_commissions c JOIN users u ON u.id = c.affiliate_user_id
         WHERE c.status = 'approved' AND c.created_at >= ?
         GROUP BY c.affiliate_user_id ORDER BY total DESC LIMIT 3`,
        [tsStr]
      );
      if (top3.length) {
        text += `\n\uD83C\uDFC6 Top Affiliate:\n`;
        top3.forEach((r, i) => { text += `  ${i + 1}. ${r.username} \u2014 ${fmt(r.total)}\u0111\n`; });
      }
    }

    await sendTg(tok.value, cid.value, text);
    logger.info('Daily TG report sent');
  } catch (err) {
    logger.error('sendDailyReport error: %s', err.message);
  }
}

function sendTg(token, chatId, text) {
  const https = require('https');
  const body  = JSON.stringify({ chat_id: chatId, text });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, resolve);
    req.on('error', resolve);
    req.write(body); req.end();
  });
}

module.exports = { dashboard, listUsers, updateUser, getSettings, updateSettings, sendDailyReport };
