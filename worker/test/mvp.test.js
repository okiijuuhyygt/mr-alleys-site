// MVP：免費集／付費集、付款解鎖、交作業＋即時通知、後台補片與排序、Gmail API 寄信
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeYt, makeHarness, fromSite, paidCallback, preorder, login, SITE } from './helpers/harness.js';
import { parseYoutubeId } from '../src/episodes.js';
import { sendEmail, buildMimeRaw, parseAddress } from '../src/email.js';
import { safeFileName, fileAllowed } from '../src/homework.js';

const ADMIN = { Authorization: 'Bearer admin-token-0123456789abcdef' };

async function paidMember(over = {}, email = 'buyer@example.com') {
  const h = makeHarness({ COURSE_OPEN: 'true', HOMEWORK_NOTIFY_EMAIL: 'team@mralleys.com', ...over });
  const o = await preorder(h, email);
  await paidCallback(h, o.merchantTradeNo);
  const ck = await login(h, email);
  return { h, ck };
}

function hwForm(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

// ---------------------------------------------------------------- 免費集／付費集

test('沒登入：課程目錄看得到，每單元第一集可以播，其他集鎖住、不給標題與 YouTube ID', async () => {
  const h = makeHarness({ COURSE_OPEN: 'true' });
  const r = await h.call('GET', '/api/course', { headers: fromSite() });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.member, false);
  assert.equal(d.price, 2480);
  assert.equal(d.course.units.length, 4);
  for (const u of d.course.units) {
    assert.equal(u.episodes[0].free, true);
    assert.equal(u.episodes[0].unlocked, true);
    assert.ok(u.episodes.slice(1).every((e) => !e.free && !e.unlocked && e.title === null));
    assert.equal(u.task, null);
  }
  assert.ok(!Object.values(fakeYt).some((y) => JSON.stringify(d).includes(y.videoId)));

  const free = await h.call('GET', '/api/video?id=u02-A', { headers: fromSite() });
  assert.equal(free.status, 200);
  assert.match((await free.json()).embedUrl, new RegExp(`^https://www\\.youtube-nocookie\\.com/embed/${fakeYt['u02-A'].videoId}\\?`));

  const paid = await h.call('GET', '/api/video?id=u02-B', { headers: fromSite() });
  assert.equal(paid.status, 401);
  assert.equal((await paid.json()).error, 'locked');
  assert.equal((await h.call('GET', '/api/video?id=nope', { headers: fromSite() })).status, 404);
});

test('FREE_EPISODES_OPEN=true：課程還沒開也先放免費集；付費集照樣等開課', async () => {
  const h = makeHarness({ COURSE_OPEN: 'false', FREE_EPISODES_OPEN: 'true' });
  assert.equal((await h.call('GET', '/api/video?id=u01-A', { headers: fromSite() })).status, 200);
  const o = await preorder(h);
  await paidCallback(h, o.merchantTradeNo);
  const ck = await login(h);
  assert.equal((await h.call('GET', '/api/video?id=u01-B', { headers: fromSite({ Cookie: ck }) })).status, 403);
});

test('付款解鎖：付款前鎖住 → 綠界 callback → 登入 → 付費集可以播、目錄全部解鎖', async () => {
  const h = makeHarness({ COURSE_OPEN: 'true' });
  assert.equal((await h.call('GET', '/api/video?id=u03-C', { headers: fromSite() })).status, 401);
  const o = await preorder(h);
  assert.equal((await paidCallback(h, o.merchantTradeNo)).status, 200);
  const ck = await login(h);
  const v = await h.call('GET', '/api/video?id=u03-C', { headers: fromSite({ Cookie: ck }) });
  assert.equal(v.status, 200);
  assert.ok((await v.json()).embedUrl.includes(fakeYt['u03-C'].videoId));
  const d = await (await h.call('GET', '/api/course', { headers: fromSite({ Cookie: ck }) })).json();
  assert.equal(d.member, true);
  assert.equal(d.canWatch, true);
  assert.ok(d.course.units.every((u) => u.episodes.every((e) => e.unlocked && e.title)));
  assert.ok(d.course.units[0].task);
});

test('live 規則：還沒定，只把 LIVE_RULE 設定值帶給前端', async () => {
  const h = makeHarness({ LIVE_RULE: '' });
  assert.deepEqual((await (await h.call('GET', '/api/course')).json()).live, { rule: null });
  const h2 = makeHarness({ LIVE_RULE: 'per_unit' });
  assert.deepEqual((await (await h2.call('GET', '/api/course')).json()).live, { rule: 'per_unit' });
});

