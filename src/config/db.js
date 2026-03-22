'use strict';

const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Connection pool — reused across all requests
// mysql2/promise wraps callbacks in native Promises
// ---------------------------------------------------------------------------
let pool = null;

function createPool() {
  pool = mysql.createPool({
    host:               process.env.DB_HOST     || '127.0.0.1',
    port:         parseInt(process.env.DB_PORT  || '3306'),
    user:               process.env.DB_USER     || 'root',
    password:           process.env.DB_PASS     || '',
    database:           process.env.DB_NAME     || 'modzone',
    charset:            'utf8mb4',
    timezone:           '+00:00',         // store all timestamps as UTC
    waitForConnections: true,
    connectionLimit:    parseInt(process.env.DB_POOL_MAX || '20'),
    queueLimit:         100,
    connectTimeout:     parseInt(process.env.DB_CONN_TIMEOUT || '30000'),
    // Keep-alive: ping idle connections
    enableKeepAlive:    true,
    keepAliveInitialDelay: 30000,
  });

  pool.on('connection', () => {
    logger.debug('MySQL: new connection established');
  });

  return pool;
}

/**
 * Get the shared pool (creates it on first call)
 */
function getPool() {
  if (!pool) createPool();
  return pool;
}

/**
 * Convenience wrapper: run a single query on the pool
 * @param {string} sql
 * @param {Array}  params
 * @returns {Promise<[RowDataPacket[], FieldPacket[]]>}
 */
async function query(sql, params = []) {
  return getPool().execute(sql, params);
}

/**
 * Run a function inside a transaction.
 * Automatically commits on success, rolls back on any error.
 *
 * @param {function(conn): Promise<any>} fn
 * @returns {Promise<any>} - whatever fn returns
 *
 * Usage:
 *   const result = await withTransaction(async (conn) => {
 *     const [rows] = await conn.execute('SELECT ...', [...]);
 *     await conn.execute('UPDATE ...', [...]);
 *     return rows;
 *   });
 */
async function withTransaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Health check: ping the database
 */
async function ping() {
  const conn = await getPool().getConnection();
  try {
    await conn.ping();
    return true;
  } finally {
    conn.release();
  }
}

module.exports = { getPool, query, withTransaction, ping };
