const jwt = require('jsonwebtoken');
const db  = require('../db');

/**
 * Middleware: xác thực JWT
 * Gắn req.user = { id, username, role } nếu token hợp lệ
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Thiếu token xác thực' });
    }

    const token = authHeader.split(' ')[1];
    let decoded;

    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ success: false, message: 'Token đã hết hạn, vui lòng đăng nhập lại' });
      }
      return res.status(401).json({ success: false, message: 'Token không hợp lệ' });
    }

    // Kiểm tra user còn tồn tại & không bị khóa
    const { rows } = await db.query(
      'SELECT id, username, email, role, is_locked FROM users WHERE id = $1',
      [decoded.id]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Tài khoản không tồn tại' });
    }

    const user = rows[0];

    if (user.is_locked) {
      return res.status(403).json({ success: false, message: 'Tài khoản đã bị khóa' });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ success: false, message: 'Lỗi xác thực' });
  }
};

/**
 * Middleware: yêu cầu quyền admin
 * Phải dùng sau authenticate
 */
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Bạn không có quyền truy cập' });
  }
  next();
};

module.exports = { authenticate, requireAdmin };
