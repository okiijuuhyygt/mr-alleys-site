# 線上寫歌課（course-online）

預購頁、學員登入與看課頁面（靜態網頁，跟主站一起放 GitHub Pages），加上 `worker/` 裡的 API（Cloudflare Worker＋D1）。
系統怎麼設計、要設定哪些帳號、上線清單：見 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 檔案

```
course-online/
  index.html          預購頁
  thanks.html         綠界付款後「返回商店」的頁面
  learn/login.html    email＋驗證碼登入
  learn/index.html    課程目錄（不用登入；每單元第一集免費）
  learn/unit.html     單元頁（YouTube 嵌入播放、鎖住的集、練習、交作業、檢查點）
  admin/index.html    後台（ADMIN_TOKEN）：單元標題介紹、集數（標題、上下架、免費、排序、補片）、試看開關、學員作業（長相跟官網 /admin.html 一樣）
  css/course-online.css  疊在 /css/service-page.css 上面
  js/api.js           API 位址、fetch、錯誤訊息（localhost 自動打 :8787，其他打 workers.dev 正式 API）
worker/
  src/                API 程式（index.js 是路由）
  migrations/         D1 schema
  test/               測試（node:test＋node:sqlite 假 D1，不用網路）
  scripts/simulate-callback.mjs  本機模擬綠界付款成功
  scripts/seed-episodes.mjs      產第一次灌集數的 SQL（YouTube ID 從 repo 外讀）
  scripts/e2e-local.mjs          本機 Playwright 走一遍＋手機 390 截圖
  seed/episodes.json             34 集的 id 與長度（標題是佔位；真標題和 YouTube ID 都從 repo 外的 yt-uploads.json 讀）
```

## 需求

- Node.js 22.13 以上（測試用到內建的 `node:sqlite`）
- 不需要 Cloudflare 帳號就能跑測試與本機開發

## 跑測試

```sh
cd worker
npm ci
npm test
```

測試涵蓋：綠界 CheckMacValue（官方範例值）、免密碼登入（過期、試錯次數、頻率限制）、單一裝置、CSV、從建單到看影片的整條流程，以及 MVP：免費集／付費集、付款解鎖、交作業（D1＋KV、檔案大小與類型、通知失敗）、後台補片與排序、Gmail API 寄信與 dry-run。

## 本機開發

開兩個終端機：

```sh
# 1) API：http://localhost:8787
cd worker
cp .dev.vars.example .dev.vars          # 綠界公開測試金鑰＋本機假值；.dev.vars 不會進 git（裡面 COURSE_OPEN=true）
npm run db:migrate:local                # 建本機 D1（0001–0003）
node scripts/seed-episodes.mjs ~/.openclaw/workspace/drafts/20261106-線上課網站/yt-uploads.json > seed.local.sql
npx wrangler d1 execute mralleys-course --local --file seed.local.sql   # 灌 34 集＋YouTube ID
npx wrangler dev --port 8787 > /tmp/wrangler.log 2>&1 &   # 驗證碼、交作業通知都印在這個 log

# 2) 網頁：http://localhost:8080（要從 repo 根目錄開，才讀得到 /css/service-page.css）
cd ..
python3 -m http.server 8080
```

然後打開 http://localhost:8080/course-online/learn/ （課程目錄）。後台：http://localhost:8080/course-online/admin/ ，密碼是 `.dev.vars` 的 `ADMIN_TOKEN`。

### 自動走一遍（Playwright）

```sh
cd worker
WRANGLER_LOG=/tmp/wrangler.log OUT=/tmp/shots node scripts/e2e-local.mjs
```

免費集可看 → 付費集鎖住 → 建單跳綠界測試頁 → 模擬付款 → 驗證碼登入 → 付費集解鎖 → 交作業（文字＋錄音）→ 通知信（dry-run）→ 後台看到、下載附檔 → 後台新增一集、移到第一個變免費集、刪掉；最後用手機寬 390 截每一頁、檢查沒有橫向捲動。用全域的 playwright（`npm i -g playwright`）。

### 本機走一次完整流程

