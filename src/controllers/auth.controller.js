'use strict';

const bcrypt = require('bcrypt');
const { query, withTransaction } = require('../config/db');
const { signToken } = require('../middleware/auth');
const { AppError, ok, created, genRef } = require('../utils/response');
const logger = require('../utils/logger');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------
async function register(req, res, next) {
  try {
    const { username, email, password, ref } = req.body;
    const fingerprint = req.body.fingerprint || null;

    // Validate referrer if provided
    let refUserId = null;
    if (ref) {
      const [refRows] = await query(
        'SELECT id, fraud_flag, aff_blacklist FROM users WHERE username = ? LIMIT 1',
        [ref]
      );
      if (refRows.length) refUserId = refRows[0].id;
    }

    // Check existing username / email (fast path before bcrypt)
    const [exist] = await query(
      'SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1',
      [username, email]
    );
    if (exist.length) throw AppError.conflict('Username hoặc email đã tồn tại.');

    // Fraud: multiple accounts from same fingerprint?
    let fraudFlag = false;
    const fraudReasons = [];
    if (fingerprint) {
      const [fpRows] = await query(
        'SELECT COUNT(*) AS cnt FROM users WHERE fingerprint = ?',
        [fingerprint]
      );
      if (fpRows[0].cnt >= 2) {
        fraudFlag = true;
        fraudReasons.push('Nhiều tài khoản cùng thiết bị (' + (fpRows[0].cnt + 1) + ')');
      }
    }

    // Hash password (expensive — do before transaction)
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const [result] = await query(
      `INSERT INTO users
         (username, email, password_hash, ref_by, fingerprint, fraud_flag, fraud_reasons)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        username,
        email,
        hash,
        ref || null,
        fingerprint,
        fraudFlag ? 1 : 0,
        fraudReasons.length ? JSON.stringify(fraudReasons) : null,
      ]
    );

    const userId = result.insertId;

    // Add user to referrer's referrals table (no FK — stored as event log)
    if (refUserId) {
      await query(
        `INSERT INTO aff_clicks (ref_user, visitor_fp, ip_hash)
         VALUES (?, ?, ?)`,
        [ref, fingerprint, hashIp(req.ip)]
      );
    }

    logger.info('User registered: %s (id=%d)', username, userId);

    const token = signToken({ id: userId, username, role: 'user' });
    return created(res, { token, username }, 'Đăng ký thành công!');
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
async function login(req, res, next) {
  try {
    const { username, password } = req.body;

    const [rows] = await query(
      'SELECT id, username, email, password_hash, role, balance, locked FROM users WHERE username = ? LIMIT 1',
      [username]
    );

    if (!rows.length) throw AppError.unauthorized('Username hoặc mật khẩu không đúng.');

    const user = rows[0];
    if (user.locked) throw AppError.unauthorized('Tài khoản đã bị khóa. Liên hệ admin.');

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) throw AppError.unauthorized('Username hoặc mật khẩu không đúng.');

    // Update last_login
    await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    const token = signToken({ id: user.id, username: user.username, role: user.role });

    logger.info('User logged in: %s', username);

    return ok(res, {
      token,
      user: {
        id:       user.id,
        username: user.username,
        email:    user.email,
        role:     user.role,
        balance:  user.balance,
      },
    }, 'Đăng nhập thành công!');
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hashIp(ip) {
  if (!ip) return null;
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 64);
}

module.exports = { register, login };
