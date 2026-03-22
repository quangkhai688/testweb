require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const db      = require('./db');

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

// Thêm mặc định cho dev
allowedOrigins.push('http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500');

app.use(cors({
  origin: (origin, callback) => {
    // Cho phép request không có origin (Postman, mobile app, curl)
    if (!origin) return callback(null, true);

    // Cho phép tất cả subdomain của netlify
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

// Request logger (dev mode)
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

// Root
app.get('/', (_req, res) => {
  res.json({
    name:    'Mod Zone API',
    version: '1.0.0',
    status:  'running',
    docs:    'See README.md for API documentation',
  });
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

// ─── Khởi động server ─────────────────────────────────────────────────────────
const startServer = async () => {
  // Test DB connection
  try {
    await db.query('SELECT NOW()');
    console.log('✅ Database connection OK');
  } catch (err) {
    console.error('❌ Cannot connect to database:', err.message);
    console.error('   Kiểm tra lại DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD trong .env');
    process.exit(1);
  }

  // Tạo tài khoản admin mặc định nếu chưa có
  await createDefaultAdmin();

  app.listen(PORT, () => {
    console.log(`\n🚀 Mod Zone API running on port ${PORT}`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/v1/auth/health\n`);
  });
};

// ─── Tạo admin mặc định ───────────────────────────────────────────────────────
const createDefaultAdmin = async () => {
  try {
    const adminUser   = process.env.ADMIN_USERNAME || 'admin';
    const adminEmail  = process.env.ADMIN_EMAIL    || 'admin@modzone.vn';
    const adminPass   = process.env.ADMIN_PASSWORD || 'Admin@123456';

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
      console.log(`✅ Admin account created: ${adminUser} / ${adminPass}`);
      console.log('   ⚠️  Hãy đổi mật khẩu admin ngay sau khi đăng nhập lần đầu!');
    } else {
      console.log(`✅ Admin account exists: ${adminUser}`);
    }
  } catch (err) {
    console.error('❌ Error creating admin:', err.message);
  }
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received. Shutting down gracefully...');
  await db.pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT received. Shutting down gracefully...');
  await db.pool.end();
  process.exit(0);
});

startServer();
