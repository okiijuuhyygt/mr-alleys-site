#!/usr/bin/env node
// e2e-local.mjs — 本機走一遍：免費集可看 → 付費集鎖住 → 測試付款解鎖 → 交作業 → 後台看到；再用手機寬 390 檢查版面
//
// 先開好兩個服務（見 course-online/README.md「本機開發」），wrangler dev 的輸出要寫進檔案（讀驗證碼用）：
//   npx wrangler dev --port 8787 > /tmp/wrangler.log 2>&1 &
//   (cd .. && python3 -m http.server 8080 &)
// 然後：
//   WRANGLER_LOG=/tmp/wrangler.log OUT=./shots node scripts/e2e-local.mjs
//
// 用的是全域安裝的 playwright（npm i -g playwright），repo 不另外裝。

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const { chromium } = createRequire(join(globalRoot, 'noop.js'))('playwright');

const here = dirname(fileURLToPath(import.meta.url));
const SITE = process.env.SITE || 'http://localhost:8080';
const LOG = process.env.WRANGLER_LOG || '/tmp/wrangler.log';
const OUT = process.env.OUT || join(here, '..', 'shots');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'local-dev-admin-token-0123456789';
const EMAIL = process.env.BUYER || `buyer${Date.now() % 100000}@example.com`;
mkdirSync(OUT, { recursive: true });

