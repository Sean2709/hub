# infra/analytics — self-hosted, cookie-less visitor analytics for hub.sean-chloe.com

Account: sean-workload (461839758724), region ap-northeast-2. Created 2026-09-22.
Dashboard: `/admin/` on the site (static HTML; shows nothing until you sign in with Google as
the allowlisted admin account — see "Admin sign-in" below).

## Why not a Function URL

This account once had something exposed to the internet without authentication and it
ended badly. So the rule here is: **nothing is reachable without an authorizer in front of
it**, enforced by API Gateway *before* any of our code runs.

```
browser ──POST /collect?k=<site key> + Origin──▶ API GW (HTTP API zoviv9w83h)
admin   ──GET  /stats  Authorization: Bearer <Google ID token>──▶ │ every route: Lambda REQUEST authorizer
                                                   │ no $default route, no NONE route
                                                   ▼
                                    hub-analytics (Lambda, py3.13, 256 MB, 15 s)
                                                   ▼
                                    hub-analytics (DynamoDB, on-demand, TTL 90 d, deletion protection)
```

| Resource | Name | Notes |
|---|---|---|
| API GW HTTP API | `hub-analytics` (`zoviv9w83h`) | routes `POST /collect`, `GET /stats`, `GET /health` — all `CUSTOM` auth. Stage `$default` throttle 20 rps / burst 50. CORS `AllowOrigins=https://hub.sean-chloe.com` only |
| Authorizer `site-key` | `3luuoy` | identity sources `$request.querystring.k` + `$request.header.origin` → both must be present or API GW returns 401 without invoking anything. Cached 300 s per (k, origin) |
| Authorizer `admin-bearer` | `enwegx` | identity source `$request.header.authorization` (a Google ID token). Cached 300 s per token; the handler re-checks `exp` so the cache can't extend a token's life |
| Lambda | `hub-analytics` | handler `lambda_function.lambda_handler`; role `hub-analytics-lambda` ([policy-collector.json](policy-collector.json): `dynamodb:PutItem/Query` on the one table + its own log group). Resource policy: invoke only from `apigateway.amazonaws.com` scoped to this API ARN. **No Function URL** |
| Lambda | `hub-analytics-authorizer` | handler `lambda_function.authorizer_handler`, 128 MB, 5 s; role `hub-analytics-authorizer` ([policy-authorizer.json](policy-authorizer.json): logs only, no DynamoDB). Resource policy scoped to `…:zoviv9w83h/authorizers/*` |
| DynamoDB | `hub-analytics` | `pk = d#<KST date>`, `sk = <ms epoch>#<rand>`, TTL attribute `ttl` (90 d), deletion protection on |
| Both roles' trust | [lambda-trust.json](lambda-trust.json) | `lambda.amazonaws.com` with `aws:SourceAccount` condition |

Both functions ship the **same zip** (`lambda_function.py`); they differ only in handler and env.

## Roles (who can do what)

| Caller | Credential | Can |
|---|---|---|
| any visitor's browser | `?k=<SITE_KEY>` **and** `Origin: https://hub.sean-chloe.com` | `POST /collect` only (write-only, 204, no body) |
| owner | `Authorization: Bearer <Google ID token>` for an `ADMIN_EMAILS` account | `GET /stats`, `GET /health`, and `/collect` |
| anyone else | — | 401/403 from API GW; Lambda never runs |

The site key is *public* (it is in the page source) — it is anti-junk, not a secret. What
makes `/collect` safe to leave open is what it does, not who can call it: it stores no
personal data (see below), rejects bodies > 2 KB and anything not `pv`/`click`, ignores
`/admin*` paths, and is throttled at the stage. There is **no static admin secret** any more
(the old `ADMIN_TOKEN` was removed 2026-09-24): read access = a Google-signed ID token.
`_role()` re-derives the role from raw credentials inside the handler as well, so even a
mis-attached authorizer cannot turn the public key into read access
(`test_local.py`: "stats: site role → 401").

## Admin sign-in (Google)

`/admin/` loads Google Identity Services (`accounts.google.com/gsi/client`), the owner signs
in, and the page sends the resulting **ID token** (JWT, ~1 h) as the bearer. The server side
(`_google_admin()` in `lambda_function.py`, standard library only) accepts it only if:

- signature is RS256 by a key in Google's JWKS (`googleapis.com/oauth2/v3/certs`, cached per
  container for its `max-age`; unknown `kid` → at most one refetch per minute; fetch failure → deny)
- `iss` ∈ {`accounts.google.com`, `https://accounts.google.com`}
- `aud` == `GOOGLE_CLIENT_ID` (so an ID token minted for some *other* app is useless here)
- `exp` in the future, `iat` not in the future (60 s skew)
- `email_verified` is `true` and `email` ∈ `ADMIN_EMAILS` (case-insensitive)

