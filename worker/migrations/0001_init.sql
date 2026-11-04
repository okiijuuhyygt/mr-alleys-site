-- 0001_init.sql — 線上寫歌課 D1 schema
-- 套用：npx wrangler d1 migrations apply mralleys-course --local   （本機）
--       npx wrangler d1 migrations apply mralleys-course --remote  （正式）
-- 時間欄位一律存 epoch 毫秒（INTEGER），顯示時再換台灣時間。

-- 訂單：建單時是 pending，綠界 ReturnURL 驗過 CheckMacValue 才改 paid。
CREATE TABLE IF NOT EXISTS orders (
  merchant_trade_no TEXT PRIMARY KEY,          -- 我們產的編號，送給綠界
  email             TEXT NOT NULL,             -- 已轉小寫、去空白
  name              TEXT,                      -- 選填稱呼
  amount            INTEGER NOT NULL,          -- 建單當下的金額（callback 會比對）
  item              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed | refunded
  marketing_opt_in  INTEGER NOT NULL DEFAULT 0,
  ecpay_trade_no    TEXT,                      -- 綠界交易編號
  rtn_code          TEXT,
  rtn_msg           TEXT,
  payment_type      TEXT,
  payment_date      TEXT,                      -- 綠界回傳的字串（台灣時間）
  simulate_paid     INTEGER NOT NULL DEFAULT 0,-- 綠界後台「模擬付款」= 1，不算真的收到錢
  created_at        INTEGER NOT NULL,
  paid_at           INTEGER,
  raw_callback      TEXT                       -- 原始 callback（JSON），對帳用
);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- 學員：帳號 = 付款時填的 email。有一筆 paid 訂單就會有一列。
CREATE TABLE IF NOT EXISTS members (
  email            TEXT PRIMARY KEY,
  name             TEXT,
  access           TEXT NOT NULL DEFAULT 'active', -- active | revoked（退款後改 revoked）
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  first_paid_at    INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);

-- 登入驗證碼：只存雜湊，不存明碼。10 分鐘過期、最多試 5 次、用過即失效。
CREATE TABLE IF NOT EXISTS login_codes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER                          -- 用掉或作廢的時間
);
CREATE INDEX IF NOT EXISTS idx_codes_email ON login_codes(email, created_at);

-- 登入狀態：cookie 裡放隨機 token，這裡只存它的 SHA-256。
-- 同一個 email 同時只會有一列 revoked_at IS NULL（新登入會把舊的作廢）。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash     TEXT PRIMARY KEY,
  email          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  revoked_reason TEXT,                         -- replaced | logout | admin
  user_agent     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email, revoked_at);

-- 頻率限制用的事件紀錄（寄驗證碼、驗證失敗）。每天由 cron 清掉一天前的。
CREATE TABLE IF NOT EXISTS rate_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket     TEXT NOT NULL,                    -- 例：code:email:a@b.com、code:ip:1.2.3.4
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_bucket ON rate_events(bucket, created_at);

-- 單元完成紀錄（每單元的「完成檢查點」）
CREATE TABLE IF NOT EXISTS progress (
  email        TEXT NOT NULL,
  unit_id      TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (email, unit_id)
);
