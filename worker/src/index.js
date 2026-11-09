// index.js — 線上寫歌課 API（Cloudflare Worker）
//
// 路由一覽（細節見 course-online/ARCHITECTURE.md）：
//   POST /api/orders              建預購單 → 回綠界 AioCheckOut 表單欄位
//   POST /api/ecpay/return        綠界 ReturnURL（伺服器對伺服器，驗 CheckMacValue）
//   POST /api/auth/request-code   寄 6 位數登入碼
//   POST /api/auth/verify         驗碼 → 發 session cookie（舊裝置同時被登出）
//   POST /api/auth/logout
//   GET  /api/session             目前登入狀態（播放頁每 60 秒問一次，用來踢掉舊裝置）
//   GET  /api/course              課程結構（不用登入；有登入會多帶進度、練習、檢查點）
//   POST /api/progress            勾選／取消單元完成
//   GET  /api/video?id=u01-B      播放網址（YouTube 不公開影片，嵌入站內）：免費集不用登入，付費集要學員
//   GET  /api/homework?unitId=u1  自己交過的作業
//   POST /api/homework            交作業（multipart：unitId、body、file）→ 即時寄信通知我們
//   GET  /api/health
//
// 後台（Authorization: Bearer ADMIN_TOKEN；網頁在 /course-online/admin/）：
//   GET  /api/admin/course                 後台一次讀全部：單元文字、全部集數（含 YouTube ID）、網站開關
//   POST /api/admin/test-email             寄一封交作業通知格式的測試信到 HOMEWORK_NOTIFY_EMAIL
//   POST /api/admin/save                   後台「儲存到網站」：{units, episodes(照順序), deleted, settings} 一次存
//   GET  /api/admin/episodes               全部集數（含 YouTube ID、未發布的）
//   POST /api/admin/episodes               新增一集 {unitId, title, youtubeId, minutes, published}
//   POST /api/admin/episodes/update        修改 {id, ...}
//   POST /api/admin/episodes/reorder       排序 {unitId, ids:[...]}（第一個就是免費集）
//   POST /api/admin/episodes/delete        刪除 {id}
//   GET  /api/admin/homework               作業列表
//   GET  /api/admin/homework/file?id=hw_…  下載作業檔案
//   POST /api/admin/homework/status        標記 {id, status:'new'|'reviewed'}
//   GET  /api/admin/export.csv             名單匯出

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
import { sendEmail, loginCodeEmail, preorderPaidEmail, ownerNotifyEmail, homeworkNotifyEmail } from './email.js';
import { youtubeEmbedUrl } from './video.js';
import { publicCourse, findUnit, loadUnits, findUnitText, COURSE } from './course.js';
import {
  listAllEpisodes,
  listPublishedEpisodes,
  findPublishedEpisode,
  createEpisode,
  updateEpisode,
  reorderEpisodes,
  deleteEpisode,
  saveAll,
  loadSettings,
} from './episodes.js';
import { parseHomeworkForm, safeFileName, newHomeworkId, HOMEWORK_DEFAULTS } from './homework.js';
import { toCsv } from './csv.js';