const steps = [];
const ok = (name, detail = '') => {
  steps.push({ name, ok: true, detail });
  console.log(`✔ ${name}${detail ? ' — ' + detail : ''}`);
};
const must = (cond, name, detail = '') => {
  if (!cond) {
    steps.push({ name, ok: false, detail });
    console.error(`✖ ${name}${detail ? ' — ' + detail : ''}`);
    throw new Error(name);
  }
  ok(name, detail);
};
const shot = async (page, file, full = true) => {
  await page.screenshot({ path: join(OUT, file), fullPage: full });
  console.log(`  📸 ${file}`);
};
const logSize = () => readFileSync(LOG, 'utf8').length;
async function waitLog(from, re, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = readFileSync(LOG, 'utf8').slice(from).match(re);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}
async function waitYoutube(page) {
  const f = await page.waitForSelector('#player iframe', { timeout: 15000 });
  const src = await f.getAttribute('src');
  // 等 YouTube 播放器畫出來（封面圖）；網路慢就照當下的畫面截
  await page.waitForTimeout(4000);
  return src;
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// 真的 YouTube ID 不寫在 repo 裡（repo 公開）：從本機後台 API 讀
const ytOf = Object.fromEntries(
  (await (await fetch('http://localhost:8787/api/admin/episodes', { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).json()).episodes.map((e) => [e.id, e.youtube_id]),
);

const browser = await chromium.launch();
try {
  // ======================================================== 桌機：完整流程
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-TW' });
  const page = await desk.newPage();
  page.on('dialog', (d) => d.accept());

  // 1. 沒登入：課程目錄
  await page.goto(`${SITE}/course-online/learn/`);
  await page.waitForSelector('.lrn-unit');
  must((await page.locator('a.lrn-unit').count()) === 4, '目錄：4 個單元，沒登入也點得進去');
  await shot(page, '01-目錄-沒登入.png');

  // 2. 免費集可看
  await page.click('a.lrn-unit >> nth=0');
  await page.waitForSelector('.lrn-ep');
  const src1 = await waitYoutube(page);
  must(src1.includes(`youtube-nocookie.com/embed/${ytOf['u01-A']}`), '免費集：第 1 單元第 1 集直接在站內播（YouTube 嵌入）', src1.split('?')[0]);
  await shot(page, '02-免費集可看.png');

  // 3. 付費集鎖住
  await page.click('.lrn-ep >> nth=1');
  await page.waitForSelector('#lock:not([hidden])');
  must((await page.locator('#player iframe').count()) === 0, '付費集：鎖住，沒有播放器、沒有影片 ID');
  const locked = await page.request.get('http://localhost:8787/api/video?id=u01-B');
  must(locked.status() === 401, '付費集：API 直接打也拿不到（401 locked）');
  await shot(page, '03-付費集鎖住.png');

  // 4. 購買 → 綠界測試環境
  await page.click('#lockBuy');
  await page.waitForSelector('#preorderForm');
  await page.fill('#email', EMAIL);
  await page.fill('#name', '測試學員');
  await page.check('#agreeRefund');
  await shot(page, '04-購買表單.png', false);
  // 頁面會馬上跳去綠界，先攔下 /api/orders 的回應記住訂單編號
  let order = null;
  await page.route('**/api/orders', async (route) => {
    const resp = await route.fetch();
    order = await resp.json();
    await route.fulfill({ response: resp });
  });
  await page.click('#payBtn');
  for (let i = 0; i < 50 && !order; i++) await page.waitForTimeout(200);
  order = order || {};
  must(/^MA\d{12}[A-Z0-9]{4}$/.test(order.merchantTradeNo || ''), '建單：拿到訂單編號＋綠界表單', order.merchantTradeNo);
  try {
    await page.waitForURL(/payment-stage\.ecpay\.com\.tw/, { timeout: 20000 });
    await page.waitForLoadState('load', { timeout: 20000 });
    await page.waitForTimeout(2500);
    ok('跳到綠界測試環境付款頁', new URL(page.url()).host);
    await shot(page, '05-綠界測試付款頁.png', false);
  } catch (e) {
    ok('綠界測試頁沒載入（網路問題，不影響後面的模擬付款）', String(e.message).slice(0, 80));
  }

  // 5. 模擬綠界 ReturnURL（本機收不到綠界的伺服器通知）
  const cb = execFileSync('node', [join(here, 'simulate-callback.mjs'), order.merchantTradeNo], { encoding: 'utf8' }).trim();
  must(cb === '200 1|OK', '模擬付款成功（綠界 ReturnURL，CheckMacValue 用測試金鑰簽）', cb);

  // 6. 登入（驗證碼從 dry-run 寄信紀錄讀）
  await page.goto(`${SITE}/course-online/learn/login.html`);
  await page.fill('#email', EMAIL);
  const mark = logSize();
  await page.click('#sendBtn');
  const m = await waitLog(mark, /你的登入驗證碼：(\d{6})/);
  must(Boolean(m), '寄驗證碼（dry-run，印在 wrangler dev）', m && `code ${m[1]}`);
  await page.fill('#code', m[1]);
  await shot(page, '06-登入驗證碼.png', false);
  await page.click('#verifyBtn');
  await page.waitForURL(/learn\/index\.html/);
  await page.waitForSelector('#progressBox:not([hidden])');
  must((await page.textContent('#who')).includes(EMAIL), '登入成功：課程目錄顯示學員 email、進度');
  await shot(page, '07-學員目錄.png');

  // 7. 付費集解鎖
  await page.goto(`${SITE}/course-online/learn/unit.html?u=u1&ep=u01-B`);
  const src2 = await waitYoutube(page);
  must(src2.includes(`youtube-nocookie.com/embed/${ytOf['u01-B']}`), '付款後：第 2 集解鎖、站內播', src2.split('?')[0]);
  must((await page.locator('.ep-tag.lock').count()) === 0, '付款後：目錄沒有任何鎖');
  await shot(page, '08-付費集解鎖.png');

  // 8. 交作業（文字＋錄音檔）
  const audio = join(OUT, 'demo-哼唱.m4a');
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'aac', '-b:a', '64k', audio]);
  } catch {
    writeFileSync(audio, Buffer.alloc(2048, 1));
  }
  await page.fill('#hwBody', '窗邊那杯沒喝完的咖啡\n手機還停在你傳的最後一張照片\n（第 1 單元的 4 句畫面句）');
  await page.setInputFiles('#hwFile', audio);
  const mark2 = logSize();
  await page.click('#hwBtn');
  await page.waitForSelector('#hwMsg:not([hidden])');
  must((await page.textContent('#hwMsg')).includes('收到了'), '交作業：送出成功');
  await page.waitForSelector('.hw-list li');
  const notify = await waitLog(mark2, /\[email:dry-run\] provider=(\w+) to=(\S+) subject=(交作業[^\n]+)/);
  must(Boolean(notify), '交作業：即時通知信（dry-run）', notify && `${notify[1]} → ${notify[2]}｜${notify[3]}`);
  await page.locator('#hwBox').scrollIntoViewIfNeeded();
  await shot(page, '09-交作業完成.png');

  // 9. 後台看到作業、下載附檔、標記已回覆
  const adm = await desk.newPage();
  adm.on('dialog', (d) => d.accept());
  await adm.goto(`${SITE}/course-online/admin/`);
  await adm.fill('#tokenInput', ADMIN_TOKEN);
  await adm.click('#btnLogin');
  await adm.waitForSelector('#sceneChooser:not(.hidden)');
  await shot(adm, '10a-後台選單.png', false);
  await adm.click('[data-go="homework"]');
  await adm.waitForSelector('.hw');
  const first = await adm.textContent('.hw');
  must(first.includes(EMAIL) && first.includes('窗邊那杯沒喝完的咖啡') && /通知信已寄|寄信還沒接上/.test(first), '後台：看到剛交的作業（文字、附檔、通知狀態）');
  const [dl] = await Promise.all([adm.waitForEvent('download'), adm.click('.hw .ep-acts button >> nth=0')]);
  const dlPath = join(OUT, 'downloaded-' + dl.suggestedFilename());
  await dl.saveAs(dlPath);
  must(readFileSync(dlPath).equals(readFileSync(audio)), '後台：下載的附檔跟上傳的一模一樣', dl.suggestedFilename());
  await shot(adm, '10-後台作業.png');
  await adm.click('.hw .ep-acts button:has-text("標記已回覆")');
  await adm.waitForSelector('.hw .hw-st.reviewed');
  ok('後台：標記已回覆');

  // 10. 後台編輯：改單元標題＋補一集（貼連結、勾免費、移到第一個）→ 儲存 → 前台看到 → 改回來、刪掉
  await adm.click('#sceneHomework [data-go=""]');
  await adm.click('[data-go="course"]');
  await adm.waitForSelector('[data-unit-panel="u1"] .ep');
  const u1p = adm.locator('[data-unit-panel="u1"]');
  const oldTitle = await u1p.locator('.panel-body input >> nth=0').inputValue();
  await u1p.locator('.panel-body input >> nth=0').fill(oldTitle + '（後台測試）');
  must((await adm.textContent('#saveInfo')).includes('未儲存'), '後台：改了欄位，底部顯示「有未儲存的變更」');
  await u1p.locator('button.add').click();
  const card = () => adm.locator('[data-unit-panel="u1"] .ep').last();
  await card().locator('input >> nth=0').fill('補拍：示範音（測試）');
  await card().locator('input >> nth=1').fill('https://youtu.be/AbCdEfGhIjK');
  await card().locator('input >> nth=2').fill('2.5');
  await card().locator('label:has-text("免費") input').check();
  for (let i = 0; i < 9; i++) await adm.locator('[data-unit-panel="u1"] .ep').nth(9 - i).locator('button:has-text("往前")').click();
  must((await adm.locator('[data-unit-panel="u1"] .ep').nth(0).locator('input').first().inputValue()).includes('補拍'), '後台：新的一集移到第一個');
  await shot(adm, '11-後台編輯-未儲存.png');
  await adm.click('#btnSave');
  await adm.waitForSelector('#toast:has-text("已儲存")');
  await adm.waitForSelector('[data-unit-panel="u1"] .ep');
  let pub = await (await adm.request.get('http://localhost:8787/api/course')).json();
  must(pub.course.units[0].title === oldTitle + '（後台測試）', '前台：單元標題改了', pub.course.units[0].title);
  must(pub.course.units[0].episodes[0].title === '補拍：示範音（測試）' && pub.course.units[0].episodes[0].free === true && pub.course.units[0].episodes[0].minutes === 3, '前台：新的一集排第一、免費、3 分鐘');
  await shot(adm, '12-後台編輯-已儲存.png', false);
  // 改回來
  await adm.locator('[data-unit-panel="u1"] .panel-body input >> nth=0').fill(oldTitle);
  await adm.locator('[data-unit-panel="u1"] .ep').nth(0).locator('button:has-text("刪除")').click();
  await adm.click('#btnSave');
  await adm.waitForSelector('#toast:has-text("已儲存")');
  await adm.waitForFunction(() => document.querySelectorAll('[data-unit-panel="u1"] .ep').length === 9);
  pub = await (await adm.request.get('http://localhost:8787/api/course')).json();
  must(pub.course.units[0].title === oldTitle && pub.course.units[0].episodes[0].id === 'u01-A' && pub.course.units[0].episodes.length === 9, '後台：改回原標題、刪掉測試集');

  // ======================================================== 手機 390：版面
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-TW',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  const guest = await phone.newPage();
  const mobilePages = [
    ['m01-目錄-沒登入.png', `${SITE}/course-online/learn/`, '.lrn-unit'],
    ['m02-單元-免費集.png', `${SITE}/course-online/learn/unit.html?u=u2`, '#player iframe'],
    ['m03-單元-鎖住.png', `${SITE}/course-online/learn/unit.html?u=u2&ep=u02-C`, '#lock:not([hidden])'],
    ['m04-購買頁.png', `${SITE}/course-online/`, '#preorderForm'],
    ['m05-登入.png', `${SITE}/course-online/learn/login.html`, '#emailForm'],
  ];
  for (const [file, url, sel] of mobilePages) {
    await guest.goto(url);
    await guest.waitForSelector(sel);
    await guest.waitForTimeout(sel.includes('iframe') ? 3500 : 500);
    must(await noHScroll(guest), `手機 390：${file.replace(/^m\d+-|\.png$/g, '')} 沒有橫向捲動`);
    await shot(guest, file);
  }
  // 學員（沿用桌機登入的 cookie）
  await phone.addCookies(await desk.cookies('http://localhost:8787'));
  const mem = await phone.newPage();
  await mem.goto(`${SITE}/course-online/learn/unit.html?u=u1&ep=u01-C`);
  await mem.waitForSelector('#hwForm:not([hidden])');
  await mem.waitForSelector('#player iframe');
  await mem.waitForTimeout(3500);
  must(await noHScroll(mem), '手機 390：學員單元頁（播放＋交作業）沒有橫向捲動');
  await shot(mem, 'm06-學員單元-交作業.png');
  const madm = await phone.newPage();
  madm.on('dialog', (d) => d.accept());
  await madm.goto(`${SITE}/course-online/admin/`);
  await madm.fill('#tokenInput', ADMIN_TOKEN);
  await madm.click('#btnLogin');
  await madm.waitForSelector('#sceneChooser:not(.hidden)');
  await madm.click('[data-go="homework"]');
  await madm.waitForSelector('.hw');
  must(await noHScroll(madm), '手機 390：後台作業沒有橫向捲動');
  await shot(madm, 'm07-後台作業.png');
  await madm.click('#sceneHomework [data-go=""]');
  await madm.click('[data-go="course"]');
  await madm.waitForSelector('[data-unit-panel="u1"] .ep');
  must(await noHScroll(madm), '手機 390：後台課程內容沒有橫向捲動');
  await shot(madm, 'm08-後台課程內容.png', false);
  await madm.locator('[data-unit-panel="u1"] .ep').nth(1).scrollIntoViewIfNeeded();
  await shot(madm, 'm09-後台集數卡.png', false);
} finally {
  await browser.close();
  writeFileSync(join(OUT, 'e2e-result.json'), JSON.stringify({ at: new Date().toISOString(), buyer: EMAIL, steps }, null, 1));
  const bad = steps.filter((s) => !s.ok).length;
  console.log(`\n${steps.length - bad} / ${steps.length} 步通過${bad ? '，有失敗' : ''}；截圖在 ${OUT}`);
  if (bad) process.exitCode = 1;
}
