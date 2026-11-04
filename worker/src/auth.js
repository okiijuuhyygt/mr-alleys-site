// auth.js — 免密碼登入：email → 6 位數驗證碼 → session；同一帳號只留一台裝置。
//
// 所有函式都吃一個 D1 相容的 db（prepare/bind/first/run/all/batch），
// 測試時換成 node:sqlite 包的假 D1，跑的是同一份 migrations SQL。

import { timingSafeEqual } from './ecpay.js';

export const AUTH_DEFAULTS = {
  codeTtlMs: 10 * 60 * 1000,          // 驗證碼 10 分鐘過期
  codeMaxAttempts: 5,                 // 一組碼最多試 5 次
  codePerEmail: { limit: 3, windowMs: 15 * 60 * 1000 },   // 同一 email 15 分鐘內最多寄 3 次
  codePerIp: { limit: 10, windowMs: 60 * 60 * 1000 },     // 同一 IP 1 小時內最多要 10 次碼
  verifyFailPerIp: { limit: 20, windowMs: 60 * 60 * 1000 },// 同一 IP 1 小時內最多錯 20 次
  sessionTtlMs: 30 * 24 * 3600 * 1000, // 登入 30 天有效（期間有使用會自動延長）
  touchEveryMs: 5 * 60 * 1000,        // last_seen 最多 5 分鐘寫一次，省 D1 寫入
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** @param {unknown} s */
export function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

/** @param {string} email 已 normalize */
export function isValidEmail(email) {
  return email.length <= 254 && EMAIL_RE.test(email);
}

/** 6 位數、可以 0 開頭；用拒絕取樣避免模數偏差 */
export function generateCode() {
  const buf = new Uint32Array(1);
  const max = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < max) return String(buf[0] % 1_000_000).padStart(6, '0');
  }
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 驗證碼雜湊：加 email 與 pepper（Worker secret），資料庫外洩也不能直接比對 6 位數 */
export function hashCode(code, email, pepper) {
  return sha256Hex(`${pepper}:${email}:${code}`);
}

/** session token：32 bytes 亂數，base64url */
export function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hashToken(token) {
  return sha256Hex(`session:${token}`);
}

// ---------------------------------------------------------------- 頻率限制

async function countRecent(db, bucket, windowMs, now) {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND created_at > ?')
    .bind(bucket, now - windowMs)
    .first();
  return Number(row?.n || 0);
}

function recordStmt(db, bucket, now) {
  return db.prepare('INSERT INTO rate_events (bucket, created_at) VALUES (?, ?)').bind(bucket, now);
}

// ---------------------------------------------------------------- 要驗證碼

/**
 * @returns {Promise<{status:'sent', code:string} | {status:'not_member'} | {status:'rate_limited', retryAfterSec:number}>}
 * 呼叫端：status 是 sent 才寄信；sent 跟 not_member 對使用者要回一模一樣的訊息（不洩漏誰買過）。
 */
