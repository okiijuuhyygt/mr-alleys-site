// episodes.js — 集數（D1 episodes 表）：讀、免費集規則、後台新增／修改／排序／刪除
//
// 免費集：後台勾選（episodes.free，0003 migration 起）。只有「已發布」的集數才算免費。
// 還沒跑 0003 的舊資料（沒有 free 欄位）照舊規則：每單元排第一個、已發布的那集免費。

import { findUnit, UNIT_TEXT_MAX } from './course.js';

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * 接受 11 碼 ID，或 youtu.be／watch?v=／embed／shorts 網址，回 11 碼 ID；看不懂回 null。
 * 後台補片時可以直接貼 YouTube 連結。
 * @param {unknown} input
 */
export function parseYoutubeId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (YT_ID.test(s)) return s;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = u.searchParams.get('v') || (u.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/) || [])[1] || null;
  }
  return id && YT_ID.test(id) ? id : null;
}

/** @param {Array<{unit_id:string, published:number, free?:number}>} rows 已照 unit、sort 排好 */
export function markFree(rows) {
  const seen = new Set();
  return rows.map((r) => {
    const free = r.free === undefined ? Boolean(r.published) && !seen.has(r.unit_id) : Boolean(r.published) && Boolean(r.free);
    if (r.published) seen.add(r.unit_id);
    return { ...r, free };
  });
}

const SELECT = 'SELECT id, unit_id, title, youtube_id, duration_sec, sort, published, free, created_at, updated_at FROM episodes';

/** 全部集數（含未發布），已標好 free。後台用。 */
export async function listAllEpisodes(db) {
  const { results } = await db.prepare(`${SELECT} ORDER BY unit_id, sort, id`).all();
  return markFree(results || []);
}

/** 學員看得到的集數（只含已發布）。 */
export async function listPublishedEpisodes(db) {
  return (await listAllEpisodes(db)).filter((e) => e.published);
}

/** @returns {Promise<null | (object & {free:boolean})>} 只找已發布的 */
export async function findPublishedEpisode(db, id) {
  return (await listPublishedEpisodes(db)).find((e) => e.id === id) || null;
}

// ---------------------------------------------------------------- 後台寫入

function cleanTitle(s) {
  return String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120);
}

function durationOf(body) {
  if (body.durationSec != null && body.durationSec !== '') return Math.max(0, Math.round(Number(body.durationSec) || 0));
  if (body.minutes != null && body.minutes !== '') return Math.max(0, Math.round((Number(body.minutes) || 0) * 60));
  return null;
}

function randomSuffix() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => a[b % a.length]).join('');
}

/**
 * @returns {Promise<{ok:true, episode:object} | {ok:false, error:string}>}
 */
