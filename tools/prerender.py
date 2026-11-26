#!/usr/bin/env python3
"""tools/prerender.py — 把 content.json 的文字直接寫進首頁和四個服務頁的 HTML（2026-11-18 建，GEO 健檢第 3 項）

為什麼要有這支：
  首頁（js/main.js）和服務頁（js/service-page.js）的內容是頁面打開後才用 JS 從 content.json 載入的。
  ChatGPT、Claude、Perplexity 的爬蟲不跑 JS，只抓得到標題和「填寫表單」，約 150 字。
  這支照 JS 的渲染邏輯，把同一份內容預先寫進 HTML。JS 照舊會在載入後用最新的 content.json 重畫一次，
  所以人看到的畫面不變；爬蟲則不用跑 JS 也讀得到全文。

什麼時候要跑：
  改了 content.json（包括從後台 admin.html 改字）之後跑一次再 commit：
      python3 tools/prerender.py
  沒跑也不會壞畫面（JS 會畫最新版），只是爬蟲讀到的是上一次跑的版本。
  跑完會印出每頁 HTML 內可讀到的字數。

規則：
  - 只改 <!-- 或 id="..." 標記的容器內容，不動版面、class、樣式。
  - 純標準庫，不需要安裝任何東西。
  - 渲染邏輯要跟 js/main.js、js/service-page.js 保持一致；那兩支改了渲染方式，這裡也要跟著改。
  - 2026-11-19：content.json 的 seo 也由這支寫進 HTML（後台「SEO」面板改）：
      seo.home       → 首頁 <meta name="description">、<meta name="keywords">、結構化資料的 knowsAbout 與 hasOfferCatalog
      seo.courseHub  → course-hub/index.html 的 <title> 與 <meta name="description">
      seo.course     → course/index.html 的 <title> 與 <meta name="description">
    這幾頁的 og:title／og:description（社群分享預覽）本來就跟搜尋用的字不同，這支不動它們。
"""
import html, json, os, re, sys

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
esc = lambda s: html.escape(str(s if s is not None else ''), quote=False)
attr = lambda s: html.escape(str(s if s is not None else ''), quote=True)


# ── 小工具：找到 id="X" 的元素，換掉它的內容 ─────────────────────
def _find(doc, el_id):
    m = re.search(r'<([a-zA-Z][\w-]*)\b[^>]*\bid="%s"[^>]*>' % re.escape(el_id), doc)
    if not m:
        raise SystemExit(f'[prerender] 找不到 id="{el_id}"，HTML 結構改了？')
    tag = m.group(1).lower()
    # 找對應的結束標籤（處理同名巢狀）
    depth, pos = 1, m.end()
    pat = re.compile(r'<(/?)%s\b[^>]*?(/?)>' % tag, re.I)
    while depth:
        n = pat.search(doc, pos)
        if not n:
            raise SystemExit(f'[prerender] id="{el_id}" 沒有結束標籤')
        if n.group(1):
            depth -= 1
        elif not n.group(2):
            depth += 1
        pos = n.end()
    return m, n  # open-tag match, close-tag match


def set_inner(doc, el_id, inner):
    m, n = _find(doc, el_id)
    return doc[:m.end()] + inner + doc[n.start():]


def set_attr(doc, el_id, name, value):
    """設定（或移除，value=None）開頭標籤上的屬性。"""
    m, _ = _find(doc, el_id)
    tag = m.group(0)
    tag2 = re.sub(r'\s%s(="[^"]*")?(?=[\s>/])' % re.escape(name), '', tag)
    if value is not None:
        tag2 = tag2[:-1].rstrip() + f' {name}="{attr(value)}">' if not tag2.endswith('/>') else tag2
    return doc[:m.start()] + tag2 + doc[m.end():]


def set_head(doc, title=None, desc=None):
    if title:
        doc = re.sub(r'<title>.*?</title>', lambda _: f'<title>{esc(title)}</title>', doc, count=1, flags=re.S)
        doc = re.sub(r'(<meta property="og:title" content=")[^"]*(")', lambda m: m.group(1) + attr(title) + m.group(2), doc, count=1)
    if desc:
        doc = re.sub(r'(<meta name="description" content=")[^"]*(")', lambda m: m.group(1) + attr(desc) + m.group(2), doc, count=1)
        doc = re.sub(r'(<meta property="og:description" content=")[^"]*(")', lambda m: m.group(1) + attr(desc) + m.group(2), doc, count=1)
    return doc


