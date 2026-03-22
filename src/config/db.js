'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false,
});

/**
 * Convenience wrapper: run a single query
 */
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/**
 * Get a client for transactions
 */
async function getClient() {
  const client = await pool.connect();
  return client;
}

/**
 * Run a function inside a transaction
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Health check
 */
async function ping() {
  const result = await query('SELECT NOW()');
  return result.rows[0];
}

module.exports = { pool, query, getClient, withTransaction, ping };
