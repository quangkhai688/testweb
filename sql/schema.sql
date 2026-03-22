-- ============================================================
-- MOD ZONE — Production MySQL Schema
-- Engine: InnoDB (transactions + row-level locking)
-- Charset: utf8mb4 (full Unicode, emoji support)
-- ============================================================

CREATE DATABASE IF NOT EXISTS modzone
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE modzone;

-- ============================================================
-- 1. USERS
-- ============================================================
CREATE TABLE users (
  id            INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  username      VARCHAR(32)     NOT NULL,
  email         VARCHAR(191)    NOT NULL,
  password_hash VARCHAR(60)     NOT NULL,           -- bcrypt
  role          ENUM('user','sub-admin','admin') NOT NULL DEFAULT 'user',
  balance       BIGINT          NOT NULL DEFAULT 0, -- stored in VND (integer, no float)
  aff_rev       BIGINT          NOT NULL DEFAULT 0, -- total approved commission earned
  aff_pending   BIGINT          NOT NULL DEFAULT 0, -- commission awaiting approval
  ref_by        VARCHAR(32)     NULL,               -- referrer username
  fingerprint   VARCHAR(64)     NULL,               -- device fingerprint
  fraud_flag    TINYINT(1)      NOT NULL DEFAULT 0,
  fraud_reasons JSON            NULL,
  aff_blacklist TINYINT(1)      NOT NULL DEFAULT 0,
  locked        TINYINT(1)      NOT NULL DEFAULT 0,
  first_dep     TINYINT(1)      NOT NULL DEFAULT 1,  -- first deposit bonus eligibility
  last_login_at DATETIME        NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_username  (username),
  UNIQUE KEY uq_email     (email),
  INDEX idx_ref_by        (ref_by),
  INDEX idx_role          (role),
  INDEX idx_fraud         (fraud_flag),
  INDEX idx_fingerprint   (fingerprint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 2. GAMES + TIERS (product catalog)
-- ============================================================
CREATE TABLE games (
  id          VARCHAR(32)   NOT NULL,
  name        VARCHAR(100)  NOT NULL,
  slug        VARCHAR(100)  NOT NULL,
  emoji       VARCHAR(8)    NOT NULL DEFAULT '🎮',
  apk_url     VARCHAR(500)  NULL,
  bypass_url  VARCHAR(500)  NULL,
  is_active   TINYINT(1)    NOT NULL DEFAULT 1,
  sort_order  INT           NOT NULL DEFAULT 0,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE game_tiers (
  id          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  game_id     VARCHAR(32)   NOT NULL,
  label       VARCHAR(50)   NOT NULL,   -- "1 ngày", "7 ngày"
  dur_days    INT           NOT NULL,   -- duration in days
  price       BIGINT        NOT NULL,   -- VND
  is_active   TINYINT(1)    NOT NULL DEFAULT 1,
  sort_order  INT           NOT NULL DEFAULT 0,
  created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_game_id  (game_id),
  INDEX idx_active   (is_active),
  CONSTRAINT fk_tier_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 3. KEYS (core inventory — most critical table)
-- ============================================================
CREATE TABLE `keys` (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code          VARCHAR(64)     NOT NULL,             -- the actual key code
  game_id       VARCHAR(32)     NOT NULL,
  tier_id       INT UNSIGNED    NOT NULL,
  price         BIGINT          NOT NULL,             -- price at time of creation
  status        ENUM('available','sold','refunded')
                NOT NULL DEFAULT 'available',
  assigned_to   INT UNSIGNED    NULL,                 -- user.id after purchase
  order_id      BIGINT UNSIGNED NULL,
  added_by      INT UNSIGNED    NOT NULL,             -- admin user.id
  activated_at  DATETIME        NULL,                 -- when user activates in game
  expires_at    DATETIME        NULL,                 -- computed on activation
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The UNIQUE constraint is the primary race-condition guard
  UNIQUE KEY uq_code (code),
  -- Covering index for the FOR UPDATE SELECT (status + tier_id)
  INDEX idx_available    (status, tier_id, id),
  INDEX idx_assigned_to  (assigned_to),
  INDEX idx_game_id      (game_id),
  CONSTRAINT fk_key_tier  FOREIGN KEY (tier_id)     REFERENCES game_tiers(id),
  CONSTRAINT fk_key_buyer FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 4. ORDERS
-- ============================================================
CREATE TABLE orders (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_ref   VARCHAR(32)     NOT NULL,              -- MZ-xxxxxxxx (human-readable)
  user_id     INT UNSIGNED    NOT NULL,
  key_id      BIGINT UNSIGNED NOT NULL,
  game_id     VARCHAR(32)     NOT NULL,
  tier_id     INT UNSIGNED    NOT NULL,
  tier_label  VARCHAR(50)     NOT NULL,
  dur_days    INT             NOT NULL,
  price_paid  BIGINT          NOT NULL,              -- after coupon/flash sale
  original_price BIGINT       NOT NULL,
  coupon_code VARCHAR(32)     NULL,
  discount    BIGINT          NOT NULL DEFAULT 0,
  key_status  ENUM('inactive','active','expired')
              NOT NULL DEFAULT 'inactive',
  status      ENUM('success','refunded','cancelled')
              NOT NULL DEFAULT 'success',
  refunded_at DATETIME        NULL,
  note        VARCHAR(255)    NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_order_ref (order_ref),
  INDEX idx_user_id   (user_id),
  INDEX idx_key_id    (key_id),
  INDEX idx_status    (status),
  INDEX idx_created   (created_at),
  CONSTRAINT fk_order_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_order_key  FOREIGN KEY (key_id)  REFERENCES `keys`(id),
  CONSTRAINT fk_order_tier FOREIGN KEY (tier_id) REFERENCES game_tiers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 5. TRANSACTIONS (wallet ledger — append-only)
-- ============================================================
CREATE TABLE transactions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        INT UNSIGNED    NOT NULL,
  type           ENUM('deposit','purchase','refund','commission','commission_pending','withdrawal') NOT NULL,
  amount         BIGINT          NOT NULL,             -- positive value always
  direction      ENUM('credit','debit') NOT NULL,
  balance_before BIGINT          NOT NULL,
  balance_after  BIGINT          NOT NULL,
  ref_id         VARCHAR(64)     NULL,                 -- order_ref / deposit_ref etc.
  description    VARCHAR(255)    NULL,
  status         ENUM('ok','pending','failed') NOT NULL DEFAULT 'ok',
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_user_id  (user_id),
  INDEX idx_type     (type),
  INDEX idx_ref_id   (ref_id),
  INDEX idx_created  (created_at),
  CONSTRAINT fk_tx_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 6. DEPOSITS
-- ============================================================
CREATE TABLE deposits (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  deposit_ref VARCHAR(32)     NOT NULL,
  user_id     INT UNSIGNED    NOT NULL,
  amount      BIGINT          NOT NULL,
  method      ENUM('card','bank_transfer','momo','zalopay') NOT NULL,
  provider    VARCHAR(50)     NULL,
  raw_payload JSON            NULL,              -- provider webhook payload
  status      ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  approved_by INT UNSIGNED    NULL,
  approved_at DATETIME        NULL,
  note        VARCHAR(255)    NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_deposit_ref (deposit_ref),
  INDEX idx_user_id   (user_id),
  INDEX idx_status    (status),
  CONSTRAINT fk_dep_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 7. AFFILIATE COMMISSIONS
-- ============================================================
CREATE TABLE aff_commissions (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  comm_ref         VARCHAR(32)     NOT NULL,
  affiliate_user_id INT UNSIGNED   NOT NULL,   -- who earns
  buyer_user_id    INT UNSIGNED    NOT NULL,   -- who bought
  order_id         BIGINT UNSIGNED NOT NULL,
  amount           BIGINT          NOT NULL,
  rate             TINYINT         NOT NULL,   -- percentage e.g. 5, 10, 15
  first_dep_bonus  BIGINT          NOT NULL DEFAULT 0,
  status           ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  auto_approve_at  DATETIME        NULL,
  approved_at      DATETIME        NULL,
  approved_by      INT UNSIGNED    NULL,
  note             VARCHAR(255)    NULL,
  created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_comm_ref (comm_ref),
  INDEX idx_aff_user   (affiliate_user_id),
  INDEX idx_buyer_user (buyer_user_id),
  INDEX idx_status     (status),
  INDEX idx_auto_ap    (auto_approve_at, status),
  CONSTRAINT fk_comm_aff   FOREIGN KEY (affiliate_user_id) REFERENCES users(id),
  CONSTRAINT fk_comm_buyer FOREIGN KEY (buyer_user_id)     REFERENCES users(id),
  CONSTRAINT fk_comm_order FOREIGN KEY (order_id)          REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 8. WITHDRAWALS
-- ============================================================
CREATE TABLE withdrawals (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  wd_ref       VARCHAR(32)     NOT NULL,
  user_id      INT UNSIGNED    NOT NULL,
  amount       BIGINT          NOT NULL,
  method       ENUM('bank','momo','zalopay') NOT NULL,
  bank_name    VARCHAR(100)    NULL,
  bank_account VARCHAR(30)     NULL,
  bank_owner   VARCHAR(100)    NULL,
  phone        VARCHAR(20)     NULL,
  note         VARCHAR(255)    NULL,
  status       ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  approved_by  INT UNSIGNED    NULL,
  approved_at  DATETIME        NULL,
  rejected_at  DATETIME        NULL,
  reject_reason VARCHAR(255)   NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_wd_ref (wd_ref),
  INDEX idx_user_id (user_id),
  INDEX idx_status  (status),
  CONSTRAINT fk_wd_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 9. COUPONS
-- ============================================================
CREATE TABLE coupons (
  id         INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  code       VARCHAR(32)    NOT NULL,
  type       ENUM('pct','fixed') NOT NULL DEFAULT 'pct',
  value      INT            NOT NULL,               -- % or VND amount
  max_uses   INT            NOT NULL DEFAULT 0,     -- 0 = unlimited
  used_count INT            NOT NULL DEFAULT 0,
  valid_from DATETIME       NULL,
  valid_to   DATETIME       NULL,
  is_active  TINYINT(1)     NOT NULL DEFAULT 1,
  created_at DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_code (code),
  INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 10. AFF CLICK LOG (fraud detection)
-- ============================================================
CREATE TABLE aff_clicks (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ref_user    VARCHAR(32)     NOT NULL,   -- referrer username
  visitor_fp  VARCHAR(64)     NULL,       -- fingerprint
  page        VARCHAR(255)    NULL,
  ip_hash     VARCHAR(64)     NULL,       -- hashed IP for privacy
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  INDEX idx_ref_user (ref_user),
  INDEX idx_created  (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 11. SETTINGS (key-value store)
-- ============================================================
CREATE TABLE settings (
  `key`   VARCHAR(64)   NOT NULL,
  `value` TEXT          NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- SEED DATA
-- ============================================================
INSERT INTO settings (`key`, `value`) VALUES
  ('spin_enabled',         '1'),
  ('bypass_enabled',       '1'),
  ('first_dep_bonus_pct',  '10'),
  ('aff_auto_approve_hrs', '24'),
  ('tg_bot_token',         ''),
  ('tg_chat_id',           ''),
  ('tg_daily_report',      '0'),
  ('tg_full_report',       '1');

INSERT INTO games (id, name, slug, emoji, sort_order) VALUES
  ('play-together', 'Play Together',    'play-together', '🎮', 1),
  ('free-fire',     'Free Fire',        'free-fire',     '💎', 2),
  ('pubg',          'PUBG Mobile',      'pubg-mobile',   '🔫', 3),
  ('lien-quan',     'Liên Quân Mobile', 'lien-quan',     '⚔️', 4);

INSERT INTO game_tiers (game_id, label, dur_days, price, sort_order) VALUES
  ('play-together', '1 ngày',  1,   10000,  1),
  ('play-together', '7 ngày',  7,   50000,  2),
  ('play-together', '14 ngày', 14,  80000,  3),
  ('play-together', '21 ngày', 21, 120000,  4),
  ('play-together', '30 ngày', 30, 150000,  5),
  ('free-fire',     '1 ngày',  1,    8000,  1),
  ('free-fire',     '7 ngày',  7,   40000,  2),
  ('free-fire',     '14 ngày', 14,  70000,  3),
  ('free-fire',     '30 ngày', 30, 120000,  4),
  ('pubg',          '1 ngày',  1,   12000,  1),
  ('pubg',          '7 ngày',  7,   60000,  2),
  ('pubg',          '14 ngày', 14, 100000,  3),
  ('pubg',          '30 ngày', 30, 180000,  4),
  ('lien-quan',     '1 ngày',  1,   10000,  1),
  ('lien-quan',     '7 ngày',  7,   50000,  2),
  ('lien-quan',     '14 ngày', 14,  85000,  3),
  ('lien-quan',     '30 ngày', 30, 150000,  4);

INSERT INTO coupons (code, type, value, max_uses) VALUES
  ('WELCOME10', 'pct', 10, 100),
  ('VIP20',     'pct', 20,  50),
  ('FLASH30',   'pct', 30,   0);
