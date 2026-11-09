// harness.js — 測試共用：假環境（FakeD1＋FakeKV＋34 集假 YouTube ID）、呼叫 API、付款、登入
import assert from 'node:assert/strict';
import { FakeD1 } from './d1.js';
import { handle } from '../../src/index.js';
import { generateCheckMacValue } from '../../src/ecpay.js';
import { buildSeedSql, loadSeedList } from '../../scripts/seed-episodes.mjs';
import { FakeKV } from './kv.js';

// 假的 YouTube ID（11 碼）：u01-A → yt_u01A____ 這種，不是真的影片
export const fakeYt = Object.fromEntries(
  loadSeedList().map((e) => [e.id, { videoId: `yt_${e.id.replace('-', '')}`.padEnd(11, '_').slice(0, 11) }]),
);

export const SITE = 'https://mralleys.com';
export const API = 'https://course-api.mralleys.com';
// 綠界公開的測試特店（官方文件範例用的那組），不是正式金鑰
export const KEY = 'pwFHCqoQZGmho4w6';
export const IV = 'EkRm7iFT261dpevs';

export function makeEnv(over = {}) {
  const DB = new FakeD1();
  DB.sqlite.exec(buildSeedSql(loadSeedList(), fakeYt, Date.UTC(2026, 10, 1)));
  return {
    DB,
    HOMEWORK_FILES: new FakeKV(),
    SITE_ORIGIN: SITE,
    API_ORIGIN: API,
    ALLOWED_ORIGINS: SITE,
    ECPAY_ENV: 'stage',
    ECPAY_MERCHANT_ID: '3002607',
    ECPAY_HASH_KEY: KEY,
    ECPAY_HASH_IV: IV,
    PREORDER_OPEN: 'true',
    PREORDER_PRICE: '2480',
    COURSE_OPEN: 'false',
    PREVIEW_EMAILS: '',
    BUNNY_LIBRARY_ID: '12345',
    BUNNY_TOKEN_KEY: 'bunny-test-key',
    CODE_PEPPER: 'pepper',
    ADMIN_TOKEN: 'admin-token-0123456789abcdef',
    ...over,
  };
}

export function makeHarness(over) {
  const env = makeEnv(over);
  const mail = [];
  const pending = [];
  let clock = Date.UTC(2026, 10, 4, 8, 0, 0);
  const deps = {
    now: () => clock,
    sendEmail: async (_env, msg) => {
      if (deps.failMail) throw new Error('smtp down');
      mail.push(msg);
    },
  };
  const ctx = { waitUntil: (p) => pending.push(p) };
  const call = async (method, path, { body, headers = {}, form, multipart } = {}) => {
    const h = new Headers(headers);
    let payload;
    if (multipart) {
      payload = multipart; // FormData：Request 自己會帶 boundary
    } else if (form) {
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
  return { env, mail, call, advance, deps, now: () => clock };
}

export const fromSite = (extra = {}) => ({ Origin: SITE, 'CF-Connecting-IP': '1.2.3.4', ...extra });
export const cookieOf = (res) => (res.headers.get('Set-Cookie') || '').split(';')[0];

export async function paidCallback(h, merchantTradeNo, over = {}) {
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
    TradeAmt: '2480',
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

export async function preorder(h, email = 'Buyer@Example.com') {
  const res = await h.call('POST', '/api/orders', {
    headers: fromSite(),
    body: { email, name: '小明', agreeRefund: true, marketingOptIn: true },
  });
  assert.equal(res.status, 200);
  return res.json();
}

export async function login(h, email = 'buyer@example.com', ua = 'ua') {
  const r1 = await h.call('POST', '/api/auth/request-code', { headers: fromSite(), body: { email } });
  assert.equal(r1.status, 200);
  const code = h.mail.at(-1).subject.match(/(\d{6})/)[1];
  const r2 = await h.call('POST', '/api/auth/verify', { headers: fromSite({ 'User-Agent': ua }), body: { email, code } });
  assert.equal(r2.status, 200);
  return cookieOf(r2);
}

