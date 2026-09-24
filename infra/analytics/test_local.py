"""Offline smoke test for lambda_function.py — stubs DynamoDB, no AWS calls.

    python3 infra/analytics/test_local.py
"""
import json
import os
import sys
import time
from pathlib import Path

os.environ.update({
    "TABLE": "",  # keep boto3 from building a resource at import
    "GOOGLE_CLIENT_ID": "test-client.apps.googleusercontent.com",
    "ADMIN_EMAILS": "seanson2709@gmail.com",
    "SITE_KEY": "site-key-public",
    "SALT_SECRET": "salt",
    "ALLOWED_ORIGINS": "https://hub.sean-chloe.com,http://localhost:4321",
})
sys.path.insert(0, str(Path(__file__).parent))
import lambda_function as lf  # noqa: E402

# --- fake Google: throwaway RSA-2048 key (openssl CLI), JWKS stub, RS256 signer --------
import base64, hashlib, re, subprocess, tempfile  # noqa: E401,E402


def _rsa_key():
    with tempfile.NamedTemporaryFile(suffix=".pem") as f:
        subprocess.run(["openssl", "genrsa", "-out", f.name, "2048"], check=True, capture_output=True)
        txt = subprocess.run(["openssl", "rsa", "-in", f.name, "-noout", "-text"], check=True,
                             capture_output=True, text=True).stdout
    def field(name):
        m = re.search(rf"^{name}:\s*\n((?:\s+[0-9a-f:]+\n)+)", txt, re.M)
        return int(re.sub(r"[\s:]", "", m.group(1)), 16)
    return field("modulus"), 65537, field("privateExponent")


N, E, D = _rsa_key()
_b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()  # noqa: E731
fetches = []


def fake_fetch():
    fetches.append(1)
    return {"kid-1": (N, E)}, time.time() + 3600


lf._fetch_jwks = fake_fetch


def jwt(claims=None, header=None, d=D, tamper=False):
    now = int(time.time())
    c = {"iss": "https://accounts.google.com", "aud": "test-client.apps.googleusercontent.com",
         "email": "seanson2709@gmail.com", "email_verified": True, "iat": now, "exp": now + 3600,
         "sub": "1234567890"}
    c.update(claims or {})
    h = {"alg": "RS256", "kid": "kid-1", "typ": "JWT", **(header or {})}
    si = f"{_b64(json.dumps(h).encode())}.{_b64(json.dumps(c).encode())}"
    t = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(si.encode()).digest()
    em = b"\x00\x01" + b"\xff" * (256 - len(t) - 3) + b"\x00" + t
    sig = pow(int.from_bytes(em, "big"), d, N).to_bytes(256, "big")
    if tamper:
        si = si.split(".")[0] + "." + _b64(json.dumps({**c, "email": "SEANSON2709@GMAIL.COM"}).encode())
    return f"{si}.{_b64(sig)}"


ADMIN = jwt()
AUTH = {"authorization": f"Bearer {ADMIN}"}


class StubTable:
    def __init__(self):
        self.items = []

    def put_item(self, Item):
        self.items.append(Item)

    def query(self, KeyConditionExpression, **_):
        # boto3 Key conditions are opaque; emulate by inspecting the expression tree
        expr = KeyConditionExpression
        pk = since = None
        parts = expr._values if expr.expression_operator == "AND" else [expr]
        for c in parts:
            name = c._values[0].name
            if name == "pk":
                pk = c._values[1]
            elif name == "sk":
                since = c._values[1]
        out = [i for i in self.items if i["pk"] == pk and (since is None or i["sk"] >= since)]
        return {"Items": out}


lf._table = StubTable()
SITE = "https://hub.sean-chloe.com"


def ev(method, path, *, body=None, headers=None, qs=None, route=None):
    h = {"user-agent": "Mozilla/5.0 (Macintosh) Chrome/130", **(headers or {})}
    return {
        "rawPath": path,
        "routeKey": route or f"{method} {path}",
        "headers": h,
        "queryStringParameters": qs or {},
        "body": body,
        "isBase64Encoded": False,
        "requestContext": {"http": {"method": method, "sourceIp": "203.0.113.7"}},
    }


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        sys.exit(1)


