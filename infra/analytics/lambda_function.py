"""hub-analytics — cookie-less page analytics for hub.sean-chloe.com.

Security posture (the whole point of this layout — see infra/analytics/README.md):
  * Nothing in this account is reachable without an authorizer. The API is an
    API Gateway HTTP API whose every route carries a Lambda REQUEST authorizer;
    there is no `$default` route and no `NONE`-typed route. The Lambda functions
    have no Function URL and no `Principal: "*"` resource policy — only
    `apigateway.amazonaws.com` scoped to this API's ARN may invoke them.
  * `POST /collect` (the beacon) is by nature called by anonymous browsers, so its
    authorizer asks for two things API Gateway must see before invoking anything:
    the site key `?k=` and an `Origin` header equal to the site origin. The key is
    public (it ships in the page), so this is anti-junk, not secrecy — the route is
    write-only, stores no personal data (see below) and is throttled at the stage.
  * `GET /stats` requires `Authorization: Bearer <ADMIN_TOKEN>` (32-byte random,
    constant-time compare). This is the only read path.

Handlers (one zip, two functions):
  lambda_handler      integration for POST /collect, GET /stats, GET /health
  authorizer_handler  REQUEST authorizer (simple response) for all routes

Storage (DynamoDB, on-demand, TTL 90d, deletion protection):
  pk = "d#<KST date>"    sk = "<13-digit ms epoch>#<rand>"
  t  = "pv" | "click"    p = path     r = referrer host ("direct" | "(internal)" | host)
  v  = visitor hash = sha256(ip|ua|date|SALT_SECRET)[:16]  — rotates daily, no cookie,
       raw IP is never stored.   d = "m"|"d" (device)   b = 1 if UA looks like a bot
  h  = outbound href (click only)   ua = UA (truncated)   l = language

CORS is configured on the API (AllowOrigins = site origin only), so this code
deliberately does not emit Access-Control-* headers (they would duplicate).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import boto3
from boto3.dynamodb.conditions import Key

TABLE = os.environ["TABLE"]
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
SITE_KEY = os.environ.get("SITE_KEY", "")
SALT_SECRET = os.environ.get("SALT_SECRET", "")
ALLOWED_ORIGINS = {
    o.strip().rstrip("/")
    for o in os.environ.get("ALLOWED_ORIGINS", "https://hub.sean-chloe.com").split(",")
    if o.strip()
}
SITE_HOSTS = {urlsplit(o).hostname for o in ALLOWED_ORIGINS}
TTL_DAYS = int(os.environ.get("TTL_DAYS", "90"))
KST = timezone(timedelta(hours=9))
LIVE_WINDOW_MS = 5 * 60 * 1000

_BOT_RE = re.compile(
    r"bot|crawl|spider|slurp|preview|fetch|scan|python|curl|wget|httpx|headless|"
    r"lighthouse|pagespeed|facebookexternalhit|inspectiontool|dataprovider|"
    r"semrush|ahrefs|mj12|dotbot|petalbot|bytespider|yandex|baidu|duckduck|"
    r"go-http-client|java/|okhttp|node-fetch|axios|postman",
    re.I,
)
_MOBILE_RE = re.compile(r"Mobile|Android|iPhone|iPad|iPod", re.I)

_table = boto3.resource("dynamodb").Table(TABLE) if TABLE else None


# ----------------------------------------------------------------------------- auth
def _headers(event) -> dict:
    return {k.lower(): v for k, v in (event.get("headers") or {}).items()}


def _eq(a: str, b: str) -> bool:
    return bool(a) and bool(b) and hmac.compare_digest(a, b)


def _bearer(event) -> str:
    got = _headers(event).get("authorization", "")
    return got[7:] if got.startswith("Bearer ") else ""


def _role(event) -> str:
    """Who the authorizer said this is: 'admin' | 'site' | ''.

    Re-derived from the raw credentials as well (defense in depth) so that even a
    misconfigured route — say someone attaches the wrong authorizer — cannot read
    stats with the public site key.
    """
    if _eq(_bearer(event), ADMIN_TOKEN):
        return "admin"
    qs = event.get("queryStringParameters") or {}
    origin = _headers(event).get("origin", "").rstrip("/")
    if _eq(qs.get("k", ""), SITE_KEY) and origin in ALLOWED_ORIGINS:
        return "site"
    return ""


def authorizer_handler(event, _ctx):
    """API Gateway HTTP API REQUEST authorizer (simple response).

    Routes:  POST /collect  → site key (?k=) + Origin ∈ ALLOWED_ORIGINS, or admin
             GET  /stats, /health → admin bearer only
    Anything else is denied. Identity sources are configured on the API so that
    API Gateway returns 401 by itself when they are absent (this function is then
    never invoked; results are cached per identity value for 300 s).
    """
    role = _role(event)
    route = event.get("routeKey", "")
    ok = role == "admin" or (role == "site" and route == "POST /collect")
    return {"isAuthorized": ok, "context": {"role": role if ok else ""}}


# ----------------------------------------------------------------------------- helpers
def _resp(status: int, body=None, ctype: str = "application/json"):
    out = {"statusCode": status, "headers": {"cache-control": "no-store"}}
    if body is not None:
        out["headers"]["content-type"] = ctype
        out["body"] = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
    return out


def _kst_date(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, KST).strftime("%Y-%m-%d")


def _ref_host(ref: str, page_host: str | None) -> str:
    if not ref:
        return "direct"
    try:
        host = (urlsplit(ref).hostname or "").lower()
    except ValueError:
        return "direct"
    if not host:
        return "direct"
    if host in SITE_HOSTS or host == page_host:
        return "(internal)"
    if host.startswith("www."):
        host = host[4:]
    # collapse the usual redirect/short hosts
    return {
        "t.co": "twitter.com",
        "l.facebook.com": "facebook.com",
        "lm.facebook.com": "facebook.com",
        "lnkd.in": "linkedin.com",
        "out.reddit.com": "reddit.com",
        "away.vk.com": "vk.com",
    }.get(host, host)


def _clip(s, n: int) -> str:
    return s[:n] if isinstance(s, str) else ""


# ----------------------------------------------------------------------------- /collect
def collect(event) -> dict:
    if _role(event) not in ("site", "admin"):
        return _resp(401, {"error": "unauthorized"})
    headers = _headers(event)
    origin = headers.get("origin", "").rstrip("/")

    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8", "replace")
    if len(raw) > 2048:
        return _resp(204)
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return _resp(204)
    if not isinstance(data, dict):
        return _resp(204)

    t = data.get("t")
    if t not in ("pv", "click"):
        return _resp(204)
    path = _clip(data.get("p"), 200)
    if not path.startswith("/") or path.startswith("/admin"):
        return _resp(204)

    http = (event.get("requestContext") or {}).get("http") or {}
    ip = http.get("sourceIp", "")
    ua = headers.get("user-agent", "")
    now_ms = int(time.time() * 1000)
    date = _kst_date(now_ms)

    width = data.get("w")
    if isinstance(width, (int, float)) and width > 0:
        device = "m" if width < 768 else "d"
    else:
        device = "m" if _MOBILE_RE.search(ua) else "d"

    item = {
        "pk": f"d#{date}",
        "sk": f"{now_ms:013d}#{secrets.token_hex(3)}",
        "t": t,
        "p": path,
        "r": _ref_host(_clip(data.get("r"), 500), urlsplit(origin).hostname),
        "v": hashlib.sha256(f"{ip}|{ua}|{date}|{SALT_SECRET}".encode()).hexdigest()[:16],
        "d": device,
        "ua": _clip(ua, 160),
        "ttl": now_ms // 1000 + TTL_DAYS * 86400,
    }
    if _BOT_RE.search(ua) or not ua:
        item["b"] = 1
    lang = _clip(data.get("l"), 16)
    if lang:
        item["l"] = lang
    if t == "click":
        href = _clip(data.get("h"), 300)
        if not href.startswith("http"):
            return _resp(204)
        item["h"] = href
    _table.put_item(Item=item)
    return _resp(204)


# ----------------------------------------------------------------------------- /stats
def _query_day(date: str, since_ms: int | None = None) -> list[dict]:
    cond = Key("pk").eq(f"d#{date}")
    if since_ms is not None:
        cond = cond & Key("sk").gte(f"{since_ms:013d}")
    kwargs = {"KeyConditionExpression": cond}
    items: list[dict] = []
    while True:
        page = _table.query(**kwargs)
        items.extend(page.get("Items", []))
        lek = page.get("LastEvaluatedKey")
        if not lek:
            return items
        kwargs["ExclusiveStartKey"] = lek


def stats(event) -> dict:
    if _role(event) != "admin":
        return _resp(401, {"error": "unauthorized"})
    qs = event.get("queryStringParameters") or {}
    try:
        days = max(1, min(90, int(qs.get("days", "7"))))
    except ValueError:
        days = 7

    now_ms = int(time.time() * 1000)
    now_kst = datetime.fromtimestamp(now_ms / 1000, KST)
    today = now_kst.strftime("%Y-%m-%d")
    dates = [(now_kst - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days)]
    dates.reverse()

    pv = clicks = bots = 0
    uv_by_day: dict[str, set] = defaultdict(set)
    pv_by_day: Counter = Counter()
    pages_pv: Counter = Counter()
    pages_uv: dict[str, set] = defaultdict(set)
    refs: Counter = Counter()
    hrefs: Counter = Counter()
    devices: Counter = Counter()
    hours = [0] * 24
    langs: Counter = Counter()
    today_pv = today_clicks = 0
    today_uv: set = set()
    recent: list[dict] = []

    for date in dates:
        for it in _query_day(date):
            if it.get("b"):
                bots += 1
                continue
            ts = int(str(it["sk"]).split("#", 1)[0])
            typ = it.get("t")
            if typ == "click":
                clicks += 1
                hrefs[it.get("h", "")] += 1
                if date == today:
                    today_clicks += 1
                continue
            pv += 1
            pv_by_day[date] += 1
            uv_by_day[date].add(it["v"])
            pages_pv[it["p"]] += 1
            pages_uv[it["p"]].add(it["v"])
            refs[it.get("r", "direct")] += 1
            devices[it.get("d", "d")] += 1
            hours[datetime.fromtimestamp(ts / 1000, KST).hour] += 1
            if it.get("l"):
                langs[it["l"].split("-")[0].lower()] += 1
            if date == today:
                today_pv += 1
                today_uv.add(it["v"])
            recent.append({"ts": ts, "p": it["p"], "r": it.get("r", "direct"), "d": it.get("d", "d")})

    # live = distinct visitors in the last 5 minutes (may straddle midnight)
    since = now_ms - LIVE_WINDOW_MS
    live_items = _query_day(today, since)
    if _kst_date(since) != today:
        live_items += _query_day(_kst_date(since), since)
    live_v: set = set()
    live_pages: Counter = Counter()
    for it in live_items:
        if it.get("b") or it.get("t") != "pv":
            continue
        live_v.add(it["v"])
        live_pages[it["p"]] += 1

    recent.sort(key=lambda e: e["ts"], reverse=True)
    top = lambda c, n=15: [{"k": k, "n": v} for k, v in c.most_common(n)]  # noqa: E731
    return _resp(200, {
        "now": now_kst.isoformat(timespec="seconds"),
        "days": days,
        "live": {"visitors": len(live_v), "pages": top(live_pages, 10)},
        "today": {"pv": today_pv, "uv": len(today_uv), "clicks": today_clicks},
        "range": {"pv": pv, "uv": sum(len(s) for s in uv_by_day.values()), "clicks": clicks, "bots": bots},
        "daily": [{"date": d, "pv": pv_by_day[d], "uv": len(uv_by_day[d])} for d in dates],
        "pages": [{"k": p, "n": n, "uv": len(pages_uv[p])} for p, n in pages_pv.most_common(20)],
        "referrers": top(refs),
        "clicks": top(hrefs),
        "devices": {"m": devices["m"], "d": devices["d"]},
        "hours": hours,
        "langs": top(langs, 8),
        "recent": recent[:30],
    })


# ----------------------------------------------------------------------------- entry
def lambda_handler(event, _ctx):
    http = (event.get("requestContext") or {}).get("http") or {}
    method = http.get("method", "GET").upper()
    path = (event.get("rawPath") or "/").rstrip("/") or "/"
    if method == "POST" and path == "/collect":
        return collect(event)
    if method == "GET" and path == "/stats":
        return stats(event)
    if method == "GET" and path == "/health":
        if _role(event) != "admin":
            return _resp(401, {"error": "unauthorized"})
        return _resp(200, {"ok": True, "table": TABLE})
    return _resp(404, {"error": "not found"})
