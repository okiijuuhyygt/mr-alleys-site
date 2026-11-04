/* page-blocks.js — 依 content.json 的 pageBlocks 開關，顯示或隱藏頁面上「收起來」的區塊（2026-11-07 建）
 *
 * 用法（以後新增可收起的區塊都照這個做）：
 *   1. HTML 裡區塊照原本的樣子保留，外面包一層 <div data-block="頁面.區塊" hidden>…</div>
 *      （hidden 讓它在 JS 還沒跑、或讀不到 content.json 時都是藏著的）
 *   2. 區塊打開時要藏起來的替代內容，加 data-block-unless="頁面.區塊"（平常顯示，打開時藏）
 *   3. 頁面載入這支：<script src="/js/page-blocks.js?v=…" defer></script>
 *   4. content.json 的 pageBlocks 加一筆："頁面.區塊": { "label": "後台顯示的名稱", "enabled": false }
 *   後台 admin.html 的「頁面區塊顯示」面板會自動列出 pageBlocks 的每一筆，勾選＝顯示。
 */
(function () {
  // 有些元件自己寫了 display（例如 .crs-btn 是 block），hidden 會被蓋掉；這條保證 hidden 一定藏得住
  var style = document.createElement('style');
  style.textContent = '[data-block][hidden],[data-block-unless][hidden]{display:none!important}';
  document.head.appendChild(style);

  function apply(blocks) {
    var on = function (key) { var b = blocks && blocks[key]; return Boolean(b && (b.enabled === true || b.enabled === 'true')); };
    document.querySelectorAll('[data-block]').forEach(function (el) { el.hidden = !on(el.getAttribute('data-block')); });
    document.querySelectorAll('[data-block-unless]').forEach(function (el) { el.hidden = on(el.getAttribute('data-block-unless')); });
  }

  fetch('/content.json?v=' + Date.now())
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (data) { apply(data.pageBlocks || {}); })
    .catch(function () { apply({}); }); // 讀不到就全部維持隱藏
})();
