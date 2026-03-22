const express = require('express');
const db      = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ─── Helper: tạo order_ref ────────────────────────────────────────────────────
const genOrderRef = () => {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `MZ-${ts}-${rand}`;
};

// ─── POST /api/v1/orders/buy ──────────────────────────────────────────────────
// Body: { tier_id, coupon_code? }
router.post('/buy', authenticate, async (req, res) => {
  const { tier_id, coupon_code } = req.body;

  if (!tier_id) {
    return res.status(400).json({ success: false, message: 'Thiếu thông tin gói mua' });
  }

  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // 1. Lấy thông tin tier + game
    const tierResult = await client.query(
      `SELECT t.*, g.name AS game_name, g.id AS game_id
       FROM tiers t
       JOIN games g ON g.id = t.game_id
       WHERE t.id = $1 AND t.is_active = TRUE`,
      [tier_id]
    );
    if (tierResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Gói không tồn tại hoặc đã ngừng bán' });
    }
    const tier = tierResult.rows[0];
    let finalPrice = parseFloat(tier.price);

    // 2. Xử lý coupon (nếu có)
    let couponId = null;
    if (coupon_code) {
      const couponResult = await client.query(
        `SELECT * FROM coupons
         WHERE code = $1
           AND is_active = TRUE
           AND used_count < max_uses
           AND (expires_at IS NULL OR expires_at > NOW())
         FOR UPDATE`,
        [coupon_code.toUpperCase()]
      );
      if (couponResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'Mã giảm giá không hợp lệ hoặc đã hết lượt' });
      }
      const coupon = couponResult.rows[0];
      couponId = coupon.id;

      // Áp dụng giảm giá
      if (coupon.discount_pct > 0) {
        finalPrice = finalPrice * (1 - coupon.discount_pct / 100);
      } else if (parseFloat(coupon.discount_flat) > 0) {
        finalPrice = Math.max(0, finalPrice - parseFloat(coupon.discount_flat));
      }

      // Tăng used_count
      await client.query(
        'UPDATE coupons SET used_count = used_count + 1 WHERE id = $1',
        [coupon.id]
      );
    }

    // 3. Kiểm tra số dư user (FOR UPDATE để lock row)
    const userResult = await client.query(
      'SELECT id, balance, referred_by_id FROM users WHERE id = $1 FOR UPDATE',
      [req.user.id]
    );
    const user = userResult.rows[0];

    if (parseFloat(user.balance) < finalPrice) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: `Số dư không đủ. Cần ${finalPrice.toLocaleString('vi-VN')}đ, hiện có ${parseFloat(user.balance).toLocaleString('vi-VN')}đ`,
      });
    }

    // 4. Lấy key còn trống (FOR UPDATE SKIP LOCKED để tránh race condition)
    const keyResult = await client.query(
      `SELECT id, code FROM game_keys
       WHERE tier_id = $1 AND status = 'available'
       ORDER BY id ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [tier_id]
    );
    if (keyResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Hết hàng! Vui lòng thử lại sau' });
    }
    const key = keyResult.rows[0];

    // 5. Trừ tiền user
    const balanceAfter = parseFloat(user.balance) - finalPrice;
    await client.query(
      'UPDATE users SET balance = $1, updated_at = NOW() WHERE id = $2',
      [balanceAfter, req.user.id]
    );

    // 6. Đánh dấu key đã bán
    await client.query(
      `UPDATE game_keys
       SET status = 'sold', sold_to_id = $1, sold_at = NOW()
       WHERE id = $2`,
      [req.user.id, key.id]
    );

    // 7. Tạo đơn hàng
    const orderRef = genOrderRef();
    const orderResult = await client.query(
      `INSERT INTO orders (order_ref, user_id, key_id, tier_id, game_id, amount_paid, coupon_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [orderRef, req.user.id, key.id, tier_id, tier.game_id, finalPrice, couponId]
    );
    const order = orderResult.rows[0];

    // 8. Affiliate commission (nếu user được giới thiệu)
    if (user.referred_by_id) {
      const COMMISSION_RATE = 5.00; // 5%
      const commissionAmount = finalPrice * (COMMISSION_RATE / 100);
      await client.query(
        `INSERT INTO affiliate_commissions
           (referrer_id, referee_id, order_id, amount, rate_pct)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.referred_by_id, req.user.id, order.id, commissionAmount, COMMISSION_RATE]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      message: 'Mua thành công!',
      key_code:      key.code,
      order_ref:     orderRef,
      balance_after: balanceAfter,
      game:          tier.game_name,
      tier:          tier.name,
      dur_days:      tier.dur_days,
      amount_paid:   finalPrice,
      bought_at:     order.created_at,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Buy order error:', err);
    res.status(500).json({ success: false, message: 'Lỗi xử lý đơn hàng, vui lòng thử lại' });
  } finally {
    client.release();
  }
});

// ─── GET /api/v1/orders — Lịch sử đơn hàng của user ─────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(50, parseInt(req.query.limit || '10'));
    const offset = (page - 1) * limit;

    const { rows } = await db.query(
      `SELECT
         o.order_ref, o.amount_paid, o.status, o.created_at,
         g.name  AS game,
         t.name  AS tier,
         t.dur_days,
         k.code  AS key_code
       FROM orders o
       JOIN game_keys k ON k.id = o.key_id
       JOIN games     g ON g.id = o.game_id
       JOIN tiers     t ON t.id = o.tier_id
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const count = await db.query(
      'SELECT COUNT(*) FROM orders WHERE user_id = $1',
      [req.user.id]
    );

    res.json({
      success: true,
      orders: rows,
      total: parseInt(count.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

module.exports = router;
