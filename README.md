# 🎮 Mod Zone Backend API

Backend API cho web bán game key **Mod Zone** — Node.js + Express + PostgreSQL.

---

## 📋 Yêu cầu hệ thống

| Phần mềm | Phiên bản tối thiểu | Ghi chú |
|----------|---------------------|---------|
| Node.js  | 18.x trở lên        | [Tải tại nodejs.org](https://nodejs.org) |
| npm      | 8.x trở lên         | Đi kèm với Node.js |
| PostgreSQL | 14.x trở lên     | [Tải tại postgresql.org](https://www.postgresql.org) |

---

## 🚀 Hướng dẫn cài đặt từng bước

### Bước 1: Tải mã nguồn về máy

```bash
# Nếu dùng git
git clone <your-repo-url>
cd modzone-backend

# Hoặc giải nén file ZIP vào thư mục modzone-backend
```

### Bước 2: Cài đặt Node.js packages

```bash
npm install
```

Lệnh này sẽ cài: `express`, `pg`, `jsonwebtoken`, `bcryptjs`, `cors`, `dotenv`, `uuid`.

---

### Bước 3: Cài đặt và cấu hình PostgreSQL

#### 3a. Tạo database

Mở **pgAdmin** hoặc **psql** và chạy:

```sql
-- Tạo database mới
CREATE DATABASE modzone;

-- Kiểm tra
\l
```

#### 3b. Chạy file schema để tạo bảng

```bash
# Dùng psql (thay 'postgres' bằng username của bạn)
psql -U postgres -d modzone -f db/schema.sql
```

Hoặc mở file `db/schema.sql` và chạy toàn bộ trong pgAdmin.

✅ Kết quả: tạo đủ 10 bảng + dữ liệu mẫu (4 game, các tier, coupon, spin prizes).

---

### Bước 4: Tạo file cấu hình `.env`

```bash
# Copy file mẫu
cp .env.example .env
```

Sau đó mở file `.env` và điền thông tin của bạn:

```env
# Cổng chạy server (mặc định 3000)
PORT=3000
NODE_ENV=development

# Thông tin kết nối PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=modzone
DB_USER=postgres
DB_PASSWORD=mật_khẩu_postgres_của_bạn

# JWT Secret — ĐỔI chuỗi này thành chuỗi ngẫu nhiên bất kỳ
JWT_SECRET=modzone_super_secret_2024_thay_chuoi_nay

# CORS — Thêm domain frontend Netlify của bạn
CORS_ORIGINS=https://ten-site-cua-ban.netlify.app

# Tài khoản admin mặc định (tạo lần đầu khởi động)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=Admin@123456
ADMIN_EMAIL=admin@modzone.vn
```

> ⚠️ **Quan trọng:** Đổi `JWT_SECRET` và `ADMIN_PASSWORD` ngay, không dùng giá trị mặc định trên production!

---

### Bước 5: Khởi động server

```bash
# Chạy bình thường
npm start

# Hoặc chạy với auto-reload khi code thay đổi (dev)
npm run dev
```

Kết quả thành công sẽ thấy:
```
✅ Database connection OK
✅ Admin account created: admin / Admin@123456
🚀 Mod Zone API running on port 3000
   http://localhost:3000
   Health: http://localhost:3000/api/v1/auth/health
```

### Bước 6: Kiểm tra server

Mở trình duyệt hoặc Postman và truy cập:
```
GET http://localhost:3000/api/v1/auth/health
```

Response mong đợi:
```json
{
  "success": true,
  "message": "Mod Zone API is running 🚀",
  "db": "connected"
}
```

---

## 📡 API Endpoints đầy đủ

### Base URL
- **Local:** `http://localhost:3000`
- **Production:** `https://your-api.railway.app` (hoặc tương tự)

### Authentication
Tất cả request cần JWT phải có header:
```
Authorization: Bearer <token>
```

---

### 🔐 Auth

| Method | Endpoint | Auth? | Mô tả |
|--------|----------|-------|-------|
| GET  | `/api/v1/auth/health` | ❌ | Kiểm tra server |
| POST | `/api/v1/auth/register` | ❌ | Đăng ký tài khoản |
| POST | `/api/v1/auth/login` | ❌ | Đăng nhập |

**POST /api/v1/auth/register**
```json
// Request body
{
  "username": "nguyenvan",
  "email": "nguyenvan@gmail.com",
  "password": "123456",
  "ref": "ABC123"  // Mã giới thiệu (tuỳ chọn)
}

// Response
{
  "success": true,
  "token": "eyJ...",
  "user": { "id": 1, "username": "nguyenvan", "role": "user", "balance": 0 }
}
```

**POST /api/v1/auth/login**
```json
// Request body
{ "username": "nguyenvan", "password": "123456" }

// Response
{
  "success": true,
  "token": "eyJ...",
  "user": { "id": 1, "username": "nguyenvan", "role": "user", "balance": 50000 }
}
```

---

### 👤 User (cần JWT)

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET  | `/api/v1/user/profile` | Thông tin tài khoản + lịch sử |
| POST | `/api/v1/user/change-password` | Đổi mật khẩu |

---

### 🛒 Orders (cần JWT)

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| POST | `/api/v1/orders/buy` | Mua key |
| GET  | `/api/v1/orders` | Lịch sử đơn hàng |

**POST /api/v1/orders/buy**
```json
// Request body
{ "tier_id": 1, "coupon_code": "WELCOME10" }

// Response thành công
{
  "success": true,
  "key_code": "XXXX-YYYY-ZZZZ-WWWW",
  "order_ref": "MZ-ABC123-XY12",
  "balance_after": 45000,
  "game": "Play Together",
  "tier": "30 Ngày",
  "dur_days": 30
}
```

---

### 💰 Wallet (cần JWT)

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET  | `/api/v1/wallet/deposits` | Lịch sử nạp tiền |
| POST | `/api/v1/wallet/deposit` | Tạo yêu cầu nạp tiền |

**POST /api/v1/wallet/deposit**
```json
// Request body
{
  "amount": 100000,
  "method": "momo",
  "note": "Chuyển khoản 13h30 ngày 01/01"
}
// method: momo | banking | zalopay | viettel_money | other
```

---

### 🔧 Admin (cần JWT + role admin)

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET    | `/api/v1/admin/stats` | Thống kê tổng quan |
| GET    | `/api/v1/admin/users` | Danh sách users |
| PATCH  | `/api/v1/admin/users/:id` | Cập nhật user |
| GET    | `/api/v1/admin/orders` | Danh sách đơn hàng |
| GET    | `/api/v1/admin/deposits` | Danh sách yêu cầu nạp |
| POST   | `/api/v1/admin/deposits/:id/approve` | Duyệt nạp tiền |
| POST   | `/api/v1/admin/deposits/:id/reject` | Từ chối nạp tiền |
| POST   | `/api/v1/admin/keys/bulk` | Import key hàng loạt |
| GET    | `/api/v1/admin/affiliate/list` | Danh sách affiliate |
| GET    | `/api/v1/admin/affiliate/commissions` | Hoa hồng |
| POST   | `/api/v1/admin/affiliate/commissions/:id/approve` | Duyệt hoa hồng |
| POST   | `/api/v1/admin/affiliate/commissions/:id/reject` | Từ chối hoa hồng |
| GET    | `/api/v1/admin/affiliate/withdrawals` | Yêu cầu rút tiền |
| POST   | `/api/v1/admin/affiliate/withdrawals/:id/approve` | Duyệt rút tiền |
| POST   | `/api/v1/admin/affiliate/withdrawals/:id/reject` | Từ chối rút tiền |

**PATCH /api/v1/admin/users/:id** — Khoá/mở khoá, đổi role, set balance:
```json
{ "is_locked": true }
{ "role": "admin" }
{ "balance": 500000 }
```

**POST /api/v1/admin/keys/bulk** — Import nhiều key cùng lúc:
```json
{
  "game_id": 1,
  "tier_id": 1,
  "price": 29000,
  "codes": [
    "KEY1-AAAA-BBBB-CCCC",
    "KEY2-DDDD-EEEE-FFFF",
    "KEY3-GGGG-HHHH-IIII"
  ]
}
```

---

## 🌐 Deploy lên production

### Option A: Railway (khuyên dùng, miễn phí)

1. Tạo tài khoản tại [railway.app](https://railway.app)
2. Tạo project mới → **Deploy from GitHub**
3. Thêm service **PostgreSQL** trong cùng project
4. Vào tab **Variables** và thêm tất cả biến từ `.env.example`
5. Lấy `DATABASE_URL` từ PostgreSQL service, điền vào các biến DB_*
6. Railway tự động deploy khi push code lên GitHub

### Option B: Render

1. Tạo tài khoản tại [render.com](https://render.com)
2. New → **Web Service** → kết nối GitHub repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Thêm biến môi trường trong tab **Environment**
6. Tạo thêm **PostgreSQL** service, lấy connection string

### Sau khi deploy:

1. Chạy schema SQL trên PostgreSQL production
2. Cập nhật `CORS_ORIGINS` với domain Netlify thực tế
3. Cập nhật URL API trong frontend HTML

---

## 🗂️ Cấu trúc project

```
modzone-backend/
├── package.json          # Dependencies
├── .env.example          # Mẫu cấu hình
├── .env                  # Cấu hình thực (KHÔNG commit lên git)
├── server.js             # Entry point, khởi động server
├── db/
│   ├── schema.sql        # SQL tạo toàn bộ bảng + seed data
│   └── index.js          # Kết nối PostgreSQL pool
├── middleware/
│   └── auth.js           # JWT verify + role check
├── routes/
│   ├── auth.js           # Đăng ký, đăng nhập
│   ├── user.js           # Profile, đổi mật khẩu
│   ├── orders.js         # Mua key
│   ├── wallet.js         # Nạp tiền
│   └── admin.js          # Quản trị toàn bộ
└── README.md
```

---

## 🔒 Bảo mật

- Mật khẩu được hash bằng **bcrypt** (salt rounds = 12)
- JWT token hết hạn sau **7 ngày**
- Transaction PostgreSQL đảm bảo không bị mất dữ liệu khi mua key
- `FOR UPDATE SKIP LOCKED` ngăn race condition khi nhiều người mua cùng lúc
- Admin không thể tự khoá tài khoản của mình

---

## ❓ Xử lý lỗi thường gặp

### Lỗi "Cannot connect to database"
- Kiểm tra PostgreSQL đang chạy: `pg_ctl status` hoặc xem Services (Windows)
- Kiểm tra `DB_PASSWORD` trong `.env` đúng chưa
- Kiểm tra `DB_NAME` đã tạo chưa

### Lỗi "relation does not exist"
- Chưa chạy `db/schema.sql`. Chạy lại:
  ```bash
  psql -U postgres -d modzone -f db/schema.sql
  ```

### Lỗi CORS khi frontend gọi API
- Thêm domain của bạn vào `CORS_ORIGINS` trong `.env`
- Restart server sau khi sửa `.env`

### Lỗi "JWT_SECRET is not defined"
- File `.env` chưa được tạo. Chạy `cp .env.example .env` và điền thông tin

---

## 📞 Support

Liên hệ admin Mod Zone để được hỗ trợ kỹ thuật.
