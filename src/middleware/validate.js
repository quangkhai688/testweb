'use strict';

const { body, param, query: qv, validationResult } = require('express-validator');

/**
 * Run validationResult; if errors exist, pass them to next() as an array
 * (the errorHandler knows how to format them).
 */
function validate(req, _res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return next(errors.array());
  next();
}

// ---------------------------------------------------------------------------
// Reusable rule sets
// ---------------------------------------------------------------------------
const rules = {
  register: [
    body('username')
      .trim()
      .isLength({ min: 4, max: 32 }).withMessage('Username phải từ 4–32 ký tự')
      .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username chỉ gồm chữ, số và _'),
    body('email')
      .isEmail().withMessage('Email không hợp lệ')
      .normalizeEmail(),
    body('password')
      .isLength({ min: 8 }).withMessage('Mật khẩu ít nhất 8 ký tự')
      .matches(/[A-Z]/).withMessage('Cần ít nhất 1 chữ hoa')
      .matches(/[0-9]/).withMessage('Cần ít nhất 1 chữ số'),
  ],

  login: [
    body('username').trim().notEmpty().withMessage('Username là bắt buộc'),
    body('password').notEmpty().withMessage('Mật khẩu là bắt buộc'),
  ],

  buyKey: [
    body('tier_id')
      .isInt({ min: 1 }).withMessage('tier_id không hợp lệ'),
    body('coupon_code')
      .optional()
      .trim()
      .isLength({ max: 32 }).withMessage('Mã coupon quá dài'),
  ],

  deposit: [
    body('amount')
      .isInt({ min: 10000, max: 100000000 }).withMessage('Số tiền nạp phải từ 10,000đ–100,000,000đ'),
    body('method')
      .isIn(['card', 'bank_transfer', 'momo', 'zalopay']).withMessage('Phương thức không hợp lệ'),
  ],

  addKey: [
    body('code')
      .trim()
      .isLength({ min: 6, max: 64 }).withMessage('Key code phải từ 6–64 ký tự')
      .matches(/^[A-Za-z0-9\-_]+$/).withMessage('Key chỉ gồm chữ, số, - và _'),
    body('game_id')
      .trim()
      .notEmpty().withMessage('game_id là bắt buộc'),
    body('tier_id')
      .isInt({ min: 1 }).withMessage('tier_id phải là số nguyên dương'),
    body('price')
      .isInt({ min: 0 }).withMessage('Giá phải >= 0'),
  ],

  addKeyBulk: [
    body('codes')
      .isArray({ min: 1, max: 500 }).withMessage('codes phải là mảng 1–500 phần tử'),
    body('codes.*')
      .trim()
      .isLength({ min: 6, max: 64 }).withMessage('Mỗi key từ 6–64 ký tự')
      .matches(/^[A-Za-z0-9\-_]+$/),
    body('game_id').trim().notEmpty(),
    body('tier_id').isInt({ min: 1 }),
    body('price').isInt({ min: 0 }),
  ],

  withdrawal: [
    body('amount')
      .isInt({ min: 100000 }).withMessage('Số tiền rút tối thiểu 100,000đ'),
    body('method')
      .isIn(['bank', 'momo', 'zalopay']).withMessage('Phương thức không hợp lệ'),
    body('bank_account')
      .if(body('method').equals('bank'))
      .trim().notEmpty().withMessage('Số tài khoản là bắt buộc'),
    body('bank_owner')
      .if(body('method').equals('bank'))
      .trim().notEmpty().withMessage('Tên chủ tài khoản là bắt buộc'),
    body('bank_name')
      .if(body('method').equals('bank'))
      .trim().notEmpty().withMessage('Tên ngân hàng là bắt buộc'),
    body('phone')
      .if(body('method').isIn(['momo', 'zalopay']))
      .trim().isMobilePhone('vi-VN').withMessage('Số điện thoại không hợp lệ'),
  ],

  idParam: [
    param('id').isInt({ min: 1 }).withMessage('ID không hợp lệ'),
  ],

  pagination: [
    qv('page').optional().isInt({ min: 1 }).toInt(),
    qv('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
};

module.exports = { validate, rules };
