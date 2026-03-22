const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db       = require('../db');

const router = express.Router();

// ─── Helper: tạo JWT ─────────────────────────────────────────────────────────
const signToken = (user) =>
  jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

// ─── Helper: tạo ref code ngẫu nhiên ─────────────────────────────────────────
const genRefCode = () =>
  Math.random().toString(36).substring(2, 8).toUpperCase();

// ─── GET /api/v1/auth/health ──────────────────────────────────────────────────
router.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({
      success: true,
      message: 'Mod Zone API is running 🚀',
      db: 'connected',
      time: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Database not connected', error: err.message });
  }
});

// ─── POST /api/v1/auth/register ───────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { username, email, password, ref } = req.body;

  // Validate input
  if (!username || !email || !password) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ thông tin' });
  }
  if (username.length < 3 || username.length > 50) {
    return res.status(400).json({ success: false, message: 'Username phải từ 3-50 ký tự' });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: 'Mật khẩu phải ít nhất 6 ký tự' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, message: 'Email không hợp lệ' });
  }

  try {
    // Kiểm tra trùng username/email
    const existing = await db.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username.toLowerCase(), email.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Username hoặc email đã tồn tại' });
    }

    // Tìm người giới thiệu
    let referredById = null;
    if (ref) {
      const refUser = await db.query(
        'SELECT id FROM users WHERE ref_code = $1',
        [ref.toUpperCase()]
      );
      if (refUser.rows.length > 0) {
        referredById = refUser.rows[0].id;
      }
    }

    // Hash mật khẩu
    const passwordHash = await bcrypt.hash(password, 12);

    // Tạo ref code duy nhất
    let refCode;
    let codeExists = true;
    while (codeExists) {
      refCode = genRefCode();
      const check = await db.query('SELECT id FROM users WHERE ref_code = $1', [refCode]);
      codeExists = check.rows.length > 0;
    }

    // Tạo user
    const { rows } = await db.query(
      `INSERT INTO users (username, email, password_hash, ref_code, referred_by_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, role, balance, ref_code, created_at`,
      [username.toLowerCase(), email.toLowerCase(), passwordHash, refCode, referredById]
    );

    const user = rows[0];
    const token = signToken(user);

    res.status(201).json({
      success: true,
      message: 'Đăng ký thành công',
      token,
      user: {
        id:         user.id,
        username:   user.username,
        email:      user.email,
        role:       user.role,
        balance:    parseFloat(user.balance),
        ref_code:   user.ref_code,
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Lỗi server, vui lòng thử lại' });
  }
});

// ─── POST /api/v1/auth/login ──────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Vui lòng nhập username và mật khẩu' });
  }

  try {
    // Tìm user (cho phép đăng nhập bằng username hoặc email)
    const { rows } = await db.query(
      `SELECT id, username, email, password_hash, role, balance, is_locked, ref_code
       FROM users
       WHERE username = $1 OR email = $1`,
      [username.toLowerCase()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không đúng' });
    }

    const user = rows[0];

    if (user.is_locked) {
      return res.status(403).json({ success: false, message: 'Tài khoản đã bị khóa. Vui lòng liên hệ admin' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Tên đăng nhập hoặc mật khẩu không đúng' });
    }

    const token = signToken(user);

    res.json({
      success: true,
      message: 'Đăng nhập thành công',
      token,
      user: {
        id:       user.id,
        username: user.username,
        email:    user.email,
        role:     user.role,
        balance:  parseFloat(user.balance),
        ref_code: user.ref_code,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Lỗi server, vui lòng thử lại' });
  }
});

module.exports = router;
