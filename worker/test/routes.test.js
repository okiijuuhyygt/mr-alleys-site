// 整條流程：建單 → 綠界 callback → 寄信 → 要碼 → 驗碼 → session → 第二台登入踢掉第一台 → 簽影片網址 → 匯出 CSV
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeD1 } from './helpers/d1.js';
import { handle } from '../src/index.js';
import { generateCheckMacValue } from '../src/ecpay.js';
import { COURSE } from '../src/course.js';

const SITE = 'https://mralleys.com';
const API = 'https://course-api.mralleys.com';
// 綠界公開的測試特店（官方文件範例用的那組），不是正式金鑰
const KEY = 'pwFHCqoQZGmho4w6';
const IV = 'EkRm7iFT261dpevs';

function makeEnv(over = {}) {
  return {
    DB: new FakeD1(),
    SITE_ORIGIN: SITE,
    API_ORIGIN: API,
    ALLOWED_ORIGINS: SITE,
    ECPAY_ENV: 'stage',
    ECPAY_MERCHANT_ID: '3002607',
    ECPAY_HASH_KEY: KEY,
    ECPAY_HASH_IV: IV,
    PREORDER_OPEN: 'true',
    PREORDER_PRICE: '1480',
    COURSE_OPEN: 'false',
    PREVIEW_EMAILS: '',
    BUNNY_LIBRARY_ID: '12345',
    BUNNY_TOKEN_KEY: 'bunny-test-key',
    CODE_PEPPER: 'pepper',
    ADMIN_TOKEN: 'admin-token-0123456789abcdef',
    ...over,
  };
}

function makeHarness(over) {
  const env = makeEnv(over);
  const mail = [];
  const pending = [];
  let clock = Date.UTC(2026, 10, 4, 8, 0, 0);
  const deps = {
    now: () => clock,
    sendEmail: async (_env, msg) => {
      mail.push(msg);
    },
  };
  const ctx = { waitUntil: (p) => pending.push(p) };
  const call = async (method, path, { body, headers = {}, form } = {}) => {
    const h = new Headers(headers);
    let payload;
    if (form) {
      h.set('Content-Type', 'application/x-www-form-urlencoded');
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      h.set('Content-Type', 'application/json');
      payload = JSON.stringify(body);
    }
    const res = await handle(new Request(API + path, { method, headers: h, body: payload }), env, ctx, deps);
    await Promise.all(pending.splice(0));
    return res;
  };
  const advance = (ms) => {
    clock += ms;
  };
  return { env, mail, call, advance, now: () => clock };
}

const fromSite = (extra = {}) => ({ Origin: SITE, 'CF-Connecting-IP': '1.2.3.4', ...extra });
const cookieOf = (res) => (res.headers.get('Set-Cookie') || '').split(';')[0];

async function paidCallback(h, merchantTradeNo, over = {}) {
  const p = {
    MerchantID: '3002607',
    MerchantTradeNo: merchantTradeNo,
    PaymentDate: '2026/11/04 16:01:00',
    PaymentType: 'Credit_CreditCard',
    PaymentTypeChargeFee: '30',
    RtnCode: '1',
    RtnMsg: '交易成功',
    SimulatePaid: '0',
    StoreID: '',
    TradeAmt: '1480',
    TradeDate: '2026/11/04 16:00:10',
    TradeNo: '2611041600104321',
    CustomField1: '',
    CustomField2: '',
    CustomField3: '',
    CustomField4: '',
    ...over,
  };
  p.CheckMacValue = await generateCheckMacValue(p, KEY, IV);
  return h.call('POST', '/api/ecpay/return', { form: p });
}

