import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bunnyToken, signedEmbedUrl } from '../src/video.js';
import { toCsv } from '../src/csv.js';
import { publicCourse, COURSE } from '../src/course.js';

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

test('課程：4 個單元、總長約 3 小時、對前端不洩漏 bunnyId', () => {
  assert.equal(COURSE.units.length, 4);
  const total = COURSE.units.flatMap((u) => u.videos).reduce((s, v) => s + v.minutes, 0);
  assert.ok(total >= 160 && total <= 200, `total ${total}`);
  const pub = JSON.stringify(publicCourse());
  assert.ok(!pub.includes('bunnyId'));
});