def set_meta_only(doc, title=None, desc=None, keywords=None):
    """只改 <title>／<meta name="description">／<meta name="keywords">，不碰 og（og 的字刻意跟搜尋用的不同）。"""
    if title:
        doc = re.sub(r'<title>.*?</title>', lambda _: f'<title>{esc(title)}</title>', doc, count=1, flags=re.S)
    if desc:
        doc = re.sub(r'(<meta name="description" content=")[^"]*(")', lambda m: m.group(1) + attr(desc) + m.group(2), doc, count=1)
    if keywords:
        doc = re.sub(r'(<meta name="keywords" content=")[^"]*(")', lambda m: m.group(1) + attr(', '.join(keywords)) + m.group(2), doc, count=1)
    return doc


def _lines(v):
    if isinstance(v, str):
        v = v.splitlines()
    return [str(x).strip() for x in (v or []) if str(x or '').strip()]


def set_home_seo(doc, seo):
    """seo.home → 首頁 head 的 description／keywords／結構化資料（knowsAbout、hasOfferCatalog）。"""
    if not seo:
        return doc
    doc = set_meta_only(doc, desc=(seo.get('description') or '').strip(), keywords=_lines(seo.get('keywords')))
    ka = _lines(seo.get('knowsAbout'))
    if ka:
        doc = re.sub(r'("knowsAbout": )\[[^\]]*\]', lambda m: m.group(1) + json.dumps(ka, ensure_ascii=False).replace('</', '<\\/'), doc, count=1)
    offers = [o for o in seo.get('offers') or [] if o.get('name') and o.get('url')]
    if offers:
        lines = []
        for o in offers:
            j = lambda v: json.dumps(str(v or '').strip(), ensure_ascii=False).replace('</', '<\\/')
            lines.append('          { "@type": "Offer", "itemOffered": { "@type": "Service", "name": %s, "url": %s, "description": %s } }'
                         % (j(o['name']), j(o['url']), j(o.get('description'))))
        doc = re.sub(r'("itemListElement": \[\n).*?(\n\s*\])', lambda m: m.group(1) + ',\n'.join(lines) + m.group(2), doc, count=1, flags=re.S)
    return doc


def render_head_only(rel, seo):
    """寫歌課兩頁：只換 <title> 與 description，內文不動（那兩頁不是 content.json 畫的）。"""
    path = os.path.join(SITE, rel)
    doc = open(path, encoding='utf-8').read()
    doc = set_meta_only(doc, title=(seo.get('title') or '').strip(), desc=(seo.get('description') or '').strip())
    open(path, 'w', encoding='utf-8').write(doc)
    return path, visible_chars(doc)


def visible_chars(doc):
    s = re.sub(r'(?is)<(script|style|head|noscript)\b[^>]*>.*?</\1>', ' ', doc)
    t = html.unescape(re.sub(r'<[^>]+>', ' ', s))
    return len(re.sub(r'\s+', '', t))


# ── 首頁（對照 js/main.js）─────────────────────────────────────
def status_for(svc):
    if svc.get('statusLabel'):
        return svc['statusLabel'], svc.get('statusClass') or ''
    url = str(svc.get('checkoutUrl') or '')
    mode = svc.get('mode')
    if mode == 'paid' and url and not url.startswith('PLACEHOLDER'):
        return '可預約', ''
    if mode == 'paid':
        return '設定中', 'service-card__status--soon'
    if mode == 'pre-order':
        return '預售中', 'service-card__status--quote'
    if mode == 'quote':
        return '諮詢報價', 'service-card__status--quote'
    return '—', 'service-card__status--soon'


def split_head(headline, default):
    parts = (headline or default).split('—')
    zh = parts[1].strip() if len(parts) > 1 else ''
    return parts[0].strip(), ('— ' + zh + ' —' if zh else '')


