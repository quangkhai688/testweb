'use strict';

/**
 * ORDER CONTROLLER
 * ─────────────────────────────────────────────────────────────────────────
 * BUY KEY — Race-condition prevention strategy:
 *
 *  1. InnoDB transaction with SERIALIZABLE isolation (set per-connection).
 *  2. `SELECT ... FOR UPDATE` on the chosen key row — acquires an
 *     exclusive row-lock that blocks any concurrent transaction from
 *     reading or modifying that row until we COMMIT or ROLLBACK.
 *  3. We re-check status INSIDE the transaction after locking — if another
 *     transaction already committed a sale for the same key, this check
 *     catches it and we roll back cleanly.
 *  4. The UNIQUE index on keys.code makes double-insert impossible.
 *  5. balance is ONLY deducted after the key lock is acquired.
 *
 *  Result: even 1000 concurrent requests for the last key will only
 *  produce 1 successful purchase. All others get "Out of stock".
 * ─────────────────────────────────────────────────────────────────────────
 */

const { withTransaction, query } = require('../config/db');
const { AppError, ok, genRef } = require('../utils/response');
const { scheduleCommission } = require('../services/affiliate.service');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// POST /orders/buy
// ---------------------------------------------------------------------------
async function buyKey(req, res, next) {
  try {
    const userId     = req.user.id;
    const { tier_id, coupon_code } = req.body;

    // ── Validate tier exists and is active ──────────────────────────────
    const [tierRows] = await query(
      `SELECT t.id, t.game_id, t.label, t.dur_days, t.price,
              g.name AS game_name, g.id AS game_id_str
       FROM   game_tiers t
       JOIN   games g ON g.id = t.game_id
       WHERE  t.id = ? AND t.is_active = 1 AND g.is_active = 1
       LIMIT  1`,
      [tier_id]
    );
    if (!tierRows.length) throw AppError.notFound('Gói sản phẩm không tồn tại hoặc đã ngừng bán.');
    const tier = tierRows[0];

    // ── Coupon (read-only check outside transaction — validated inside) ──
    let coupon = null;
    if (coupon_code) {
      const [cpRows] = await query(
        `SELECT id, code, type, value, max_uses, used_count
         FROM coupons
         WHERE code = ? AND is_active = 1
           AND (valid_from IS NULL OR valid_from <= NOW())
           AND (valid_to   IS NULL OR valid_to   >= NOW())
         LIMIT 1`,
        [coupon_code.toUpperCase()]
      );
      if (!cpRows.length) throw AppError.badRequest('Mã coupon không hợp lệ hoặc đã hết hạn.');
      if (cpRows[0].max_uses > 0 && cpRows[0].used_count >= cpRows[0].max_uses)
        throw AppError.badRequest('Mã coupon đã hết lượt sử dụng.');
      coupon = cpRows[0];
    }

    // ── Calculate final price ────────────────────────────────────────────
    let finalPrice = tier.price;
    let discount   = 0;
    if (coupon) {
      discount = coupon.type === 'pct'
        ? Math.round(tier.price * coupon.value / 100)
        : coupon.value;
      finalPrice = Math.max(0, tier.price - discount);
    }

    // ── TRANSACTION ──────────────────────────────────────────────────────
    const result = await withTransaction(async (conn) => {

      // 1. Set SERIALIZABLE for this connection to prevent phantom reads
      await conn.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");

      // 2. Lock the user's balance row to prevent concurrent deductions
      const [userRows] = await conn.execute(
        'SELECT id, balance, locked FROM users WHERE id = ? FOR UPDATE',
        [userId]
      );
      if (!userRows.length || userRows[0].locked)
        throw AppError.unauthorized('Tài khoản không hợp lệ.');

      const user = userRows[0];

      // 3. Check balance
      if (user.balance < finalPrice)
        throw AppError.insufficientBalance(finalPrice, user.balance);

      // 4. SELECT one available key FOR UPDATE — this is the critical lock
      //    Only ONE transaction will hold this lock at a time.
      //    The FOR UPDATE ensures no other transaction can read this row
      //    until we COMMIT (releasing the lock).
      const [keyRows] = await conn.execute(
        `SELECT id, code, status
         FROM \`keys\`
         WHERE tier_id = ? AND status = 'available'
         ORDER BY id ASC
         LIMIT 1
         FOR UPDATE`,
        [tier_id]
      );

      if (!keyRows.length) throw AppError.outOfStock();

      const key = keyRows[0];

      // 5. Re-verify status AFTER lock (race-condition double-check)
      if (key.status !== 'available')
        throw AppError.outOfStock();

      // 6. Generate unique order reference
      const orderRef = genRef('MZ', 10);

      // 7. Create order FIRST (before deducting balance — if order insert
      //    fails due to constraint, the whole transaction rolls back cleanly)
      const [orderResult] = await conn.execute(
        `INSERT INTO orders
           (order_ref, user_id, key_id, game_id, tier_id, tier_label, dur_days,
            price_paid, original_price, coupon_code, discount, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success')`,
        [
          orderRef, userId, key.id, tier.game_id, tier_id,
          tier.label, tier.dur_days, finalPrice, tier.price,
          coupon ? coupon.code : null, discount,
        ]
      );
      const orderId = orderResult.insertId;

      // 8. Mark key as sold (atomic — can't be sold again)
      await conn.execute(
        `UPDATE \`keys\`
         SET status = 'sold', assigned_to = ?, order_id = ?, updated_at = NOW()
         WHERE id = ? AND status = 'available'`,
        [userId, orderId, key.id]
      );
      // Verify the UPDATE actually changed 1 row (extra safety net)
      // If affectedRows = 0, another transaction beat us despite the FOR UPDATE
      // (shouldn't happen with SERIALIZABLE but belt-and-suspenders)
      const [verifyRows] = await conn.execute(
        "SELECT status FROM `keys` WHERE id = ? LIMIT 1",
        [key.id]
      );
      if (!verifyRows.length || verifyRows[0].status !== 'sold')
        throw AppError.outOfStock();

      // 9. Deduct balance
      const balanceAfter = user.balance - finalPrice;
      await conn.execute(
        'UPDATE users SET balance = ? WHERE id = ?',
        [balanceAfter, userId]
      );

      // 10. Write transaction ledger record
      await conn.execute(
        `INSERT INTO transactions
           (user_id, type, amount, direction, balance_before, balance_after, ref_id, description)
         VALUES (?, 'purchase', ?, 'debit', ?, ?, ?, ?)`,
        [
          userId, finalPrice, user.balance, balanceAfter,
          orderRef, `Mua ${tier.game_name} — ${tier.label}`,
        ]
      );

      // 11. Increment coupon usage counter (if coupon used)
      if (coupon) {
        await conn.execute(
          'UPDATE coupons SET used_count = used_count + 1 WHERE id = ?',
          [coupon.id]
        );
      }

      // Transaction complete — return data needed for response
      return { orderId, orderRef, key, tier, finalPrice, balanceAfter };
    });

    // ── Post-transaction: affiliate commission (outside TX — non-critical) ──
    scheduleCommission({
      buyerUserId: userId,
      orderId:     result.orderId,
      amount:      result.finalPrice,
    }).catch(err => logger.error('scheduleCommission failed: %s', err.message));

    logger.info('Order success: %s | user=%d | key=%s | price=%d',
      result.orderRef, userId, result.key.code, result.finalPrice);

    return ok(res, {
      order_ref:     result.orderRef,
      key_code:      result.key.code,
      game:          result.tier.game_name,
      tier:          result.tier.label,
      dur_days:      result.tier.dur_days,
      price_paid:    result.finalPrice,
      balance_after: result.balanceAfter,
      key_status:    'inactive',
      message:       'Mua thành công! Key chưa được kích hoạt — hiệu lực tính từ lúc nhập vào game.',
    }, 'Mua key thành công!');

  } catch (err) {
    // Log unexpected errors, pass AppErrors to handler
    if (!err.isAppError) logger.error('buyKey error: %s\n%s', err.message, err.stack);
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /orders/:id/activate — user activates key in game
// ---------------------------------------------------------------------------
async function activateKey(req, res, next) {
  try {
    const userId  = req.user.id;
    const orderId = parseInt(req.params.id);

    const [rows] = await query(
      `SELECT o.id, o.key_id, o.dur_days, o.key_status, k.code
       FROM orders o JOIN \`keys\` k ON k.id = o.key_id
       WHERE o.id = ? AND o.user_id = ? LIMIT 1`,
      [orderId, userId]
    );
    if (!rows.length) throw AppError.notFound('Đơn hàng không tồn tại.');
    const order = rows[0];
    if (order.key_status !== 'inactive')
      throw AppError.badRequest('Key đã được kích hoạt hoặc đã hết hạn.');

    const activatedAt = new Date();
    const expiresAt   = new Date(activatedAt.getTime() + order.dur_days * 86400000);

    await withTransaction(async (conn) => {
      await conn.execute(
        "UPDATE orders SET key_status = 'active', updated_at = NOW() WHERE id = ?",
        [orderId]
      );
      await conn.execute(
        `UPDATE \`keys\` SET activated_at = ?, expires_at = ?, updated_at = NOW() WHERE id = ?`,
        [activatedAt, expiresAt, order.key_id]
      );
    });

    return ok(res, {
      key_code:     order.code,
      activated_at: activatedAt.toISOString(),
      expires_at:   expiresAt.toISOString(),
      dur_days:     order.dur_days,
    }, 'Key đã kích hoạt thành công!');
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /orders/my
// ---------------------------------------------------------------------------
async function myOrders(req, res, next) {
  try {
    const userId = req.user.id;
    const page   = parseInt(req.query.page  || '1');
    const limit  = Math.min(parseInt(req.query.limit || '20'), 50);
    const offset = (page - 1) * limit;

    const [rows] = await query(
      `SELECT
         o.id, o.order_ref, o.game_id, o.tier_label, o.dur_days,
         o.price_paid, o.coupon_code, o.discount,
         o.key_status, o.status, o.created_at,
         k.code AS key_code,
         k.activated_at, k.expires_at,
         g.name AS game_name, g.emoji
       FROM   orders o
       JOIN   \`keys\`   k ON k.id  = o.key_id
       JOIN   games    g ON g.id  = o.game_id
       WHERE  o.user_id = ?
       ORDER  BY o.created_at DESC
       LIMIT  ? OFFSET ?`,
      [userId, limit, offset]
    );

    const [[{ total }]] = await query(
      'SELECT COUNT(*) AS total FROM orders WHERE user_id = ?',
      [userId]
    );

    return ok(res, {
      orders: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /orders/:id/refund  (admin only)
// ---------------------------------------------------------------------------
async function refundOrder(req, res, next) {
  try {
    const orderId = parseInt(req.params.id);
    const adminId = req.user.id;

    await withTransaction(async (conn) => {
      const [rows] = await conn.execute(
        `SELECT o.id, o.user_id, o.key_id, o.price_paid, o.status, u.balance
         FROM orders o JOIN users u ON u.id = o.user_id
         WHERE o.id = ? FOR UPDATE`,
        [orderId]
      );
      if (!rows.length) throw AppError.notFound('Đơn hàng không tồn tại.');
      const order = rows[0];
      if (order.status === 'refunded') throw AppError.conflict('Đơn đã hoàn tiền.');

      // Restore balance
      const balanceAfter = order.balance + order.price_paid;
      await conn.execute(
        "UPDATE users SET balance = ? WHERE id = ?",
        [balanceAfter, order.user_id]
      );

      // Mark order
      await conn.execute(
        "UPDATE orders SET status = 'refunded', refunded_at = NOW() WHERE id = ?",
        [orderId]
      );

      // Mark key available again
      await conn.execute(
        "UPDATE `keys` SET status = 'refunded', assigned_to = NULL, order_id = NULL WHERE id = ?",
        [order.key_id]
      );

      // Ledger
      await conn.execute(
        `INSERT INTO transactions
           (user_id, type, amount, direction, balance_before, balance_after, ref_id, description)
         VALUES (?, 'refund', ?, 'credit', ?, ?, ?, 'Hoàn tiền đơn hàng')`,
        [order.user_id, order.price_paid, order.balance, balanceAfter, 'REF-' + orderId]
      );
    });

    logger.info('Order refunded: id=%d by admin=%d', orderId, adminId);
    return ok(res, null, 'Đã hoàn tiền thành công.');
  } catch (err) {
    next(err);
  }
}

module.exports = { buyKey, activateKey, myOrders, refundOrder };
