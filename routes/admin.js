const express = require('express');
const db      = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Tất cả admin routes đều cần JWT + role admin
router.use(authenticate, requireAdmin);

// ─── Helper: phân trang ───────────────────────────────────────────────────────
const getPagination = (query) => {
  const page   = Math.max(1, parseInt(query.page  || '1'));
  const limit  = Math.min(100, parseInt(query.limit || '20'));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

// ============================================================
// USERS
// ============================================================

// GET /api/v1/admin/users
router.get('/users', async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const search = req.query.search || '';

    const whereClause = search
      ? `WHERE username ILIKE $3 OR email ILIKE $3`
      : '';
    const params = search
      ? [limit, offset, `%${search}%`]
      : [limit, offset];

    const { rows } = await db.query(
      `SELECT id, username, email, role, balance, is_locked, ref_code, created_at
       FROM users
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    const count = await db.query(
      `SELECT COUNT(*) FROM users ${whereClause}`,
      search ? [`%${search}%`] : []
    );

    res.json({ success: true, users: rows, total: parseInt(count.rows[0].count), page, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// PATCH /api/v1/admin/users/:id
router.patch('/users/:id', async (req, res) => {
  const { is_locked, role, balance } = req.body;
  const userId = parseInt(req.params.id);

  if (isNaN(userId)) {
    return res.status(400).json({ success: false, message: 'ID không hợp lệ' });
  }
  // Không cho tự khóa mình
  if (userId === req.user.id) {
    return res.status(400).json({ success: false, message: 'Không thể chỉnh sửa tài khoản của mình' });
  }

  try {
    const updates = [];
    const values  = [];
    let idx = 1;

    if (typeof is_locked === 'boolean') { updates.push(`is_locked = $${idx++}`); values.push(is_locked); }
    if (role && ['user', 'admin'].includes(role)) { updates.push(`role = $${idx++}`); values.push(role); }
    if (balance !== undefined) {
      const bal = parseFloat(balance);
      if (isNaN(bal) || bal < 0) {
        return res.status(400).json({ success: false, message: 'Số dư không hợp lệ' });
      }
      updates.push(`balance = $${idx++}`);
      values.push(bal);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'Không có thông tin cần cập nhật' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(userId);

    const { rows } = await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}
       RETURNING id, username, email, role, balance, is_locked`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy user' });
    }

    res.json({ success: true, message: 'Cập nhật thành công', user: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ============================================================
// ORDERS
// ============================================================

// GET /api/v1/admin/orders
router.get('/orders', async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);

    const { rows } = await db.query(
      `SELECT
         o.id, o.order_ref, o.amount_paid, o.status, o.created_at,
         u.username, u.email,
         g.name AS game,
         t.name AS tier, t.dur_days,
         k.code AS key_code
       FROM orders o
       JOIN users     u ON u.id = o.user_id
       JOIN game_keys k ON k.id = o.key_id
       JOIN games     g ON g.id = o.game_id
       JOIN tiers     t ON t.id = o.tier_id
       ORDER BY o.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const count = await db.query('SELECT COUNT(*) FROM orders');
    res.json({ success: true, orders: rows, total: parseInt(count.rows[0].count), page, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ============================================================
// DEPOSITS
// ============================================================

// GET /api/v1/admin/deposits
router.get('/deposits', async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const status = req.query.status; // filter by status

    const where  = status ? `WHERE d.status = $3` : '';
    const params = status ? [limit, offset, status] : [limit, offset];

    const { rows } = await db.query(
      `SELECT
         d.id, d.amount, d.method, d.note, d.status, d.created_at, d.reviewed_at,
         u.username, u.email
       FROM deposits d
       JOIN users u ON u.id = d.user_id
       ${where}
       ORDER BY d.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    const count = await db.query(
      `SELECT COUNT(*) FROM deposits ${status ? 'WHERE status = $1' : ''}`,
      status ? [status] : []
    );

    res.json({ success: true, deposits: rows, total: parseInt(count.rows[0].count), page, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// POST /api/v1/admin/deposits/:id/approve
router.post('/deposits/:id/approve', async (req, res) => {
  const depositId = parseInt(req.params.id);
  const client    = await db.getClient();

  try {
    await client.query('BEGIN');

    const depResult = await client.query(
      `SELECT * FROM deposits WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [depositId]
    );
    if (depResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Yêu cầu không tồn tại hoặc đã xử lý' });
    }
    const deposit = depResult.rows[0];

    // Cộng tiền vào tài khoản user
    await client.query(
      'UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
      [deposit.amount, deposit.user_id]
    );

    // Cập nhật trạng thái deposit
    await client.query(
      `UPDATE deposits
       SET status = 'approved', reviewed_by_id = $1, reviewed_at = NOW()
       WHERE id = $2`,
      [req.user.id, depositId]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: `Đã duyệt và cộng ${deposit.amount.toLocaleString('vi-VN')}đ vào tài khoản` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  } finally {
    client.release();
  }
});

// POST /api/v1/admin/deposits/:id/reject
router.post('/deposits/:id/reject', async (req, res) => {
  const depositId = parseInt(req.params.id);

  try {
    const { rows } = await db.query(
      `UPDATE deposits
       SET status = 'rejected', reviewed_by_id = $1, reviewed_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING id`,
      [req.user.id, depositId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Yêu cầu không tồn tại hoặc đã xử lý' });
    }

    res.json({ success: true, message: 'Đã từ chối yêu cầu nạp tiền' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ============================================================
// KEYS — BULK IMPORT
// ============================================================

// POST /api/v1/admin/keys/bulk
// Body: { codes: string[], game_id, tier_id, price }
router.post('/keys/bulk', async (req, res) => {
  const { codes, game_id, tier_id, price } = req.body;

  if (!codes || !Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ success: false, message: 'Danh sách key không được để trống' });
  }
  if (!game_id || !tier_id || !price) {
    return res.status(400).json({ success: false, message: 'Thiếu game_id, tier_id hoặc price' });
  }

  // Làm sạch danh sách key
  const cleanCodes = [...new Set(codes.map(c => c.trim()).filter(c => c.length > 0))];
  if (cleanCodes.length === 0) {
    return res.status(400).json({ success: false, message: 'Không có key hợp lệ để import' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Kiểm tra game và tier tồn tại
    const gameCheck = await client.query('SELECT id FROM games WHERE id = $1', [game_id]);
    const tierCheck = await client.query('SELECT id FROM tiers WHERE id = $1 AND game_id = $2', [tier_id, game_id]);

    if (gameCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Game không tồn tại' });
    }
    if (tierCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Tier không tồn tại hoặc không thuộc game này' });
    }

    // Insert từng key, bỏ qua key đã tồn tại
    let inserted = 0;
    let skipped  = 0;

    for (const code of cleanCodes) {
      const result = await client.query(
        `INSERT INTO game_keys (code, game_id, tier_id, price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
        [code, game_id, tier_id, parseFloat(price)]
      );
      if (result.rows.length > 0) inserted++;
      else skipped++;
    }

    await client.query('COMMIT');
    res.status(201).json({
      success:  true,
      message:  `Import thành công ${inserted} key, bỏ qua ${skipped} key trùng`,
      inserted,
      skipped,
      total:    cleanCodes.length,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Bulk import error:', err);
    res.status(500).json({ success: false, message: 'Lỗi server khi import key' });
  } finally {
    client.release();
  }
});

// ============================================================
// AFFILIATE
// ============================================================

// GET /api/v1/admin/affiliate/list
router.get('/affiliate/list', async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);

    const { rows } = await db.query(
      `SELECT
         u.id, u.username, u.email, u.ref_code, u.created_at,
         COUNT(DISTINCT r.id)           AS referral_count,
         COALESCE(SUM(ac.amount), 0)    AS total_commission,
         COALESCE(SUM(CASE WHEN ac.status = 'approved' THEN ac.amount END), 0) AS paid_commission
       FROM users u
       LEFT JOIN users  r  ON r.referred_by_id = u.id
       LEFT JOIN affiliate_commissions ac ON ac.referrer_id = u.id
       GROUP BY u.id
       HAVING COUNT(DISTINCT r.id) > 0
       ORDER BY total_commission DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({ success: true, affiliates: rows, page, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// GET /api/v1/admin/affiliate/commissions
router.get('/affiliate/commissions', async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const status = req.query.status;

    const where  = status ? `WHERE ac.status = $3` : '';
    const params = status ? [limit, offset, status] : [limit, offset];

    const { rows } = await db.query(
      `SELECT
         ac.id, ac.amount, ac.rate_pct, ac.status, ac.created_at,
         referrer.username AS referrer_username,
         referee.username  AS referee_username,
         o.order_ref
       FROM affiliate_commissions ac
       JOIN users  referrer ON referrer.id = ac.referrer_id
       JOIN users  referee  ON referee.id  = ac.referee_id
       JOIN orders o        ON o.id = ac.order_id
       ${where}
       ORDER BY ac.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    const count = await db.query(
      `SELECT COUNT(*) FROM affiliate_commissions ${status ? 'WHERE status = $1' : ''}`,
      status ? [status] : []
    );

    res.json({ success: true, commissions: rows, total: parseInt(count.rows[0].count), page, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// POST /api/v1/admin/affiliate/commissions/:id/approve
router.post('/affiliate/commissions/:id/approve', async (req, res) => {
  const id     = parseInt(req.params.id);
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const comResult = await client.query(
      `SELECT * FROM affiliate_commissions WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [id]
    );
    if (comResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Hoa hồng không tồn tại hoặc đã xử lý' });
    }
    const com = comResult.rows[0];

    // Cộng tiền cho referrer
    await client.query(
      'UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
      [com.amount, com.referrer_id]
    );

    await client.query(
      `UPDATE affiliate_commissions
       SET status = 'approved', reviewed_by_id = $1, reviewed_at = NOW()
       WHERE id = $2`,
      [req.user.id, id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Đã duyệt hoa hồng và cộng tiền cho affiliate' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  } finally {
    client.release();
  }
});

// POST /api/v1/admin/affiliate/commissions/:id/reject
router.post('/affiliate/commissions/:id/reject', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE affiliate_commissions
       SET status = 'rejected', reviewed_by_id = $1, reviewed_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING id`,
      [req.user.id, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy hoặc đã xử lý' });
    }
    res.json({ success: true, message: 'Đã từ chối hoa hồng' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// GET /api/v1/admin/affiliate/withdrawals
router.get('/affiliate/withdrawals', async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req.query);
    const status = req.query.status;

    const where  = status ? `WHERE aw.status = $3` : '';
    const params = status ? [limit, offset, status] : [limit, offset];

    const { rows } = await db.query(
      `SELECT
         aw.id, aw.amount, aw.bank_info, aw.status, aw.created_at,
         u.username, u.email
       FROM affiliate_withdrawals aw
       JOIN users u ON u.id = aw.user_id
       ${where}
       ORDER BY aw.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );

    const count = await db.query(
      `SELECT COUNT(*) FROM affiliate_withdrawals ${status ? 'WHERE status = $1' : ''}`,
      status ? [status] : []
    );

    res.json({ success: true, withdrawals: rows, total: parseInt(count.rows[0].count), page, limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// POST /api/v1/admin/affiliate/withdrawals/:id/approve
router.post('/affiliate/withdrawals/:id/approve', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE affiliate_withdrawals
       SET status = 'approved', reviewed_by_id = $1, reviewed_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING id`,
      [req.user.id, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy hoặc đã xử lý' });
    }
    res.json({ success: true, message: 'Đã duyệt yêu cầu rút tiền' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// POST /api/v1/admin/affiliate/withdrawals/:id/reject
router.post('/affiliate/withdrawals/:id/reject', async (req, res) => {
  const id     = parseInt(req.params.id);
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const wdResult = await client.query(
      `SELECT * FROM affiliate_withdrawals WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [id]
    );
    if (wdResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Không tìm thấy hoặc đã xử lý' });
    }
    const wd = wdResult.rows[0];

    // Hoàn tiền lại cho user khi từ chối
    await client.query(
      'UPDATE users SET balance = balance + $1, updated_at = NOW() WHERE id = $2',
      [wd.amount, wd.user_id]
    );

    await client.query(
      `UPDATE affiliate_withdrawals
       SET status = 'rejected', reviewed_by_id = $1, reviewed_at = NOW()
       WHERE id = $2`,
      [req.user.id, id]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: 'Đã từ chối và hoàn tiền lại tài khoản' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  } finally {
    client.release();
  }
});

// ============================================================
// DASHBOARD STATS
// ============================================================

// GET /api/v1/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const [users, orders, revenue, pendingDeposits, availableKeys] = await Promise.all([
      db.query('SELECT COUNT(*) FROM users WHERE role = $1', ['user']),
      db.query('SELECT COUNT(*) FROM orders WHERE status = $1', ['completed']),
      db.query(`SELECT COALESCE(SUM(amount_paid), 0) AS total FROM orders WHERE status = 'completed'`),
      db.query(`SELECT COUNT(*) FROM deposits WHERE status = 'pending'`),
      db.query(`SELECT COUNT(*) FROM game_keys WHERE status = 'available'`),
    ]);

    res.json({
      success: true,
      stats: {
        total_users:       parseInt(users.rows[0].count),
        total_orders:      parseInt(orders.rows[0].count),
        total_revenue:     parseFloat(revenue.rows[0].total),
        pending_deposits:  parseInt(pendingDeposits.rows[0].count),
        available_keys:    parseInt(availableKeys.rows[0].count),
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

module.exports = router;
