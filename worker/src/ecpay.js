// ecpay.js — 綠界 AioCheckOut（信用卡）＋ CheckMacValue
//
// 規格來源：綠界全方位金流 API 技術文件「檢查碼機制」（EncryptType=1，SHA256）
//   https://developers.ecpay.com.tw/?p=2902
// 測試向量（test/ecpay.test.js）就是那頁的官方範例，算出來不一樣就是這裡寫錯。
//
// 只用 Web Crypto（crypto.subtle），Cloudflare Workers 跟 Node 18+ 都能跑。

export const ECPAY_ENDPOINTS = {
  stage: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5',
  prod: 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5',
};

/**
 * 綠界要的是 .NET HttpUtility.UrlEncode 的結果再轉小寫。
 * encodeURIComponent 跟它只差三處：空白（%20 → +）、~、'。
 * 綠界文件那張「特殊字元置換表」（- _ . ! * ( ) 不編碼）encodeURIComponent 本來就不編碼。
 * @param {string} s
 */
export function dotNetUrlEncodeLower(s) {
  return encodeURIComponent(s)
    .toLowerCase()
    .replace(/'/g, '%27')
    .replace(/~/g, '%7e')
    .replace(/%20/g, '+');
}

/** @param {string} s */
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 組出要拿去雜湊的原始字串（測試用得到，所以拆出來）。
 * 1. 去掉 CheckMacValue 本身
 * 2. 參數名 A→Z 排序（不分大小寫，跟綠界官方 SDK 一樣）
 * 3. 前面接 HashKey=…，後面接 HashIV=…
 * @param {Record<string, string|number>} params
 * @param {string} hashKey
 * @param {string} hashIV
 */
export function checkMacRawString(params, hashKey, hashIV) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'CheckMacValue')
    .sort((a, b) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  const body = keys.map((k) => `${k}=${params[k]}`).join('&');
  return `HashKey=${hashKey}&${body}&HashIV=${hashIV}`;
}

/**
 * @param {Record<string, string|number>} params
 * @param {string} hashKey
 * @param {string} hashIV
 * @returns {Promise<string>} 64 碼大寫 hex
 */
export async function generateCheckMacValue(params, hashKey, hashIV) {
  const raw = checkMacRawString(params, hashKey, hashIV);
  return (await sha256Hex(dotNetUrlEncodeLower(raw))).toUpperCase();
}

/** 不會因為比較時間洩漏「前幾碼對了」的字串比較 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * 驗證綠界打回來的參數（ReturnURL 的 POST body）。
 * @param {Record<string, string>} params
 * @param {string} hashKey
 * @param {string} hashIV
 */
export async function verifyCheckMacValue(params, hashKey, hashIV) {
  const got = String(params.CheckMacValue || '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(got)) return false;
  const want = await generateCheckMacValue(params, hashKey, hashIV);
  return timingSafeEqual(got, want);
}

/**
 * 綠界要台灣時間 yyyy/MM/dd HH:mm:ss。Worker 跑在 UTC，自己加 8 小時。
 * @param {number} ms epoch 毫秒
 */
export function formatTaipeiDate(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * 特店訂單編號：英數 20 碼內、不可重複。格式 MA + yyMMddHHmmss（台灣時間）+ 4 碼亂數。
 * @param {number} ms
 */
export function newMerchantTradeNo(ms) {
  const t = formatTaipeiDate(ms).replace(/[^0-9]/g, '').slice(2); // yyMMddHHmmss
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(4));
  const suffix = [...r].map((b) => alphabet[b % alphabet.length]).join('');
  return `MA${t}${suffix}`; // 18 碼
}

/**
 * 組 AioCheckOut 表單欄位（含 CheckMacValue）。前端拿去 auto-submit 到 action。
 * @param {object} o
 * @param {string} o.merchantId
 * @param {string} o.hashKey
 * @param {string} o.hashIV
 * @param {'stage'|'prod'} o.env
 * @param {string} o.merchantTradeNo
 * @param {number} o.nowMs
 * @param {number} o.amount  整數新台幣
 * @param {string} o.itemName
 * @param {string} o.tradeDesc
 * @param {string} o.returnURL   伺服器端通知（我們的 Worker）
 * @param {string} o.clientBackURL 付款完「返回商店」按鈕
 * @param {string} [o.customField1]
 */
export async function buildAioCheckOut(o) {
  if (!Number.isInteger(o.amount) || o.amount <= 0) throw new Error('amount must be a positive integer');
  /** @type {Record<string,string>} */
  const fields = {
    MerchantID: o.merchantId,
    MerchantTradeNo: o.merchantTradeNo,
    MerchantTradeDate: formatTaipeiDate(o.nowMs),
    PaymentType: 'aio',
    TotalAmount: String(o.amount),
    TradeDesc: o.tradeDesc,
    ItemName: o.itemName,
    ReturnURL: o.returnURL,
    ChoosePayment: 'Credit',
    EncryptType: '1',
    ClientBackURL: o.clientBackURL,
    NeedExtraPaidInfo: 'N',
  };
  if (o.customField1) fields.CustomField1 = o.customField1;
  fields.CheckMacValue = await generateCheckMacValue(fields, o.hashKey, o.hashIV);
  const action = ECPAY_ENDPOINTS[o.env] || ECPAY_ENDPOINTS.stage;
  return { action, fields };
}
