// index.js — 線上寫歌課 API（Cloudflare Worker）
//
// 路由一覽（細節見 course-online/ARCHITECTURE.md）：
//   POST /api/orders              建預購單 → 回綠界 AioCheckOut 表單欄位
//   POST /api/ecpay/return        綠界 ReturnURL（伺服器對伺服器，驗 CheckMacValue）
//   POST /api/auth/request-code   寄 6 位數登入碼
//   POST /api/auth/verify         驗碼 → 發 session cookie（舊裝置同時被登出）
//   POST /api/auth/logout
//   GET  /api/session             目前登入狀態（播放頁每 60 秒問一次，用來踢掉舊裝置）
//   GET  /api/course              課程結構＋自己的進度
//   POST /api/progress            勾選／取消單元完成
//   GET  /api/video?id=u1v2       簽一個有期限的播放網址
//   GET  /api/admin/export.csv    名單匯出（Authorization: Bearer ADMIN_TOKEN）
//   GET  /api/health

import { buildAioCheckOut, newMerchantTradeNo, verifyCheckMacValue, timingSafeEqual } from './ecpay.js';
import {
  AUTH_DEFAULTS,
  normalizeEmail,
  isValidEmail,
  requestLoginCode,
  verifyLoginCode,
  getSession,
  revokeSession,
  cleanup,
} from './auth.js';
import { sendEmail, loginCodeEmail, preorderPaidEmail, ownerNotifyEmail } from './email.js';
import { signedEmbedUrl } from './video.js';
import { publicCourse, findVideo, findUnit } from './course.js';
import { toCsv } from './csv.js';

const DEFAULTS = {
  PREORDER_PRICE: '1480',
  ITEM_NAME: '寫歌課・線上第一期（預購）',
  TRADE_DESC: '巷弄故事館線上寫歌課預購',
  LAUNCH_TEXT: '預計 2027 年 1 月上線（以實際公告為準）',
  REFUND_DEADLINE_TEXT: '2027 年 1 月 31 日',
  VIDEO_TOKEN_TTL_SEC: '3600',
};
const cfgOf = (env, k) => (env[k] != null && env[k] !== '' ? String(env[k]) : DEFAULTS[k]);

// ---------------------------------------------------------------- 小工具

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || env.SITE_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(data, status, request, env, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
      ...extra,
    },
  });
}

function text(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...extra } });
}