// ---------------------------------------------------------------- 交作業

test('交作業：文字＋檔案 → D1＋KV → 即時寄信通知我們 → 自己看得到 → 後台看得到、下載、標記', async () => {
  const { h, ck } = await paidMember();
  const audio = new File([new Uint8Array([1, 2, 3, 4, 5])], '我的 demo.m4a', { type: 'audio/mp4' });
  const before = h.mail.length;
  const r = await h.call('POST', '/api/homework', {
    headers: fromSite({ Cookie: ck }),
    multipart: hwForm({ unitId: 'u1', body: '窗邊那杯沒喝完的咖啡\n第二句', file: audio }),
  });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  assert.match(id, /^hw_[a-z0-9]{12}$/);

  const row = h.env.DB.sqlite.prepare('SELECT * FROM homework WHERE id = ?').get(id);
  assert.equal(row.email, 'buyer@example.com');
  assert.equal(row.unit_id, 'u1');
  assert.equal(row.file_name, '我的 demo.m4a');
  assert.equal(row.file_size, 5);
  assert.ok(row.notified_at, '通知已寄');
  assert.equal(h.env.HOMEWORK_FILES.store.get(row.file_key).metadata.email, 'buyer@example.com');

  assert.equal(h.mail.length, before + 1);
  const n = h.mail.at(-1);
  assert.equal(n.to, 'team@mralleys.com');
  assert.equal(n.subject, '交作業：第 1 單元｜小明');
  assert.match(n.text, /窗邊那杯沒喝完的咖啡/);
  assert.match(n.text, /我的 demo\.m4a/);
  assert.ok(n.text.includes(`${SITE}/course-online/admin/#homework`));

  const mine = await (await h.call('GET', '/api/homework?unitId=u1', { headers: fromSite({ Cookie: ck }) })).json();
  assert.equal(mine.homework.length, 1);
  assert.equal(mine.homework[0].status, 'new');
  assert.equal(mine.homework[0].file_key, undefined, '不給學員 KV key');

  assert.equal((await h.call('GET', '/api/admin/homework')).status, 401);
  const list = await (await h.call('GET', '/api/admin/homework', { headers: ADMIN })).json();
  assert.equal(list.homework[0].id, id);
  assert.equal(list.homework[0].name, '小明');
  const file = await h.call('GET', `/api/admin/homework/file?id=${id}`, { headers: ADMIN });
  assert.equal(file.status, 200);
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1, 2, 3, 4, 5]);
  assert.match(file.headers.get('Content-Disposition'), /filename\*=UTF-8''/);

  const st = await h.call('POST', '/api/admin/homework/status', { headers: ADMIN, body: { id, status: 'reviewed' } });
  assert.equal(st.status, 200);
  const mine2 = await (await h.call('GET', '/api/homework?unitId=u1', { headers: fromSite({ Cookie: ck }) })).json();
  assert.equal(mine2.homework[0].status, 'reviewed');
  assert.equal((await (await h.call('GET', '/api/admin/homework?status=new', { headers: ADMIN })).json()).homework.length, 0);
});

test('交作業：沒登入、別的網站、空白、檔案太大、檔案類型不對、單元不存在都擋', async () => {
  const { h, ck } = await paidMember({ HOMEWORK_MAX_MB: '1' });
  const post = (fields, headers = fromSite({ Cookie: ck })) => h.call('POST', '/api/homework', { headers, multipart: hwForm(fields) });
  assert.equal((await post({ unitId: 'u1', body: 'hi' }, fromSite())).status, 401);
  assert.equal((await post({ unitId: 'u1', body: 'hi' }, { Origin: 'https://evil.example', Cookie: ck })).status, 403);
  const empty = await post({ unitId: 'u1', body: '   ' });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, 'homework_empty');
  const big = await post({ unitId: 'u1', file: new File([new Uint8Array(1024 * 1024 + 1)], 'a.wav', { type: 'audio/wav' }) });
  assert.equal(big.status, 413);
  const exe = await post({ unitId: 'u1', file: new File(['x'], 'run.exe', { type: 'application/x-msdownload' }) });
  assert.equal((await exe.json()).error, 'file_type');
  assert.equal((await post({ unitId: 'u9', body: 'hi' })).status, 400);
  assert.equal((await post({ unitId: 'u1', body: 'x'.repeat(5001) })).status, 400);
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM homework').get().n, 0);
});

