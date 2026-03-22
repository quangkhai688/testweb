const express = require('express');
const db      = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/v1/wallet/deposits — Lịch sử nạp tiền ─────────────────────────
router.get('/deposits', authenticate, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(50, parseInt(req.query.limit || '20'));
    const offset = (page - 1) * limit;

    const { rows } = await db.query(
      `SELECT id, amount, method, note, status, created_at, reviewed_at
       FROM deposits
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const count = await db.query(
      'SELECT COUNT(*) FROM deposits WHERE user_id = $1',
      [req.user.id]
    );

    res.json({
      success:  true,
      deposits: rows,
      total:    parseInt(count.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    console.error('Get deposits error:', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

// ─── POST /api/v1/wallet/deposit — Tạo yêu cầu nạp tiền ─────────────────────
// Body: { amount, method, note }
router.post('/deposit', authenticate, async (req, res) => {
  const { amount, method, note } = req.body;

  // Validate
  if (!amount || !method) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập số tiền và phương thức nạp' });
  }

  const amountNum = parseFloat(amount);
  if (isNaN(amountNum) || amountNum < 10000) {
    return res.status(400).json({ success: false, message: 'Số tiền nạp tối thiểu là 10.000đ' });
  }
  if (amountNum > 50000000) {
    return res.status(400).json({ success: false, message: 'Số tiền nạp tối đa là 50.000.000đ' });
  }

  const allowedMethods = ['momo', 'banking', 'zalopay', 'viettel_money', 'other'];
  if (!allowedMethods.includes(method.toLowerCase())) {
    return res.status(400).json({
      success: false,
      message: `Phương thức không hợp lệ. Chọn một trong: ${allowedMethods.join(', ')}`,
    });
  }

  try {
    // Giới hạn: không quá 5 yêu cầu pending cùng lúc
    const pendingCount = await db.query(
      `SELECT COUNT(*) FROM deposits
       WHERE user_id = $1 AND status = 'pending'`,
      [req.user.id]
    );
    if (parseInt(pendingCount.rows[0].count) >= 5) {
      return res.status(429).json({
        success: false,
        message: 'Bạn đang có quá nhiều yêu cầu nạp tiền chờ xử lý. Vui lòng chờ admin duyệt',
      });
    }

    const { rows } = await db.query(
      `INSERT INTO deposits (user_id, amount, method, note)
       VALUES ($1, $2, $3, $4)
       RETURNING id, amount, method, note, status, created_at`,
      [req.user.id, amountNum, method.toLowerCase(), note || null]
    );

    res.status(201).json({
      success:  true,
      message:  'Yêu cầu nạp tiền đã được tạo. Vui lòng chờ admin xác nhận',
      deposit:  rows[0],
    });
  } catch (err) {
    console.error('Create deposit error:', err);
    res.status(500).json({ success: false, message: 'Lỗi server' });
  }
});

module.exports = router;