const DEFAULTS = {
  PREORDER_PRICE: '2480',
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-MA-Session, X-MA-Admin',
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

/**
 * 管理員預覽：前台頁面在後台登入過的瀏覽器會帶 X-MA-Admin（後台密碼），對就當成已購買，
 * 課程目錄全部解鎖、影片都拿得到（含預購期間關掉的免費集）。只影響讀取，不能交作業、不算學員。
 */
function isAdminPreview(request, env) {
  const want = String(env.ADMIN_TOKEN || '');
  const got = (request.headers.get('X-MA-Admin') || '').trim();
  return want.length >= 24 && got.length > 0 && timingSafeEqual(got, want);
}

/**
 * 登入 token：同網域（course-api.mralleys.com）用 HttpOnly cookie；
 * API 放在 *.workers.dev 時是跨站，Safari 等瀏覽器會擋第三方 cookie，所以前端也會把 token 放在 X-MA-Session header 帶來。
 */
function sessionToken(request, env) {
  return readCookie(request, cookieName(env)) || (request.headers.get('X-MA-Session') || '').trim();
}

/** 付費集看得到：學員＋課程已開，或在預覽名單 */
function canWatch(env, email) {
  if (env.COURSE_OPEN === 'true') return true;
  const preview = String(env.PREVIEW_EMAILS || '')
    .split(',')
    .map((s) => normalizeEmail(s))
    .filter(Boolean);
  return preview.includes(email);
}

/**
 * 金鑰沒設好就不收單、不收回呼：否則 HashKey 會變成字串 "undefined"，
 * 任何人都能算出「正確」的 CheckMacValue 偽造付款成功。
 */
function ecpayConfigured(env) {
  return Boolean(env.ECPAY_MERCHANT_ID && env.ECPAY_HASH_KEY && env.ECPAY_HASH_IV);
}

// ---------------------------------------------------------------- handlers

async function createOrder(request, env, deps) {
  if (env.PREORDER_OPEN !== 'true') return json({ error: 'preorder_closed' }, 403, request, env);
  if (!ecpayConfigured(env)) return json({ error: 'payment_not_ready' }, 503, request, env);
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
  if (!ecpayConfigured(env)) return text('0|not configured', 503);
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
  // token 也放在回應裡：API 在 workers.dev 時 cookie 是第三方，前端改用 X-MA-Session header 帶
  return json({ ok: true, email: r.email, replacedOthers: r.replacedOthers, token: r.token, maxAgeSec: maxAge }, 200, request, env, {
    'Set-Cookie': sessionCookie(env, r.token, maxAge),
  });
}

async function requireSession(request, env, deps) {
  return getSession(env.DB, sessionToken(request, env), { now: deps.now() });
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
  const member = s.ok;
  const adminPreview = isAdminPreview(request, env);
  const entitled = adminPreview || (member && canWatch(env, s.email));
  let progress = {};
  if (member) {
    const { results } = await env.DB.prepare('SELECT unit_id, completed_at FROM progress WHERE email = ?').bind(s.email).all();
    progress = Object.fromEntries((results || []).map((r) => [r.unit_id, r.completed_at]));
  }
  const [episodes, units, settings] = await Promise.all([listPublishedEpisodes(env.DB), loadUnits(env.DB), loadSettings(env.DB, env)]);
  return json(
    {
      course: publicCourse(episodes, {
        member: member || adminPreview,
        entitled,
        freeOpen: settings.freeOpen,
        showLockedTitles: settings.showLockedTitles,
        units,
      }),
      member,
      adminPreview,
      email: member ? s.email : null,
      progress,
      canWatch: entitled,
      courseOpen: env.COURSE_OPEN === 'true',
      freeOpen: settings.freeOpen,
      price: parseInt(cfgOf(env, 'PREORDER_PRICE'), 10),
      purchaseOpen: env.PREORDER_OPEN === 'true',
      paymentReady: ecpayConfigured(env),
      launchText: cfgOf(env, 'LAUNCH_TEXT'),
      // live 規則還沒定（每單元一堂 or 每月兩堂）：先只把設定值帶出去，前端與解鎖邏輯都還沒做
      live: { rule: env.LIVE_RULE || null },
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
  const ep = await findPublishedEpisode(env.DB, url.searchParams.get('id') || '');
  if (!ep) return json({ error: 'unknown_video' }, 404, request, env);

  let email = null;
  const { freeOpen } = await loadSettings(env.DB, env);
  if (!(ep.free && freeOpen) && !isAdminPreview(request, env)) {
    const s = await requireSession(request, env, deps);
    // none = 沒登入（前端顯示「購買解鎖」）；replaced／expired… = 這台被登出了
    if (!s.ok) {
      if (s.reason === 'none') return json({ error: ep.free ? 'trial_closed' : 'locked' }, 401, request, env);
      return json({ error: s.reason }, 401, request, env);
    }
    if (!canWatch(env, s.email)) return json({ error: 'course_not_open' }, 403, request, env);
    email = s.email;
  }
  if (!ep.youtube_id) return json({ error: 'video_not_ready' }, 404, request, env);
  const out = { id: ep.id, title: ep.title, ...youtubeEmbedUrl(ep.youtube_id, env.SITE_ORIGIN) };
  // 浮水印：邏輯留著，預設關（WATERMARK=true 才帶 email 給前端疊字）。對外文案不提。
  if (env.WATERMARK === 'true' && email) out.watermark = email;
  return json(out, 200, request, env);
}

// ---------------------------------------------------------------- 交作業

const taipeiText = (ms) => new Date(Number(ms) + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);

async function listMyHomework(request, env, deps, url) {
  const s = await requireSession(request, env, deps);
  if (!s.ok) return json({ error: s.reason }, 401, request, env);
  const unit = findUnit(url.searchParams.get('unitId') || '');
  const { results } = await env.DB.prepare(
    `SELECT id, unit_id, body, file_name, file_size, status, created_at FROM homework WHERE email = ? ${unit ? 'AND unit_id = ?' : ''} ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(...(unit ? [s.email, unit.id] : [s.email]))
    .all();
  return json({ homework: results || [] }, 200, request, env);
}

async function submitHomework(request, env, ctx, deps) {
  const s = await requireSession(request, env, deps);
  if (!s.ok) return json({ error: s.reason }, 401, request, env);
  const parsed = await parseHomeworkForm(request, env);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status, request, env);
  const unit = await findUnitText(env.DB, parsed.unitId);
  if (!unit) return json({ error: 'unknown_unit' }, 400, request, env);
  if (parsed.file && !env.HOMEWORK_FILES) return json({ error: 'upload_unavailable' }, 503, request, env);

  const db = env.DB;
  const now = deps.now();
  const bucket = `hw:email:${s.email}`;
  const rl = await db
    .prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND created_at > ?')
    .bind(bucket, now - 24 * 3600 * 1000)
    .first();
  if (Number(rl?.n || 0) >= HOMEWORK_DEFAULTS.perEmailPerDay) return json({ error: 'rate_limited' }, 429, request, env);

  const id = newHomeworkId();
  let file = null;
  if (parsed.file) {
    const name = safeFileName(parsed.file.name);
    file = { key: `hw/${id}`, name, type: String(parsed.file.type || 'application/octet-stream').slice(0, 100), size: parsed.file.size };
    await env.HOMEWORK_FILES.put(file.key, await parsed.file.arrayBuffer(), {
      metadata: { name, type: file.type, size: file.size, email: s.email, unitId: unit.id },
    });
  }
  await db.batch([
    db.prepare('INSERT INTO rate_events (bucket, created_at) VALUES (?, ?)').bind(bucket, now),
    db
      .prepare(
        'INSERT INTO homework (id, email, unit_id, body, file_key, file_name, file_type, file_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id, s.email, unit.id, parsed.body || null, file?.key ?? null, file?.name ?? null, file?.type ?? null, file?.size ?? null, 'new', now),
  ]);

  // 即時通知我們；寄信失敗不影響學員（記在 notify_error，後台看得到）
  const to = env.HOMEWORK_NOTIFY_EMAIL || env.OWNER_NOTIFY_EMAIL;
  const job = (async () => {
    if (!to) {
      await db.prepare('UPDATE homework SET notify_error = ? WHERE id = ?').bind('no_notify_email', id).run();
      return;
    }
    try {
      const m = await db.prepare('SELECT name FROM members WHERE email = ?').bind(s.email).first();
      const mail = homeworkNotifyEmail({
        id,
        email: s.email,
        name: m?.name || null,
        unitNo: unit.no,
        unitTitle: unit.title,
        body: parsed.body,
        fileName: file?.name,
        fileSize: file?.size,
        adminUrl: `${env.SITE_ORIGIN}/course-online/admin/#homework`,
        createdText: taipeiText(now),
      });
      const sent = await deps.sendEmail(env, { to, ...mail });
      if (sent && sent.logged) {
        // dry-run：沒有真的寄出，後台要看得出來
        await db.prepare('UPDATE homework SET notify_error = ? WHERE id = ?').bind('dry_run', id).run();
      } else {
        await db.prepare('UPDATE homework SET notified_at = ? WHERE id = ?').bind(deps.now(), id).run();
      }
    } catch (e) {
      console.error('[email] homework notify failed', e);
      await db.prepare('UPDATE homework SET notify_error = ? WHERE id = ?').bind(String(e?.message || e).slice(0, 300), id).run();
    }
  })();
  ctx.waitUntil(job);

  return json({ ok: true, id, createdAt: now }, 200, request, env);
}