test('交作業：通知信寄不出去，學員那邊照樣成功，後台看得到原因；沒設通知信箱也記下來', async () => {
  const { h, ck } = await paidMember();
  h.deps.failMail = true;
  const r = await h.call('POST', '/api/homework', { headers: fromSite({ Cookie: ck }), multipart: hwForm({ unitId: 'u2', body: '只有文字' }) });
  assert.equal(r.status, 200);
  const row = h.env.DB.sqlite.prepare('SELECT notified_at, notify_error, file_key FROM homework').get();
  assert.equal(row.notified_at, null);
  assert.match(row.notify_error, /smtp down/);
  assert.equal(row.file_key, null);

  const { h: h2, ck: ck2 } = await paidMember({ HOMEWORK_NOTIFY_EMAIL: '', OWNER_NOTIFY_EMAIL: '' });
  await h2.call('POST', '/api/homework', { headers: fromSite({ Cookie: ck2 }), multipart: hwForm({ unitId: 'u2', body: 'x' }) });
  assert.equal(h2.env.DB.sqlite.prepare('SELECT notify_error FROM homework').get().notify_error, 'no_notify_email');
});

test('交作業：沒有 KV 時，有附檔就回 upload_unavailable（純文字照收）', async () => {
  const { h, ck } = await paidMember({ HOMEWORK_FILES: undefined });
  const r = await h.call('POST', '/api/homework', {
    headers: fromSite({ Cookie: ck }),
    multipart: hwForm({ unitId: 'u1', file: new File(['a'], 'a.mp3', { type: 'audio/mpeg' }) }),
  });
  assert.equal(r.status, 503);
  assert.equal((await h.call('POST', '/api/homework', { headers: fromSite({ Cookie: ck }), multipart: hwForm({ unitId: 'u1', body: 'ok' }) })).status, 200);
});

test('檔名與檔案類型：擋路徑、留中文；常見錄音格式都收', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\x\\我的歌<1>.m4a'), '我的歌1.m4a');
  for (const n of ['a.m4a', 'a.MP3', 'a.wav', 'a.mov', 'a.pdf', 'a.HEIC']) assert.ok(fileAllowed(n, ''), n);
  assert.ok(fileAllowed('noext', 'audio/x-caf'));
  assert.ok(!fileAllowed('a.exe', 'application/octet-stream'));
});

// ---------------------------------------------------------------- 後台：補片、排序

