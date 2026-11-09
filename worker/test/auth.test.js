import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeD1 } from './helpers/d1.js';
import {
  AUTH_DEFAULTS,
  generateCode,
  normalizeEmail,
  isValidEmail,
  requestLoginCode,
  verifyLoginCode,
  getSession,
  revokeSession,
  cleanup,
} from '../src/auth.js';

const PEPPER = 'test-pepper';
const T0 = Date.UTC(2026, 10, 4, 8, 0, 0);
const MIN = 60 * 1000;

function setup() {
  const db = new FakeD1();
  db.sqlite
    .prepare("INSERT INTO members (email, access, first_paid_at, created_at) VALUES (?, 'active', ?, ?)")
    .run('buyer@example.com', T0, T0);
  return db;
}

const req = (db, now, extra = {}) =>
  requestLoginCode(db, { email: 'buyer@example.com', ip: '1.1.1.1', now, pepper: PEPPER, ...extra });
const ver = (db, code, now, extra = {}) =>
  verifyLoginCode(db, { email: 'buyer@example.com', code, ip: '1.1.1.1', now, pepper: PEPPER, ...extra });

test('generateCode：一定是 6 位數字（可以 0 開頭）', () => {
  for (let i = 0; i < 500; i++) assert.match(generateCode(), /^\d{6}$/);
});

test('email 正規化與格式', () => {
  assert.equal(normalizeEmail('  Buyer@Example.COM '), 'buyer@example.com');
  assert.ok(isValidEmail('a@b.tw'));
  assert.ok(!isValidEmail('a@b'));
  assert.ok(!isValidEmail('not an email'));
});

test('驗證碼只存雜湊、不存明碼', async () => {
  const db = setup();
  const r = await req(db, T0);
  assert.equal(r.status, 'sent');
  const row = db.sqlite.prepare('SELECT code_hash FROM login_codes').get();
  assert.notEqual(row.code_hash, r.code);
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
});

test('沒買過的 email：不寄碼，但回 not_member（路由層會回跟 sent 一樣的話）', async () => {
  const db = setup();
  const r = await requestLoginCode(db, { email: 'stranger@example.com', ip: '1.1.1.1', now: T0, pepper: PEPPER });
  assert.equal(r.status, 'not_member');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_codes').get().n, 0);
});

test('正確的碼 → 拿到 session；同一組碼不能用第二次', async () => {
  const db = setup();
  const { code } = await req(db, T0);
  const ok = await ver(db, code, T0 + MIN);
  assert.equal(ok.ok, true);
  assert.ok(ok.token.length >= 40);
  const s = await getSession(db, ok.token, { now: T0 + 2 * MIN });
  assert.deepEqual(s, { ok: true, email: 'buyer@example.com' });
  const again = await ver(db, code, T0 + 2 * MIN);
  assert.deepEqual(again, { ok: false, reason: 'invalid' });
});

test('驗證碼 10 分鐘過期', async () => {
  const db = setup();
  const { code } = await req(db, T0);
  const late = await ver(db, code, T0 + AUTH_DEFAULTS.codeTtlMs + 1);
  assert.deepEqual(late, { ok: false, reason: 'expired' });
  const before = await (async () => {
    const db2 = setup();
    const { code: c2 } = await req(db2, T0);
    return ver(db2, c2, T0 + AUTH_DEFAULTS.codeTtlMs - 1000);
  })();
  assert.equal(before.ok, true);
});

test('錯 5 次碼就作廢，正確的碼也不能再用', async () => {
  const db = setup();
  const { code } = await req(db, T0);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 1; i <= 4; i++) assert.equal((await ver(db, wrong, T0 + i * 1000)).reason, 'invalid');
  assert.equal((await ver(db, wrong, T0 + 5000)).reason, 'too_many_attempts');
  assert.equal((await ver(db, code, T0 + 6000)).ok, false);
});

test('要新碼時舊碼作廢', async () => {
  const db = setup();
  const first = await req(db, T0);
  const second = await req(db, T0 + MIN);
  if (first.code !== second.code) assert.equal((await ver(db, first.code, T0 + 2 * MIN)).ok, false);
  assert.equal((await ver(db, second.code, T0 + 2 * MIN)).ok, true);
});

