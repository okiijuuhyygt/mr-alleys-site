#!/usr/bin/env python3
"""tools/build-blog.py — 從 blog-src/*.md 產生 blog/（純標準庫，GitHub Actions 每次 blog-src 變動就跑）。
來源 frontmatter：id／title／series／series_key／date／keywords／tags／assets。內文 markdown。
標點：中文脈絡半形→全形，網址／數字／code 不碰。文末裸網址→按鈕。文章頁帶「編輯」鈕（只有存了後台 token 的瀏覽器看得到）。
"""
import re, os, sys, json, glob, html, shutil, datetime
SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = 'https://mralleys.com'; TODAY = datetime.date.today().isoformat()
SERIES_ORDER = ['qa','se01','se09','se02','se03','se05','se06','se04','se07','se10','se08']
HIDE_SERIES = set()  # 目錄不列但頁面仍產（例：'se08'）
CJK = r'[一-鿿　-〿＀-￯]'
CJKL = r'[一-鿿　-〿＀-￯」』）]'   # 左鄰：含收尾全形括號
CJKR = r'[一-鿿　-〿＀-￯「『（]'   # 右鄰：含起始全形括號

# ── 標點正規化 ──────────────────────────────────────────────
PROTECT = re.compile(r'(`[^`]*`|https?://\S+|\[[^\]]*\]\([^)]*\)|\d[\d,.:]*\d)')  # 站內連結 [..](/..) 已含在第三項
def _fw(seg):
    seg = re.sub(rf'(?<={CJKL})\s*,\s*|\s*,\s*(?={CJKR})', '，', seg)
    seg = re.sub(rf'(?<={CJKL})\s*;\s*|\s*;\s*(?={CJKR})', '；', seg)
    seg = re.sub(rf'(?<={CJKL})\s*:\s*|\s*:\s*(?={CJKR})', '：', seg)
    seg = re.sub(rf'(?<={CJKL})\s*\?\s*|\s*\?\s*(?={CJKR})', '？', seg)
    seg = re.sub(rf'(?<={CJKL})\s*!\s*|\s*!\s*(?={CJKR})', '！', seg)
    seg = re.sub(rf'(?<={CJKL})\s*\(|\((?=[^)]*{CJK})', '（', seg)
    seg = re.sub(rf'\)(?={CJKR})|(?<={CJK})\s*\)', '）', seg)
    # 括號配平：前面已開了全形（，遇到半形 ) 就收成 ）
    buf, depth = [], 0
    for ch in seg:
        if ch == '（': depth += 1
        elif ch == '）': depth = max(0, depth - 1)
        elif ch == ')' and depth > 0: ch = '）'; depth -= 1
        buf.append(ch)
    seg = ''.join(buf)
    seg = re.sub(rf'(?<={CJK})\.(?=\s|$|{CJK})', '。', seg)
    return seg
def normalize_punct(line):
    if line.startswith(('    ', '\t')): return line
    out, i = [], 0
    for m in PROTECT.finditer(line):
        out.append(_fw(line[i:m.start()])); out.append(m.group(0)); i = m.end()
    out.append(_fw(line[i:]))
    s = ''.join(out)
    # 第二趟（同樣避開受保護區段）：括號轉全形後，鄰接的逗號才看得到全形鄰居
    out2, j = [], 0
    for m in PROTECT.finditer(s):
        out2.append(_fw(s[j:m.start()])); out2.append(m.group(0)); j = m.end()
    out2.append(_fw(s[j:])); s = ''.join(out2)
    s = re.sub(r'（\s+', '（', s); s = re.sub(r'\s+）', '）', s)
    return s

# ── markdown → html（只做這批用到的構件）──────────────────
def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r'`([^`]+)`', r'<code>\1</code>', s)
    s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s)
    s = re.sub(r'\[([^\]]+)\]\((https?://[^)\s]+)\)', r'<a href="\2" target="_blank" rel="noopener">\1</a>', s)
    s = re.sub(r'\[([^\]]+)\]\((/[^)\s]+)\)', r'<a href="\2">\1</a>', s)
    s = re.sub(r'(?<![">])(https?://[^\s<]+)', r'<a href="\1" target="_blank" rel="noopener">\1</a>', s)
    return s
