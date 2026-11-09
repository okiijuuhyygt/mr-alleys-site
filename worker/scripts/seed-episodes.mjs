#!/usr/bin/env node
// seed-episodes.mjs — 產「第一次灌集數」的 SQL（34 集＋YouTube 不公開影片 ID）
//
// repo 是公開的，YouTube ID 和真的集數標題都不進 git：
//   seed/episodes.json 只有 id、單元、長度（標題是「第 N 單元第 M 集」佔位，給測試用）；
//   ID 與標題從 repo 外面的 yt-uploads.json 讀（{ "u01-A": { "videoId": "...", "title": "線上寫歌課 第1單元｜開場…" } }，
//   標題取「｜」後面那段）；產出的 SQL 寫到 *.local.sql（已 gitignore）。
// 每個單元排第一個的集數預設勾「免費」（之後在後台改）。
//
// 用法：
//   node scripts/seed-episodes.mjs <yt-uploads.json> > seed.local.sql
//   npx wrangler d1 execute mralleys-course --local --file seed.local.sql
//
// 重跑安全：已經有的集數只補／更新 YouTube ID，不動後台改過的標題、順序、發布狀態。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/**
 * @param {Array<{id:string, unit:string, title:string, durationSec:number}>} list
 * @param {Record<string, {videoId?:string}>} yt
 * @param {number} now epoch ms
 */
export function buildSeedSql(list, yt, now) {
  const sortIn = {};
  const lines = ['-- 由 scripts/seed-episodes.mjs 產生；含 YouTube 不公開影片 ID，不要 commit'];
  for (const e of list) {
    const first = !sortIn[e.unit];
    sortIn[e.unit] = (sortIn[e.unit] || 0) + 10;
    const vid = yt?.[e.id]?.videoId || null;
    const ytTitle = String(yt?.[e.id]?.title || '').split('｜').slice(1).join('｜').trim();
    lines.push(
      `INSERT INTO episodes (id, unit_id, title, youtube_id, duration_sec, sort, published, free, created_at, updated_at) VALUES (${[
        e.id, e.unit, ytTitle || e.title, vid, e.durationSec, sortIn[e.unit], 1, first ? 1 : 0, now, now,
      ].map(q).join(', ')}) ON CONFLICT(id) DO UPDATE SET youtube_id = COALESCE(excluded.youtube_id, episodes.youtube_id);`,
    );
  }
  return lines.join('\n') + '\n';
}

export function loadSeedList() {
  return JSON.parse(readFileSync(join(here, '..', 'seed', 'episodes.json'), 'utf8'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ytPath = process.argv[2];
  const yt = ytPath ? JSON.parse(readFileSync(ytPath, 'utf8')) : {};
  const list = loadSeedList();
  const missing = list.filter((e) => !yt[e.id]?.videoId).map((e) => e.id);
  if (missing.length) console.error(`[seed] 沒有 YouTube ID（會顯示「影片準備中」）：${missing.join(', ')}`);
  process.stdout.write(buildSeedSql(list, yt, Date.now()));
}