test('後台補片：要 token；貼 YouTube 網址新增 → 排到第一個（免費集是勾選的，不跟著換）→ 勾免費 → 藏起來就不算免費 → 刪除', async () => {
  const h = makeHarness({ COURSE_OPEN: 'true' });
  assert.equal((await h.call('GET', '/api/admin/episodes')).status, 401);
  assert.equal((await h.call('POST', '/api/admin/episodes', { headers: { Authorization: 'Bearer nope' }, body: {} })).status, 401);

  const all = await (await h.call('GET', '/api/admin/episodes', { headers: ADMIN })).json();
  assert.equal(all.episodes.length, 34);
  assert.equal(all.episodes[0].youtube_id, fakeYt['u01-A'].videoId, '後台看得到 YouTube ID');

  const bad = await h.call('POST', '/api/admin/episodes', { headers: ADMIN, body: { unitId: 'u1', title: 'x', youtubeId: 'not a video' } });
  assert.equal((await bad.json()).error, 'bad_youtube_id');
  const c = await h.call('POST', '/api/admin/episodes', {
    headers: ADMIN,
    body: { unitId: 'u1', title: '補拍：示範音', youtubeId: 'https://youtu.be/AbCdEfGhIjK?si=x', minutes: 3 },
  });
  assert.equal(c.status, 200);
  const ep = (await c.json()).episode;
  assert.match(ep.id, /^u1-[a-z0-9]{6}$/);
  assert.equal(ep.youtube_id, 'AbCdEfGhIjK');
  assert.equal(ep.duration_sec, 180);
  assert.equal(ep.free, false, '新增的排在最後，不是免費集');

  const u1 = all.episodes.filter((e) => e.unit_id === 'u1').map((e) => e.id);
  assert.equal(
    (await (await h.call('POST', '/api/admin/episodes/reorder', { headers: ADMIN, body: { unitId: 'u1', ids: u1 } })).json()).error,
    'ids_mismatch',
    '漏排一集要擋',
  );
  const re = await h.call('POST', '/api/admin/episodes/reorder', { headers: ADMIN, body: { unitId: 'u1', ids: [ep.id, ...u1] } });
  assert.equal(re.status, 200);
  let pub = await (await h.call('GET', '/api/course')).json();
  assert.equal(pub.course.units[0].episodes[0].id, ep.id);
  assert.equal(pub.course.units[0].episodes[0].free, false, '排第一不會自動變免費');
  assert.equal(pub.course.units[0].episodes[1].free, true, 'u01-A 還是免費');
  assert.equal(pub.course.units[0].episodes.length, 10);

  await h.call('POST', '/api/admin/episodes/update', { headers: ADMIN, body: { id: ep.id, free: true } });
  pub = await (await h.call('GET', '/api/course')).json();
  assert.equal(pub.course.units[0].episodes[0].free, true, '勾了就免費');

  await h.call('POST', '/api/admin/episodes/update', { headers: ADMIN, body: { id: ep.id, published: false, title: '補拍：示範音（重錄）' } });
  pub = await (await h.call('GET', '/api/course')).json();
  assert.equal(pub.course.units[0].episodes[0].id, 'u01-A', '藏起來的學員看不到');
  assert.equal((await h.call('GET', `/api/video?id=${ep.id}`)).status, 404, '未發布的播不到');

  assert.equal((await h.call('POST', '/api/admin/episodes/update', { headers: ADMIN, body: { id: 'u01-B', youtubeId: 'ZZZZZZZZZZZ' } })).status, 200);
  assert.equal(h.env.DB.sqlite.prepare("SELECT youtube_id FROM episodes WHERE id = 'u01-B'").get().youtube_id, 'ZZZZZZZZZZZ');

  assert.equal((await h.call('POST', '/api/admin/episodes/delete', { headers: ADMIN, body: { id: ep.id } })).status, 200);
  assert.equal((await h.call('POST', '/api/admin/episodes/delete', { headers: ADMIN, body: { id: ep.id } })).status, 404);
});

test('後台 CORS：網站可以帶 Authorization 呼叫', async () => {
  const h = makeHarness();
  const pre = await h.call('OPTIONS', '/api/admin/episodes', { headers: { Origin: SITE } });
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  const r = await h.call('GET', '/api/admin/episodes', { headers: { Origin: SITE, ...ADMIN } });
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), SITE);
});

test('parseYoutubeId：ID、各種網址都吃，亂打的回 null', () => {
  const id = 'AbCdEfGhIjK';
  for (const s of [id, `https://youtu.be/${id}`, `https://www.youtube.com/watch?v=${id}&t=3`, `https://youtube.com/embed/${id}`, `https://m.youtube.com/shorts/${id}`]) {
    assert.equal(parseYoutubeId(s), id, s);
  }
  for (const s of ['', 'abc', 'https://vimeo.com/123', `https://evil.com/watch?v=${id}`]) assert.equal(parseYoutubeId(s), null, s);
});

// ---------------------------------------------------------------- 寄信：dry-run、Gmail API

test('寄信 dry-run：EMAIL_MODE=log 或 dry-run 都不打網路；正式環境不准 dry-run', async () => {
  let called = 0;
  const f = async () => {
    called += 1;
    return new Response('{}');
  };
  for (const mode of ['log', 'dry-run']) {
    const r = await sendEmail({ EMAIL_MODE: mode, EMAIL_PROVIDER: 'gmail', GMAIL_CLIENT_ID: 'x', GMAIL_CLIENT_SECRET: 'x', GMAIL_REFRESH_TOKEN: 'x' }, { to: 'a@b.tw', subject: 's', text: 't', html: 'h' }, f);
    assert.deepEqual(r, { logged: true });
  }
  assert.equal(called, 0);
  await assert.rejects(sendEmail({ EMAIL_MODE: 'log', ECPAY_ENV: 'prod' }, { to: 'a@b.tw', subject: 's', text: 't', html: 'h' }, f));
  await assert.rejects(sendEmail({ EMAIL_MODE: 'send', EMAIL_PROVIDER: 'gmail', ECPAY_ENV: 'prod' }, { to: 'a@b.tw', subject: 's', text: 't', html: 'h' }, f));
});

