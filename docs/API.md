# Mod Zone Backend API — Documentation
## Base URL: `https://api.modzone.vn/api/v1`

---

## Authentication

All protected routes require:
```
Authorization: Bearer <jwt_token>
```

---

## AUTH

### POST /auth/register
```json
// Request
{
  "username": "gamer123",
  "email": "gamer@example.com",
  "password": "Secure123",
  "ref": "affiliate_user",          // optional referral
  "fingerprint": "abc123def456"     // optional device fingerprint
}

// Response 201
{
  "ok": true,
  "message": "Đăng ký thành công!",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiJ9...",
    "username": "gamer123"
  }
}
```

### POST /auth/login
```json
// Request
{ "username": "gamer123", "password": "Secure123" }

// Response 200
{
  "ok": true,
  "data": {
    "token": "eyJ...",
    "user": { "id": 42, "username": "gamer123", "role": "user", "balance": 150000 }
  }
}
```

---

## GAMES (Public)

### GET /games
```json
// Response 200
{
  "ok": true,
  "data": [
    {
      "id": "play-together",
      "name": "Play Together",
      "emoji": "🎮",
      "tiers": [
        { "id": 1, "label": "1 ngày",  "dur_days": 1,  "price": 10000 },
        { "id": 2, "label": "7 ngày",  "dur_days": 7,  "price": 50000 },
        { "id": 3, "label": "14 ngày", "dur_days": 14, "price": 80000 }
      ]
    }
  ]
}
```

---

## ORDERS

### POST /orders/buy  ⚡ CRITICAL
```json
// Request
{
  "tier_id": 2,
  "coupon_code": "WELCOME10"   // optional
}

// Response 200 — SUCCESS
{
  "ok": true,
  "message": "Mua key thành công!",
  "data": {
    "order_ref":     "MZ-A3B4C5D6EF",
    "key_code":      "MOD-ABCD-EFGH-1234",
    "game":          "Play Together",
    "tier":          "7 ngày",
    "dur_days":      7,
    "price_paid":    45000,
    "balance_after": 55000,
    "key_status":    "inactive",
    "message":       "Key chưa được kích hoạt — hiệu lực tính từ lúc nhập vào game."
  }
}

// Response 409 — OUT OF STOCK
{
  "ok": false,
  "message": "Hết key. Vui lòng thử lại sau.",
  "code": "OUT_OF_STOCK"
}

// Response 402 — INSUFFICIENT BALANCE
{
  "ok": false,
  "message": "Số dư không đủ. Cần 50000đ, hiện có 20000đ.",
  "code": "INSUFFICIENT_BALANCE"
}
```

### POST /orders/:id/activate
```json
// Response 200
{
  "ok": true,
  "data": {
    "key_code":     "MOD-ABCD-EFGH-1234",
    "activated_at": "2024-03-15T10:30:00.000Z",
    "expires_at":   "2024-03-22T10:30:00.000Z",
    "dur_days":     7
  }
}
```

### GET /orders/my?page=1&limit=20
```json
// Response 200
{
  "ok": true,
  "data": {
    "orders": [
      {
        "order_ref":  "MZ-A3B4C5D6EF",
        "game_name":  "Play Together",
        "tier_label": "7 ngày",
        "key_code":   "MOD-ABCD-EFGH-1234",
        "price_paid": 45000,
        "key_status": "active",
        "expires_at": "2024-03-22T10:30:00.000Z"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 5 }
  }
}
```

---

## WALLET

### POST /wallet/deposit
```json
// Request
{ "amount": 100000, "method": "bank_transfer", "note": "CK qua MB Bank" }

// Response 201
{
  "ok": true,
  "data": { "deposit_ref": "DEP-X9Y8Z7W6VU", "status": "pending" }
}
```

---

## AFFILIATE

### GET /affiliate/dashboard
```json
// Response 200
{
  "ok": true,
  "data": {
    "rate":          10,
    "ref_count":     15,
    "depositors":    8,
    "clicks":        142,
    "ref_orders":    23,
    "ref_revenue":   575000,
    "aff_rev":       57500,
    "comm_pending":  12000,
    "comm_approved": 45500,
    "withdrawn":     20000,
    "withdrawable":  25500,
    "ref_link":      "https://modzone.vn/?ref=gamer123"
  }
}
```

### POST /affiliate/withdraw
```json
// Request
{
  "amount":       150000,
  "method":       "bank",
  "bank_name":    "MB Bank",
  "bank_account": "9999123456789",
  "bank_owner":   "NGUYEN VAN A"
}

// Response 201
{
  "ok": true,
  "data": { "wd_ref": "WD-P1Q2R3S4TU", "amount": 150000, "status": "pending" }
}
```

---

