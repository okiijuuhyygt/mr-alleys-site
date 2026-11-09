-- 0003_admin_edit.sql — 後台可以自己改：單元標題與介紹、哪集免費、網站開關
-- 套用：npx wrangler d1 migrations apply mralleys-course --local   （本機）
--       npx wrangler d1 migrations apply mralleys-course --remote --env production（正式）

-- 哪集免費改成後台勾選（以前是「每單元排第一個」自動算）。
-- 套用時先照舊規則勾好：每個單元排第一個、已發布的那集＝免費。
ALTER TABLE episodes ADD COLUMN free INTEGER NOT NULL DEFAULT 0;
UPDATE episodes SET free = 1
WHERE published = 1
  AND id IN (
    SELECT e.id FROM episodes e
    WHERE e.published = 1
      AND NOT EXISTS (
        SELECT 1 FROM episodes x
        WHERE x.unit_id = e.unit_id AND x.published = 1
          AND (x.sort < e.sort OR (x.sort = e.sort AND x.id < e.id))
      )
  );

-- 單元文字：沒有這一列就用 src/course.js 的預設值；後台存過才有。
CREATE TABLE IF NOT EXISTS unit_overrides (
  id         TEXT PRIMARY KEY,                 -- u1..u4
  title      TEXT,
  summary    TEXT,
  task       TEXT,                             -- 練習（只有學員看得到）
  checkpoint TEXT,                             -- 檢查點（只有學員看得到）
  updated_at INTEGER NOT NULL
);

-- 網站開關（後台改）：沒有這一列就用 wrangler.toml 的 vars。
--   free_open           'true'/'false'：沒買的人能不能看免費集（試看）
--   show_locked_titles  'true'/'false'：鎖住的集要不要顯示標題
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
