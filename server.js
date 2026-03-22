require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const db      = require('./src/config/db');

// ─── Routes ───────────────────────────────────────────────────────────────────
const authRoutes   = require('./routes/auth');
const userRoutes   = require('./routes/user');
const orderRoutes  = require('./routes/orders');
const walletRoutes = require('./routes/wallet');
const adminRoutes  = require('./routes/admin');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

allowedOrigins.push('http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500');

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin.endsWith('.netlify.app') || origin.endsWith('.netlify.com')) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    console.warn(`🚫 CORS blocked: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/v1/auth',   authRoutes);
app.use('/api/v1/user',   userRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/wallet', walletRoutes);
app.use('/api/v1/admin',  adminRoutes);

app.get('/', (_req, res) => {
  res.json({ name: 'Mod Zone API', version: '1.0.0', status: 'running' });
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Endpoint không tồn tại' });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ success: false, message: 'CORS: origin không được phép' });
  }
  res.status(500).json({ success: false, message: 'Lỗi server nội bộ' });
});

// ─── Tạo bảng nếu chưa có ────────────────────────────────────────────────────
const runMigrations = async () => {
  await db.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

  await db.query(`
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

    CREATE TABLE IF NOT EXISTS games (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name        VARCHAR(100) NOT NULL,
      slug        VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      image_url   VARCHAR(500),
      is_active   BOOLEAN DEFAULT true,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tiers (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      game_id     UUID REFERENCES games(id) ON DELETE CASCADE,
      name        VARCHAR(100) NOT NULL,
      price       DECIMAL(10,2) NOT NULL,
      dur_days    INT NOT NULL,
      is_active   BOOLEAN DEFAULT true,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS game_keys (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tier_id     UUID REFERENCES tiers(id) ON DELETE CASCADE,
      code        VARCHAR(255) NOT NULL,
      status      VARCHAR(20) DEFAULT 'available',
      sold_to_id  UUID REFERENCES users(id) ON DELETE SET NULL,
      sold_at     TIMESTAMP,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code          VARCHAR(50) UNIQUE NOT NULL,
      discount_pct  DECIMAL(5,2) DEFAULT 0,
      discount_flat DECIMAL(10,2) DEFAULT 0,
      max_uses      INT DEFAULT 1,
      used_count    INT DEFAULT 0,
      is_active     BOOLEAN DEFAULT true,
      expires_at    TIMESTAMP,
      created_at    TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_ref   VARCHAR(50) UNIQUE NOT NULL,
      user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      key_id      UUID REFERENCES game_keys(id) ON DELETE SET NULL,
      tier_id     UUID REFERENCES tiers(id) ON DELETE SET NULL,
      game_id     UUID REFERENCES games(id) ON DELETE SET NULL,
      amount_paid DECIMAL(10,2) NOT NULL,
      coupon_id   UUID REFERENCES coupons(id) ON DELETE SET NULL,
      status      VARCHAR(20) DEFAULT 'completed',
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS affiliate_commissions (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      referrer_id  UUID REFERENCES users(id) ON DELETE CASCADE,
      referee_id   UUID REFERENCES users(id) ON DELETE CASCADE,
      order_id     UUID REFERENCES orders(id) ON DELETE CASCADE,
      amount       DECIMAL(10,2) NOT NULL,
      rate_pct     DECIMAL(5,2) NOT NULL,
      created_at   TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
      type          VARCHAR(20) NOT NULL,
      amount        DECIMAL(10,2) NOT NULL,
      balance_after DECIMAL(10,2) NOT NULL,
      note          TEXT,
      created_at    TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log('✅ Tables ready');
};

// ─── Tạo admin mặc định ───────────────────────────────────────────────────────
const createDefaultAdmin = async () => {
  try {
    const adminUser  = process.env.ADMIN_USERNAME || 'admin';
    const adminEmail = process.env.ADMIN_EMAIL    || 'admin@modzone.vn';
    const adminPass  = process.env.ADMIN_PASSWORD || 'Admin@123456';

    const existing = await db.query(
      'SELECT id FROM users WHERE username = $1',
      [adminUser]
    );

    if (existing.rows.length === 0) {
      const hash    = await bcrypt.hash(adminPass, 12);
      const refCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      await db.query(
        `INSERT INTO users (username, email, password_hash, role, ref_code)
         VALUES ($1, $2, $3, 'admin', $4)`,
        [adminUser, adminEmail, hash, refCode]
      );
      console.log(`✅ Admin account created: ${adminUser}`);
    } else {
      console.log(`✅ Admin account exists: ${adminUser}`);
    }
  } catch (err) {
    console.error('❌ Error creating admin:', err.message);
  }
};

// ─── Khởi động server ─────────────────────────────────────────────────────────
const startServer = async () => {
  try {
    await db.query('SELECT NOW()');
    console.log('✅ Database connection OK');
  } catch (err) {
    console.error('❌ Cannot connect to database:', err.message);
    process.exit(1);
  }

  try {
    await runMigrations();
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }

  await createDefaultAdmin();

  app.listen(PORT, () => {
    console.log(`\n🚀 Mod Zone API running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/v1/auth/health\n`);
  });
};

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await db.pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await db.pool.end();
  process.exit(0);
});

startServer();
