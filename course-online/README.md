# 線上寫歌課（course-online）

預購頁、學員登入與看課頁面（靜態網頁，跟主站一起放 GitHub Pages），加上 `worker/` 裡的 API（Cloudflare Worker＋D1）。
系統怎麼設計、要設定哪些帳號、上線清單：見 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 檔案

```
course-online/
  index.html          預購頁
  thanks.html         綠界付款後「返回商店」的頁面
  learn/login.html    email＋驗證碼登入
  learn/index.html    我的課程（4 個單元、進度）
  learn/unit.html     單元頁（影片、浮水印、練習、檢查點）
  css/course-online.css  疊在 /css/service-page.css 上面
  js/api.js           API 位址、fetch、錯誤訊息（localhost 自動打 :8787）
worker/
  src/                API 程式（index.js 是路由）
  migrations/         D1 schema
  test/               測試（node:test＋node:sqlite 假 D1，不用網路）
  scripts/simulate-callback.mjs  本機模擬綠界付款成功
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

測試涵蓋：綠界 CheckMacValue（官方範例值）、免密碼登入（過期、試錯次數、頻率限制）、單一裝置、Bunny 簽名網址、CSV、以及從建單到看影片的整條流程。

## 本機開發

開兩個終端機：

```sh
# 1) API：http://localhost:8787
cd worker
cp .dev.vars.example .dev.vars          # 綠界公開測試金鑰＋本機假值；.dev.vars 不會進 git
npm run db:migrate:local                # 建本機 D1
npm run dev

# 2) 網頁：http://localhost:8080（要從 repo 根目錄開，才讀得到 /css/service-page.css）
cd ..
python3 -m http.server 8080
```

然後打開 http://localhost:8080/course-online/ 。

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
5. 登入後會看到 4 個單元。課程還沒開（`COURSE_OPEN=false`），要測影片頁的話，在 `.dev.vars` 加 `PREVIEW_EMAILS=你的email` 或 `COURSE_OPEN=true`，重開 `npm run dev`。影片的 `bunnyId` 還沒填，按鈕會顯示「影片準備中」。
6. 單一裝置：用另一個瀏覽器（或無痕視窗）登入同一個 email，第一個視窗的單元頁 60 秒內會顯示已登出。

### 匯出名單

```sh
curl -H "Authorization: Bearer local-dev-admin-token-0123456789" \
  "http://localhost:8787/api/admin/export.csv?type=members" -o members.csv
```

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

- 測試環境（沒加 `--env`）的 Worker 會在 `*.workers.dev`，跟 `mralleys.com` 不是同一個網站，瀏覽器不會送 `SameSite=Lax` 的 cookie，所以**登入流程只能在本機或正式網域測**；測試環境主要用來接綠界 stage 的 ReturnURL。另外 `js/api.js` 在非 localhost 一律打正式 API。
- 預購價、上線時間、退款期限在 `worker/wrangler.toml` 的 vars，但預購頁 `index.html` 上的價格與日期是寫死的文字，改的時候兩邊要一起改。
- 所有使用者看到的文字用繁體中文全形標點；不要寫「寫出人生第一首歌」，第一期的承諾是「寫出你的第一段詞、錄下你哼的第一段旋律」。