1. 在預購頁填 email、勾退款說明，按「前往綠界付款」。會跳到綠界**測試**付款頁；本機的 ReturnURL 綠界打不到，所以直接關掉那頁也沒關係。
2. 到 `wrangler dev` 的終端機找訂單編號，或查資料庫：
   ```sh
   cd worker
   npx wrangler d1 execute mralleys-course --local --command "SELECT merchant_trade_no, email, status FROM orders"
   ```
3. 模擬綠界通知付款成功：
   ```sh
   node scripts/simulate-callback.mjs MA2611041600001234
   # 應該印出：200 1|OK
   ```
   本機 `EMAIL_MODE=log`，確認信會印在 `wrangler dev` 的終端機。
4. 打開 http://localhost:8080/course-online/learn/login.html ，輸入同一個 email。驗證碼一樣印在終端機。
5. 登入後全部集數解鎖，單元頁可以交作業；交了之後 `wrangler dev` 的 log 會印出寄給 `HOMEWORK_NOTIFY_EMAIL` 的通知信（dry-run）。
6. 要模擬「還沒開課」：`.dev.vars` 改 `COURSE_OPEN=false`（可以再加 `FREE_EPISODES_OPEN=true` 先放免費集），重開 dev。

### 匯出名單

```sh
curl -H "Authorization: Bearer local-dev-admin-token-0123456789" \
  "http://localhost:8787/api/admin/export.csv?type=members" -o members.csv
```

## 正式環境（2026-11-09 上線）

- API：`https://mralleys-course-api.mralleys.workers.dev`（Cloudflare Worker＋D1＋KV；`mralleys.com` 的 DNS 沒有動）
- 前台：`https://mralleys.com/course-online/learn/`；後台：`https://mralleys.com/course-online/admin/`
- 後台密碼＝Worker secret `ADMIN_TOKEN`（放在哪、哪個帳號管 Cloudflare，記在內部的據點總表，不寫在這個公開的 repo）
- 部署：`cd worker && npx wrangler deploy --env production`；新 migration：`npx wrangler d1 migrations apply mralleys-course --remote --env production`
- 登入：API 跟網站不同站，Safari 會擋第三方 cookie，所以登入後 token 存在瀏覽器 localStorage，用 `X-MA-Session` header 帶（cookie 照送，有就用）
- 寄信：Gmail API，寄件人 mr.alleysmusic@gmail.com（三個 `GMAIL_*` secret）。測試：`curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://mralleys-course-api.mralleys.workers.dev/api/admin/test-email` → 寄一封交作業通知格式的測試信到 hao@mralleys.com
- 綠界：正式環境已接上（2026-11-09；`ECPAY_MERCHANT_ID`／`ECPAY_HASH_KEY`／`ECPAY_HASH_IV` 三個 secret；沒設時「前往付款」顯示付款設定中）

## 常用維運指令（正式環境）

正式環境加 `--remote --env production`。

```sh
# 目前已付款筆數（不含模擬付款）
npx wrangler d1 execute mralleys-course --remote --env production \
  --command "SELECT COUNT(*) FROM orders WHERE status='paid' AND simulate_paid=0"

# 退款：先在綠界後台退刷，再停掉看課權限並登出所有裝置
npx wrangler d1 execute mralleys-course --remote --env production --command \
  "UPDATE orders SET status='refunded' WHERE merchant_trade_no='MA...'; \
   UPDATE members SET access='revoked' WHERE email='someone@example.com'; \
   UPDATE sessions SET revoked_at=strftime('%s','now')*1000, revoked_reason='admin' WHERE email='someone@example.com' AND revoked_at IS NULL;"
```

## 注意

- 正式 API 現在也在 `*.workers.dev`（跟 `mralleys.com` 不同站），所以登入改用 header 帶 token（見上面「正式環境」）。`js/api.js` 在非 localhost 一律打正式 API。
- 預購價、上線時間、退款期限在 `worker/wrangler.toml` 的 vars，但預購頁 `index.html` 上的價格與日期是寫死的文字，改的時候兩邊要一起改。
- 所有使用者看到的文字用繁體中文全形標點；不要寫「寫出人生第一首歌」，第一期的承諾是「寫出你的第一段詞、錄下你哼的第一段旋律」。
