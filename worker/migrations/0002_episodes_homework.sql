-- 0002_episodes_homework.sql — 集數（後台自己補片、排序）＋交作業
-- 套用：npx wrangler d1 migrations apply mralleys-course --local   （本機）
--       npx wrangler d1 migrations apply mralleys-course --remote  （正式）
--
-- 集數資料「不」寫在 migration 裡：repo 是公開的，YouTube 不公開影片的 ID 不能進 git。
-- 第一次灌資料用 worker/scripts/seed-episodes.mjs 產 SQL（見 course-online/README.md），之後在後台補。

-- 集數：每個單元底下的影片。哪一集免費不存欄位——每個單元排第一個、已發布的那集就是免費集
-- （後台調順序，免費集會跟著換；規則寫在 src/episodes.js 的 markFree）。
CREATE TABLE IF NOT EXISTS episodes (
  id           TEXT PRIMARY KEY,               -- 例：u01-A；後台新增的會自動產
  unit_id      TEXT NOT NULL,                  -- u1..u4（對應 src/course.js）
  title        TEXT NOT NULL,
  youtube_id   TEXT,                           -- YouTube 不公開影片 ID（11 碼）；只經 /api/video 給看得到的人
  duration_sec INTEGER NOT NULL DEFAULT 0,
  sort         INTEGER NOT NULL,               -- 同單元內由小到大
  published    INTEGER NOT NULL DEFAULT 1,     -- 0 = 先藏起來（學員看不到，也不算免費集）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_unit ON episodes(unit_id, sort);

-- 交作業：文字放這裡，檔案本體放 KV（binding HOMEWORK_FILES，key = file_key）。
CREATE TABLE IF NOT EXISTS homework (
  id           TEXT PRIMARY KEY,               -- hw_ + 亂數
  email        TEXT NOT NULL,
  unit_id      TEXT NOT NULL,
  body         TEXT,                           -- 學員寫的文字（最多 5000 字）
  file_key     TEXT,                           -- KV key；沒附檔就是 NULL
  file_name    TEXT,
  file_type    TEXT,
  file_size    INTEGER,
  status       TEXT NOT NULL DEFAULT 'new',    -- new | reviewed
  created_at   INTEGER NOT NULL,
  notified_at  INTEGER,                        -- 通知信寄出（或 dry-run 印出）的時間
  notify_error TEXT                            -- 通知信失敗的原因（學員那邊照樣算交成功）
);
CREATE INDEX IF NOT EXISTS idx_homework_email ON homework(email, unit_id, created_at);
CREATE INDEX IF NOT EXISTS idx_homework_created ON homework(created_at);
