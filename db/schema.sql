-- ============================================================
-- MOD ZONE DATABASE SCHEMA
-- Chạy file này để khởi tạo toàn bộ cơ sở dữ liệu
-- ============================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- ENUM TYPES
-- ============================================================
CREATE TYPE user_role AS ENUM ('user', 'admin');
CREATE TYPE deposit_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE order_status AS ENUM ('completed', 'refunded', 'failed');
CREATE TYPE key_status AS ENUM ('available', 'sold', 'reserved');
CREATE TYPE commission_status AS ENUM ('pending', 'approved', 'rejected', 'paid');
CREATE TYPE withdrawal_status AS ENUM ('pending', 'approved', 'rejected');

-- ============================================================
-- GAMES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS games (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    slug        VARCHAR(100) UNIQUE NOT NULL,
    icon_url    TEXT,
    is_active   BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- TIERS TABLE (gói thời gian / loại key)
-- ============================================================
CREATE TABLE IF NOT EXISTS tiers (
    id          SERIAL PRIMARY KEY,
    game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,   -- VD: "30 ngày", "90 ngày"
    dur_days    INTEGER NOT NULL,        -- Số ngày
    price       NUMERIC(15,2) NOT NULL,  -- Giá gốc
    is_active   BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- USERS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    username        VARCHAR(50) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    role            user_role DEFAULT 'user',
    balance         NUMERIC(15,2) DEFAULT 0.00,
    is_locked       BOOLEAN DEFAULT FALSE,
    ref_code        VARCHAR(20) UNIQUE,         -- Mã giới thiệu của user này
    referred_by_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- GAME KEYS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS game_keys (
    id          SERIAL PRIMARY KEY,
    code        TEXT UNIQUE NOT NULL,
    game_id     INTEGER NOT NULL REFERENCES games(id),
    tier_id     INTEGER NOT NULL REFERENCES tiers(id),
    price       NUMERIC(15,2) NOT NULL,
    status      key_status DEFAULT 'available',
    sold_to_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sold_at     TIMESTAMP WITH TIME ZONE,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- COUPONS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS coupons (
    id              SERIAL PRIMARY KEY,
    code            VARCHAR(50) UNIQUE NOT NULL,
    discount_pct    INTEGER DEFAULT 0,        -- % giảm (0-100)
    discount_flat   NUMERIC(15,2) DEFAULT 0,  -- Giảm cố định (VND)
    max_uses        INTEGER DEFAULT 1,
    used_count      INTEGER DEFAULT 0,
    expires_at      TIMESTAMP WITH TIME ZONE,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- ORDERS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
    id              SERIAL PRIMARY KEY,
    order_ref       VARCHAR(30) UNIQUE NOT NULL,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    key_id          INTEGER NOT NULL REFERENCES game_keys(id),
    tier_id         INTEGER NOT NULL REFERENCES tiers(id),
    game_id         INTEGER NOT NULL REFERENCES games(id),
    amount_paid     NUMERIC(15,2) NOT NULL,
    coupon_id       INTEGER REFERENCES coupons(id),
    status          order_status DEFAULT 'completed',
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- DEPOSITS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS deposits (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    amount          NUMERIC(15,2) NOT NULL,
    method          VARCHAR(50) NOT NULL,    -- momo, banking, etc.
    note            TEXT,
    status          deposit_status DEFAULT 'pending',
    reviewed_by_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- AFFILIATE COMMISSIONS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS affiliate_commissions (
    id              SERIAL PRIMARY KEY,
    referrer_id     INTEGER NOT NULL REFERENCES users(id),  -- Người giới thiệu
    referee_id      INTEGER NOT NULL REFERENCES users(id),  -- Người được giới thiệu
    order_id        INTEGER NOT NULL REFERENCES orders(id),
    amount          NUMERIC(15,2) NOT NULL,                 -- Số tiền hoa hồng
    rate_pct        NUMERIC(5,2) NOT NULL DEFAULT 5.00,    -- % hoa hồng
    status          commission_status DEFAULT 'pending',
    reviewed_by_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- AFFILIATE WITHDRAWALS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS affiliate_withdrawals (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    amount          NUMERIC(15,2) NOT NULL,
    bank_info       TEXT,                   -- Thông tin tài khoản ngân hàng
    status          withdrawal_status DEFAULT 'pending',
    reviewed_by_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- SPIN WHEEL TABLE (Vòng quay may mắn)
-- ============================================================
CREATE TABLE IF NOT EXISTS spin_prizes (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    prize_type  VARCHAR(30) NOT NULL,   -- 'balance', 'key', 'coupon', 'nothing'
    prize_value NUMERIC(15,2) DEFAULT 0,
    coupon_id   INTEGER REFERENCES coupons(id),
    probability NUMERIC(5,4) NOT NULL,  -- Xác suất (tổng = 1)
    is_active   BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS spin_history (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    prize_id    INTEGER NOT NULL REFERENCES spin_prizes(id),
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_game_keys_status ON game_keys(status);
CREATE INDEX IF NOT EXISTS idx_game_keys_tier ON game_keys(tier_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_commissions_referrer ON affiliate_commissions(referrer_id);
CREATE INDEX IF NOT EXISTS idx_users_ref_code ON users(ref_code);

-- ============================================================
-- SEED DATA
-- ============================================================

-- Games
INSERT INTO games (name, slug) VALUES
    ('Play Together',  'play-together'),
    ('Free Fire',      'free-fire'),
    ('PUBG Mobile',    'pubg-mobile'),
    ('Liên Quân Mobile', 'lien-quan')
ON CONFLICT (slug) DO NOTHING;

-- Tiers (gói cho từng game)
INSERT INTO tiers (game_id, name, dur_days, price) VALUES
    (1, '30 Ngày',  30,  29000),
    (1, '90 Ngày',  90,  79000),
    (1, '180 Ngày', 180, 149000),
    (2, '30 Ngày',  30,  39000),
    (2, '90 Ngày',  90,  99000),
    (3, '30 Ngày',  30,  49000),
    (3, '90 Ngày',  90,  129000),
    (4, '30 Ngày',  30,  35000),
    (4, '90 Ngày',  90,  89000)
ON CONFLICT DO NOTHING;

-- Sample coupon
INSERT INTO coupons (code, discount_pct, max_uses) VALUES
    ('WELCOME10', 10, 100)
ON CONFLICT (code) DO NOTHING;

-- Spin prizes
INSERT INTO spin_prizes (name, prize_type, prize_value, probability) VALUES
    ('Chúc may mắn lần sau', 'nothing',  0,     0.4000),
    ('Cộng 5.000đ',          'balance',  5000,  0.2500),
    ('Cộng 10.000đ',         'balance',  10000, 0.1500),
    ('Cộng 20.000đ',         'balance',  20000, 0.0800),
    ('Cộng 50.000đ',         'balance',  50000, 0.0500),
    ('Giảm 5%',              'coupon',   5,     0.0400),
    ('Giảm 10%',             'coupon',   10,    0.0200),
    ('Cộng 100.000đ',        'balance',  100000,0.0100)
ON CONFLICT DO NOTHING;