def render_home(c):
    path = os.path.join(SITE, 'index.html')
    doc = open(path, encoding='utf-8').read()
    m = c.get('meta', {}); h = c.get('hero', {})
    doc = set_home_seo(doc, (c.get('seo') or {}).get('home'))

    # console bar
    doc = set_inner(doc, 'brandNameEn', esc(m.get('brandNameEn') or 'MR. ALLEYS'))
    doc = set_inner(doc, 'brandEst', esc(m.get('established') or ''))

    # marquee
    mq = c.get('marquee', {})
    items = mq.get('items')
    if isinstance(items, str):
        items = items.splitlines()
    items = [str(s or '').strip() for s in (items or []) if str(s or '').strip()]
    if (mq.get('enabled') in (True, 'true')) and items:
        sep = '  ●  '
        doc = set_attr(doc, 'marquee', 'hidden', None)
        doc = set_inner(doc, 'marqueeTrack', esc(sep.join(items) + sep + sep.join(items) + sep))
        doc = set_attr(doc, 'marqueeTrack', 'style', f'--marquee-speed: {int(mq.get("speed") or 28)}s;')
    else:
        doc = set_attr(doc, 'marquee', 'hidden', '')
        doc = set_inner(doc, 'marqueeTrack', '')

    # hero
    doc = set_inner(doc, 'heroTitleZh', esc(m.get('brandName') or '巷弄故事館'))
    doc = set_inner(doc, 'heroTitleEn', esc(m.get('brandNameEn') or 'MR. ALLEYS'))
    doc = set_inner(doc, 'heroSub', esc(m.get('subtagline') or ''))
    doc = set_inner(doc, 'heroCtaPrimary', esc(h.get('ctaPrimary') or '▶ 開始'))
    doc = set_inner(doc, 'heroCtaSecondary', esc(h.get('ctaSecondary') or '↓ 看服務'))
    doc = set_inner(doc, 'signalFlow', ''.join(
        f'<div class="signal-flow__line">{esc(line)}</div>' for line in h.get('consoleLines') or []))

    # services grid（卡片本體；點擊彈窗由 JS 綁定）
    cards = []
    for svc in c.get('services') or []:
        label, cls = status_for(svc)
        cards.append(
            f'<button type="button" class="service-card reveal" data-service-id="{attr(svc.get("id"))}" aria-label="{attr(svc.get("title"))}">'
            f'<div class="service-card__head"><span class="service-card__code">{esc(svc.get("code") or "")}</span>'
            f'<span class="service-card__status {attr(cls)}">{esc(label)}</span></div>'
            f'<h3 class="service-card__title">{esc(svc.get("title"))}</h3>'
            f'<p class="service-card__sub">{esc(svc.get("subtitle") or "")}</p>'
            f'<div class="service-card__foot"><span class="service-card__price"></span>'
            f'<span class="service-card__cta">{esc(svc.get("ctaLabel") or "→ 詳情")}</span></div></button>')
    doc = set_inner(doc, 'servicesGrid', '\n    ' + '\n    '.join(cards) + '\n  ')

    # process
    p = c.get('process', {})
    en, zh = split_head(p.get('headline'), 'SIGNAL FLOW')
    doc = set_inner(doc, 'processHeadline', esc(en))
    doc = set_inner(doc, 'processSub', esc(zh))
    steps = []
    for s in p.get('steps') or []:
        clickable = bool(s.get('detail'))
        extra_attr = ' role="button" tabindex="0"' if clickable else ''
        more = '<span class="process-step__more">點一下看說明 ▸</span>' if clickable else ''
        steps.append(
            f'<div class="process-step reveal{" process-step--clickable" if clickable else ""}"'
            f'{extra_attr}>'
            f'<div class="process-step__num">{esc(s.get("step"))}</div>'
            f'<h4 class="process-step__title">{esc(s.get("title"))}</h4>'
            f'<p class="process-step__desc">{esc(s.get("desc"))}</p>'
            f'{more}</div>')
    doc = set_inner(doc, 'processSteps', '\n    ' + '\n    '.join(steps) + '\n  ')

    # about
    a = c.get('about', {})
    en, zh = split_head(a.get('headline'), 'WORKSHOP NOTES')
    doc = set_inner(doc, 'aboutHeadline', esc(en))
    doc = set_inner(doc, 'aboutSub', esc(zh))
    doc = set_inner(doc, 'aboutManifesto', ''.join(f'<p>{esc(x)}</p>' for x in a.get('manifesto') or []))
    doc = set_inner(doc, 'aboutStats', ''.join(
        f'<div class="stat-card reveal"><span class="stat-card__label">{esc(s.get("label"))}</span>'
        f'<div><span class="stat-card__value">{esc(s.get("value"))}</span>'
        f'<span class="stat-card__unit">{esc(s.get("unit") or "")}</span></div></div>' for s in a.get('stats') or []))

    # showcase
    s = c.get('showcase', {})
    en, zh = split_head(s.get('headline'), 'ALREADY ON AIR')
    doc = set_inner(doc, 'showcaseHeadline', esc(en))
    doc = set_inner(doc, 'showcaseSub', esc(zh))
    doc = set_inner(doc, 'showcaseIntro', esc(s.get('intro') or ''))
    if s.get('playlistUrl'):
        doc = set_attr(doc, 'showcaseCta', 'href', s['playlistUrl'])
        # 2026-11-26：按鈕改圓形 A 鍵（裡面有 abtn__key／abtn__sub 兩個 span），只寫下面那行小字，不能蓋掉整顆按鈕
        doc = set_inner(doc, 'showcaseCtaSub', esc(re.sub(r'^[▶→]\s*', '', s.get('playlistLabel') or '在 YouTube 聽完整歌單')))

    # contact
    ct = c.get('contact', {})
    en, zh = split_head(ct.get('headline'), 'TRANSMIT')
    doc = set_inner(doc, 'contactHeadline', esc(en))
    doc = set_inner(doc, 'contactSub', esc(zh))
    if ct.get('email'):
        doc = set_attr(doc, 'contactEmail', 'href', 'mailto:' + ct['email'])
        doc = set_inner(doc, 'contactEmail', esc(ct['email']))
    doc = set_inner(doc, 'contactSocials', ''.join(
        f'<li><a href="{attr(x.get("url"))}" target="_blank" rel="noopener">→ {esc(x.get("label"))}</a></li>'
        for x in ct.get('socials') or []))

    # footer
    f = c.get('footer', {})
    doc = set_inner(doc, 'footerCredit', esc(f.get('credit') or ''))
    doc = set_inner(doc, 'footerBuild', esc(f.get('buildNote') or ''))

    open(path, 'w', encoding='utf-8').write(doc)
    return path, visible_chars(doc)


