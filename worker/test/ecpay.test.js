import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkMacRawString,
  dotNetUrlEncodeLower,
  generateCheckMacValue,
  verifyCheckMacValue,
  formatTaipeiDate,
  newMerchantTradeNo,
  buildAioCheckOut,
  ECPAY_ENDPOINTS,
} from '../src/ecpay.js';

// 綠界官方文件「檢查碼機制」的範例（https://developers.ecpay.com.tw/?p=2902）
// 這組 HashKey / HashIV 是綠界公開的測試特店，不是我們的。
const DOC_KEY = 'pwFHCqoQZGmho4w6';
const DOC_IV = 'EkRm7iFT261dpevs';
const DOC_PARAMS = {
  ChoosePayment: 'ALL',
  EncryptType: '1',
  ItemName: 'Apple iphone 15',
  MerchantID: '3002607',
  MerchantTradeDate: '2023/03/12 15:30:23',
  MerchantTradeNo: 'ecpay20230312153023',
  PaymentType: 'aio',
  ReturnURL: 'https://www.ecpay.com.tw/receive.php',
  TotalAmount: '30000',
  TradeDesc: '促銷方案',
};
const DOC_CMV = '6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840';

test('CheckMacValue：原始字串跟官方步驟 2 一樣', () => {
  assert.equal(
    checkMacRawString(DOC_PARAMS, DOC_KEY, DOC_IV),
    'HashKey=pwFHCqoQZGmho4w6&ChoosePayment=ALL&EncryptType=1&ItemName=Apple iphone 15&MerchantID=3002607&MerchantTradeDate=2023/03/12 15:30:23&MerchantTradeNo=ecpay20230312153023&PaymentType=aio&ReturnURL=https://www.ecpay.com.tw/receive.php&TotalAmount=30000&TradeDesc=促銷方案&HashIV=EkRm7iFT261dpevs',
  );
});

test('CheckMacValue：編碼＋轉小寫跟官方步驟 4 一樣', () => {
  assert.equal(
    dotNetUrlEncodeLower(checkMacRawString(DOC_PARAMS, DOC_KEY, DOC_IV)),
    'hashkey%3dpwfhcqoqzgmho4w6%26choosepayment%3dall%26encrypttype%3d1%26itemname%3dapple+iphone+15%26merchantid%3d3002607%26merchanttradedate%3d2023%2f03%2f12+15%3a30%3a23%26merchanttradeno%3decpay20230312153023%26paymenttype%3daio%26returnurl%3dhttps%3a%2f%2fwww.ecpay.com.tw%2freceive.php%26totalamount%3d30000%26tradedesc%3d%e4%bf%83%e9%8a%b7%e6%96%b9%e6%a1%88%26hashiv%3dekrm7ift261dpevs',
  );
});

test('CheckMacValue：最終值跟官方範例一樣', async () => {
  assert.equal(await generateCheckMacValue(DOC_PARAMS, DOC_KEY, DOC_IV), DOC_CMV);
});

test('CheckMacValue：參數順序、CheckMacValue 欄位本身都不影響結果', async () => {
  const shuffled = Object.fromEntries(Object.entries(DOC_PARAMS).reverse());
  assert.equal(await generateCheckMacValue({ ...shuffled, CheckMacValue: 'whatever' }, DOC_KEY, DOC_IV), DOC_CMV);
});

test('URL 編碼：.NET 風格特殊字元', () => {
  // 空白→+、~→%7e、'→%27；- _ . ! * ( ) 保留
  assert.equal(dotNetUrlEncodeLower("a b~c'd-_.!*()"), "a+b%7ec%27d-_.!*()");
});

test('verifyCheckMacValue：正確的通過、竄改任何欄位就失敗', async () => {
  const signed = { ...DOC_PARAMS, CheckMacValue: DOC_CMV };
  assert.equal(await verifyCheckMacValue(signed, DOC_KEY, DOC_IV), true);
  assert.equal(await verifyCheckMacValue({ ...signed, CheckMacValue: DOC_CMV.toLowerCase() }, DOC_KEY, DOC_IV), true);
  assert.equal(await verifyCheckMacValue({ ...signed, TotalAmount: '1' }, DOC_KEY, DOC_IV), false);
  assert.equal(await verifyCheckMacValue({ ...signed, Extra: 'x' }, DOC_KEY, DOC_IV), false);
  assert.equal(await verifyCheckMacValue(signed, DOC_KEY, 'wrongIV'), false);
  assert.equal(await verifyCheckMacValue({ ...DOC_PARAMS }, DOC_KEY, DOC_IV), false);
  assert.equal(await verifyCheckMacValue({ ...signed, CheckMacValue: 'zz' }, DOC_KEY, DOC_IV), false);
});

test('formatTaipeiDate：UTC 轉台灣時間', () => {
  // 2026-11-04T16:05:09Z = 台灣 2026/11/05 00:05:09
  assert.equal(formatTaipeiDate(Date.UTC(2026, 10, 4, 16, 5, 9)), '2026/11/05 00:05:09');
});

test('newMerchantTradeNo：20 碼內、英數、不重複', () => {
  const now = Date.UTC(2026, 10, 4, 8, 0, 0);
  const set = new Set();
  for (let i = 0; i < 200; i++) {
    const no = newMerchantTradeNo(now);
    assert.match(no, /^MA261104160000[A-Z0-9]{4}$/);
    assert.ok(no.length <= 20);
    set.add(no);
  }
  assert.ok(set.size > 190);
});

test('buildAioCheckOut：欄位齊全、簽章可被自己驗過', async () => {
  const { action, fields } = await buildAioCheckOut({
    merchantId: '3002607',
    hashKey: DOC_KEY,
    hashIV: DOC_IV,
    env: 'stage',
    merchantTradeNo: 'MA2611041600001234',
    nowMs: Date.UTC(2026, 10, 4, 8, 0, 0),
    amount: 1480,
    itemName: '寫歌課・線上第一期（預購）',
    tradeDesc: '巷弄故事館線上寫歌課預購',
    returnURL: 'https://course-api.example/api/ecpay/return',
    clientBackURL: 'https://example/course-online/thanks.html',
  });
  assert.equal(action, ECPAY_ENDPOINTS.stage);
  assert.equal(fields.ChoosePayment, 'Credit');
  assert.equal(fields.TotalAmount, '1480');
  assert.equal(fields.MerchantTradeDate, '2026/11/04 16:00:00');
  assert.equal(await verifyCheckMacValue(fields, DOC_KEY, DOC_IV), true);
  await assert.rejects(() => buildAioCheckOut({ amount: 14.8 }));
});
