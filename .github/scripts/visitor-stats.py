#!/usr/bin/env python3
"""後台「訪客數」那塊的資料來源：每天由 GitHub Actions（visitor-stats.yml）跑一次，寫 stats.json。

2026-11-19 耗耗：「我好像也需要訪客數，這樣就不用每次問你了」
→ 兩個站（官網 mralleys.com、Bio 頁 haohao.mralleys.com）共用同一支腳本，同一個 GoatCounter 帳號（haohao）。

用法：python3 visitor-stats.py alleys|bio  > stats.json
token：環境變數 GOATCOUNTER_TOKEN（repo secret，唯讀 token）。不印、不寫進檔案。

🔑 查證過的 API 行為（2026-11-19 實測，不是猜的）：
  ・GoatCounter 2.x 只記「訪客」（同一人同一頁一段時間內只算一次），API 的 count 就是訪客，**沒有瀏覽數（pageview）**。
    → 畫面上只寫「訪客」，不假裝有瀏覽數。
  ・帳號時區是 Asia/Taipei；start/end 用 UTC 時間傳，end 那一小時「含」在內
    （實測 start=16:00Z end=17:00Z 回兩個小時）。所以一天＝台灣 00:00 → 23:00 那一小時。
  ・/stats/hits 分頁：exclude_paths 要用逗號串（重複參數會被忽略，實測）。

分桶（同帳號多個頁面，用 path 區分）：
  bio    ：非事件 path 以 /bio 開頭；按鈕事件 path 以 bio-click- 開頭
  alleys ：非事件 path 對得到這個 repo 裡真的有的頁面（/ → index.html、/store → store/index.html…），
           加上舊路徑 /mr-alleys-site（＝首頁）。發行頁（/drunk、/notbecause、/music/*）不在這個 repo，自然排除。
           按鈕事件：cta/（首頁）、store-（廢歌店）。
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://haohao.goatcounter.com/api/v0"
TW = timezone(timedelta(hours=8))
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# Bio 頁按鈕 id → 後台顯示的名字（index.html 的 data-gc）。沒列到的就用事件自己的 title。
BIO_NAMES = {
    "extra": "找我做歌",
    "podcast": "Podcast 大按鈕",
    "mail-submit": "電子報訂閱送出",
    "mail": "電子報按鈕",
    "social-spotify": "Spotify",
    "social-threads": "Threads",
    "social-instagram": "Instagram",
    "social-podcast": "Podcast 小按鈕",
}


def api(path, params):
    token = os.environ.get("GOATCOUNTER_TOKEN", "")
    if not token:
        raise SystemExit("缺 GOATCOUNTER_TOKEN")
    url = f"{BASE}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def hits(start_day, end_day):
    """台灣日期 start_day～end_day（含）每個 path 的訪客數。"""
    start = datetime(start_day.year, start_day.month, start_day.day, tzinfo=TW)
    end = datetime(end_day.year, end_day.month, end_day.day, 23, tzinfo=TW)  # end 那一小時含在內
    fmt = lambda d: d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out, seen = [], []
    while True:
        p = {"start": fmt(start), "end": fmt(end), "limit": 100}
        if seen:
            p["exclude_paths"] = ",".join(map(str, seen))
        d = api("/stats/hits", p)
        page = d.get("hits", [])
        out += page
        seen += [h["path_id"] for h in page]
        if not d.get("more") or not page:
            return out


def clean(s, n=40):
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def is_alleys_page(path):
    p = path.split("?")[0]
    if p in ("/", "/mr-alleys-site", "/mr-alleys-site/"):
        return True
    if p.startswith("/bio"):
        return False
    rel = p.strip("/")
    cands = [os.path.join(REPO_ROOT, rel, "index.html"), os.path.join(REPO_ROOT, rel)]
    if not rel.endswith(".html"):
        cands.append(os.path.join(REPO_ROOT, rel + ".html"))
    return any(os.path.isfile(c) for c in cands)


def classify(site, h):
    """回傳 ('page'|'click'|None, key, 顯示名字)"""
    path = h.get("path", "")
    if site == "bio":
        if h.get("event"):
            if path.startswith("bio-click-"):
                k = path[len("bio-click-"):]
                return "click", k, BIO_NAMES.get(k) or clean(h.get("title")) or k
            return None, None, None
        if path.startswith("/bio"):
            return "page", path, path
        return None, None, None
    # alleys
    if h.get("event"):
        if path.startswith("cta/") or path.startswith("store-"):
            title = re.sub(r"\s+", " ", str(h.get("title") or "")).strip()
            m = re.match(r"^CH-\d+ \S+ (\S+)", title)  # 服務卡：「CH-02 可預約 寫歌課｜… 說明」→ 只留卡片標題
            return "click", clean(path, 60), clean(m.group(1) if m else title) or clean(path)
        return None, None, None
    if is_alleys_page(path):
        key = "/" if path.split("?")[0] in ("/", "/mr-alleys-site", "/mr-alleys-site/") else path.split("?")[0]
        name = "首頁" if key == "/" else clean(h.get("title")) or key
        return "page", key, name
    return None, None, None


def window(site, start_day, end_day):
    pages, clicks = {}, {}
    for h in hits(start_day, end_day):
        kind, key, name = classify(site, h)
        if not kind:
            continue
        bucket = pages if kind == "page" else clicks
        b = bucket.setdefault(key, {"name": name, "n": 0})
        b["n"] += h.get("count", 0)
    return pages, clicks


def main():
    site = sys.argv[1] if len(sys.argv) > 1 else ""
    if site not in ("bio", "alleys"):
        raise SystemExit("用法：visitor-stats.py alleys|bio")

    now = datetime.now(TW)
    yday = now.date() - timedelta(days=1)  # 只算「整天」：到昨天為止
    w7 = (yday - timedelta(days=6), yday)
    w30 = (yday - timedelta(days=29), yday)
    p7, c7 = window(site, *w7)
    p30, c30 = window(site, *w30)

    def rows(d30, d7, limit=None):
        keys = sorted(set(d30) | set(d7), key=lambda k: (-d30.get(k, {}).get("n", 0), -d7.get(k, {}).get("n", 0), k))
        out = []
        for k in keys[:limit] if limit else keys:
            name = (d30.get(k) or d7.get(k))["name"]
            out.append({"key": k, "name": name, "d7": d7.get(k, {}).get("n", 0), "d30": d30.get(k, {}).get("n", 0)})
        return out

    out = {
        "site": site,
        "updated_at": now.strftime("%Y-%m-%d %H:%M"),
        "note": "GoatCounter 只記訪客（同一人同一頁一段時間內算一次），沒有瀏覽數。只算到昨天為止的整天。",
        "d7": {"from": w7[0].isoformat(), "to": w7[1].isoformat(), "visitors": sum(v["n"] for v in p7.values())},
        "d30": {"from": w30[0].isoformat(), "to": w30[1].isoformat(), "visitors": sum(v["n"] for v in p30.values())},
    }
    if site == "bio":
        out["clicks"] = rows(c30, c7)
    else:
        out["top_pages"] = rows(p30, p7, 5)
        out["top_clicks"] = rows(c30, c7, 5)
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
