// 2026-11-10 全面檢查補的測試：頻率限制的漏洞、訂單狀態的終點、綠界回呼的各種重送
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, fromSite, paidCallback, preorder } from './helpers/harness.js';

test('建預購單：「已經買過」的回覆也算進頻率限制，不能無限次拿 email 來問誰買過', async () => {
  const h = makeHarness();
  const o = await preorder(h); // 這個 IP 的第 1 次
  await paidCallback(h, o.merchantTradeNo);
  const ask = (ip = '1.2.3.4') =>
    h.call('POST', '/api/orders', { headers: fromSite({ 'CF-Connecting-IP': ip }), body: { email: 'buyer@example.com', agreeRefund: true } });
  for (let i = 0; i < 19; i++) assert.equal((await ask()).status, 409, `第 ${i + 2} 次還在額度內：回已經買過`);
  assert.equal((await ask()).status, 429, '同一個 IP 一小時 20 次之後就擋，不再回答買過沒');
  assert.equal((await ask('5.6.7.8')).status, 409, '別的 IP 不受影響');
  h.advance(3600 * 1000 + 1);
  assert.equal((await ask()).status, 409, '過一小時恢復');
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1, '沒有多建訂單');
});

test('綠界 callback：已退款的訂單是終點，補發通知不會把權限又打開', async () => {
  const h = makeHarness();
  const o = await preorder(h);
  await paidCallback(h, o.merchantTradeNo);
  assert.equal(h.mail.length, 1, '付款確認信一封');
  // 退款（README 的維運指令做的事）
  h.env.DB.sqlite.prepare("UPDATE orders SET status = 'refunded' WHERE merchant_trade_no = ?").run(o.merchantTradeNo);
  h.env.DB.sqlite.prepare("UPDATE members SET access = 'revoked' WHERE email = 'buyer@example.com'").run();
  // 綠界後台補發同一筆付款成功通知（簽章是對的）
  const again = await paidCallback(h, o.merchantTradeNo);
  assert.equal(await again.text(), '1|OK', '照樣回 1|OK，綠界才不會一直重送');
  assert.equal(h.env.DB.sqlite.prepare('SELECT status FROM orders').get().status, 'refunded', '訂單維持已退款');
  assert.equal(h.env.DB.sqlite.prepare('SELECT access FROM members').get().access, 'revoked', '看課權限維持關閉');
  assert.equal(h.mail.length, 1, '不會再寄一次預購完成信');
});

test('綠界 callback：先失敗、同一筆後來刷成功 → 開通，確認信只寄一次；之後再重送也不重寄', async () => {
  const h = makeHarness();
  const o = await preorder(h);
  await paidCallback(h, o.merchantTradeNo, { RtnCode: '10100058', RtnMsg: '付款失敗' });
  assert.equal(h.env.DB.sqlite.prepare('SELECT status FROM orders').get().status, 'failed');
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get().n, 0);
  assert.equal(h.mail.length, 0);
  await paidCallback(h, o.merchantTradeNo);
  assert.equal(h.env.DB.sqlite.prepare('SELECT status FROM orders').get().status, 'paid');
  assert.equal(h.env.DB.sqlite.prepare('SELECT access FROM members').get().access, 'active');
  assert.equal(h.mail.length, 1);
  // 已付款之後收到「失敗」的舊通知：不能把已付款打回失敗
  await paidCallback(h, o.merchantTradeNo, { RtnCode: '10100058', RtnMsg: '付款失敗' });
  assert.equal(h.env.DB.sqlite.prepare('SELECT status FROM orders').get().status, 'paid');
  assert.equal(h.mail.length, 1);
});

test('綠界 callback：別家特店編號、不存在的訂單都不開通', async () => {
  const h = makeHarness();
  const o = await preorder(h);
  const other = await paidCallback(h, o.merchantTradeNo, { MerchantID: '2000132' });
  assert.equal(other.status, 400);
  const ghost = await paidCallback(h, 'MA999999999999ZZZZ');
  assert.equal(ghost.status, 404);
  assert.equal(h.env.DB.sqlite.prepare('SELECT status FROM orders').get().status, 'pending');
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get().n, 0);
  assert.equal(h.mail.length, 0);
});