// ---------------------------------------------------------------- 後台

/** @returns {Response|null} null = 通過 */
function adminGuard(request, env) {
  const want = String(env.ADMIN_TOKEN || '');
  if (want.length < 24) return text('admin token not configured', 503, corsHeaders(request, env));
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(got, want)) return json({ error: 'unauthorized' }, 401, request, env);
  return null;
}

async function adminRoute(request, env, deps, url) {
  const denied = adminGuard(request, env);
  if (denied) return denied;
  const { pathname } = url;
  const method = request.method;
  const db = env.DB;
  const result = (r) => (r.ok ? json(r, 200, request, env) : json({ error: r.error }, r.error.startsWith('unknown_') ? 404 : 400, request, env));

  if (pathname === '/api/admin/export.csv' && method === 'GET') return adminExport(request, env, url);
  if (pathname === '/api/admin/course' && method === 'GET') {
    const [units, episodes, settings] = await Promise.all([loadUnits(db), listAllEpisodes(db), loadSettings(db, env)]);
    const defaults = Object.fromEntries(COURSE.units.map((u) => [u.id, { title: u.title, summary: u.summary, task: u.task, checkpoint: u.checkpoint }]));
    return json(
      {
        units,
        defaults,
        episodes,
        settings,
        status: {
          courseOpen: env.COURSE_OPEN === 'true',
          preorderOpen: env.PREORDER_OPEN === 'true',
          paymentReady: ecpayConfigured(env),
          ecpayEnv: env.ECPAY_ENV === 'prod' ? 'prod' : 'stage',
          emailMode: env.EMAIL_MODE === 'log' || env.EMAIL_MODE === 'dry-run' ? 'dry-run' : 'send',
          homeworkNotifyEmail: env.HOMEWORK_NOTIFY_EMAIL || env.OWNER_NOTIFY_EMAIL || '',
          price: parseInt(cfgOf(env, 'PREORDER_PRICE'), 10),
        },
      },
      200,
      request,
      env,
    );
  }
  if (pathname === '/api/admin/test-email' && method === 'POST') {
    // 寄一封「交作業通知」格式的測試信到 HOMEWORK_NOTIFY_EMAIL，確認寄信有接上
    const to = env.HOMEWORK_NOTIFY_EMAIL || env.OWNER_NOTIFY_EMAIL;
    if (!to) return json({ error: 'no_notify_email' }, 400, request, env);
    const now = deps.now();
    const mail = homeworkNotifyEmail({
      id: 'hw_test',
      email: 'test@example.com',
      name: '（測試信）',
      unitNo: 1,
      unitTitle: '寄信測試',
      body: '這是後台寄的測試信，不是學員交的作業。收到就代表交作業通知會寄到這裡。',
      fileName: null,
      fileSize: null,
      adminUrl: `${env.SITE_ORIGIN}/course-online/admin/#homework`,
      createdText: taipeiText(now),
    });
    try {
      const r = await deps.sendEmail(env, { to, ...mail, subject: `【測試】${mail.subject}` });
      return json({ ok: true, to, dryRun: Boolean(r && r.logged) }, 200, request, env);
    } catch (e) {
      console.error('[email] test failed', e);
      return json({ error: 'email_failed', detail: String(e?.message || e).slice(0, 200) }, 502, request, env);
    }
  }
  if (pathname === '/api/admin/save' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return json({ error: 'bad_request' }, 400, request, env);
    const r = await saveAll(db, body, deps.now());
    return r.ok ? json(r, 200, request, env) : json({ error: r.error, detail: r.detail || null }, 400, request, env);
  }
  if (pathname === '/api/admin/episodes' && method === 'GET') {
    return json({ episodes: await listAllEpisodes(db) }, 200, request, env);
  }
  if (method === 'POST' && pathname.startsWith('/api/admin/episodes')) {
    const body = (await readJson(request)) || {};
    const now = deps.now();
    if (pathname === '/api/admin/episodes') return result(await createEpisode(db, body, now));
    if (pathname === '/api/admin/episodes/update') return result(await updateEpisode(db, body, now));
    if (pathname === '/api/admin/episodes/reorder') return result(await reorderEpisodes(db, body, now));
    if (pathname === '/api/admin/episodes/delete') return result(await deleteEpisode(db, body));
  }
  if (pathname === '/api/admin/homework' && method === 'GET') {
    const status = url.searchParams.get('status');
    const where = status === 'new' || status === 'reviewed' ? 'WHERE h.status = ?' : '';
    const { results } = await db
      .prepare(
        `SELECT h.id, h.email, m.name, h.unit_id, h.body, h.file_name, h.file_type, h.file_size, h.status, h.created_at, h.notified_at, h.notify_error
         FROM homework h LEFT JOIN members m ON m.email = h.email ${where} ORDER BY h.created_at DESC LIMIT 200`,
      )
      .bind(...(where ? [status] : []))
      .all();
    return json({ homework: results || [] }, 200, request, env);
  }
  if (pathname === '/api/admin/homework/file' && method === 'GET') {
    const row = await db.prepare('SELECT file_key, file_name, file_type FROM homework WHERE id = ?').bind(url.searchParams.get('id') || '').first();
    if (!row?.file_key || !env.HOMEWORK_FILES) return json({ error: 'not_found' }, 404, request, env);
    const obj = await env.HOMEWORK_FILES.get(row.file_key, { type: 'arrayBuffer' });
    if (!obj) return json({ error: 'not_found' }, 404, request, env);
    return new Response(obj, {
      headers: {
        'Content-Type': row.file_type || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name || 'file')}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...corsHeaders(request, env),
      },
    });
  }
  if (pathname === '/api/admin/homework/status' && method === 'POST') {
    const body = (await readJson(request)) || {};
    if (body.status !== 'new' && body.status !== 'reviewed') return json({ error: 'bad_request' }, 400, request, env);
    const r = await db.prepare('UPDATE homework SET status = ? WHERE id = ?').bind(body.status, String(body.id || '')).run();
    return r?.meta?.changes ? json({ ok: true }, 200, request, env) : json({ error: 'unknown_homework' }, 404, request, env);
  }
  return json({ error: 'not_found' }, 404, request, env);
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
      ...corsHeaders(request, env),
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
    if (pathname.startsWith('/api/admin/')) return await adminRoute(request, env, deps, url);
    if (pathname === '/api/health') return json({ ok: true }, 200, request, env);

    if (method === 'POST' && !originOk(request, env)) return json({ error: 'bad_origin' }, 403, request, env);

    if (pathname === '/api/orders' && method === 'POST') return await createOrder(request, env, deps);
    if (pathname === '/api/auth/request-code' && method === 'POST') return await requestCode(request, env, ctx, deps);
    if (pathname === '/api/auth/verify' && method === 'POST') return await verifyCode(request, env, deps);
    if (pathname === '/api/auth/logout' && method === 'POST') {
      await revokeSession(env.DB, sessionToken(request, env), { now: deps.now() });
      return json({ ok: true }, 200, request, env, { 'Set-Cookie': sessionCookie(env, '', 0) });
    }
    if (pathname === '/api/session' && method === 'GET') return await sessionInfo(request, env, deps);
    if (pathname === '/api/course' && method === 'GET') return await courseInfo(request, env, deps);
    if (pathname === '/api/progress' && method === 'POST') return await setProgress(request, env, deps);
    if (pathname === '/api/video' && method === 'GET') return await videoUrl(request, env, deps, url);
    if (pathname === '/api/homework' && method === 'GET') return await listMyHomework(request, env, deps, url);
    if (pathname === '/api/homework' && method === 'POST') return await submitHomework(request, env, ctx, deps);

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
