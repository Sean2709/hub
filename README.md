# hub.sean-chloe.com

Sean's personal hub — tools, iOS apps, writing, certifications.

- Framework: [Astro](https://astro.build) (static output; the only client JS is the table filter on `/bedrock/`)
- Hosting: GitHub Pages via Actions (`.github/workflows/pages.yml`)
- Content: `src/data/site.ts` (single source of truth for the hub page)

## `/bedrock/` — Bedrock model catalog for ap-northeast-2, refreshed daily

**The data is the product; the page is a viewer.** Everything under
[`public/data/bedrock/`](public/data/bedrock/) is regenerated every day at 06:00 KST
from the Bedrock control-plane API and published as-is:

| file | what |
|---|---|
| [`seoul.json`](https://hub.sean-chloe.com/data/bedrock/seoul.json) | models available in Seoul + access path (on-demand / CRIS profile ids) + models missing vs. reference regions + stats |
| [`models.json`](https://hub.sean-chloe.com/data/bedrock/models.json) | normalized `ListFoundationModels` for all tracked regions (`ap-northeast-2`, `us-east-1`, `us-west-2`, `us-east-2`, `ap-northeast-1`) |
| [`profiles.json`](https://hub.sean-chloe.com/data/bedrock/profiles.json) | system-defined inference profiles reachable from Seoul, with routed regions |
| [`changes.json`](https://hub.sean-chloe.com/data/bedrock/changes.json) | append-only diff log (added / removed / changed) |
| [`feed.xml`](https://hub.sean-chloe.com/data/bedrock/feed.xml) | RSS 2.0 of `changes.json` |
| [`meta.json`](https://hub.sean-chloe.com/data/bedrock/meta.json) | last-checked timestamp, sources |

```sh
# on-demand model ids in Seoul
curl -s https://hub.sean-chloe.com/data/bedrock/seoul.json | jq -r '.models[] | select(.access | index("on-demand")) | .id'
```

Pipeline: `.github/workflows/bedrock-refresh.yml` (cron) → OIDC → read-only IAM role →
`scripts/gen_bedrock.py` → commit → dispatch `pages.yml`. The script needs only the AWS CLI
(or boto3 if present) and Python 3.10+.

Scope notes: catalog data only — per-account model access, quotas and pricing are not
reflected. Feature support (prompt caching, tool use, structured output) isn't exposed by the
API and is not included yet.

## Dev

```sh
npm ci
npm run dev      # http://localhost:4321
npm run build    # → dist/

AWS_PROFILE=<ro-profile> python3 scripts/gen_bedrock.py   # regenerate public/data/bedrock/
```

Derived data files are released under CC0. Source: AWS Bedrock public catalog API responses.
