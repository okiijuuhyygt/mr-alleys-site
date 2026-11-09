#!/usr/bin/env node
// simulate-callback.mjs — 本機測試用：假裝自己是綠界，對 ReturnURL 送一筆「付款成功」
//
// 綠界的伺服器打不到你的 localhost，所以本機要測「付款 → 開通 → 寄信」只能這樣模擬。
// 簽章用的是綠界公開測試特店的 HashKey/HashIV（跟 .dev.vars.example 同一組）。
//
// 用法：
//   node scripts/simulate-callback.mjs <MerchantTradeNo> [金額=2480] [API=http://localhost:8787]

import { generateCheckMacValue } from '../src/ecpay.js';

const [tradeNo, amount = '2480', api = 'http://localhost:8787'] = process.argv.slice(2);
if (!tradeNo) {
  console.error('用法：node scripts/simulate-callback.mjs <MerchantTradeNo> [金額] [API]');
  process.exit(1);
}
const KEY = process.env.ECPAY_HASH_KEY || 'pwFHCqoQZGmho4w6';
const IV = process.env.ECPAY_HASH_IV || 'EkRm7iFT261dpevs';

const p = {
  MerchantID: process.env.ECPAY_MERCHANT_ID || '3002607',
  MerchantTradeNo: tradeNo,
  PaymentDate: '2026/11/04 16:01:00',
  PaymentType: 'Credit_CreditCard',
  PaymentTypeChargeFee: '0',
  RtnCode: '1',
  RtnMsg: '交易成功',
  SimulatePaid: '1',
  StoreID: '',
  TradeAmt: String(amount),
  TradeDate: '2026/11/04 16:00:10',
  TradeNo: `SIM${Date.now()}`.slice(0, 20),
  CustomField1: '',
  CustomField2: '',
  CustomField3: '',
  CustomField4: '',
};
p.CheckMacValue = await generateCheckMacValue(p, KEY, IV);

const res = await fetch(`${api}/api/ecpay/return`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(p),
});
console.log(res.status, await res.text());
