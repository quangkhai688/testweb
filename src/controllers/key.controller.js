'use strict';

const { query, withTransaction } = require('../config/db');
const { AppError, ok, created } = require('../utils/response');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// POST /admin/keys  — add a single key
// ---------------------------------------------------------------------------
async function addKey(req, res, next) {
  try {
    const { code, game_id, tier_id, price } = req.body;
    const adminId = req.user.id;

    // Verify tier belongs to game
    const [tierRows] = await query(
      'SELECT id FROM game_tiers WHERE id = ? AND game_id = ? AND is_active = 1 LIMIT 1',
      [tier_id, game_id]
    );
    if (!tierRows.length) throw AppError.badRequest('tier_id không thuộc game này.');

    const [result] = await query(
      `INSERT INTO \`keys\` (code, game_id, tier_id, price, added_by)
       VALUES (?, ?, ?, ?, ?)`,
      [code.toUpperCase(), game_id, tier_id, price, adminId]
    );

    logger.info('Key added: %s by admin=%d', code, adminId);
    return created(res, { id: result.insertId, code: code.toUpperCase() }, 'Đã thêm key.');
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /admin/keys/bulk  — import many keys at once
// ---------------------------------------------------------------------------
async function addKeyBulk(req, res, next) {
  try {
    const { codes, game_id, tier_id, price } = req.body;
    const adminId = req.user.id;

    const [tierRows] = await query(
      'SELECT id FROM game_tiers WHERE id = ? AND game_id = ? LIMIT 1',
      [tier_id, game_id]
    );
    if (!tierRows.length) throw AppError.badRequest('tier_id không hợp lệ.');

    // Deduplicate input list
    const unique = [...new Set(codes.map(c => c.trim().toUpperCase()))];

    // Find which codes already exist
    const placeholders = unique.map(() => '?').join(',');
    const [existing] = await query(
      `SELECT code FROM \`keys\` WHERE code IN (${placeholders})`,
      unique
    );
    const existingSet = new Set(existing.map(r => r.code));
    const newCodes    = unique.filter(c => !existingSet.has(c));

    if (!newCodes.length) {
      return ok(res, { added: 0, duplicates: unique.length }, 'Tất cả key đã tồn tại.');
    }

    // Bulk insert
    const rows = newCodes.map(c => [c, game_id, tier_id, price, adminId]);
    await withTransaction(async (conn) => {
      for (const row of rows) {
        await conn.execute(
          "INSERT IGNORE INTO `keys` (code, game_id, tier_id, price, added_by) VALUES (?, ?, ?, ?, ?)",
          row
        );
      }
    });

    logger.info('Bulk keys added: %d keys for tier=%d by admin=%d', newCodes.length, tier_id, adminId);
    return created(res, {
      added:      newCodes.length,
      duplicates: existingSet.size,
      skipped:    unique.length - newCodes.length,
    }, `Đã import ${newCodes.length} key.`);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /admin/keys  — list all keys with inventory summary
// ---------------------------------------------------------------------------
async function listKeys(req, res, next) {
  try {
    const { game_id, tier_id, status } = req.query;
    const page  = Math.max(1, parseInt(req.query.page  || '1'));
    const limit = Math.min(100, parseInt(req.query.limit || '50'));
    const offset = (page - 1) * limit;

    let where = '1=1';
    const params = [];
    if (game_id) { where += ' AND k.game_id = ?'; params.push(game_id); }
    if (tier_id) { where += ' AND k.tier_id = ?'; params.push(parseInt(tier_id)); }
    if (status)  { where += ' AND k.status = ?';  params.push(status); }

    const [rows] = await query(
      `SELECT k.id, k.code, k.game_id, k.tier_id, t.label AS tier_label,
              k.price, k.status, k.assigned_to, k.created_at,
              k.activated_at, k.expires_at
       FROM   \`keys\` k
       JOIN   game_tiers t ON t.id = k.tier_id
       WHERE  ${where}
       ORDER  BY k.id DESC
       LIMIT  ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await query(
      `SELECT COUNT(*) AS total FROM \`keys\` k WHERE ${where}`,
      params
    );

    // Inventory summary per tier
    const [summary] = await query(
      `SELECT tier_id, status, COUNT(*) AS cnt
       FROM \`keys\`
       GROUP BY tier_id, status`
    );

    return ok(res, { keys: rows, summary, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /admin/keys/stock  — quick stock check (no key codes exposed)
// ---------------------------------------------------------------------------
async function stockSummary(req, res, next) {
  try {
    const [rows] = await query(
      `SELECT
         g.id AS game_id, g.name AS game_name, g.emoji,
         t.id AS tier_id, t.label, t.dur_days, t.price,
         SUM(CASE WHEN k.status = 'available' THEN 1 ELSE 0 END) AS available,
         SUM(CASE WHEN k.status = 'sold'      THEN 1 ELSE 0 END) AS sold,
         COUNT(k.id) AS total
       FROM   game_tiers t
       JOIN   games g ON g.id = t.game_id
       LEFT   JOIN \`keys\` k ON k.tier_id = t.id
       WHERE  t.is_active = 1 AND g.is_active = 1
       GROUP  BY t.id
       ORDER  BY g.sort_order, t.sort_order`
    );
    return ok(res, rows);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /admin/keys/:id  — remove an unused key
// ---------------------------------------------------------------------------
async function deleteKey(req, res, next) {
  try {
    const keyId = parseInt(req.params.id);
    const [rows] = await query(
      "SELECT id, status FROM `keys` WHERE id = ? LIMIT 1",
      [keyId]
    );
    if (!rows.length) throw AppError.notFound('Key không tồn tại.');
    if (rows[0].status === 'sold') throw AppError.conflict('Không thể xóa key đã bán.');

    await query("DELETE FROM `keys` WHERE id = ?", [keyId]);
    return ok(res, null, 'Đã xóa key.');
  } catch (err) {
    next(err);
  }
}

module.exports = { addKey, addKeyBulk, listKeys, stockSummary, deleteKey };
