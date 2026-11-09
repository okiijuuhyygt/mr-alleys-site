import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bunnyToken, signedEmbedUrl } from '../src/video.js';
import { toCsv } from '../src/csv.js';
import { publicCourse, COURSE } from '../src/course.js';
import { markFree } from '../src/episodes.js';
import { loadSeedList } from '../scripts/seed-episodes.mjs';

test('Bunny token = SHA256_HEX(key + videoId + expires)（用官方文件的範例值）', async () => {
  const key = '4742a81b-bf15-42fe-8b1c-8fcb9024c550';
  const vid = '32d140e2-e4f4-4eec-9d53-20371e9be607';
  const exp = 1623440202;
  const want = createHash('sha256').update(`${key}${vid}${exp}`).digest('hex');
  assert.equal(await bunnyToken(key, vid, exp), want);
});

test('signedEmbedUrl：網址格式與期限', async () => {
  const nowMs = Date.UTC(2026, 10, 4, 8, 0, 0);
  const r = await signedEmbedUrl({ libraryId: '12345', videoId: 'abc-def', tokenKey: 'k', nowMs, ttlSec: 3600 });
  const u = new URL(r.embedUrl);
  assert.equal(u.origin + u.pathname, 'https://player.mediadelivery.net/embed/12345/abc-def');
  assert.equal(u.searchParams.get('expires'), String(nowMs / 1000 + 3600));
  assert.equal(u.searchParams.get('token'), await bunnyToken('k', 'abc-def', nowMs / 1000 + 3600));
  assert.equal(r.expiresAt, nowMs + 3600 * 1000);
});

test('CSV：BOM、跳脫、擋公式注入', () => {
  const csv = toCsv(['email', 'name'], [
    { email: 'a@b.tw', name: '小明, "阿明"' },
    { email: '=HYPERLINK("x")', name: null },
  ]);
  assert.ok(csv.startsWith('﻿email,name\r\n'));
  assert.ok(csv.includes('a@b.tw,"小明, ""阿明"""'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")",`));
});

test('課程：4 個單元、34 集、總長約 2 小時 40 分、每單元第一集免費、對前端不洩漏 YouTube ID', () => {
  assert.equal(COURSE.units.length, 4);
  const rows = markFree(
    loadSeedList().map((e, i) => ({ id: e.id, unit_id: e.unit, title: e.title, youtube_id: 'SECRETyt' + String(i).padStart(3, '0'), duration_sec: e.durationSec, published: 1 })),
  );
  assert.equal(rows.length, 34);
  const total = rows.reduce((s, e) => s + e.duration_sec, 0) / 60;
  assert.ok(total >= 150 && total <= 170, `total ${total}`);
  assert.deepEqual(rows.filter((e) => e.free).map((e) => e.id), ['u01-A', 'u02-A', 'u03-A', 'u04-A']);

  const visitor = publicCourse(rows, { member: false, entitled: false, freeOpen: true, showLockedTitles: false });
  assert.ok(!JSON.stringify(visitor).includes('SECRETyt'));
  const u1 = visitor.units[0];
  assert.equal(u1.episodes.length, 9);
  assert.equal(u1.task, null, '沒登入看不到練習');
  assert.deepEqual([u1.episodes[0].unlocked, u1.episodes[1].unlocked], [true, false]);
  assert.equal(u1.episodes[1].title, null, '鎖住的集數預設不顯示標題（對外不寫做法）');
  assert.ok(u1.episodes[0].title);

  const member = publicCourse(rows, { member: true, entitled: true, freeOpen: true, showLockedTitles: false });
  assert.ok(member.units.every((u) => u.episodes.every((e) => e.unlocked && e.title)));
  assert.ok(member.units[0].task);
});