# ── 服務頁（對照 js/service-page.js）──────────────────────────────
# 2026-11-24：線上影片課由 pageBlocks["courseOnline.enabled"] 總開關控制（預設關，跟 js/service-page.js 同一邏輯）。
# 回台中打開總開關後重跑本支，這裡自動換回三種上法。
COURSE_NAV_ON = ('<nav class="svc-others" aria-label="寫歌課"><div class="svc-others-label">寫歌課</div>'
                 '<p class="svc-course-text">沒寫過歌也可以：初學者實體小班、線上影片課、一對一，三種上法。</p>'
                 '<div class="svc-others-row"><a class="svc-other" href="/course-hub/">看寫歌課的三種上法 →</a></div></nav>')
COURSE_NAV_OFF = COURSE_NAV_ON.replace('、線上影片課', '').replace('三種上法', '兩種上法')
COURSE_NAV = COURSE_NAV_OFF  # main() 依開關覆寫


def render_service(page, all_pages):
    path = os.path.join(SITE, 'services', page['slug'], 'index.html')
    doc = open(path, encoding='utf-8').read()
    doc = set_head(doc, page.get('docTitle') or (page['title'] + ' · 巷弄故事館 MR. ALLEYS'), page.get('metaDescription'))
    doc = set_inner(doc, 'svcTitle', esc(page['title']))

    out = []
    if page.get('lead'):
        out.append(f'<p class="svc-lead">{esc(page["lead"])}</p>')
    for s in page.get('sections') or []:
        h = (f'<span class="svc-ico">{esc(s["icon"])}</span>' if s.get('icon') else '') + esc(s.get('heading') or '')
        body = ''.join(f'<p>{esc(p)}</p>' for p in s.get('paras') or [] if p)
        lst = [li for li in s.get('list') or [] if li]
        if lst:
            body += '<ul class="svc-list">' + ''.join(f'<li>{esc(li)}</li>' for li in lst) + '</ul>'
        if s.get('note'):
            body += f'<p class="svc-note">{esc(s["note"])}</p>'
        out.append(f'<section class="svc-sec"><h2>{h}</h2>{body}</section>')
    doc = set_inner(doc, 'svcBody', '\n    ' + '\n    '.join(out) + '\n  ')

    others = ''.join(f'<a class="svc-other" href="../{attr(p["slug"])}/">{esc(p["title"])}</a>'
                     for p in all_pages if p['id'] != page['id'])
    nav = f'<nav class="svc-others"><div class="svc-others-label">其他服務</div><div class="svc-others-row">{others}</div></nav>'
    doc = set_inner(doc, 'svcOthers', COURSE_NAV + nav)
    open(path, 'w', encoding='utf-8').write(doc)
    return path, visible_chars(doc)


def main():
    c = json.load(open(os.path.join(SITE, 'content.json'), encoding='utf-8'))
    global COURSE_NAV
    _sw = (c.get('pageBlocks') or {}).get('courseOnline.enabled') or {}
    COURSE_NAV = COURSE_NAV_ON if str(_sw.get('enabled')).lower() == 'true' else COURSE_NAV_OFF
    results = [render_home(c)]
    pages = c.get('servicePages') or []
    for p in pages:
        results.append(render_service(p, pages))
    seo = c.get('seo') or {}
    for key, rel in (('courseHub', 'course-hub/index.html'), ('course', 'course/index.html')):
        if seo.get(key):
            results.append(render_head_only(rel, seo[key]))
    for path, n in results:
        print(f'{os.path.relpath(path, SITE):32s} HTML 可讀字數 {n}')


if __name__ == '__main__':
    main()
