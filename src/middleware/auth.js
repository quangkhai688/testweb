'use strict';

const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { AppError } = require('../utils/response');

const SECRET = process.env.JWT_SECRET || 'change_me_in_production';

// ---------------------------------------------------------------------------
// Issue a token
// ---------------------------------------------------------------------------
function signToken(payload) {
  return jwt.sign(payload, SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    algorithm: 'HS256',
  });
}

// ---------------------------------------------------------------------------
// authenticate — verifies Bearer token, attaches req.user
// ---------------------------------------------------------------------------
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer '))
      throw AppError.unauthorized('Token không hợp lệ hoặc chưa đăng nhập.');

    const token = header.slice(7);
    let decoded;
    try {
      decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    } catch (jwtErr) {
      const msg = jwtErr.name === 'TokenExpiredError' ? 'Token đã hết hạn.' : 'Token không hợp lệ.';
      throw AppError.unauthorized(msg);
    }

    // Re-fetch user from DB on every request to catch lock/role changes
    const [rows] = await query(
      'SELECT id, username, email, role, balance, aff_rev, locked FROM users WHERE id = ? LIMIT 1',
      [decoded.id]
    );
    if (!rows.length) throw AppError.unauthorized('Tài khoản không tồn tại.');
    if (rows[0].locked)  throw AppError.unauthorized('Tài khoản đã bị khóa. Liên hệ admin.');

    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// requireRole — call after authenticate
// Usage: router.post('/route', authenticate, requireRole('admin'), handler)
// ---------------------------------------------------------------------------
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(AppError.unauthorized());
    if (!roles.includes(req.user.role))
      return next(AppError.forbidden(`Yêu cầu quyền: ${roles.join(' hoặc ')}`));
    next();
  };
}

const isAdmin    = requireRole('admin');
const isSubAdmin = requireRole('admin', 'sub-admin');

module.exports = { signToken, authenticate, requireRole, isAdmin, isSubAdmin };