test('Gmail API：refresh token 換 access token → messages.send，信件是 UTF-8 MIME', async () => {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'ya29.test' }));
    return new Response(JSON.stringify({ id: 'msg1' }));
  };
  const env = {
    EMAIL_MODE: 'send',
    EMAIL_PROVIDER: 'gmail',
    GMAIL_CLIENT_ID: 'cid',
    GMAIL_CLIENT_SECRET: 'sec',
    GMAIL_REFRESH_TOKEN: 'rt',
    GMAIL_SENDER: '巷弄故事館 <hao@mralleys.com>',
    EMAIL_REPLY_TO: 'hao@mralleys.com',
  };
  const r = await sendEmail(env, { to: 'team@mralleys.com', subject: '交作業：第 1 單元｜小明', text: '內容', html: '<p>內容</p>' }, f);
  assert.deepEqual(r, { id: 'msg1' });
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.match(calls[0].init.body, /grant_type=refresh_token/);
  assert.equal(calls[1].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ya29.test');
  const raw = JSON.parse(calls[1].init.body).raw;
  assert.match(raw, /^[A-Za-z0-9_-]+$/, 'base64url');
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(mime, /^From: =\?UTF-8\?B\?.+\?= <hao@mralleys\.com>\r\n/);
  assert.match(mime, /\r\nTo: team@mralleys\.com\r\n/);
  const subj = mime.match(/Subject: =\?UTF-8\?B\?(.+?)\?=/)[1];
  assert.equal(Buffer.from(subj, 'base64').toString('utf8'), '交作業：第 1 單元｜小明');
  const parts = mime.split(/\r\n\r\n/);
  assert.ok(parts.some((p) => Buffer.from(p.split('\r\n--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8') === '內容'));
});

test('MIME：標頭擋換行注入；地址解析', () => {
  const mime = Buffer.from(buildMimeRaw({ from: 'a@b.tw', to: 'x@y.tw\r\nBcc: evil@z.tw', subject: 'hi\r\nBcc: evil@z.tw', text: 't', html: 'h' }), 'base64url').toString();
  assert.ok(!/\r\nBcc:/.test(mime));
  assert.deepEqual(parseAddress('巷弄故事館 <course@mralleys.com>'), { name: '巷弄故事館', address: 'course@mralleys.com' });
  assert.deepEqual(parseAddress('plain@x.tw'), { name: '', address: 'plain@x.tw' });
});

// ---------------------------------------------------------------- 後台：儲存到網站（一次存）

test('後台儲存：單元標題介紹、集數標題順序上下架免費、補片、刪除、試看開關，一次存好', async () => {
  const h = makeHarness({ COURSE_OPEN: 'false', FREE_EPISODES_OPEN: 'false' });
  assert.equal((await h.call('GET', '/api/admin/course')).status, 401);
  const before = await (await h.call('GET', '/api/admin/course', { headers: ADMIN })).json();
  assert.equal(before.units.length, 4);
  assert.equal(before.settings.freeOpen, false);
  assert.equal(before.status.paymentReady, true);
  const u2 = before.episodes.filter((e) => e.unit_id === 'u2');

  const body = {
    units: before.units.map((u) => (u.id === 'u1' ? { ...u, title: '冰山理論（改）', summary: '新的介紹' } : u)),
    episodes: [
      // u2：最後一集移到第一個並勾免費、原本第一集取消免費、第二集下架、補一集新的
      { ...pick(u2.at(-1)), free: true },
      ...u2.slice(0, -1).map((e, i) => ({ ...pick(e), free: false, published: i !== 1 })),
      { unitId: 'u2', title: '新的一集', youtubeId: 'https://www.youtube.com/watch?v=AbCdEfGhIjK', minutes: 2.5, free: false },
    ],
    deleted: ['u03-B'],
    settings: { freeOpen: true },
  };
  const r = await h.call('POST', '/api/admin/save', { headers: ADMIN, body });
  assert.equal(r.status, 200, await r.clone().text());

  const pub = await (await h.call('GET', '/api/course')).json();
  assert.equal(pub.course.units[0].title, '冰山理論（改）');
  assert.equal(pub.course.units[0].summary, '新的介紹');
  assert.equal(pub.freeOpen, true, '試看開關後台打開');
  const pu2 = pub.course.units[1].episodes;
  assert.equal(pu2[0].id, u2.at(-1).id);
  assert.equal(pu2[0].free, true);
  assert.equal(pu2[0].unlocked, true, '試看開了：免費集沒買也能看');
  assert.equal(pu2.length, u2.length, '下架一集＋新增一集');
  assert.ok(!pu2.some((e) => e.id === u2[1].id), '下架的看不到');
  assert.equal(pu2.at(-1).minutes, 3);
  assert.ok(!pub.course.units[2].episodes.some((e) => e.id === 'u03-B'), '刪掉的不見');
  assert.equal((await h.call('GET', `/api/video?id=${u2.at(-1).id}`)).status, 200);
  assert.equal((await h.call('GET', `/api/video?id=${u2[0].id}`)).status, 401, '取消免費就要買');

  // 試看關掉：免費集回 trial_closed（前端顯示「預購期間不開放試看」）
  await h.call('POST', '/api/admin/save', { headers: ADMIN, body: { settings: { freeOpen: false } } });
  const v = await h.call('GET', `/api/video?id=${u2.at(-1).id}`);
  assert.equal(v.status, 401);
  assert.equal((await v.json()).error, 'trial_closed');

  // 驗證：標題不能空、YouTube 看不懂要擋，而且整包都不寫
  const bad = await h.call('POST', '/api/admin/save', {
    headers: ADMIN,
    body: { units: [{ id: 'u1', title: '不該存進去' }], episodes: [{ ...pick(u2[0]), youtubeId: 'nope' }] },
  });
  assert.equal((await bad.json()).error, 'bad_youtube_id');
  const after = await (await h.call('GET', '/api/admin/course', { headers: ADMIN })).json();
  assert.equal(after.units[0].title, '冰山理論（改）', '驗證失敗整包不寫');
  assert.equal((await (await h.call('POST', '/api/admin/save', { headers: ADMIN, body: { units: [{ id: 'u1', title: ' ' }] } })).json()).error, 'title_required');
});

