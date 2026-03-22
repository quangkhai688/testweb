'use strict';

const logger = require('../utils/logger');

/**
 * Central error handler — must be registered LAST in Express.
 * Distinguishes operational errors (AppError) from programming bugs.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Operational / expected errors
  if (err.isAppError) {
    return res.status(err.status).json({
      ok:      false,
      message: err.message,
      code:    err.code,
    });
  }

  // express-validator ValidationError array
  if (Array.isArray(err) && err[0]?.msg) {
    return res.status(422).json({
      ok:     false,
      message: 'Dữ liệu không hợp lệ.',
      errors: err.map(e => ({ field: e.path, message: e.msg })),
    });
  }

  // MySQL duplicate-entry (e.g. unique constraint)
  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ ok: false, message: 'Dữ liệu đã tồn tại.', code: 'DUPLICATE' });
  }

  // Unexpected / programming error — log full stack, hide detail in prod
  logger.error('Unhandled error: %s\n%s', err.message, err.stack);

  return res.status(500).json({
    ok:      false,
    message: process.env.NODE_ENV === 'production'
      ? 'Lỗi hệ thống. Vui lòng thử lại sau.'
      : err.message,
    code: 'INTERNAL_ERROR',
  });
}

module.exports = errorHandler;