# --- authorizer -------------------------------------------------------------------
a = lf.authorizer_handler(ev("POST", "/collect", qs={"k": "site-key-public"}, headers={"origin": SITE}), None)
check(a["isAuthorized"] and a["context"]["role"] == "site", "authorizer: site key + origin → site")
a = lf.authorizer_handler(ev("POST", "/collect", qs={"k": "site-key-public"}), None)
check(not a["isAuthorized"], "authorizer: site key without Origin → deny")
a = lf.authorizer_handler(ev("POST", "/collect", qs={"k": "site-key-public"}, headers={"origin": "https://evil.example"}), None)
check(not a["isAuthorized"], "authorizer: foreign Origin → deny")
a = lf.authorizer_handler(ev("GET", "/stats", qs={"k": "site-key-public"}, headers={"origin": SITE}), None)
check(not a["isAuthorized"], "authorizer: site key cannot read /stats")
a = lf.authorizer_handler(ev("GET", "/stats", headers=AUTH), None)
check(a["isAuthorized"] and a["context"]["role"] == "admin", "authorizer: Google ID token (allowlisted) → admin")
a = lf.authorizer_handler(ev("GET", "/stats", headers={"authorization": "Bearer nope"}), None)
check(not a["isAuthorized"], "authorizer: garbage bearer → deny")
a = lf.authorizer_handler(ev("GET", "/stats"), None)
check(not a["isAuthorized"], "authorizer: nothing → deny")

# --- Google ID token verification (each must be refused) ----------------------------
def denied(tok):
    return not lf.authorizer_handler(ev("GET", "/stats", headers={"authorization": f"Bearer {tok}"}), None)["isAuthorized"]

_, _, D2 = _rsa_key()
cases = {
    "other Google account": jwt({"email": "someone.else@gmail.com"}),
    "email_verified false": jwt({"email_verified": False}),
    "email_verified missing": jwt({"email_verified": None}),
    "wrong aud (another app's token)": jwt({"aud": "other.apps.googleusercontent.com"}),
    "wrong iss": jwt({"iss": "https://evil.example"}),
    "expired": jwt({"exp": int(time.time()) - 120}),
    "issued in the future": jwt({"iat": int(time.time()) + 600}),
    "alg none": jwt(header={"alg": "none"}),
    "alg HS256": jwt(header={"alg": "HS256"}),
    "unknown kid": jwt(header={"kid": "kid-x"}),
    "signed by another key": jwt(d=D2),
    "payload tampered after signing": jwt(tamper=True),
    "signature stripped": ADMIN.rsplit(".", 1)[0] + ".",
    "2 segments": ADMIN.rsplit(".", 1)[0],
}
for name, tok in cases.items():
    check(denied(tok), f"google: {name} → deny")
check(lf._google_admin(ADMIN) == "seanson2709@gmail.com", "google: valid token → e-mail")
check(jwt({"email": "SeanSon2709@Gmail.com"}) and not denied(jwt({"email": "SeanSon2709@Gmail.com"})), "google: e-mail compare is case-insensitive")
n_fetch = len(fetches)
for _ in range(5):
    denied(jwt(header={"kid": "kid-x"}))
check(len(fetches) - n_fetch <= 1, "google: unknown kid does not hammer JWKS (≤1 refetch/min)")
_saved = dict(lf._jwks)
lf._jwks.update({"keys": {}, "exp": 0.0, "fetched": 0.0})
lf._fetch_jwks = lambda: (_ for _ in ()).throw(OSError("network down"))
check(denied(ADMIN), "google: JWKS unreachable → fail closed")
lf._jwks.update(_saved)
lf._fetch_jwks = fake_fetch
_cid = lf.GOOGLE_CLIENT_ID
lf.GOOGLE_CLIENT_ID = ""
check(denied(ADMIN), "google: GOOGLE_CLIENT_ID unset → deny everything")
lf.GOOGLE_CLIENT_ID = _cid

# --- collect ------------------------------------------------------------------------
def post(body, **kw):
    return lf.lambda_handler(ev("POST", "/collect", body=json.dumps(body),
                               qs={"k": "site-key-public"}, headers={"origin": SITE}, **kw), None)

r = lf.lambda_handler(ev("POST", "/collect", body='{"t":"pv","p":"/"}'), None)
check(r["statusCode"] == 401 and not lf._table.items, "collect: no credentials → 401, nothing stored")

r = post({"t": "pv", "p": "/", "r": "https://velog.io/@seanson2709/x", "w": 1440, "l": "ko-KR"})
check(r["statusCode"] == 204 and len(lf._table.items) == 1, "collect: pv stored")
it = lf._table.items[0]
check(it["r"] == "velog.io" and it["d"] == "d" and it["l"] == "ko-KR" and "b" not in it, "collect: referrer host / device / lang")
check("ip" not in it and "203.0.113.7" not in json.dumps(it, default=str), "collect: raw IP never stored")
check(len(it["v"]) == 16, "collect: visitor hash 16 hex")