function pick(e) {
  return { id: e.id, unitId: e.unit_id, title: e.title, youtubeId: e.youtube_id, durationSec: e.duration_sec, published: Boolean(e.published), free: Boolean(e.free) };
}

test('跨站（API 在 workers.dev）：登入回 token，用 X-MA-Session header 也認得', async () => {
  const h = makeHarness({ COURSE_OPEN: 'true' });
  const o = await preorder(h);
  await paidCallback(h, o.merchantTradeNo);
  await h.call('POST', '/api/auth/request-code', { headers: fromSite(), body: { email: 'buyer@example.com' } });
  const code = h.mail.at(-1).subject.match(/(\d{6})/)[1];
  const v = await (await h.call('POST', '/api/auth/verify', { headers: fromSite(), body: { email: 'buyer@example.com', code } })).json();
  assert.ok(v.token && v.token.length > 20);
  const s = await h.call('GET', '/api/session', { headers: { 'X-MA-Session': v.token } });
  assert.equal(s.status, 200);
  const pre = await h.call('OPTIONS', '/api/session', { headers: { Origin: SITE } });
  assert.match(pre.headers.get('Access-Control-Allow-Headers'), /X-MA-Session/);
  await h.call('POST', '/api/auth/logout', { headers: fromSite({ 'X-MA-Session': v.token }) });
  assert.equal((await h.call('GET', '/api/session', { headers: { 'X-MA-Session': v.token } })).status, 401);
});

test('綠界金鑰還沒設：建單回 payment_not_ready，課程資料帶 paymentReady=false', async () => {
  const h = makeHarness({ ECPAY_HASH_KEY: '', ECPAY_HASH_IV: '' });
  const r = await h.call('POST', '/api/orders', { headers: fromSite(), body: { email: 'a@b.tw', agreeRefund: true } });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'payment_not_ready');
  assert.equal((await (await h.call('GET', '/api/course')).json()).paymentReady, false);
});

test('正式環境 dry-run：預設擋，EMAIL_DRY_RUN_IN_PROD=true 才放行（寄信授權還沒好先上線用）', async () => {
  const msg = { to: 'a@b.tw', subject: 's', text: 't', html: 'h' };
  await assert.rejects(sendEmail({ ECPAY_ENV: 'prod', EMAIL_MODE: 'dry-run' }, msg), /not allowed/);
  const r = await sendEmail({ ECPAY_ENV: 'prod', EMAIL_MODE: 'dry-run', EMAIL_DRY_RUN_IN_PROD: 'true' }, msg);
  assert.equal(r.logged, true);
});
