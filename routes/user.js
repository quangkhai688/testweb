const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/v1/user/profile ────────────────────────────────────────────────
// Trả về thông tin user + lịch sử mua key + lịch sử giao dịch
router.get('/profile', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;

    // Lấy thông tin đầy đủ
    const userResult = await db.query(
      `SELECT id, username, email, role, balance, ref_code, created_at
       FROM users WHERE id = $1`,
      [userId]
    );
    const user = userResult.rows[0];

    // Lịch sử mua key (10 đơn gần nhất)
    const keysResult = await db.query(
      `SELECT
         o.order_ref,
         o.amount_paid,
         o.created_at AS bought_at,
         g.name  AS game,
         t.name  AS tier,
         t.dur_days,
         k.code  AS key_code
       FROM orders o
       JOIN game_keys k ON k.id = o.key_id
       JOIN games     g ON g.id = o.game_id
       JOIN tiers     t ON t.id = o.tier_id
       WHERE o.user_id = $1 AND o.status = 'completed'
       ORDER BY o.created_at DESC
       LIMIT 10`,
      [userId]
    );

    // Lịch sử nạp tiền (10 lần gần nhất)
    const depositsResult = await db.query(
      `SELECT id, amount, method, status, created_at
       FROM deposits
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [userId]
    );

    // Hoa hồng affiliate
    const commissionResult = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_earned
       FROM affiliate_commissions
       WHERE referrer_id = $1 AND status = 'approved'`,
      [userId]
    );

    res.json({
      success: true,
      user: {
        id:              user.id,
        username:        user.username,
        email:           user.email,
        role:            user.role,
        balance:         parseFloat(user.balance),
        ref_code:        user.ref_code,
        created_at:      user.created_at,
        affiliate_earned: parseFloat(commissionResult.rows[0].total_earned),
      },
      keys:     keysResult.rows,
      deposits: depositsResult.rows,
    });
  } catch (err) {
    console.error('Profile error:', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ─── POST /api/v1/user/change-password ───────────────────────────────────────
router.post('/change-password', authenticate, async (req, res) => {
  const { old_password, new_password } = req.body;

  if (!old_password || !new_password) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ thông tin' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ success: false, message: 'Mật khẩu mới phải ít nhất 6 ký tự' });
  }

  try {
    const { rows } = await db.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user.id]
    );

    const isMatch = await bcrypt.compare(old_password, rows[0].password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Mật khẩu cũ không đúng' });
    }

    const newHash = await bcrypt.hash(new_password, 12);
    await db.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, req.user.id]
    );

    res.json({ success: true, message: 'Đổi mật khẩu thành công' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

module.exports = router;
