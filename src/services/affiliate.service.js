'use strict';

/**
 * Affiliate Service
 * ─────────────────────────────────────────────────────────────────────────
 * Commission flow:
 *  1. Order completes → scheduleCommission() called asynchronously
 *  2. Commission saved as 'pending' — NOT credited to balance yet
 *  3. Auto-approve job runs every 30 min → approves commissions past their
 *     auto_approve_at timestamp (unless user is blacklisted/flagged)
 *  4. Admin can approve/reject manually at any time
 *  5. When approved → balance + aff_rev updated, transaction written
 * ─────────────────────────────────────────────────────────────────────────
 */

const { query, withTransaction } = require('../config/db');
const { genRef } = require('../utils/response');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Commission rates by referral count
// ---------------------------------------------------------------------------
function getAffRate(referralCount) {
  if (referralCount >= 50) return 15;
  if (referralCount >= 10) return 10;
  return 5;
}

// ---------------------------------------------------------------------------
// scheduleCommission — called after a successful purchase
// ---------------------------------------------------------------------------
async function scheduleCommission({ buyerUserId, orderId, amount }) {
  try {
    // Get buyer's referrer
    const [buyerRows] = await query(
      'SELECT ref_by FROM users WHERE id = ? LIMIT 1',
      [buyerUserId]
    );
    if (!buyerRows.length || !buyerRows[0].ref_by) return;

    const refUsername = buyerRows[0].ref_by;

    // Get affiliate user
    const [affRows] = await query(
      `SELECT u.id, u.fraud_flag, u.aff_blacklist,
              (SELECT COUNT(*) FROM users WHERE ref_by = u.username) AS ref_count
       FROM users u WHERE u.username = ? LIMIT 1`,
      [refUsername]
    );
    if (!affRows.length) return;
    const aff = affRows[0];

    // Skip if blacklisted or fraud-flagged
    if (aff.aff_blacklist || aff.fraud_flag) {
      logger.info('Commission skipped (blacklist/fraud) for affiliate=%s', refUsername);
      return;
    }

    // Is this buyer's first order? (for first-dep bonus)
    const [[{ orderCount }]] = await query(
      "SELECT COUNT(*) AS orderCount FROM orders WHERE user_id = ? AND status = 'success'",
      [buyerUserId]
    );
    const isFirst = orderCount <= 1;

    const rate       = getAffRate(aff.ref_count);
    const commission = Math.round(amount * rate / 100);
    const firstBonus = isFirst ? Math.min(Math.round(amount * 0.10), 1000000) : 0;
    const total      = commission + firstBonus;

    if (total <= 0) return;

    // Read auto-approve delay from settings
    const [[setting]] = await query(
      "SELECT `value` FROM settings WHERE `key` = 'aff_auto_approve_hrs' LIMIT 1"
    );
    const hours = parseInt(setting?.value || '24');
    const autoApproveAt = new Date(Date.now() + hours * 3600000);

    const commRef = genRef('COMM', 10);

    await query(
      `INSERT INTO aff_commissions
         (comm_ref, affiliate_user_id, buyer_user_id, order_id,
          amount, rate, first_dep_bonus, status, auto_approve_at,
          note)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        commRef, aff.id, buyerUserId, orderId,
        total, rate, firstBonus, autoApproveAt,
        isFirst ? `Lần mua đầu — bonus ${firstBonus}đ` : null,
      ]
    );

    // Update pending counter (optimistic, not transactional — recalculated on approval)
    await query(
      'UPDATE users SET aff_pending = aff_pending + ? WHERE id = ?',
      [total, aff.id]
    );

    logger.info('Commission scheduled: %s aff=%s amount=%d auto_approve=%s',
      commRef, refUsername, total, autoApproveAt.toISOString());
  } catch (err) {
    logger.error('scheduleCommission error: %s', err.message);
  }
}

// ---------------------------------------------------------------------------
// approveCommission — credit to balance
// ---------------------------------------------------------------------------
async function approveCommission(commId, approvedBy = null) {
  return withTransaction(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT c.id, c.affiliate_user_id, c.amount, c.status,
              u.balance, u.aff_rev, u.aff_pending, u.fraud_flag, u.aff_blacklist
       FROM   aff_commissions c
       JOIN   users u ON u.id = c.affiliate_user_id
       WHERE  c.id = ? FOR UPDATE`,
      [commId]
    );
    if (!rows.length) throw new Error('Commission not found: ' + commId);
    const comm = rows[0];
    if (comm.status !== 'pending') return null; // already processed
    if (comm.aff_blacklist || comm.fraud_flag) {
      await conn.execute(
        "UPDATE aff_commissions SET status = 'cancelled', note = 'Auto-cancelled: fraud/blacklist' WHERE id = ?",
        [commId]
      );
      return null;
    }

    const newBalance    = comm.balance    + comm.amount;
    const newAffRev     = comm.aff_rev    + comm.amount;
    const newAffPending = Math.max(0, comm.aff_pending - comm.amount);

    await conn.execute(
      `UPDATE users SET balance = ?, aff_rev = ?, aff_pending = ? WHERE id = ?`,
      [newBalance, newAffRev, newAffPending, comm.affiliate_user_id]
    );
    await conn.execute(
      `UPDATE aff_commissions
       SET status = 'approved', approved_at = NOW(), approved_by = ?
       WHERE id = ?`,
      [approvedBy, commId]
    );
    await conn.execute(
      `INSERT INTO transactions
         (user_id, type, amount, direction, balance_before, balance_after, ref_id, description)
       VALUES (?, 'commission', ?, 'credit', ?, ?, ?, 'Hoa hồng affiliate đã duyệt')`,
      [comm.affiliate_user_id, comm.amount, comm.balance, newBalance, 'COMM-' + commId]
    );

    return comm.amount;
  });
}

// ---------------------------------------------------------------------------
// processAutoApprove — called by cron job every 30 minutes
// ---------------------------------------------------------------------------
async function processAutoApprove() {
  const [pending] = await query(
    `SELECT id FROM aff_commissions
     WHERE status = 'pending' AND auto_approve_at <= NOW()
     LIMIT 100`
  );
  if (!pending.length) return 0;

  let approved = 0;
  for (const row of pending) {
    try {
      const amount = await approveCommission(row.id);
      if (amount !== null) approved++;
    } catch (err) {
      logger.error('Auto-approve commission %d failed: %s', row.id, err.message);
    }
  }
  if (approved > 0)
    logger.info('Auto-approved %d commissions', approved);
  return approved;
}

module.exports = { scheduleCommission, approveCommission, processAutoApprove, getAffRate };