export async function requestLoginCode(db, { email, ip, now, pepper, cfg = AUTH_DEFAULTS }) {
  const eb = `code:email:${email}`;
  const ib = `code:ip:${ip || 'unknown'}`;
  if (
    (await countRecent(db, eb, cfg.codePerEmail.windowMs, now)) >= cfg.codePerEmail.limit ||
    (await countRecent(db, ib, cfg.codePerIp.windowMs, now)) >= cfg.codePerIp.limit
  ) {
    return { status: 'rate_limited', retryAfterSec: Math.ceil(cfg.codePerEmail.windowMs / 1000) };
  }
  // 不管是不是學員都記一筆，這樣「被擋」的行為對買過、沒買過的人一樣
  const stmts = [recordStmt(db, eb, now), recordStmt(db, ib, now)];

  const member = await db
    .prepare("SELECT email FROM members WHERE email = ? AND access = 'active'")
    .bind(email)
    .first();
  if (!member) {
    await db.batch(stmts);
    return { status: 'not_member' };
  }

  const code = generateCode();
  const codeHash = await hashCode(code, email, pepper);
  stmts.push(
    // 新碼一發，舊的還沒用的碼全部作廢
    db.prepare('UPDATE login_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL').bind(now, email),
    db
      .prepare('INSERT INTO login_codes (email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(email, codeHash, now, now + cfg.codeTtlMs),
  );
  await db.batch(stmts);
  return { status: 'sent', code };
}

// ---------------------------------------------------------------- 驗證碼換 session

/**
 * @returns {Promise<{ok:true, token:string, email:string, replacedOthers:number} |
 *                   {ok:false, reason:'invalid'|'expired'|'too_many_attempts'|'rate_limited'}>}
 */
export async function verifyLoginCode(db, { email, code, ip, now, pepper, userAgent = '', cfg = AUTH_DEFAULTS }) {
  const fb = `verify_fail:ip:${ip || 'unknown'}`;
  if ((await countRecent(db, fb, cfg.verifyFailPerIp.windowMs, now)) >= cfg.verifyFailPerIp.limit) {
    return { ok: false, reason: 'rate_limited' };
  }
  const fail = async (reason) => {
    await recordStmt(db, fb, now).run();
    return { ok: false, reason };
  };

  if (!/^\d{6}$/.test(String(code || ''))) return fail('invalid');

  const row = await db
    .prepare(
      'SELECT id, code_hash, expires_at, attempts FROM login_codes WHERE email = ? AND consumed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .bind(email)
    .first();
  if (!row) return fail('invalid');
  if (row.expires_at <= now) {
    await db.prepare('UPDATE login_codes SET consumed_at = ? WHERE id = ?').bind(now, row.id).run();
    return fail('expired');
  }
  if (row.attempts >= cfg.codeMaxAttempts) {
    await db.prepare('UPDATE login_codes SET consumed_at = ? WHERE id = ?').bind(now, row.id).run();
    return fail('too_many_attempts');
  }

  const want = await hashCode(String(code), email, pepper);
  if (!timingSafeEqual(want, row.code_hash)) {
    const attempts = row.attempts + 1;
    await db
      .prepare('UPDATE login_codes SET attempts = ?, consumed_at = ? WHERE id = ?')
      .bind(attempts, attempts >= cfg.codeMaxAttempts ? now : null, row.id)
      .run();
    return fail(attempts >= cfg.codeMaxAttempts ? 'too_many_attempts' : 'invalid');
  }

  // 碼對了：用掉它（WHERE consumed_at IS NULL 防同一組碼被兩個請求同時用）
  const used = await db
    .prepare('UPDATE login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
    .bind(now, row.id)
    .run();
  if (!used?.meta?.changes) return fail('invalid');

  const member = await db
    .prepare("SELECT email FROM members WHERE email = ? AND access = 'active'")
    .bind(email)
    .first();
  if (!member) return fail('invalid');

  const token = randomToken();
  const tokenHash = await hashToken(token);
  const results = await db.batch([
    // 一個帳號只留一台：先把其他還有效的 session 全部作廢
    db
      .prepare(
        "UPDATE sessions SET revoked_at = ?, revoked_reason = 'replaced' WHERE email = ? AND revoked_at IS NULL",
      )
      .bind(now, email),
    db
      .prepare(
        'INSERT INTO sessions (token_hash, email, created_at, last_seen_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(tokenHash, email, now, now, now + cfg.sessionTtlMs, String(userAgent).slice(0, 300)),
  ]);
  return { ok: true, token, email, replacedOthers: Number(results?.[0]?.meta?.changes || 0) };
}

// ---------------------------------------------------------------- 檢查 session

/**
 * @returns {Promise<{ok:true, email:string} | {ok:false, reason:'none'|'replaced'|'logout'|'admin'|'expired'|'no_access'}>}
 * reason = replaced 代表「這個帳號在別台裝置登入了」，前端要講清楚。
 */
export async function getSession(db, token, { now, cfg = AUTH_DEFAULTS }) {
  if (!token) return { ok: false, reason: 'none' };
  const tokenHash = await hashToken(token);
  const s = await db
    .prepare('SELECT email, last_seen_at, expires_at, revoked_at, revoked_reason FROM sessions WHERE token_hash = ?')
    .bind(tokenHash)
    .first();
  if (!s) return { ok: false, reason: 'none' };
  if (s.revoked_at) return { ok: false, reason: s.revoked_reason || 'logout' };
  if (s.expires_at <= now) return { ok: false, reason: 'expired' };

  const member = await db.prepare('SELECT access FROM members WHERE email = ?').bind(s.email).first();
  if (!member || member.access !== 'active') return { ok: false, reason: 'no_access' };

  if (now - s.last_seen_at >= cfg.touchEveryMs) {
    await db
      .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
      .bind(now, now + cfg.sessionTtlMs, tokenHash)
      .run();
  }
  return { ok: true, email: s.email };
}

export async function revokeSession(db, token, { now, reason = 'logout' }) {
  if (!token) return;
  const tokenHash = await hashToken(token);
  await db
    .prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(now, reason, tokenHash)
    .run();
}

/** cron 每天跑：清掉過期的頻率紀錄與驗證碼 */
export async function cleanup(db, now) {
  await db.batch([
    db.prepare('DELETE FROM rate_events WHERE created_at < ?').bind(now - 24 * 3600 * 1000),
    db.prepare('DELETE FROM login_codes WHERE created_at < ?').bind(now - 24 * 3600 * 1000),
  ]);
}
