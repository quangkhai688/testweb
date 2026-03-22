const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username        VARCHAR(50) UNIQUE NOT NULL,
        email           VARCHAR(255) UNIQUE NOT NULL,
        password_hash   VARCHAR(255) NOT NULL,
        role            VARCHAR(20) DEFAULT 'user',
        balance         DECIMAL(10,2) DEFAULT 0,
        ref_code        VARCHAR(10) UNIQUE,
        referred_by_id  UUID REFERENCES users(id) ON DELETE SET NULL,
        is_locked       BOOLEAN DEFAULT false,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Tạo bảng users thành công!');

    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await pool.query(`
      INSERT INTO users (username, email, password_hash, role, ref_code)
      VALUES ($1, $2, $3, 'admin', 'ADMIN1')
      ON CONFLICT (username) DO NOTHING;
    `, [
      process.env.ADMIN_USERNAME,
      process.env.ADMIN_EMAIL,
      passwordHash
    ]);
    console.log('✅ Tạo tài khoản admin thành công!');

  } catch (err) {
    console.error('❌ Migration thất bại:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();