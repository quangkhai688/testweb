const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'modzone',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  // Connection pool settings
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection khi khởi động
pool.on('connect', () => {
  console.log('✅ PostgreSQL connected');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL pool error:', err.message);
});

/**
 * Helper: query với tham số
 * @param {string} text  - SQL query
 * @param {Array}  params - Tham số
 */
const query = (text, params) => pool.query(text, params);

/**
 * Helper: lấy một client từ pool (dùng cho transactions)
 */
const getClient = () => pool.connect();

module.exports = { query, getClient, pool };
