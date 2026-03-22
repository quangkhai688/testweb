'use strict';

// ---------------------------------------------------------------------------
// Standard API response envelope
// ---------------------------------------------------------------------------

/**
 * @param {import('express').Response} res
 * @param {number} statusCode
 * @param {boolean} ok
 * @param {string} message
 * @param {*} data
 */
function respond(res, statusCode, ok, message, data = null) {
  const body = { ok, message };
  if (data !== null) body.data = data;
  return res.status(statusCode).json(body);
}

const ok      = (res, data, message = 'OK', code = 200)        => respond(res, code, true, message, data);
const created = (res, data, message = 'Created')                => respond(res, 201, true, message, data);
const badReq  = (res, message = 'Bad request')                  => respond(res, 400, false, message);
const unauth  = (res, message = 'Unauthorized')                 => respond(res, 401, false, message);
const forbid  = (res, message = 'Forbidden')                    => respond(res, 403, false, message);
const notFound = (res, message = 'Not found')                   => respond(res, 404, false, message);
const conflict = (res, message = 'Conflict')                    => respond(res, 409, false, message);
const serverErr = (res, message = 'Internal server error')      => respond(res, 500, false, message);

// ---------------------------------------------------------------------------
// Operational error class (expected failures — do NOT log stack in prod)
// ---------------------------------------------------------------------------
class AppError extends Error {
  /**
   * @param {string} message  - human-readable message
   * @param {number} status   - HTTP status code
   * @param {string} [code]   - machine-readable error code
   */
  constructor(message, status = 400, code = 'ERROR') {
    super(message);
    this.status     = status;
    this.code       = code;
    this.isAppError = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// Convenience factories
AppError.badRequest  = (msg, code) => new AppError(msg, 400, code || 'BAD_REQUEST');
AppError.unauthorized = (msg)      => new AppError(msg || 'Unauthorized', 401, 'UNAUTHORIZED');
AppError.forbidden   = (msg)       => new AppError(msg || 'Forbidden', 403, 'FORBIDDEN');
AppError.notFound    = (msg)       => new AppError(msg || 'Not found', 404, 'NOT_FOUND');
AppError.conflict    = (msg)       => new AppError(msg || 'Conflict', 409, 'CONFLICT');
AppError.outOfStock  = ()          => new AppError('Hết key. Vui lòng thử lại sau.', 409, 'OUT_OF_STOCK');
AppError.insufficientBalance = (need, have) =>
  new AppError(`Số dư không đủ. Cần ${need}đ, hiện có ${have}đ.`, 402, 'INSUFFICIENT_BALANCE');

// ---------------------------------------------------------------------------
// Ref ID generator (URL-safe, no ambiguous chars)
// ---------------------------------------------------------------------------
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genRef(prefix, len = 10) {
  let s = prefix + '-';
  for (let i = 0; i < len; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  return s;
}

module.exports = { ok, created, badReq, unauth, forbid, notFound, conflict, serverErr, AppError, genRef };