test('頻率限制：同一 email 15 分鐘內最多 3 次', async () => {
  const db = setup();
  for (let i = 0; i < 3; i++) assert.equal((await req(db, T0 + i * 1000)).status, 'sent');
  assert.equal((await req(db, T0 + 4000)).status, 'rate_limited');
  // 15 分鐘後恢復
  assert.equal((await req(db, T0 + 15 * MIN + 5000)).status, 'sent');
});

test('頻率限制：同一 IP 1 小時內最多 10 次（換不同 email 也算）', async () => {
  const db = setup();
  for (let i = 0; i < 10; i++) {
    const r = await requestLoginCode(db, { email: `x${i}@example.com`, ip: '9.9.9.9', now: T0 + i, pepper: PEPPER });
    assert.equal(r.status, 'not_member');
  }
  const r = await requestLoginCode(db, { email: 'buyer@example.com', ip: '9.9.9.9', now: T0 + 100, pepper: PEPPER });
  assert.equal(r.status, 'rate_limited');
});

test('頻率限制：同一 IP 驗證失敗 20 次後先擋', async () => {
  const db = setup();
  for (let i = 0; i < 20; i++) {
    await verifyLoginCode(db, { email: `x${i}@example.com`, code: '123456', ip: '8.8.8.8', now: T0 + i, pepper: PEPPER });
  }
  const r = await verifyLoginCode(db, { email: 'buyer@example.com', code: '123456', ip: '8.8.8.8', now: T0 + 50, pepper: PEPPER });
  assert.deepEqual(r, { ok: false, reason: 'rate_limited' });
});

test('一個帳號只能一台：新登入把舊裝置踢掉，舊裝置看到 replaced', async () => {
  const db = setup();
  const a = await ver(db, (await req(db, T0)).code, T0 + 1000, { userAgent: 'phone' });
  assert.equal(a.replacedOthers, 0);
  const b = await ver(db, (await req(db, T0 + MIN)).code, T0 + MIN + 1000, { userAgent: 'laptop' });
  assert.equal(b.replacedOthers, 1);

  assert.deepEqual(await getSession(db, a.token, { now: T0 + 2 * MIN }), { ok: false, reason: 'replaced' });
  assert.deepEqual(await getSession(db, b.token, { now: T0 + 2 * MIN }), { ok: true, email: 'buyer@example.com' });
  const active = db.sqlite
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE email = 'buyer@example.com' AND revoked_at IS NULL")
    .get().n;
  assert.equal(active, 1);
});

test('登出後 session 失效；亂給的 token 無效', async () => {
  const db = setup();
  const a = await ver(db, (await req(db, T0)).code, T0 + 1000);
  await revokeSession(db, a.token, { now: T0 + 2000 });
  assert.deepEqual(await getSession(db, a.token, { now: T0 + 3000 }), { ok: false, reason: 'logout' });
  assert.deepEqual(await getSession(db, 'garbage', { now: T0 }), { ok: false, reason: 'none' });
  assert.deepEqual(await getSession(db, '', { now: T0 }), { ok: false, reason: 'none' });
});

test('session 過期；有在用會自動延長', async () => {
  const db = setup();
  const a = await ver(db, (await req(db, T0)).code, T0);
  const ttl = AUTH_DEFAULTS.sessionTtlMs;
  // 第 20 天用過一次 → 延長到第 50 天
  assert.equal((await getSession(db, a.token, { now: T0 + 20 * 86400000 })).ok, true);
  assert.equal((await getSession(db, a.token, { now: T0 + ttl + 86400000 })).ok, true);
  // 之後很久沒用就過期
  assert.deepEqual(await getSession(db, a.token, { now: T0 + 200 * 86400000 }), { ok: false, reason: 'expired' });
});

test('退款後（access=revoked）不能登入、舊 session 也失效', async () => {
  const db = setup();
  const a = await ver(db, (await req(db, T0)).code, T0);
  db.sqlite.prepare("UPDATE members SET access = 'revoked'").run();
  assert.deepEqual(await getSession(db, a.token, { now: T0 + 1000 }), { ok: false, reason: 'no_access' });
  assert.equal((await req(db, T0 + 2000)).status, 'not_member');
});

test('cleanup 清掉一天前的紀錄', async () => {
  const db = setup();
  await req(db, T0);
  await cleanup(db, T0 + 2 * 86400000);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM rate_events').get().n, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_codes').get().n, 0);
});