post({"t": "pv", "p": "/bedrock/", "r": SITE + "/", "w": 390})
check(lf._table.items[-1]["r"] == "(internal)" and lf._table.items[-1]["d"] == "m", "collect: internal nav + mobile width")
post({"t": "click", "p": "/", "h": "https://apps.apple.com/kr/app/id6801016602"})
check(lf._table.items[-1]["t"] == "click" and lf._table.items[-1]["h"].startswith("https://apps.apple.com"), "collect: outbound click")
n = len(lf._table.items)
post({"t": "pv", "p": "/admin/"})
post({"t": "pv", "p": "relative"})
post({"t": "weird", "p": "/"})
post({"t": "click", "p": "/", "h": "javascript:alert(1)"})
check(len(lf._table.items) == n, "collect: /admin, non-root path, bad type, non-http href all dropped")
r = lf.lambda_handler({**ev("POST", "/collect", body='{"t":"pv","p":"/"}', qs={"k": "site-key-public"}, headers={"origin": SITE, "user-agent": "curl/8.4"})}, None)
check(lf._table.items[-1].get("b") == 1, "collect: curl UA flagged as bot")
r = post({"t": "pv", "p": "/x" * 2000})
check(r["statusCode"] == 204 and len(lf._table.items) == n + 1, "collect: oversized body dropped silently")

# same visitor twice → same hash; different IP → different hash
post({"t": "pv", "p": "/"}); post({"t": "pv", "p": "/"})
check(lf._table.items[-1]["v"] == lf._table.items[-2]["v"], "collect: same ip+ua → same visitor hash")
e = ev("POST", "/collect", body='{"t":"pv","p":"/"}', qs={"k": "site-key-public"}, headers={"origin": SITE})
e["requestContext"]["http"]["sourceIp"] = "198.51.100.1"
lf.lambda_handler(e, None)
check(lf._table.items[-1]["v"] != lf._table.items[-2]["v"], "collect: different ip → different hash")

# --- stats ------------------------------------------------------------------------
r = lf.lambda_handler(ev("GET", "/stats"), None)
check(r["statusCode"] == 401, "stats: no token → 401")
r = lf.lambda_handler(ev("GET", "/stats", qs={"k": "site-key-public", "days": "7"}, headers={"origin": SITE}), None)
check(r["statusCode"] == 401, "stats: site key → 401")
r = lf.lambda_handler(ev("GET", "/stats", qs={"days": "7"}, headers=AUTH), None)
check(r["statusCode"] == 200, "stats: admin → 200")
s = json.loads(r["body"])
pv_expected = sum(1 for i in lf._table.items if i["t"] == "pv" and not i.get("b"))
check(s["range"]["pv"] == pv_expected and s["range"]["bots"] == 1 and s["range"]["clicks"] == 1, f"stats: pv={s['range']['pv']} bots=1 clicks=1")
check(s["today"]["uv"] == 2 and s["range"]["uv"] == 2, "stats: 2 distinct visitors")
check(s["live"]["visitors"] == 2 and s["live"]["pages"][0]["k"] == "/", "stats: live window sees both visitors")
check(any(x["k"] == "velog.io" for x in s["referrers"]) and any(x["k"] == "(internal)" for x in s["referrers"]), "stats: referrers")
check(s["clicks"][0]["k"].startswith("https://apps.apple.com") and s["devices"] == {"m": 1, "d": pv_expected - 1}, "stats: clicks/devices")
check(len(s["daily"]) == 7 and s["daily"][-1]["pv"] == pv_expected and sum(s["hours"]) == pv_expected, "stats: daily/hours shape")
check(s["recent"][0]["p"] == "/" and "ts" in s["recent"][0], "stats: recent events")
r = lf.lambda_handler(ev("GET", "/stats", qs={"days": "9999"}, headers=AUTH), None)
check(json.loads(r["body"])["days"] == 90, "stats: days clamped to 90")

# --- misc ---------------------------------------------------------------------------
check(lf.lambda_handler(ev("GET", "/health"), None)["statusCode"] == 401, "health: needs admin")
old = {"authorization": "Bearer " + "0" * 64}  # shape of the retired static ADMIN_TOKEN
check(lf.lambda_handler(ev("GET", "/stats", headers=old), None)["statusCode"] == 401, "stats: static hex token no longer works")
exp_tok = {"authorization": "Bearer " + jwt({"exp": int(time.time()) - 120})}
check(lf.lambda_handler(ev("GET", "/stats", headers=exp_tok), None)["statusCode"] == 401,
      "stats: expired ID token refused by handler too (authorizer cache ≤300 s can't extend it)")
check(json.loads(lf.lambda_handler(ev("GET", "/health", headers=AUTH), None)["body"])["email"] == "seanson2709@gmail.com", "health: returns signed-in e-mail")
check(lf.lambda_handler(ev("GET", "/health", headers=AUTH), None)["statusCode"] == 200, "health: admin ok")
check(lf.lambda_handler(ev("GET", "/nope", headers=AUTH), None)["statusCode"] == 404, "unknown path → 404")
check("access-control" not in json.dumps(r["headers"]).lower(), "no CORS headers emitted by code (API handles CORS)")
print("\nALL PASS")
