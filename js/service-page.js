/* service-page.js — 四個服務子頁共用的渲染器（2026-08-11 建）
 *
 * 為什麼是資料驅動而不是四份寫死的 HTML：
 *   耗耗要「後台能改字」。內容全部住在 content.json 的 servicePages，
 *   admin.html 本來就在編輯 content.json，所以完全不用新增第二套存檔路徑。改字不用碰 HTML，也不用找我。
 *
 * 每頁只差 <body data-page="consult"> 那個值，其餘完全一樣。
 * head 裡的 title / description / canonical / og 是寫死的（每頁各自一份）——
 * 那是給 Google 看的，不能等 JS 跑完才有。
 */
(function () {
  const PAGE_ID = document.body.dataset.page;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  fetch('../../content.json?v=' + Date.now())
    .then((r) => {
      if (!r.ok) throw new Error('content.json ' + r.status);
      return r.json();
    })
    .then((data) => {
      const page = (data.servicePages || []).find((p) => p.id === PAGE_ID);
      if (!page) throw new Error('找不到 id=' + PAGE_ID + ' 的頁面資料');
      render(page, data.servicePages);
    })
    .catch((err) => {
      // 讀不到就講清楚讀不到，不要留一片空白讓人以為站壞了
      const box = $('svcBody');
      box.innerHTML = '';
      const w = el('section', 'svc-sec');
      w.appendChild(el('h2', null, '內容暫時讀不到'));
      w.appendChild(el('p', null, '請稍後重新整理，或直接來信 hao@mralleys.com。'));
      w.appendChild(el('p', 'svc-note', String(err.message || err)));
      box.appendChild(w);
    });

  function render(page, allPages) {
    document.title = page.title + ' · 巷弄故事館 MR. ALLEYS';
    $('svcTitle').textContent = page.title;

    const body = $('svcBody');
    body.innerHTML = '';

    if (page.lead) {
      const lead = el('p', 'svc-lead', page.lead);
      body.appendChild(lead);
    }

    (page.sections || []).forEach((s) => {
      const sec = el('section', 'svc-sec');
      const h = el('h2');
      if (s.icon) {
        const i = el('span', 'svc-ico', s.icon);
        h.appendChild(i);
      }
      h.appendChild(document.createTextNode(s.heading || ''));
      sec.appendChild(h);

      (s.paras || []).forEach((p) => { if (p) sec.appendChild(el('p', null, p)); });

      if ((s.list || []).length) {
        const ul = el('ul', 'svc-list');
        s.list.forEach((li) => { if (li) ul.appendChild(el('li', null, li)); });
        sec.appendChild(ul);
      }

      if (s.note) sec.appendChild(el('p', 'svc-note', s.note));
      body.appendChild(sec);
    });

    // 其他三個服務的橫向導覽（原本 Notion 頁上也有，留著）
    const nav = el('nav', 'svc-others');
    nav.appendChild(el('div', 'svc-others-label', '其他服務'));
    const row = el('div', 'svc-others-row');
    (allPages || []).forEach((p) => {
      if (p.id === page.id) return;
      const a = el('a', 'svc-other', p.title);
      a.href = '../' + p.slug + '/';
      row.appendChild(a);
    });
    nav.appendChild(row);
    (document.getElementById('svcOthers') || body).appendChild(nav);
  }
})();
