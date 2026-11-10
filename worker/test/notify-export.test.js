// 有人付款時通知店主、後台下載名單／訂單
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SITE, makeHarness, fromSite, paidCallback, preorder } from './helpers/harness.js';

const here = dirname(fileURLToPath(import.meta.url));

test('有人付款：通知信寄給店主（買家、訂單編號、金額、目前幾筆），買家的確認信照寄；綠界重送不重寄', async () => {
  const h = makeHarness({ OWNER_NOTIFY_EMAIL: 'owner@example.com' });
  const o = await preorder(h);
  assert.equal(h.mail.length, 0, '只是建單、還沒付款：不通知');
  await paidCallback(h, o.merchantTradeNo);
  assert.equal(h.mail.length, 2);
  const [buyer, owner] = h.mail;
  assert.equal(buyer.to, 'buyer@example.com');
  assert.equal(buyer.subject, '預購完成：寫歌課・線上第一期');
  assert.equal(owner.to, 'owner@example.com');
  assert.equal(owner.subject, '線上課預購 +1（目前 1 筆）');
  assert.match(owner.text, /小明 <buyer@example\.com>/);
  assert.ok(owner.text.includes(`訂單：${o.merchantTradeNo}`));
  assert.match(owner.text, /金額：NT\$2480/);
  assert.match(owner.text, /目前已付款：1 筆/);
  assert.ok(owner.html.includes('buyer@example.com'));
  await paidCallback(h, o.merchantTradeNo);
  assert.equal(h.mail.length, 2, '綠界重送同一筆：店主不會收到第二封');

  // 第二個人付款：筆數往上加
  const o2 = await preorder(h, 'second@example.com');
  await paidCallback(h, o2.merchantTradeNo, { TradeNo: '2611041600109999' });
  assert.equal(h.mail.at(-1).to, 'owner@example.com');
  assert.equal(h.mail.at(-1).subject, '線上課預購 +1（目前 2 筆）');
});

test('有人付款：付款失敗、金額不符、正式環境的模擬付款都不通知店主；沒設通知信箱就只寄買家那封', async () => {
  const h = makeHarness({ OWNER_NOTIFY_EMAIL: 'owner@example.com' });
  const a = await preorder(h, 'a@example.com');
  await paidCallback(h, a.merchantTradeNo, { RtnCode: '10100058', RtnMsg: '付款失敗' });
  const b = await preorder(h, 'b@example.com');
  await paidCallback(h, b.merchantTradeNo, { TradeAmt: '1' });
  assert.equal(h.mail.length, 0);

  const prod = makeHarness({ OWNER_NOTIFY_EMAIL: 'owner@example.com', ECPAY_ENV: 'prod' });
  const c = await preorder(prod);
  await paidCallback(prod, c.merchantTradeNo, { SimulatePaid: '1' });
  assert.equal(prod.mail.length, 0);

  const off = makeHarness({ OWNER_NOTIFY_EMAIL: '' });
  const d = await preorder(off);
  await paidCallback(off, d.merchantTradeNo);
  assert.deepEqual(off.mail.map((m) => m.to), ['buyer@example.com']);
});

test('正式環境的設定檔：付款通知信箱有填（只有這個設定跟 11/9 不一樣）', () => {
  const toml = readFileSync(join(here, '..', 'wrangler.toml'), 'utf8');
  const prod = toml.slice(toml.indexOf('[env.production.vars]'));
  assert.match(prod, /^OWNER_NOTIFY_EMAIL = "hao@mralleys\.com"/m);
  assert.match(prod, /^HOMEWORK_NOTIFY_EMAIL = "hao@mralleys\.com"/m);
  assert.match(prod, /^EMAIL_MODE = "send"/m);
  assert.match(prod, /^PREORDER_PRICE = "2480"/m);
});

test('後台下載名單／訂單：要後台密碼；從網站的後台頁面抓得到（帶跨站標頭）；訂單含還沒付的', async () => {
  const h = makeHarness();
  const paid = await preorder(h);
  await paidCallback(h, paid.merchantTradeNo);
  const pending = await preorder(h, 'later@example.com');
  const AD = { Authorization: `Bearer ${h.env.ADMIN_TOKEN}`, Origin: SITE };

  for (const type of ['orders', 'members']) {
    const path = `/api/admin/export.csv?type=${type}`;
    assert.equal((await h.call('GET', path)).status, 401, `${type}：沒帶密碼`);
    assert.equal((await h.call('GET', path, { headers: { Authorization: 'Bearer wrong-wrong-wrong-wrong-wrong' } })).status, 401, `${type}：錯的密碼`);
    assert.equal((await h.call('GET', path, { headers: { 'X-MA-Admin': h.env.ADMIN_TOKEN } })).status, 401, `${type}：導師身份那個標頭不能拿來下載`);
    const ok = await h.call('GET', path, { headers: AD });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('Content-Type'), /^text\/csv/);
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), SITE, '後台頁面在 mralleys.com，用 fetch 下載要有這個標頭');
    assert.equal(ok.headers.get('Cache-Control'), 'no-store');
    const evil = await h.call('GET', path, { headers: { ...AD, Origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null, '別的網站拿不到跨站標頭');
  }

  const orders = await (await h.call('GET', '/api/admin/export.csv?type=orders', { headers: AD })).text();
  assert.match(orders, /merchant_trade_no,email,name,amount,status,/);
  assert.ok(orders.includes(`${paid.merchantTradeNo},buyer@example.com,小明,2480,paid,`));
  assert.ok(orders.includes(`${pending.merchantTradeNo},later@example.com,小明,2480,pending,`), '還沒付的訂單也列出來');
  const members = await (await h.call('GET', '/api/admin/export.csv?type=members', { headers: AD })).text();
  assert.match(members, /buyer@example\.com,小明,active,/);
  assert.ok(!members.includes('later@example.com'), '沒付款的人不在學員名單');
  // 預檢請求（瀏覽器帶 Authorization 之前會先問一次）
  const pre = await h.call('OPTIONS', '/api/admin/export.csv?type=orders', { headers: { Origin: SITE, 'Access-Control-Request-Headers': 'authorization' } });
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
});

test('建預購單：email 以伺服器收到的那一個為準（轉小寫、去空白），不合法的不建單', async () => {
  const h = makeHarness();
  const post = (email) => h.call('POST', '/api/orders', { headers: fromSite(), body: { email, agreeRefund: true } });
  assert.equal((await post('  Mixed.Case@Example.COM  ')).status, 200);
  assert.equal(h.env.DB.sqlite.prepare('SELECT email FROM orders').get().email, 'mixed.case@example.com');
  for (const bad of ['a@b', 'a b@c.tw', '@example.com', 'someone@', '', null]) assert.equal((await post(bad)).status, 400, String(bad));
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
});