export async function createEpisode(db, body, now) {
  const unit = findUnit(String(body?.unitId || ''));
  if (!unit) return { ok: false, error: 'unknown_unit' };
  const title = cleanTitle(body.title);
  if (!title) return { ok: false, error: 'title_required' };
  let youtubeId = null;
  if (body.youtubeId) {
    youtubeId = parseYoutubeId(body.youtubeId);
    if (!youtubeId) return { ok: false, error: 'bad_youtube_id' };
  }
  const max = await db.prepare('SELECT MAX(sort) AS m FROM episodes WHERE unit_id = ?').bind(unit.id).first();
  const sort = Number(max?.m || 0) + 10;
  const id = `${unit.id}-${randomSuffix()}`;
  await db
    .prepare(
      'INSERT INTO episodes (id, unit_id, title, youtube_id, duration_sec, sort, published, free, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, unit.id, title, youtubeId, durationOf(body) ?? 0, sort, body.published === false ? 0 : 1, body.free === true ? 1 : 0, now, now)
    .run();
  const episode = (await listAllEpisodes(db)).find((e) => e.id === id);
  return { ok: true, episode };
}

export async function updateEpisode(db, body, now) {
  const id = String(body?.id || '');
  const cur = await db.prepare(`${SELECT} WHERE id = ?`).bind(id).first();
  if (!cur) return { ok: false, error: 'unknown_episode' };
  const sets = [];
  const vals = [];
  if (body.title !== undefined) {
    const t = cleanTitle(body.title);
    if (!t) return { ok: false, error: 'title_required' };
    sets.push('title = ?');
    vals.push(t);
  }
  if (body.youtubeId !== undefined) {
    let y = null;
    if (body.youtubeId) {
      y = parseYoutubeId(body.youtubeId);
      if (!y) return { ok: false, error: 'bad_youtube_id' };
    }
    sets.push('youtube_id = ?');
    vals.push(y);
  }
  const d = durationOf(body || {});
  if (d != null) {
    sets.push('duration_sec = ?');
    vals.push(d);
  }
  if (body.published !== undefined) {
    sets.push('published = ?');
    vals.push(body.published ? 1 : 0);
  }
  if (body.free !== undefined) {
    sets.push('free = ?');
    vals.push(body.free ? 1 : 0);
  }
  if (body.unitId !== undefined && body.unitId !== cur.unit_id) {
    const unit = findUnit(String(body.unitId));
    if (!unit) return { ok: false, error: 'unknown_unit' };
    const max = await db.prepare('SELECT MAX(sort) AS m FROM episodes WHERE unit_id = ?').bind(unit.id).first();
    sets.push('unit_id = ?', 'sort = ?');
    vals.push(unit.id, Number(max?.m || 0) + 10);
  }
  if (!sets.length) return { ok: false, error: 'nothing_to_update' };
  sets.push('updated_at = ?');
  vals.push(now);
  await db.prepare(`UPDATE episodes SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  return { ok: true, episode: (await listAllEpisodes(db)).find((e) => e.id === id) };
}

/** ids 必須剛好是這個單元的全部集數（防止漏排、排到別的單元） */
export async function reorderEpisodes(db, body, now) {
  const unit = findUnit(String(body?.unitId || ''));
  if (!unit) return { ok: false, error: 'unknown_unit' };
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const { results } = await db.prepare('SELECT id FROM episodes WHERE unit_id = ?').bind(unit.id).all();
  const have = new Set((results || []).map((r) => r.id));
  if (ids.length !== have.size || new Set(ids).size !== ids.length || !ids.every((i) => have.has(i))) {
    return { ok: false, error: 'ids_mismatch' };
  }
  await db.batch(
    ids.map((id, i) => db.prepare('UPDATE episodes SET sort = ?, updated_at = ? WHERE id = ?').bind((i + 1) * 10, now, id)),
  );
  return { ok: true };
}

export async function deleteEpisode(db, body) {
  const r = await db.prepare('DELETE FROM episodes WHERE id = ?').bind(String(body?.id || '')).run();
  return r?.meta?.changes ? { ok: true } : { ok: false, error: 'unknown_episode' };
}

// ---------------------------------------------------------------- 後台「儲存到網站」：一次存全部

function cleanText(s, max) {
  return String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/g, '').trim().slice(0, max);
}

/**
 * 後台一次送整份：單元文字、集數（照畫面順序）、要刪的集數、網站開關。全部驗過才寫，寫在同一個 batch。
 * @param {object} body
 * @param {Array<{id:string,title?:string,summary?:string,task?:string,checkpoint?:string}>} [body.units]
 * @param {Array<{id?:string,unitId:string,title:string,youtubeId?:string,minutes?:number|string,published?:boolean,free?:boolean}>} [body.episodes]
 *   每個單元的集數照陣列順序排；沒有 id 的是新增
 * @param {string[]} [body.deleted]
 * @param {{freeOpen?:boolean, showLockedTitles?:boolean}} [body.settings]
 * @returns {Promise<{ok:true, changed:number} | {ok:false, error:string, detail?:string}>}
 */
export async function saveAll(db, body, now) {
  const stmts = [];
  // 單元文字
  for (const u of Array.isArray(body?.units) ? body.units : []) {
    const unit = findUnit(String(u?.id || ''));
    if (!unit) return { ok: false, error: 'unknown_unit', detail: String(u?.id || '') };
    const v = {};
    for (const k of Object.keys(UNIT_TEXT_MAX)) v[k] = cleanText(u[k], UNIT_TEXT_MAX[k]);
    if (!v.title) return { ok: false, error: 'title_required', detail: unit.id };
    stmts.push(
      db
        .prepare(
          `INSERT INTO unit_overrides (id, title, summary, task, checkpoint, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary, task = excluded.task, checkpoint = excluded.checkpoint, updated_at = excluded.updated_at`,
        )
        .bind(unit.id, v.title, v.summary || null, v.task || null, v.checkpoint || null, now),
    );
  }

  // 集數
  const { results } = await db.prepare('SELECT id FROM episodes').all();
  const have = new Set((results || []).map((r) => r.id));
  const deleted = (Array.isArray(body?.deleted) ? body.deleted : []).map(String);
  for (const id of deleted) {
    if (!have.has(id)) return { ok: false, error: 'unknown_episode', detail: id };
    stmts.push(db.prepare('DELETE FROM episodes WHERE id = ?').bind(id));
  }
  const sortIn = {};
  const seen = new Set();
  for (const e of Array.isArray(body?.episodes) ? body.episodes : []) {
    const unit = findUnit(String(e?.unitId || ''));
    if (!unit) return { ok: false, error: 'unknown_unit', detail: String(e?.unitId || '') };
    const title = cleanTitle(e.title);
    if (!title) return { ok: false, error: 'title_required', detail: e.id || '' };
    let youtubeId = null;
    if (e.youtubeId) {
      youtubeId = parseYoutubeId(e.youtubeId);
      if (!youtubeId) return { ok: false, error: 'bad_youtube_id', detail: title };
    }
    const dur = durationOf(e) ?? 0;
    sortIn[unit.id] = (sortIn[unit.id] || 0) + 10;
    const pub = e.published === false ? 0 : 1;
    const free = e.free === true ? 1 : 0;
    if (e.id) {
      const id = String(e.id);
      if (!have.has(id)) return { ok: false, error: 'unknown_episode', detail: id };
      if (seen.has(id) || deleted.includes(id)) return { ok: false, error: 'ids_mismatch', detail: id };
      seen.add(id);
      stmts.push(
        db
          .prepare('UPDATE episodes SET unit_id = ?, title = ?, youtube_id = ?, duration_sec = ?, sort = ?, published = ?, free = ?, updated_at = ? WHERE id = ?')
          .bind(unit.id, title, youtubeId, dur, sortIn[unit.id], pub, free, now, id),
      );
    } else {
      stmts.push(
        db
          .prepare(
            'INSERT INTO episodes (id, unit_id, title, youtube_id, duration_sec, sort, published, free, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(`${unit.id}-${randomSuffix()}`, unit.id, title, youtubeId, dur, sortIn[unit.id], pub, free, now, now),
      );
    }
  }

  // 網站開關
  const st = body?.settings || {};
  for (const [k, col] of [['freeOpen', 'free_open'], ['showLockedTitles', 'show_locked_titles']]) {
    if (typeof st[k] !== 'boolean') continue;
    stmts.push(
      db
        .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .bind(col, st[k] ? 'true' : 'false', now),
    );
  }

  if (!stmts.length) return { ok: false, error: 'nothing_to_update' };
  await db.batch(stmts);
  return { ok: true, changed: stmts.length };
}

/**
 * 網站開關：後台存過（D1 settings）就照後台，沒存過照 wrangler.toml 的 vars。
 * @returns {Promise<{freeOpen:boolean, showLockedTitles:boolean, source:{freeOpen:string, showLockedTitles:string}}>}
 */
export async function loadSettings(db, env) {
  let rows = [];
  try {
    ({ results: rows } = await db.prepare('SELECT key, value FROM settings').all());
  } catch {
    rows = [];
  }
  const kv = Object.fromEntries((rows || []).map((r) => [r.key, r.value]));
  const envFree =
    env.FREE_EPISODES_OPEN === 'true' || env.FREE_EPISODES_OPEN === 'false' ? env.FREE_EPISODES_OPEN === 'true' : env.COURSE_OPEN === 'true';
  return {
    freeOpen: kv.free_open != null ? kv.free_open === 'true' : envFree,
    showLockedTitles: kv.show_locked_titles != null ? kv.show_locked_titles === 'true' : env.SHOW_LOCKED_TITLES === 'true',
    source: { freeOpen: kv.free_open != null ? 'admin' : 'default', showLockedTitles: kv.show_locked_titles != null ? 'admin' : 'default' },
  };
}
