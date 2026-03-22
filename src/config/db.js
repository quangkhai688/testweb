'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function getClient() {
  return pool.connect();
}

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

async function ping() {
  const result = await pool.query('SELECT NOW()');
  return result.rows[0];
}

module.exports = { pool, query, getClient, withTransaction, ping };