async function preorder(h, email = 'Buyer@Example.com') {
  const res = await h.call('POST', '/api/orders', {
    headers: fromSite(),
    body: { email, name: '小明', agreeRefund: true, marketingOptIn: true },
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function login(h, email = 'buyer@example.com', ua = 'ua') {
  const r1 = await h.call('POST', '/api/auth/request-code', { headers: fromSite(), body: { email } });
  assert.equal(r1.status, 200);
  const code = h.mail.at(-1).subject.match(/(\d{6})/)[1];
  const r2 = await h.call('POST', '/api/auth/verify', { headers: fromSite({ 'User-Agent': ua }), body: { email, code } });
  assert.equal(r2.status, 200);
  return cookieOf(r2);
}

test('建預購單：回綠界表單欄位，訂單 pending', async () => {
  const h = makeHarness();
  const o = await preorder(h);
  assert.equal(o.action, 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5');
  assert.equal(o.fields.TotalAmount, '1480');
  assert.equal(o.fields.ReturnURL, `${API}/api/ecpay/return`);
  assert.match(o.fields.CheckMacValue, /^[0-9A-F]{64}$/);
  const row = h.env.DB.sqlite.prepare('SELECT email, status, amount FROM orders').get();
  assert.deepEqual({ ...row }, { email: 'buyer@example.com', status: 'pending', amount: 1480 });
});

test('建預購單：要勾退款說明、email 要合法、要從自己網站送出、預購關閉時擋', async () => {
  const h = makeHarness();
  const post = (body, headers = fromSite()) => h.call('POST', '/api/orders', { headers, body });
  assert.equal((await post({ email: 'a@b.tw' })).status, 400);
  assert.equal((await post({ email: 'nope', agreeRefund: true })).status, 400);
  assert.equal((await post({ email: 'a@b.tw', agreeRefund: true }, { Origin: 'https://evil.example' })).status, 403);
  const closed = makeHarness({ PREORDER_OPEN: 'false' });
  assert.equal((await closed.call('POST', '/api/orders', { headers: fromSite(), body: { email: 'a@b.tw', agreeRefund: true } })).status, 403);
});

test('綠界 callback：CheckMacValue 錯就拒絕，訂單不變', async () => {
  const h = makeHarness();
  const o = await preorder(h);
  const res = await h.call('POST', '/api/ecpay/return', {
    form: { MerchantID: '3002607', MerchantTradeNo: o.merchantTradeNo, RtnCode: '1', TradeAmt: '1480', CheckMacValue: 'A'.repeat(64) },
  });
  assert.equal(res.status, 400);
  assert.equal(h.env.DB.sqlite.prepare('SELECT status FROM orders').get().status, 'pending');
  assert.equal(h.mail.length, 0);
});

test('綠界 callback：金額不符不開通', async () => {
  const h = makeHarness();
  const o = await preorder(h);
  const res = await paidCallback(h, o.merchantTradeNo, { TradeAmt: '1' });
  assert.equal(await res.text(), '1|OK');
  assert.equal(h.env.DB.sqlite.prepare('SELECT status FROM orders').get().status, 'failed');
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get().n, 0);
});

test('綠界 callback：正式環境的「模擬付款」不開通', async () => {
  const h = makeHarness({ ECPAY_ENV: 'prod' });
  const o = await preorder(h);
  await paidCallback(h, o.merchantTradeNo, { SimulatePaid: '1' });
  assert.equal(h.env.DB.sqlite.prepare('SELECT status FROM orders').get().status, 'failed');
});

test('完整流程：付款 → 確認信 → 登入 → 單一裝置 → 影片 → CSV', async () => {
  const h = makeHarness({ OWNER_NOTIFY_EMAIL: 'owner@example.com' });
  const o = await preorder(h);

  // 綠界 callback（重送兩次也只處理一次）
  const cb = await paidCallback(h, o.merchantTradeNo);
  assert.equal(await cb.text(), '1|OK');
  assert.equal(await (await paidCallback(h, o.merchantTradeNo)).text(), '1|OK');
  const order = h.env.DB.sqlite.prepare('SELECT status, ecpay_trade_no FROM orders').get();
  assert.equal(order.status, 'paid');
  assert.equal(order.ecpay_trade_no, '2611041600104321');
  assert.equal(h.mail.length, 2, '確認信＋老闆通知各一封，重送不重寄');
  assert.equal(h.mail[0].to, 'buyer@example.com');
  assert.match(h.mail[0].text, /預計 2027 年 1 月上線（以實際公告為準）/);
  assert.match(h.mail[0].text, /全額退款/);

  // 同一個 email 不能再預購
  const dup = await h.call('POST', '/api/orders', { headers: fromSite(), body: { email: 'buyer@example.com', agreeRefund: true } });
  assert.equal(dup.status, 409);

  // 沒買過的人要碼：回應一樣是 200，但不寄信
  const before = h.mail.length;
  const stranger = await h.call('POST', '/api/auth/request-code', { headers: fromSite(), body: { email: 'who@example.com' } });
  assert.equal(stranger.status, 200);
  assert.equal(h.mail.length, before);

  // 登入（手機）
  const phone = await login(h, 'buyer@example.com', 'phone');
  assert.match(phone, /^__Host-ma_sess=/);
  const s1 = await h.call('GET', '/api/session', { headers: fromSite({ Cookie: phone }) });
  assert.equal(s1.status, 200);
  const s1j = await s1.json();
  assert.equal(s1j.email, 'buyer@example.com');
  assert.equal(s1j.canWatch, false, '預購期還不能看');

  // 預購期：影片網址拿不到
  assert.equal((await h.call('GET', '/api/video?id=u1v2', { headers: fromSite({ Cookie: phone }) })).status, 403);

  // 筆電登入 → 手機被踢掉
  h.advance(60 * 1000);
  const laptop = await login(h, 'buyer@example.com', 'laptop');
  const kicked = await h.call('GET', '/api/session', { headers: fromSite({ Cookie: phone }) });
  assert.equal(kicked.status, 401);
  assert.equal((await kicked.json()).error, 'replaced');
  assert.equal((await h.call('GET', '/api/session', { headers: fromSite({ Cookie: laptop }) })).status, 200);

  // 開課後：簽影片網址，附浮水印 email
  h.env.COURSE_OPEN = 'true';
  COURSE.units[0].videos[1].bunnyId = 'bunny-guid-1';
  try {
    const v = await h.call('GET', '/api/video?id=u1v2', { headers: fromSite({ Cookie: laptop }) });
    assert.equal(v.status, 200);
    const vj = await v.json();
    assert.equal(vj.watermark, 'buyer@example.com');
    assert.match(vj.embedUrl, /^https:\/\/player\.mediadelivery\.net\/embed\/12345\/bunny-guid-1\?token=[0-9a-f]{64}&expires=\d+/);
    assert.equal((await h.call('GET', '/api/video?id=u1v1', { headers: fromSite({ Cookie: laptop }) })).status, 404, '還沒上傳的影片');
    assert.equal((await h.call('GET', '/api/video?id=u1v2', { headers: fromSite({ Cookie: phone }) })).status, 401, '被踢掉的裝置拿不到');
  } finally {
    COURSE.units[0].videos[1].bunnyId = null;
  }

  // 課程與進度
  const p1 = await h.call('POST', '/api/progress', { headers: fromSite({ Cookie: laptop }), body: { unitId: 'u1', done: true } });
  assert.equal(p1.status, 200);
  const c = await (await h.call('GET', '/api/course', { headers: fromSite({ Cookie: laptop }) })).json();
  assert.equal(c.course.units.length, 4);
  assert.ok(c.progress.u1);
  assert.ok(!JSON.stringify(c).includes('bunny-guid'));

  // 登出
  const out = await h.call('POST', '/api/auth/logout', { headers: fromSite({ Cookie: laptop }) });
  assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await h.call('GET', '/api/session', { headers: fromSite({ Cookie: laptop }) })).status, 401);

  // CSV 匯出
  assert.equal((await h.call('GET', '/api/admin/export.csv')).status, 401);
  assert.equal((await h.call('GET', '/api/admin/export.csv', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const csv = await h.call('GET', '/api/admin/export.csv', { headers: { Authorization: `Bearer ${h.env.ADMIN_TOKEN}` } });
  assert.equal(csv.status, 200);
  const body = await csv.text();
  assert.match(body, /email,name,access,marketing_opt_in,first_paid_at/);
  assert.match(body, /buyer@example\.com,小明,active,1,2026-11-04 16:00:00/);
  const orders = await h.call('GET', '/api/admin/export.csv?type=orders', { headers: { Authorization: `Bearer ${h.env.ADMIN_TOKEN}` } });
  assert.match(await orders.text(), /,paid,/);
});

test('預覽名單：開課前 PREVIEW_EMAILS 裡的人可以看', async () => {
  const h = makeHarness({ PREVIEW_EMAILS: 'buyer@example.com' });
  const o = await preorder(h);
  await paidCallback(h, o.merchantTradeNo);
  const ck = await login(h);
  const s = await (await h.call('GET', '/api/session', { headers: fromSite({ Cookie: ck }) })).json();
  assert.equal(s.canWatch, true);
});

test('CORS：只對自己網站開放，帶 credentials', async () => {
  const h = makeHarness();
  const ok = await h.call('OPTIONS', '/api/session', { headers: { Origin: SITE } });
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), SITE);
  assert.equal(ok.headers.get('Access-Control-Allow-Credentials'), 'true');
  const bad = await h.call('OPTIONS', '/api/session', { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('Access-Control-Allow-Origin'), null);
});

test('ADMIN_TOKEN 沒設或太短：匯出直接關閉', async () => {
  const h = makeHarness({ ADMIN_TOKEN: 'short' });
  assert.equal((await h.call('GET', '/api/admin/export.csv', { headers: { Authorization: 'Bearer short' } })).status, 503);
});

test('綠界金鑰沒設：不收單、callback 也不接受（避免用 "undefined" 當金鑰偽造付款）', async () => {
  const h = makeHarness({ ECPAY_HASH_KEY: '', ECPAY_HASH_IV: '' });
  const r1 = await h.call('POST', '/api/orders', {
    headers: fromSite(),
    body: { email: 'a@example.com', agreeRefund: true },
  });
  assert.equal(r1.status, 503);
  const p = { MerchantID: '3002607', MerchantTradeNo: 'MA000', RtnCode: '1', TradeAmt: '1480' };
  p.CheckMacValue = await generateCheckMacValue(p, 'undefined', 'undefined');
  const r2 = await h.call('POST', '/api/ecpay/return', { form: p });
  assert.equal(r2.status, 503);
  assert.equal(await r2.text(), '0|not configured');
});