function cookieName(env) {
  return env.COOKIE_INSECURE === 'true' ? 'ma_sess' : '__Host-ma_sess';
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function sessionCookie(env, token, maxAgeSec) {
  const secure = env.COOKIE_INSECURE === 'true' ? '' : '; Secure';
  return `${cookieName(env)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'local';

/** 會改狀態的請求（POST）必須來自我們自己的網站，擋 CSRF */
function originOk(request, env) {
  return allowedOrigins(env).includes(request.headers.get('Origin') || '');
}

function canWatch(env, email) {
  if (env.COURSE_OPEN === 'true') return true;
  const preview = String(env.PREVIEW_EMAILS || '')
    .split(',')
    .map((s) => normalizeEmail(s))
    .filter(Boolean);
  return preview.includes(email);
}

// ---------------------------------------------------------------- handlers

async function createOrder(request, env, deps) {
  if (env.PREORDER_OPEN !== 'true') return json({ error: 'preorder_closed' }, 403, request, env);
  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, 400, request, env);

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return json({ error: 'invalid_email' }, 400, request, env);
  if (body.agreeRefund !== true) return json({ error: 'must_agree' }, 400, request, env);
  const name = String(body.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
  const optIn = body.marketingOptIn === true ? 1 : 0;

  const db = env.DB;
  const now = deps.now();
  const ip = clientIp(request);
  const rl = await db
    .prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND created_at > ?')
    .bind(`order:ip:${ip}`, now - 3600 * 1000)
    .first();
  if (Number(rl?.n || 0) >= 20) return json({ error: 'rate_limited' }, 429, request, env);

  const paid = await db.prepare("SELECT 1 AS x FROM orders WHERE email = ? AND status = 'paid' LIMIT 1").bind(email).first();
  if (paid) return json({ error: 'already_paid' }, 409, request, env);

  const amount = parseInt(cfgOf(env, 'PREORDER_PRICE'), 10);
  const itemName = cfgOf(env, 'ITEM_NAME');
  const merchantTradeNo = newMerchantTradeNo(now);

  await db.batch([
    db.prepare('INSERT INTO rate_events (bucket, created_at) VALUES (?, ?)').bind(`order:ip:${ip}`, now),
    db
      .prepare(
        'INSERT INTO orders (merchant_trade_no, email, name, amount, item, status, marketing_opt_in, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(merchantTradeNo, email, name || null, amount, itemName, 'pending', optIn, now),
  ]);

  const form = await buildAioCheckOut({
    merchantId: env.ECPAY_MERCHANT_ID,
    hashKey: env.ECPAY_HASH_KEY,
    hashIV: env.ECPAY_HASH_IV,
    env: env.ECPAY_ENV === 'prod' ? 'prod' : 'stage',
    merchantTradeNo,
    nowMs: now,
    amount,
    itemName,
    tradeDesc: cfgOf(env, 'TRADE_DESC'),
    returnURL: `${env.API_ORIGIN}/api/ecpay/return`,
    clientBackURL: `${env.SITE_ORIGIN}/course-online/thanks.html`,
  });
  return json({ merchantTradeNo, ...form }, 200, request, env);
}

async function ecpayReturn(request, env, ctx, deps) {
  // 綠界送 application/x-www-form-urlencoded；要回純文字 1|OK，否則它會重送
  const params = Object.fromEntries(new URLSearchParams(await request.text()));
  const okSig = await verifyCheckMacValue(params, env.ECPAY_HASH_KEY, env.ECPAY_HASH_IV);
  if (!okSig) {
    console.warn('[ecpay] CheckMacValue mismatch', params.MerchantTradeNo);
    return text('0|CheckMacValue error', 400);
  }
  if (params.MerchantID !== env.ECPAY_MERCHANT_ID) return text('0|MerchantID mismatch', 400);

  const db = env.DB;
  const now = deps.now();
  const order = await db.prepare('SELECT * FROM orders WHERE merchant_trade_no = ?').bind(params.MerchantTradeNo).first();
  if (!order) return text('0|order not found', 404);
  if (order.status === 'paid') return text('1|OK'); // 綠界重送：已處理過

  const simulated = params.SimulatePaid === '1';
  const amountOk = Number(params.TradeAmt) === Number(order.amount);
  const success = params.RtnCode === '1' && amountOk && (!simulated || env.ECPAY_ENV !== 'prod');
  const raw = JSON.stringify(params);

  if (!success) {
    const msg = !amountOk ? `amount_mismatch:${params.TradeAmt}` : simulated ? 'simulate_paid_in_prod' : params.RtnMsg || '';
    await db
      .prepare(
        "UPDATE orders SET status = 'failed', rtn_code = ?, rtn_msg = ?, ecpay_trade_no = ?, simulate_paid = ?, raw_callback = ? WHERE merchant_trade_no = ? AND status = 'pending'",
      )
      .bind(params.RtnCode || '', msg, params.TradeNo || '', simulated ? 1 : 0, raw, order.merchant_trade_no)
      .run();
    return text('1|OK');
  }

  const [upd] = await db.batch([
    db
      .prepare(
        "UPDATE orders SET status = 'paid', paid_at = ?, rtn_code = ?, rtn_msg = ?, ecpay_trade_no = ?, payment_type = ?, payment_date = ?, simulate_paid = ?, raw_callback = ? WHERE merchant_trade_no = ? AND status != 'paid'",
      )
      .bind(
        now,
        params.RtnCode,
        params.RtnMsg || '',
        params.TradeNo || '',
        params.PaymentType || '',
        params.PaymentDate || '',
        simulated ? 1 : 0,
        raw,
        order.merchant_trade_no,
      ),
    db
      .prepare(
        `INSERT INTO members (email, name, access, marketing_opt_in, first_paid_at, created_at) VALUES (?, ?, 'active', ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET access = 'active', marketing_opt_in = MAX(members.marketing_opt_in, excluded.marketing_opt_in), name = COALESCE(members.name, excluded.name)`,
      )
      .bind(order.email, order.name, order.marketing_opt_in, now, now),
  ]);

  // 只有真的從 pending 改成 paid 的那一次才寄信（擋兩個重送同時進來）
  if (upd?.meta?.changes) {
    const jobs = (async () => {
      const mail = preorderPaidEmail({
        name: order.name,
        merchantTradeNo: order.merchant_trade_no,
        amount: order.amount,
        launchText: cfgOf(env, 'LAUNCH_TEXT'),
        refundDeadlineText: cfgOf(env, 'REFUND_DEADLINE_TEXT'),
        siteOrigin: env.SITE_ORIGIN,
      });
      await deps.sendEmail(env, { to: order.email, ...mail });
      if (env.OWNER_NOTIFY_EMAIL) {
        const c = await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'").first();
        const n = ownerNotifyEmail({ ...order, merchantTradeNo: order.merchant_trade_no, paidCount: Number(c?.n || 0) });
        await deps.sendEmail(env, { to: env.OWNER_NOTIFY_EMAIL, ...n });
      }
    })().catch((e) => console.error('[email] paid mail failed', e));
    ctx.waitUntil(jobs);
  }
  return text('1|OK');
}

async function requestCode(request, env, ctx, deps) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  if (!isValidEmail(email)) return json({ error: 'invalid_email' }, 400, request, env);
  const r = await requestLoginCode(env.DB, { email, ip: clientIp(request), now: deps.now(), pepper: env.CODE_PEPPER });
  if (r.status === 'rate_limited') {
    return json({ error: 'rate_limited', retryAfterSec: r.retryAfterSec }, 429, request, env);
  }
  if (r.status === 'sent') {
    // 寄信要等它真的送出去，失敗才能告訴使用者
    try {
      await deps.sendEmail(env, { to: email, ...loginCodeEmail({ code: r.code }) });
    } catch (e) {
      console.error('[email] code mail failed', e);
      return json({ error: 'email_failed' }, 502, request, env);
    }
  }
  // 買過、沒買過都回一樣的話，不讓人拿來查誰是學員
  return json({ ok: true }, 200, request, env);
}

async function verifyCode(request, env, deps) {
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const r = await verifyLoginCode(env.DB, {
    email,
    code: String(body?.code || '').trim(),
    ip: clientIp(request),
    now: deps.now(),
    pepper: env.CODE_PEPPER,
    userAgent: request.headers.get('User-Agent') || '',
  });
  if (!r.ok) return json({ error: r.reason }, r.reason === 'rate_limited' ? 429 : 401, request, env);
  const maxAge = Math.floor(AUTH_DEFAULTS.sessionTtlMs / 1000);
  return json({ ok: true, email: r.email, replacedOthers: r.replacedOthers }, 200, request, env, {
    'Set-Cookie': sessionCookie(env, r.token, maxAge),
  });
}

async function requireSession(request, env, deps) {
  const token = readCookie(request, cookieName(env));
  return getSession(env.DB, token, { now: deps.now() });
}

async function sessionInfo(request, env, deps) {
  const s = await requireSession(request, env, deps);
  if (!s.ok) return json({ error: s.reason }, 401, request, env);
  return json(
    {
      ok: true,
      email: s.email,
      courseOpen: env.COURSE_OPEN === 'true',
      canWatch: canWatch(env, s.email),
      launchText: cfgOf(env, 'LAUNCH_TEXT'),
    },
    200,
    request,
    env,
  );
}

async function courseInfo(request, env, deps) {
  const s = await requireSession(request, env, deps);
  if (!s.ok) return json({ error: s.reason }, 401, request, env);
  const { results } = await env.DB.prepare('SELECT unit_id, completed_at FROM progress WHERE email = ?').bind(s.email).all();
  return json(
    {
      course: publicCourse(),
      progress: Object.fromEntries((results || []).map((r) => [r.unit_id, r.completed_at])),
      canWatch: canWatch(env, s.email),
      launchText: cfgOf(env, 'LAUNCH_TEXT'),
    },
    200,
    request,
    env,
  );
}

async function setProgress(request, env, deps) {
  const s = await requireSession(request, env, deps);
  if (!s.ok) return json({ error: s.reason }, 401, request, env);
  const body = await readJson(request);
  const unit = findUnit(String(body?.unitId || ''));
  if (!unit) return json({ error: 'unknown_unit' }, 400, request, env);
  if (body.done === true) {
    await env.DB.prepare('INSERT OR IGNORE INTO progress (email, unit_id, completed_at) VALUES (?, ?, ?)')
      .bind(s.email, unit.id, deps.now())
      .run();
  } else {
    await env.DB.prepare('DELETE FROM progress WHERE email = ? AND unit_id = ?').bind(s.email, unit.id).run();
  }
  return json({ ok: true }, 200, request, env);
}

async function videoUrl(request, env, deps, url) {
  const s = await requireSession(request, env, deps);
  if (!s.ok) return json({ error: s.reason }, 401, request, env);
  if (!canWatch(env, s.email)) return json({ error: 'course_not_open' }, 403, request, env);
  const found = findVideo(url.searchParams.get('id') || '');
  if (!found) return json({ error: 'unknown_video' }, 404, request, env);
  if (!found.video.bunnyId) return json({ error: 'video_not_ready' }, 404, request, env);
  const signed = await signedEmbedUrl({
    libraryId: env.BUNNY_LIBRARY_ID,
    videoId: found.video.bunnyId,
    tokenKey: env.BUNNY_TOKEN_KEY,
    nowMs: deps.now(),
    ttlSec: parseInt(cfgOf(env, 'VIDEO_TOKEN_TTL_SEC'), 10),
  });
  return json({ ...signed, watermark: s.email }, 200, request, env);
}

async function adminExport(request, env, url) {
  const want = String(env.ADMIN_TOKEN || '');
  if (want.length < 24) return text('admin token not configured', 503);
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(got, want)) return text('unauthorized', 401);

  const type = url.searchParams.get('type') || 'members';
  let rows;
  let columns;
  if (type === 'orders') {
    columns = ['merchant_trade_no', 'email', 'name', 'amount', 'status', 'simulate_paid', 'ecpay_trade_no', 'payment_date', 'created_at', 'paid_at'];
    ({ results: rows } = await env.DB.prepare(`SELECT ${columns.join(', ')} FROM orders ORDER BY created_at`).all());
  } else {
    columns = ['email', 'name', 'access', 'marketing_opt_in', 'first_paid_at'];
    ({ results: rows } = await env.DB.prepare(`SELECT ${columns.join(', ')} FROM members ORDER BY first_paid_at`).all());
  }
  const iso = (ms) => (ms ? new Date(Number(ms) + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) : '');
  const mapped = (rows || []).map((r) => {
    const o = { ...r };
    for (const k of ['created_at', 'paid_at', 'first_paid_at']) if (k in o) o[k] = iso(o[k]);
    return o;
  });
  return new Response(toCsv(columns, mapped), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="mralleys-course-${type}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------- router

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{waitUntil(p: Promise<any>): void}} ctx
 * @param {{now(): number, sendEmail: typeof sendEmail}} deps  測試時換掉時鐘與寄信
 */
export async function handle(request, env, ctx, deps) {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });

  try {
    if (pathname === '/api/ecpay/return' && method === 'POST') return await ecpayReturn(request, env, ctx, deps);
    if (pathname === '/api/admin/export.csv' && method === 'GET') return await adminExport(request, env, url);
    if (pathname === '/api/health') return json({ ok: true }, 200, request, env);

    if (method === 'POST' && !originOk(request, env)) return json({ error: 'bad_origin' }, 403, request, env);

    if (pathname === '/api/orders' && method === 'POST') return await createOrder(request, env, deps);
    if (pathname === '/api/auth/request-code' && method === 'POST') return await requestCode(request, env, ctx, deps);
    if (pathname === '/api/auth/verify' && method === 'POST') return await verifyCode(request, env, deps);
    if (pathname === '/api/auth/logout' && method === 'POST') {
      await revokeSession(env.DB, readCookie(request, cookieName(env)), { now: deps.now() });
      return json({ ok: true }, 200, request, env, { 'Set-Cookie': sessionCookie(env, '', 0) });
    }
    if (pathname === '/api/session' && method === 'GET') return await sessionInfo(request, env, deps);
    if (pathname === '/api/course' && method === 'GET') return await courseInfo(request, env, deps);
    if (pathname === '/api/progress' && method === 'POST') return await setProgress(request, env, deps);
    if (pathname === '/api/video' && method === 'GET') return await videoUrl(request, env, deps, url);

    return json({ error: 'not_found' }, 404, request, env);
  } catch (e) {
    console.error('[api] unhandled', e);
    return json({ error: 'server_error' }, 500, request, env);
  }
}

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx, { now: () => Date.now(), sendEmail });
  },
  async scheduled(_event, env) {
    await cleanup(env.DB, Date.now());
  },
};
