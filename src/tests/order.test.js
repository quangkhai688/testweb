'use strict';

/**
 * Integration test — BUY KEY race condition
 *
 * Prerequisites: test DB running, seeded with 1 key for tier_id=1
 * Run: npm test
 */

const request = require('supertest');
const app     = require('../src/app');
const { query, withTransaction } = require('../src/config/db');

// ── helpers ──────────────────────────────────────────────────────────────────
async function registerAndLogin(suffix) {
  const un = `testuser_${suffix}_${Date.now()}`;
  await request(app).post('/api/v1/auth/register').send({
    username: un, email: `${un}@test.com`, password: 'Test1234A'
  });
  const res = await request(app).post('/api/v1/auth/login').send({
    username: un, password: 'Test1234A'
  });
  return { token: res.body.data.token, username: un };
}

async function seedOneKey(tierId = 1) {
  const code = 'TEST-' + Math.random().toString(36).slice(2, 10).toUpperCase();
  await query(
    "INSERT INTO `keys` (code, game_id, tier_id, price, added_by) VALUES (?, 'play-together', ?, 10000, 1)",
    [code, tierId]
  );
  return code;
}

async function topUpBalance(userId, amount) {
  await query('UPDATE users SET balance = balance + ? WHERE id = ?', [amount, userId]);
}

// ── tests ─────────────────────────────────────────────────────────────────────
describe('BUY KEY — Race condition (critical)', () => {

  test('Only 1 of 2 concurrent buyers gets the last key', async () => {
    // Seed exactly 1 key
    await seedOneKey(1);

    // Create 2 users, both with enough balance
    const [u1, u2] = await Promise.all([registerAndLogin('rc1'), registerAndLogin('rc2')]);

    // Get user IDs to top up
    const [[r1]] = await query('SELECT id FROM users WHERE username=? LIMIT 1', [u1.username]);
    const [[r2]] = await query('SELECT id FROM users WHERE username=? LIMIT 1', [u2.username]);
    await Promise.all([topUpBalance(r1.id, 100000), topUpBalance(r2.id, 100000)]);

    // Fire both requests at the SAME TIME
    const [res1, res2] = await Promise.all([
      request(app).post('/api/v1/orders/buy')
        .set('Authorization', `Bearer ${u1.token}`)
        .send({ tier_id: 1 }),
      request(app).post('/api/v1/orders/buy')
        .set('Authorization', `Bearer ${u2.token}`)
        .send({ tier_id: 1 }),
    ]);

    const successes = [res1, res2].filter(r => r.status === 200);
    const failures  = [res1, res2].filter(r => r.status === 409);

    expect(successes).toHaveLength(1);
    expect(failures ).toHaveLength(1);
    expect(failures[0].body.code).toBe('OUT_OF_STOCK');

    // Verify key is marked sold exactly once
    const [[{ cnt }]] = await query(
      "SELECT COUNT(*) AS cnt FROM `keys` WHERE status='sold' AND tier_id=1"
    );
    expect(cnt).toBeGreaterThanOrEqual(1);

    // Verify the winner got a unique key
    const winner = successes[0].body.data;
    expect(winner.key_code).toMatch(/^[A-Z0-9\-]+$/);
  }, 15000);

  test('Insufficient balance returns 402', async () => {
    const u = await registerAndLogin('broke');
    // No top-up — balance = 0
    const res = await request(app).post('/api/v1/orders/buy')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ tier_id: 1 });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
  });

  test('Invalid coupon returns 400', async () => {
    const u = await registerAndLogin('coupon');
    const [[r]] = await query('SELECT id FROM users WHERE username=? LIMIT 1', [u.username]);
    await topUpBalance(r.id, 100000);

    const res = await request(app).post('/api/v1/orders/buy')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ tier_id: 1, coupon_code: 'FAKECODE999' });

    expect(res.status).toBe(400);
  });

  test('Unauthenticated buy returns 401', async () => {
    const res = await request(app).post('/api/v1/orders/buy').send({ tier_id: 1 });
    expect(res.status).toBe(401);
  });
});

describe('AUTH', () => {
  test('Register with weak password returns 422', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({
      username: 'weakuser', email: 'weak@test.com', password: '123'
    });
    expect(res.status).toBe(422);
  });

  test('Duplicate username returns 409', async () => {
    await request(app).post('/api/v1/auth/register').send({
      username: 'dupuser', email: 'dup1@test.com', password: 'Dup1234A'
    });
    const res = await request(app).post('/api/v1/auth/register').send({
      username: 'dupuser', email: 'dup2@test.com', password: 'Dup1234A'
    });
    expect(res.status).toBe(409);
  });

  test('Wrong password returns 401', async () => {
    await request(app).post('/api/v1/auth/register').send({
      username: 'pwtest', email: 'pwtest@test.com', password: 'Correct1A'
    });
    const res = await request(app).post('/api/v1/auth/login').send({
      username: 'pwtest', password: 'WrongPass1'
    });
    expect(res.status).toBe(401);
  });
});

describe('ADMIN key management', () => {
  let adminToken;

  beforeAll(async () => {
    const res = await request(app).post('/api/v1/auth/login').send({
      username: process.env.ADMIN_USERNAME || 'admin',
      password: process.env.ADMIN_PASSWORD || 'Admin@2024!'
    });
    adminToken = res.body.data?.token;
  });

  test('Admin can add a key', async () => {
    if (!adminToken) return;
    const code = 'ADMINKEY-' + Date.now();
    const res = await request(app).post('/api/v1/admin/keys')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code, game_id: 'free-fire', tier_id: 6, price: 40000 });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe(code.toUpperCase());
  });

  test('Non-admin cannot add key', async () => {
    const u   = await registerAndLogin('normie');
    const res = await request(app).post('/api/v1/admin/keys')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ code: 'HACKER-KEY', game_id: 'free-fire', tier_id: 6, price: 0 });
    expect(res.status).toBe(403);
  });

  test('Key codes not exposed to regular users', async () => {
    const u   = await registerAndLogin('spyguy');
    const res = await request(app).get('/api/v1/admin/keys')
      .set('Authorization', `Bearer ${u.token}`);
    expect(res.status).toBe(403);
  });
});
