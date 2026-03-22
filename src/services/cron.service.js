'use strict';

const cron   = require('node-cron');
const logger = require('../utils/logger');

/**
 * Register all background cron jobs.
 * Called once from app.js after DB is ready.
 */
function registerCronJobs() {

  // ── Every 30 minutes: auto-approve pending commissions past their timer ──
  cron.schedule('*/30 * * * *', async () => {
    try {
      const { processAutoApprove } = require('../services/affiliate.service');
      const count = await processAutoApprove();
      if (count > 0) logger.info('Cron: auto-approved %d commissions', count);
    } catch (err) {
      logger.error('Cron auto-approve error: %s', err.message);
    }
  });

  // ── Every hour: expire activated keys that have passed their expires_at ──
  cron.schedule('5 * * * *', async () => {
    try {
      const { query } = require('../config/db');
      const [result] = await query(
        "UPDATE orders SET key_status = 'expired' WHERE key_status = 'active' AND id IN (SELECT order_id FROM `keys` WHERE expires_at < NOW() AND expires_at IS NOT NULL)"
      );
      if (result.affectedRows > 0)
        logger.info('Cron: marked %d keys as expired', result.affectedRows);
    } catch (err) {
      logger.error('Cron key-expire error: %s', err.message);
    }
  });

  // ── Every day at 23:59: send Telegram daily report ──
  cron.schedule('59 23 * * *', async () => {
    try {
      const { sendDailyReport } = require('../controllers/admin.controller');
      await sendDailyReport();
    } catch (err) {
      logger.error('Cron daily-report error: %s', err.message);
    }
  }, { timezone: 'Asia/Ho_Chi_Minh' });

  logger.info('Cron jobs registered: auto-approve (30min), key-expire (1h), daily-report (23:59 ICT)');
}

module.exports = { registerCronJobs };
