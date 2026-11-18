#!/usr/bin/env python3
"""tools/indexnow.py — 改完網頁後通知 Bing（IndexNow）重新抓（2026-11-18 建，GEO 健檢第 4 項）

為什麼：ChatGPT 的搜尋有一部分可能靠 Bing 的索引。IndexNow 是 Bing、Yandex 等共用的「我改了這幾頁」通知管道，
不用登入、不用帳號，只要網站根目錄放一個 key 檔證明網站是我們的。

key 檔：網站根目錄的 <KEY>.txt，內容就是 KEY 本身（已放在 repo 根目錄，跟著網站上線）。
🔴 一定要等改過的頁面「已經上線」（merge 進 main、GitHub Pages 部署完）才送；送了還沒上線的網址，Bing 抓到的是舊版。

用法：
  python3 tools/indexnow.py https://mralleys.com/ https://mralleys.com/services/vocal/   # 送指定網址
  python3 tools/indexnow.py --sitemap                       # 送 sitemap.xml 裡全部網址（一次最多 10,000 個）
  python3 tools/indexnow.py --since 2026-11-18              # 只送 sitemap 裡 lastmod >= 這天的網址
  加 --dry-run 只印出要送什麼，不真的送。
回應碼：200／202＝收到；403＝key 檔找不到或內容不符（多半是還沒上線）；422＝網址不屬於這個網域；429＝送太頻繁。
"""
import json, os, re, sys, urllib.request

SITE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST = 'mralleys.com'
ENDPOINT = 'https://api.indexnow.org/indexnow'


def find_key():
    for f in os.listdir(SITE):
        if re.fullmatch(r'[0-9a-f]{32}\.txt', f):
            k = open(os.path.join(SITE, f)).read().strip()
            if k == f[:-4]:
                return k
    raise SystemExit('找不到 key 檔（根目錄 <32 位 hex>.txt，內容要等於檔名）')


def sitemap_urls(since=None):
    s = open(os.path.join(SITE, 'sitemap.xml'), encoding='utf-8').read()
    s = re.sub(r'<!--.*?-->', '', s, flags=re.S)
    out = []
    for loc, lastmod in re.findall(r'<loc>([^<]+)</loc>\s*(?:<lastmod>([^<]+)</lastmod>)?', s):
        if since and (lastmod or '') < since:
            continue
        out.append(loc.strip())
    return out


def main(argv):
    dry = '--dry-run' in argv
    args = [a for a in argv if a != '--dry-run']
    if not args:
        print(__doc__); return 1
    if args[0] == '--sitemap':
        urls = sitemap_urls()
    elif args[0] == '--since':
        urls = sitemap_urls(args[1])
    else:
        urls = args
    urls = list(dict.fromkeys(u for u in urls if u.startswith(f'https://{HOST}/')))
    if not urls:
        print('沒有要送的網址'); return 1
    key = find_key()
    body = {'host': HOST, 'key': key, 'keyLocation': f'https://{HOST}/{key}.txt', 'urlList': urls[:10000]}
    print(f'要送 {len(body["urlList"])} 個網址：')
    for u in body['urlList']:
        print('  ', u)
    if dry:
        print('（--dry-run，沒有送）'); return 0
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json; charset=utf-8'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print('IndexNow 回應', r.status)
            return 0
    except urllib.error.HTTPError as e:
        print('IndexNow 回應', e.code, e.read()[:300].decode(errors='replace'))
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