## ADMIN

### POST /admin/keys  — Add single key
```json
// Request (requires admin/sub-admin JWT)
{
  "code":    "MOD-XXXX-YYYY-ZZZZ",
  "game_id": "play-together",
  "tier_id": 2,
  "price":   50000
}
```

### POST /admin/keys/bulk  — Import many keys
```json
// Request
{
  "codes": ["MOD-AAA1-BBB2", "MOD-CCC3-DDD4", "MOD-EEE5-FFF6"],
  "game_id": "free-fire",
  "tier_id": 6,
  "price":   40000
}
// Response
{
  "ok": true,
  "data": { "added": 3, "duplicates": 0, "skipped": 0 }
}
```

### GET /admin/keys/stock
```json
// Response — stock summary without exposing key codes
{
  "ok": true,
  "data": [
    { "game_name": "Play Together", "tier_id": 1, "label": "1 ngày",
      "price": 10000, "available": 45, "sold": 312 }
  ]
}
```

### PATCH /admin/users/:id
```json
// Request
{ "balance_delta": 50000, "locked": false, "role": "sub-admin" }
```

---

## ERROR CODES

| Code                  | HTTP | Description                        |
|-----------------------|------|------------------------------------|
| BAD_REQUEST           | 400  | Validation error                   |
| UNAUTHORIZED          | 401  | Missing / invalid / expired token  |
| INSUFFICIENT_BALANCE  | 402  | Not enough balance                 |
| FORBIDDEN             | 403  | Role not allowed                   |
| NOT_FOUND             | 404  | Resource not found                 |
| CONFLICT              | 409  | Duplicate / already processed      |
| OUT_OF_STOCK          | 409  | No available keys                  |
| DUPLICATE             | 409  | MySQL unique constraint             |
| INTERNAL_ERROR        | 500  | Unexpected server error            |

---

## RACE CONDITION PREVENTION — How it works

```
User A ──┐
          ├─ Both start simultaneously
User B ──┘

Transaction A:                         Transaction B:
  BEGIN                                  BEGIN
  SET ISOLATION SERIALIZABLE             SET ISOLATION SERIALIZABLE
  SELECT users ... FOR UPDATE            SELECT users ... FOR UPDATE (waits for A's lock)
  ✓ balance OK                           ...
  SELECT keys WHERE status='available'
    FOR UPDATE  ← acquires row lock
    ↑ B is now BLOCKED here
  UPDATE keys SET status='sold'          ...still waiting...
  UPDATE users SET balance -= price
  INSERT orders
  INSERT transactions
  COMMIT ← releases all locks
                                         ← B unblocked
                                         SELECT keys WHERE status='available'
                                           FOR UPDATE
                                         ← 0 rows returned (key already sold)
                                         ROLLBACK
                                         → returns OUT_OF_STOCK
```

**Key mechanisms:**
1. `FOR UPDATE` — exclusive row-level lock; concurrent readers must wait
2. `SERIALIZABLE` isolation — prevents phantom reads and dirty reads
3. Re-verify `status` AFTER acquiring lock — handles split-second races
4. `UNIQUE KEY (code)` on keys table — last resort guard against duplicate codes
5. Per-user `buyLimiter` (5 req/min) — prevents flooding from single user
6. `_lock` flag on order in DB — prevents double-processing

---

## FOLDER STRUCTURE

```
modzone-backend/
├── sql/
│   └── schema.sql              ← Run this first
├── src/
│   ├── app.js                  ← Entry point
│   ├── config/
│   │   └── db.js               ← MySQL pool + withTransaction()
│   ├── middleware/
│   │   ├── auth.js             ← JWT sign/verify + requireRole()
│   │   ├── validate.js         ← express-validator rules
│   │   └── errorHandler.js     ← Global error handler
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   ├── user.controller.js
│   │   ├── order.controller.js ← ⚡ BUY LOGIC (race-safe)
│   │   ├── key.controller.js   ← Admin key CRUD
│   │   ├── wallet.controller.js
│   │   ├── affiliate.controller.js
│   │   └── admin.controller.js
│   ├── services/
│   │   ├── affiliate.service.js ← Commission scheduling + auto-approve
│   │   └── cron.service.js      ← node-cron background jobs
│   ├── routes/
│   │   └── index.js            ← All routes
│   └── utils/
│       ├── logger.js           ← Winston
│       └── response.js         ← Response helpers + AppError
├── docs/
│   └── API.md                  ← This file
├── .env.example
└── package.json
```

---

## SETUP

```bash
# 1. Clone & install
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your DB credentials and JWT secret

# 3. Create database and run schema
mysql -u root -p < sql/schema.sql

# 4. Start
npm run dev     # development (nodemon)
npm start       # production
```
