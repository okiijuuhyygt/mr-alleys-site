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