def md_to_html(md):
    # 痞客邦 CDN 註記行（【示意圖①】已上架 CDN: https://pimg…（原檔 xxx.png）——說明）→ 本站圖
    def _fig(m):
        name = m.group(1); cap = (m.group(2) or '').strip(' ——-')
        return f'<figure><img src="/blog/assets/{name}" alt="{html.escape(cap)}" loading="lazy"><figcaption>{html.escape(cap)}</figcaption></figure>'
    md = re.sub(r'^【示意圖[^】]*】[^\n]*?原檔\s*([\w.-]+\.png)\s*[)）]\s*(?:——|—|-)?\s*([^\n]*)$', _fig, md, flags=re.M)
    lines = [normalize_punct(l.rstrip()) for l in md.split('\n')]
    out, i, n = [], 0, len(lines)
    def flush_para(buf):
        if buf: out.append('<p>' + '<br>'.join(inline(x) for x in buf) + '</p>')
    buf = []
    while i < n:
        l = lines[i]
        if not l.strip(): flush_para(buf); buf = []; i += 1; continue
        m = re.match(r'^(#{1,6})\s+(.*)$', l)
        if m:
            flush_para(buf); buf = []; lvl = min(len(m.group(1)) + 1, 4)
            out.append(f'<h{lvl}>{inline(m.group(2).strip())}</h{lvl}>'); i += 1; continue
        if l.startswith('|') and i + 1 < n and re.match(r'^\|?\s*:?-{2,}', lines[i+1]):
            flush_para(buf); buf = []
            head = [c.strip() for c in l.strip('|').split('|')]; i += 2; rows = []
            while i < n and lines[i].startswith('|'):
                rows.append([c.strip() for c in lines[i].strip('|').split('|')]); i += 1
            out.append('<div class="tbl"><table><thead><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in head) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in rows) + '</tbody></table></div>'); continue
        if re.match(r'^\s*[-*]\s+', l):
            flush_para(buf); buf = []; items = []
            while i < n and re.match(r'^\s*[-*]\s+', lines[i]): items.append(re.sub(r'^\s*[-*]\s+', '', lines[i])); i += 1
            out.append('<ul>' + ''.join(f'<li>{inline(x)}</li>' for x in items) + '</ul>'); continue
        if re.match(r'^\s*\d+\.\s+', l):
            flush_para(buf); buf = []; items = []
            while i < n and re.match(r'^\s*\d+\.\s+', lines[i]): items.append(re.sub(r'^\s*\d+\.\s+', '', lines[i])); i += 1
            out.append('<ol>' + ''.join(f'<li>{inline(x)}</li>' for x in items) + '</ol>'); continue
        if l.startswith('>'):
            flush_para(buf); buf = []; q = []
            while i < n and lines[i].startswith('>'): q.append(lines[i].lstrip('> ').strip()); i += 1
            out.append('<blockquote>' + '<br>'.join(inline(x) for x in q) + '</blockquote>'); continue
        if l.startswith('<figure>'): flush_para(buf); buf = []; out.append(l); i += 1; continue
        buf.append(l); i += 1
    flush_para(buf)
    htmltext = '\n'.join(out)
    # 裸網址錨點（顯示文字＝網址）→ 按鈕；句尾的「：」收成「。」
    def _btn(m):
        href = m.group(1)
        if 'gumroad' in href: label, to = '去 Gumroad 看伴奏 →', href
        elif '/store' in href: label, to = '看伴奏商店 →', '/store/'
        elif href.rstrip('/') == 'https://mralleys.com': label, to = '找我聊聊 →', '/services/consult/'
        elif href.startswith('https://mralleys.com/'): label, to = '看服務說明 →', href.replace('https://mralleys.com', '')
        else: label, to = '打開連結 →', href
        ext = ' target="_blank" rel="noopener"' if to.startswith('http') else ''
        return f'<a class="btn" href="{to}"{ext}>{label}</a>'
    htmltext = re.sub(r'[：:]\s*<a href="(https?://[^"]+)"[^>]*>https?://[^<]+</a>', lambda m: '。' + _btn(m), htmltext)
    htmltext = re.sub(r'<a href="(https?://[^"]+)"[^>]*>https?://[^<]+</a>', _btn, htmltext)
    htmltext = re.sub(r'<p>([^<]*?)。(<a class="btn"[^>]*>[^<]*</a>)</p>', r'<p>\1。</p><p class="btn-row">\2</p>', htmltext)
    return htmltext

# ── 模板 ─────────────────────────────────────────────────────
CSS = '''/* blog.css — 專欄頁，顏色字體沿用首頁（羊皮紙＋黃銅＋像素字），2026-09-04 建 */
:root{--paper:#f3ead4;--paper-soft:#ede2c4;--paper-edge:#c9b88c;--ink:#2a1f12;--ink-soft:#5e4a30;--ink-mute:#8a7556;--brass:#b8801f;--brass-light:#d4a13a;--brass-deep:#6e4d10;--quest:#1f5b8b;--shadow:#2a1f12}
@font-face{font-family:"Cubic 11";src:url("../assets/Cubic_11_1.013_R.ttf") format("truetype");font-weight:400;font-display:swap}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--paper);color:var(--ink);font-family:"Noto Sans TC","PingFang TC","Heiti TC",sans-serif;line-height:1.9;padding:16px;-webkit-text-size-adjust:100%}
.wrap{max-width:720px;margin:0 auto}
.back{display:inline-block;margin-bottom:14px;color:var(--quest);font-size:.9rem;text-decoration:none;border-bottom:2px solid var(--quest)}
.back:hover{color:var(--brass-deep);border-color:var(--brass-deep)}
.badge{display:inline-block;font-family:"Cubic 11","Press Start 2P",monospace;font-size:.72rem;letter-spacing:.06em;color:var(--brass-deep);background:var(--paper-soft);border:2px solid var(--paper-edge);padding:4px 10px;margin-bottom:12px}
h1{font-size:1.65rem;line-height:1.35;margin:0 0 8px;letter-spacing:.01em;text-wrap:balance}
.meta{font-size:.82rem;color:var(--ink-mute);margin-bottom:22px;display:flex;flex-wrap:wrap;gap:6px 14px}
.meta a{color:var(--quest);text-decoration:none}
article h2{font-size:1.18rem;margin:30px 0 10px;padding-left:10px;border-left:4px solid var(--brass)}
article h3{font-size:1.02rem;margin:22px 0 8px;color:var(--brass-deep)}
article h4{font-size:.98rem;margin:16px 0 6px}
article p{margin:0 0 14px}
article ul,article ol{margin:0 0 14px 1.4em}
article li{margin:4px 0}
article blockquote{margin:0 0 14px;padding:8px 14px;border-left:4px solid var(--paper-edge);background:var(--paper-soft);color:var(--ink-soft)}
article code{font-family:"VT323","Courier New",monospace;font-size:1.02em;background:var(--paper-soft);padding:0 4px}
article strong{color:var(--brass-deep)}
article a{color:var(--quest)}
.tbl{overflow-x:auto;margin:0 0 14px}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{border:1px solid var(--paper-edge);padding:6px 8px;text-align:left;vertical-align:top}
th{background:var(--paper-soft)}
figure{margin:18px 0}figure img{max-width:100%;border:2px solid var(--paper-edge);background:#fff}figcaption{font-size:.8rem;color:var(--ink-mute);margin-top:4px}
.tags{margin:26px 0 0;font-size:.82rem;color:var(--ink-mute)}
.tags span{display:inline-block;background:var(--paper-soft);border:1px solid var(--paper-edge);padding:1px 8px;margin:0 6px 6px 0}
.cta{margin:34px 0 0;padding:16px 18px;border:2px solid var(--brass);background:var(--paper-soft)}
.cta a{color:var(--brass-deep);font-weight:700}
.btn,.cta .btn{display:inline-block;font-family:"Cubic 11","Press Start 2P",monospace;font-size:.86rem;letter-spacing:.04em;color:var(--ink);background:var(--paper-soft);border:2px solid var(--brass);box-shadow:3px 3px 0 var(--brass-deep);padding:9px 16px;text-decoration:none;margin:6px 0 2px}
.btn:hover{background:var(--brass-light);color:var(--ink);transform:translate(1px,1px);box-shadow:2px 2px 0 var(--brass-deep)}
.btn-row{margin:0 0 18px}
.cta{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.nav2{display:flex;justify-content:space-between;gap:12px;margin:26px 0 0;font-size:.9rem}
.nav2 a{color:var(--quest);text-decoration:none;max-width:48%}
.foot{margin-top:40px;padding-top:14px;border-top:2px solid var(--paper-edge);font-size:.82rem;color:var(--ink-mute)}
.foot a{color:var(--quest);text-decoration:none}
/* 目錄 */
.intro{margin:0 0 22px;color:var(--ink-soft)}
.series{margin:26px 0 0}
.series h2{font-size:1.08rem;margin:0 0 8px;padding-left:10px;border-left:4px solid var(--brass)}
.list{list-style:none;margin:0}
.list li{padding:7px 0;border-bottom:1px dashed var(--paper-edge)}
.list a{color:var(--ink);text-decoration:none}
.list a:hover{color:var(--brass-deep)}
.list .d{font-size:.78rem;color:var(--ink-mute);margin-left:8px;white-space:nowrap}
/* feed（2026-09-04 耗耗：像痞客邦一篇一篇往下滑，目錄另開） */
.topbar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px}
.btn--sm{font-size:.78rem;padding:6px 12px;margin:0}
.feed{display:flex;flex-direction:column;gap:18px;margin-top:8px}
.card{background:#fbf6ea;border:2px solid var(--paper-edge);box-shadow:4px 4px 0 var(--paper-edge);padding:18px 18px 14px}
.card__meta{display:flex;justify-content:space-between;gap:10px;font-size:.78rem;color:var(--ink-mute);margin-bottom:6px}
.card__series{color:var(--brass-deep);text-decoration:none;letter-spacing:.04em}
.card__title{font-size:1.22rem;line-height:1.4;margin:0 0 8px;text-wrap:balance}
.card__title a{color:var(--ink);text-decoration:none}
.card__title a:hover{color:var(--brass-deep)}
.card__ex{margin:0 0 10px;color:var(--ink-soft);font-size:.95rem}
.card__more{color:var(--quest);text-decoration:none;font-size:.9rem;border-bottom:2px solid var(--quest)}
.feed__all{margin:26px 0 0;text-align:center}
.intro a{color:var(--quest)}
/* 讀者浮動鈕（耗耗 9/4 定：只放一個動作＝LINE 聊聊；滑下縮起、滑上出現） */
.chat-fab{position:fixed;right:14px;bottom:16px;z-index:9;font-family:"Cubic 11","Press Start 2P",monospace;font-size:.86rem;letter-spacing:.06em;color:var(--ink);background:var(--paper-soft);border:2px solid var(--brass);box-shadow:3px 3px 0 var(--brass-deep);padding:9px 14px;text-decoration:none;transition:transform .25s,opacity .25s}
.chat-fab:hover{background:var(--brass-light)}
.chat-fab.hide{transform:translateY(80px);opacity:0;pointer-events:none}
@media (prefers-reduced-motion:reduce){.chat-fab{transition:none}}
'''
def head(title, desc, url, extra=''):
    return f'''<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{html.escape(title)}</title>
<meta name="description" content="{html.escape(desc)}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="巷弄故事館 · MR. ALLEYS">
<meta property="og:title" content="{html.escape(title)}">
<meta property="og:description" content="{html.escape(desc)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{BASE}/assets/og-image-v3.png?v=20260429c">
<meta property="og:locale" content="zh_TW">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="alternate" type="application/rss+xml" title="巷弄故事館 音樂製作專欄" href="{BASE}/blog/feed.xml">
<link rel="stylesheet" href="/css/blog.css?v=20260904d">
{extra}</head>'''
FOOT = f'<footer class="foot"><a href="/">回首頁</a> ｜ <a href="/blog/">專欄</a> ｜ <a href="/blog/all/">目錄</a></footer>'
def article_page(p, prev, nxt):
    url = f'{BASE}/blog/{p["id"]}/'
    ld = {"@context":"https://schema.org","@graph":[
        {"@type":"Article","@id":url+"#article","headline":p['title'],"description":p['desc'],"inLanguage":"zh-Hant","datePublished":p['date'],"dateModified":TODAY,"mainEntityOfPage":{"@type":"WebPage","@id":url},"keywords":", ".join(p['keywords']+p['tags']),"articleSection":p['series'],
         "author":{"@type":"Person","name":"陳則皞","url":BASE+"/"},"publisher":{"@type":"Organization","name":"巷弄故事館 Mr.Alleys","url":BASE+"/","logo":{"@type":"ImageObject","url":BASE+"/apple-touch-icon.png"}},"image":BASE+"/assets/og-image-v3.png"},
        {"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"巷弄故事館","item":BASE+"/"},{"@type":"ListItem","position":2,"name":"音樂製作專欄","item":BASE+"/blog/"},{"@type":"ListItem","position":3,"name":p['title'],"item":url}]}]}
    figs = ''
    for a in p['assets']:
        src = f'{SITE}/blog-src/assets/{a}'
        if os.path.exists(src) and f'/blog/assets/{a}' in p['html']:
            os.makedirs(f'{SITE}/blog/assets', exist_ok=True); shutil.copy2(src, f'{SITE}/blog/assets/{a}'); continue
        if os.path.exists(src):
            os.makedirs(f'{SITE}/blog/assets', exist_ok=True); shutil.copy2(src, f'{SITE}/blog/assets/{a}')
            cap = a.replace('.png','').split('-', 2)[-1].replace('-', ' ')
            figs += f'<figure><img src="/blog/assets/{a}" alt="{html.escape(cap)}" loading="lazy"><figcaption>{html.escape(cap)}</figcaption></figure>'
    tags = ''.join(f'<span>{html.escape(t)}</span>' for t in dict.fromkeys(p['keywords'] + p['tags']))
    nav = '<nav class="nav2">' + (f'<a href="/blog/{prev["id"]}/">← {html.escape(prev["title"][:22])}</a>' if prev else '<span></span>') + (f'<a href="/blog/{nxt["id"]}/">{html.escape(nxt["title"][:22])} →</a>' if nxt else '<span></span>') + '</nav>'
    return head(f'{p["title"]}｜巷弄故事館音樂製作專欄', p['desc'], url, f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>\n') + f'''
<body>
<div class="wrap">
  <a class="back" href="/blog/">← 專欄</a>
  <div class="badge">MR.ALLEYS · 音樂製作專欄 · {html.escape(p['series'])}</div>
  <h1>{html.escape(p['title'])}</h1>
  <div class="meta"><span>陳則皞</span><span>{p['date']}</span><span><a href="/blog/all/#{p['pref']}">{html.escape(p['series'])}</a></span></div>
  <article>
{p['html']}
{figs}
  </article>
  <div class="tags">{tags}</div>
  <div class="cta"><span>看完想把自己的歌做出來？從 45 分鐘諮詢開始，把現況跟下一步一次講清楚。</span><a class="btn" href="/services/consult/">預約諮詢 →</a></div>
  {nav}
  {FOOT}
</div>
<a class="chat-fab" id="chatFab" href="https://line.me/R/ti/p/@285qszgm" target="_blank" rel="noopener" aria-label="用 LINE 找製作人聊聊">LINE 聊聊</a>
<script>(function(){{var f=document.getElementById('chatFab'),y=window.scrollY||0;window.addEventListener('scroll',function(){{var n=window.scrollY||0;if(n>y+8&&n>120)f.classList.add('hide');else if(n<y-8)f.classList.remove('hide');y=n;}},{{passive:true}});}})();</script>
</body>
</html>'''
def all_page(posts):
    url = f'{BASE}/blog/all/'
    groups = {}
    for p in posts: groups.setdefault(p['pref'] if p['pref'] != 'ins' else 'se08', []).append(p)
    secs = ''
    for k in SERIES_ORDER:
        if k not in groups or k in HIDE_SERIES: continue
        items = sorted(groups[k], key=lambda x: (x['date'], x['id']), reverse=True)
        secs += f'<section class="series" id="{k}"><h2>{html.escape(SERIES[k])} <span class="d">{len(items)} 篇</span></h2><ul class="list">' + ''.join(f'<li><a href="/blog/{p["id"]}/">{html.escape(p["title"])}</a><span class="d">{p["date"]}</span></li>' for p in items) + '</ul></section>'
    ld = {"@context":"https://schema.org","@type":"CollectionPage","name":"巷弄故事館 音樂製作專欄","url":url,"inLanguage":"zh-Hant","isPartOf":{"@type":"WebSite","name":"巷弄故事館 · MR. ALLEYS","url":BASE+"/"},"about":"音樂製作、編曲、混音、錄音、詞曲創作、AI 音樂、客製化歌曲"}
    return head('專欄目錄｜巷弄故事館音樂製作專欄', f'{len(posts)} 篇音樂製作文章的完整分類目錄：常見問題、編曲混音、錄音、詞曲創作、Logic Pro、AI 音樂、客製化歌曲。', url, f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>\n') + f'''
<body>
<div class="wrap">
  <a class="back" href="/blog/">← 回專欄</a>
  <div class="badge">MR.ALLEYS · 音樂製作專欄 · 目錄</div>
  <h1>專欄目錄</h1>
  <p class="intro">全部 {len(posts)} 篇，照主題分。不知道從哪讀起，回<a href="/blog/">專欄首頁</a>一篇一篇往下滑。</p>
{secs}
  {FOOT}
</div>
<a class="chat-fab" id="chatFab" href="https://line.me/R/ti/p/@285qszgm" target="_blank" rel="noopener" aria-label="用 LINE 找製作人聊聊">LINE 聊聊</a>
<script>(function(){{var f=document.getElementById('chatFab'),y=window.scrollY||0;window.addEventListener('scroll',function(){{var n=window.scrollY||0;if(n>y+8&&n>120)f.classList.add('hide');else if(n<y-8)f.classList.remove('hide');y=n;}},{{passive:true}});}})();</script>
</body>
</html>'''

def index_page(posts):
    url = f'{BASE}/blog/'
    newest = sorted(posts, key=lambda x: (x['date'], x['id']), reverse=True)
    N = 30
    cards = ''
    for p in newest[:N]:
        ex = p['desc'] if len(p['desc']) < 110 else p['desc'][:108].rstrip('，。、；：') + '…'
        cards += f'''<article class="card">
  <div class="card__meta"><a class="card__series" href="/blog/all/#{p["pref"]}">{html.escape(p["series"])}</a><span class="card__date">{p["date"]}</span></div>
  <h2 class="card__title"><a href="/blog/{p["id"]}/">{html.escape(p["title"])}</a></h2>
  <p class="card__ex">{html.escape(ex)}</p>
  <a class="card__more" href="/blog/{p["id"]}/">繼續閱讀 →</a>
</article>
'''
    ld = {"@context":"https://schema.org","@type":"Blog","name":"巷弄故事館 音樂製作專欄","url":url,"inLanguage":"zh-Hant","author":{"@type":"Person","name":"陳則皞"},"publisher":{"@type":"Organization","name":"巷弄故事館 Mr.Alleys","url":BASE+"/"},"blogPost":[{"@type":"BlogPosting","headline":p["title"],"url":f"{BASE}/blog/{p['id']}/","datePublished":p["date"]} for p in newest[:N]]}
    return head('音樂製作專欄｜巷弄故事館 MR. ALLEYS', f'製作人陳則皞的 {len(posts)} 篇音樂製作文章：編曲、混音、錄音、詞曲創作、Logic Pro、AI 音樂、客製化歌曲怎麼做。', url, f'<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>\n') + f'''
<body>
<div class="wrap">
  <div class="topbar"><a class="back" href="/">← 回巷弄故事館</a><a class="btn btn--sm" href="/blog/all/">▤ 目錄</a></div>
  <div class="badge">MR.ALLEYS · 音樂製作專欄</div>
  <h1>音樂製作專欄</h1>
  <p class="intro">製作人陳則皞寫的，編曲、混音、錄音、詞曲創作、AI 音樂、客製化歌曲。每一篇都是做歌時真的會碰到的問題。</p>
  <div class="feed">
{cards}  </div>
  <p class="feed__all"><a class="btn" href="/blog/all/">看全部 {len(posts)} 篇的目錄 →</a></p>
  {FOOT}
</div>
<a class="chat-fab" id="chatFab" href="https://line.me/R/ti/p/@285qszgm" target="_blank" rel="noopener" aria-label="用 LINE 找製作人聊聊">LINE 聊聊</a>
<script>(function(){{var f=document.getElementById('chatFab'),y=window.scrollY||0;window.addEventListener('scroll',function(){{var n=window.scrollY||0;if(n>y+8&&n>120)f.classList.add('hide');else if(n<y-8)f.classList.remove('hide');y=n;}},{{passive:true}});}})();</script>
</body>
</html>'''

def rss(posts):
    items = sorted(posts, key=lambda x: (x['date'], x['id']), reverse=True)[:30]
    def it(p):
        return f'<item><title>{html.escape(p["title"])}</title><link>{BASE}/blog/{p["id"]}/</link><guid>{BASE}/blog/{p["id"]}/</guid><pubDate>{datetime.datetime.strptime(p["date"],"%Y-%m-%d").strftime("%a, %d %b %Y 08:00:00 +0800")}</pubDate><description>{html.escape(p["desc"])}</description></item>'
    return f'<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>巷弄故事館 音樂製作專欄</title><link>{BASE}/blog/</link><description>製作人陳則皞的音樂製作文章</description><language>zh-Hant</language>{"".join(it(p) for p in items)}</channel></rss>'


# ── 讀來源（repo 內 blog-src）────────────────────────────────
def parse_fm(s):
    m = re.match(r'^---\n(.*?)\n---\n', s, re.S); fm = {}
    for line in m.group(1).split('\n'):
        if ':' in line:
            k, v = line.split(':', 1); fm[k.strip()] = v.strip()
    return fm, s[m.end():]
def listval(v): return [x.strip() for x in v.strip('[]').split(',') if x.strip()] if v else []
posts = []
for f in sorted(glob.glob(f'{SITE}/blog-src/*.md')):
    fm, body = parse_fm(open(f, encoding='utf-8').read())
    pid = fm['id']; pref = fm.get('series_key') or re.match(r'([a-z]+\d*)', pid).group(1)
    title = normalize_punct(fm['title'])
    desc = normalize_punct(re.sub(r'\s+', ' ', re.sub(r'[#*`>|\-]', '', body.strip().split('\n\n')[0])))[:110]
    posts.append(dict(id=pid, pref=pref, series=fm.get('series', '其他'), title=title, date=fm.get('date', TODAY), keywords=listval(fm.get('keywords')), tags=listval(fm.get('tags')), assets=listval(fm.get('assets')), desc=desc, html=md_to_html(body.strip())))
SERIES = {p['pref']: p['series'] for p in posts}
ids = [p['id'] for p in posts]; assert len(set(ids)) == len(ids), '重複 id'

# ── 寫檔 ─────────────────────────────────────────────────────
os.makedirs(f'{SITE}/blog', exist_ok=True); os.makedirs(f'{SITE}/css', exist_ok=True)
open(f'{SITE}/css/blog.css', 'w').write(CSS)
ordered = sorted(posts, key=lambda x: (SERIES_ORDER.index(x['pref']) if x['pref'] in SERIES_ORDER else 99, x['id']))
for i, p in enumerate(ordered):
    os.makedirs(f'{SITE}/blog/{p["id"]}', exist_ok=True)
    open(f'{SITE}/blog/{p["id"]}/index.html', 'w').write(article_page(p, ordered[i-1] if i > 0 else None, ordered[i+1] if i+1 < len(ordered) else None))
open(f'{SITE}/blog/index.html', 'w').write(index_page(posts))
os.makedirs(f'{SITE}/blog/all', exist_ok=True)
open(f'{SITE}/blog/all/index.html', 'w').write(all_page(posts))
open(f'{SITE}/blog/feed.xml', 'w').write(rss(posts))
sm = open(f'{SITE}/sitemap.xml').read()
sm = re.sub(r'\n\s*<!-- blog:start.*?<!-- blog:end -->', '', sm, flags=re.S)
blk = '\n  <!-- blog:start（tools/build-blog.py 產生，勿手改）-->\n' + f'  <url><loc>{BASE}/blog/</loc><lastmod>{TODAY}</lastmod><changefreq>daily</changefreq><priority>0.9</priority></url>\n  <url><loc>{BASE}/blog/all/</loc><lastmod>{TODAY}</lastmod><changefreq>weekly</changefreq><priority>0.6</priority></url>\n' + ''.join(f'  <url><loc>{BASE}/blog/{p["id"]}/</loc><lastmod>{p["date"]}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>\n' for p in ordered) + '  <!-- blog:end -->'
sm = sm.replace('</urlset>', blk + '\n</urlset>')
open(f'{SITE}/sitemap.xml', 'w').write(sm)
print(f'built {len(ordered)} articles')