The e-mail check in the page's JS is only UX. Expired tokens: the page asks GIS again with
`auto_select` (silent for the one consented account), otherwise shows the button.

OAuth client: Google Cloud project `hub-sean-chloe`, *Web application* client, authorized
JavaScript origins `https://hub.sean-chloe.com`, `http://localhost:4321`, `http://localhost`.
Consent screen in *Testing* with `seanson2709@gmail.com` as the only test user (scopes
openid/email/profile only). The client ID is public (`src/data/site.ts` → `admin.googleClientId`);
there is no client secret in this flow. To add another admin: append to `ADMIN_EMAILS` on
**both** functions (and add them as a test user).

## What is stored (privacy)

Per event: KST date, ms timestamp, type (`pv`|`click`), path, referrer **host** only,
device `m|d`, language, UA (truncated 160), outbound href for clicks, and a visitor hash
`sha256(ip|ua|date|SALT_SECRET)[:16]`. The hash rotates daily and the raw IP is never
written, so there is no cross-day tracking and no cookie. Rows expire after 90 days via TTL.
The beacon in `src/layouts/Base.astro` is skipped on `noindex` pages and when
`localStorage['hub.notrack']='1'` (the `/admin/` page sets this on first admin sign-in).

## Secrets & where they live

| Name | Where | Purpose |
|---|---|---|
| `GOOGLE_CLIENT_ID` · `ADMIN_EMAILS` | Lambda env (both functions) · client ID also in `src/data/site.ts` | admin sign-in (not secrets) |
| `SITE_KEY` | Lambda env · `src/data/site.ts` (public by design) | anti-junk gate for `/collect` |
| `SALT_SECRET` | Lambda env (`hub-analytics` only) · `~/.hub-analytics-secrets` | visitor hash salt |

### Rotate SITE_KEY / SALT_SECRET

```sh
for f in hub-analytics hub-analytics-authorizer; do
  aws lambda get-function-configuration --function-name $f --query Environment.Variables --output json \
   | python3 -c "import sys,json;e=json.load(sys.stdin);e['SITE_KEY']='<new>';print(json.dumps({'Variables':e}))" > /tmp/env.json
  aws lambda update-function-configuration --function-name $f --environment file:///tmp/env.json --query LastUpdateStatus
done; rm /tmp/env.json
```
For `SITE_KEY` also edit `src/data/site.ts` and redeploy the site; keep both functions' env
identical. Old values keep working for ≤ 300 s (authorizer cache).

## Update the code

```sh
cd infra/analytics
~/Documents/Projects/seanchat/seanchat-cli/.venv/bin/python test_local.py   # needs boto3; offline, stubs DynamoDB
zip -j /tmp/hub-analytics.zip lambda_function.py
for f in hub-analytics hub-analytics-authorizer; do
  aws lambda update-function-code --function-name $f --zip-file fileb:///tmp/hub-analytics.zip --query LastUpdateStatus
done
```
Then re-run the live checks below.

## Live security checks (expected)

```
POST /collect                      no key/origin            401  (API GW, authorizer not invoked)
POST /collect?k=KEY                key, no Origin           401
POST /collect?k=KEY  Origin:evil   wrong origin             403
POST /collect?k=BAD  Origin:site   wrong key                403
POST /collect?k=KEY  Origin:site   valid                    204
GET  /stats                        no auth                  401
GET  /stats   Bearer wrong                                  403
GET  /stats   Bearer <old static ADMIN_TOKEN>               403  (retired 2026-09-24)
GET  /stats?k=KEY Origin:site      site key can't read      403
GET  /stats   Bearer <Google ID token, admin account>       200  (browser, /admin/)
GET  /health                       no auth                  401
GET  / · GET /collect · DELETE /stats                       404  (no $default route)
OPTIONS /collect from evil origin                           204 with **no** Access-Control-Allow-Origin
```
Verified 2026-09-22 (16/16). Test rows written during checks were deleted from the table by
hand (`aws dynamodb delete-item`) — the Lambda role deliberately has no delete permission.

## Cost

Well inside the free tier at this traffic: API GW HTTP API ~$1 per million requests,
Lambda/DynamoDB on-demand fractions of a cent, CloudWatch logs default retention. Nothing
runs when nobody visits.

## Local development

`npm run dev` pages send beacons with `Origin: http://localhost:4321`, which the authorizer
rejects (403) — so dev traffic never pollutes the table. To test end-to-end from localhost,
add it to `ALLOWED_ORIGINS` on **both** functions temporarily.
