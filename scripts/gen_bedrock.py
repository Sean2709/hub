#!/usr/bin/env python3
"""Generate public/data/bedrock/*.json (+ feed.xml) from the Bedrock control-plane API.

Data product first, page second: everything the /bedrock/ page renders comes from
these files, and the files are meant to be consumed directly (curl / embed / RSS).

Sources (read-only, public catalog data — not account-specific):
  bedrock:ListFoundationModels   per region
  bedrock:ListInferenceProfiles  primary region, SYSTEM_DEFINED only

Outputs (all deterministic except meta.json):
  models.json    all tracked regions, normalized model entries
  seoul.json     primary-region view: models + access path + what's missing vs. reference regions
  profiles.json  system-defined inference profiles reachable from the primary region
  changes.json   append-only diff log (added / removed / changed per region)
  feed.xml       RSS 2.0 of changes.json
  meta.json      last checked timestamp (only file that changes on a no-op day)

Runs with boto3 if importable, otherwise shells out to the AWS CLI. No other deps.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from xml.sax.saxutils import escape

PRIMARY = "ap-northeast-2"
REFERENCE = ["us-east-1", "us-west-2", "us-east-2", "ap-northeast-1"]
REGIONS = [PRIMARY, *REFERENCE]
SITE = "https://hub.sean-chloe.com"
PAGE = f"{SITE}/bedrock/"
OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "bedrock"
MAX_FEED_ITEMS = 50
SCHEMA = 1

# foo-v1:0:200k / foo-v1:0:24k / foo-v3:0:512 → foo-v1:0  (context-window / size variants: exactly 2 colons)
VARIANT_RE = re.compile(r"^(?P<base>[^:]+:\d+):(?:\d+k|\d+)$")


# ---------------------------------------------------------------- fetch
def _cli(args: list[str]) -> dict:
    exe = shutil.which("aws")
    if not exe:
        sys.exit("neither boto3 nor the aws CLI is available")
    env = {**os.environ, "AWS_PAGER": ""}
    res = subprocess.run([exe, *args, "--output", "json"], capture_output=True, text=True, env=env)
    if res.returncode != 0:
        raise RuntimeError(f"aws {' '.join(args)} failed: {res.stderr.strip()}")
    return json.loads(res.stdout)


def fetch_models(region: str) -> list[dict]:
    try:
        import boto3  # type: ignore

        return boto3.client("bedrock", region_name=region).list_foundation_models()["modelSummaries"]
    except ImportError:
        return _cli(["bedrock", "list-foundation-models", "--region", region])["modelSummaries"]


def fetch_profiles(region: str) -> list[dict]:
    try:
        import boto3  # type: ignore

        client = boto3.client("bedrock", region_name=region)
        out: list[dict] = []
        for page in client.get_paginator("list_inference_profiles").paginate(typeEquals="SYSTEM_DEFINED"):
            out.extend(page["inferenceProfileSummaries"])
        return out
    except ImportError:
        return _cli(
            ["bedrock", "list-inference-profiles", "--region", region, "--type-equals", "SYSTEM_DEFINED"]
        )["inferenceProfileSummaries"]


# ---------------------------------------------------------------- normalize
def _date(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date().isoformat()
    return str(v)[:10]


def base_id(model_id: str, known: set[str] | None = None) -> str:
    """Collapse context-window variants (foo-v1:0:200k, foo-v1:0:24k) onto their base id.

    If the stripped base isn't itself a listed model (e.g. cohere.embed-english-v3:0:512 →
    cohere.embed-english-v3:0, which doesn't exist) fall back one more segment when that exists.
    """
    mt = VARIANT_RE.match(model_id)
    if not mt:
        return model_id
    base = mt.group("base")
    if known is not None and base not in known:
        shorter = base.rsplit(":", 1)[0]
        if shorter in known:
            return shorter
    return base


def norm_model(m: dict, known: set[str]) -> dict:
    lc = m.get("modelLifecycle") or {}
    return {
        "id": m["modelId"],
        "base": base_id(m["modelId"], known),
        "name": m.get("modelName", ""),
        "provider": m.get("providerName", ""),
        "input": sorted(m.get("inputModalities") or []),
        "output": sorted(m.get("outputModalities") or []),
        "streaming": bool(m.get("responseStreamingSupported", False)),
        "inference": sorted(m.get("inferenceTypesSupported") or []),
        "customization": sorted(m.get("customizationsSupported") or []),
        "status": lc.get("status"),
        "since": _date(lc.get("startOfLifeTime")),
        "eol": _date(lc.get("endOfLifeTime")),
    }


def norm_profile(p: dict) -> dict:
    # model ARNs are account-less (arn:aws:bedrock:<region>::foundation-model/<id>);
    # the profile ARN itself carries the caller's account id, so we never publish it.
    arns = [a["modelArn"] for a in p.get("models", [])]
    all_regions = {a.split(":")[3] for a in arns}
    # global.* profiles list an account-less, region-less ARN (arn:aws:bedrock:::foundation-model/…)
    # for the global endpoint alongside the caller's region; surface that as a flag, not "".
    regions = sorted(r for r in all_regions if r)
    model_ids = sorted({a.rsplit("/", 1)[-1] for a in arns})
    return {
        "id": p["inferenceProfileId"],
        "name": p.get("inferenceProfileName", ""),
        "scope": p["inferenceProfileId"].split(".", 1)[0],  # apac / global / us / eu ...
        "model": model_ids[0] if len(model_ids) == 1 else model_ids,
        "regions": regions,
        "global_endpoint": "" in all_regions,
        "status": p.get("status"),
        "created": _date(p.get("createdAt")),
        "updated": _date(p.get("updatedAt")),
    }


def sort_models(ms: list[dict]) -> list[dict]:
    return sorted(ms, key=lambda m: (m["provider"].lower(), m["name"].lower(), m["id"]))


# ---------------------------------------------------------------- diff
def _brief(m: dict) -> dict:
    return {"id": m["id"], "name": m["name"], "provider": m["provider"]}


def diff_region(old: list[dict], new: list[dict]) -> dict:
    o = {m["id"]: m for m in old}
    n = {m["id"]: m for m in new}
    added = [_brief(n[i]) for i in sorted(n.keys() - o.keys())]
    removed = [_brief(o[i]) for i in sorted(o.keys() - n.keys())]
    changed = []
    for i in sorted(o.keys() & n.keys()):
        for f in ("status", "inference", "streaming", "input", "output", "eol", "customization"):
            if o[i].get(f) != n[i].get(f):
                changed.append({"id": i, "name": n[i]["name"], "field": f, "from": o[i].get(f), "to": n[i].get(f)})
    return {"added": added, "removed": removed, "changed": changed}


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None


def dump_json(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n")


# ---------------------------------------------------------------- rss
def rss(changes: list[dict], checked_at: str) -> str:
    items = []
    for c in changes[:MAX_FEED_ITEMS]:
        if c.get("type") == "baseline":
            title = f"[{c['region']}] baseline snapshot — {c['count']} models"
            body = f"First snapshot of {c['region']}: {c['count']} foundation models."
        else:
            parts = []
            if c["added"]:
                parts.append(f"+{len(c['added'])} added")
            if c["removed"]:
                parts.append(f"-{len(c['removed'])} removed")
            if c["changed"]:
                parts.append(f"{len(c['changed'])} changed")
            title = f"[{c['region']}] " + ", ".join(parts)
            lines = [f"added: {a['name']} ({a['id']})" for a in c["added"]]
            lines += [f"removed: {r['name']} ({r['id']})" for r in c["removed"]]
            lines += [f"changed: {x['name']} {x['field']} {x['from']} → {x['to']}" for x in c["changed"]]
            body = "\n".join(lines)
        guid = f"{c['date']}-{c['region']}"
        pub = datetime.fromisoformat(c["date"]).replace(tzinfo=timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
        items.append(
            "  <item>\n"
            f"   <title>{escape(title)}</title>\n"
            f"   <link>{PAGE}#changes</link>\n"
            f'   <guid isPermaLink="false">{escape(guid)}</guid>\n'
            f"   <pubDate>{pub}</pubDate>\n"
            f"   <description>{escape(body)}</description>\n"
            "  </item>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n'
        " <channel>\n"
        f"  <title>Amazon Bedrock model catalog changes — {PRIMARY} first</title>\n"
        f"  <link>{PAGE}</link>\n"
        f'  <atom:link href="{SITE}/data/bedrock/feed.xml" rel="self" type="application/rss+xml"/>\n'
        "  <description>Daily diff of bedrock:ListFoundationModels across "
        + ", ".join(REGIONS)
        + ". Generated by hub.sean-chloe.com.</description>\n"
        "  <language>ko</language>\n"
        f"  <lastBuildDate>{checked_at}</lastBuildDate>\n"
        + "\n".join(items)
        + "\n </channel>\n</rss>\n"
    )


# ---------------------------------------------------------------- main
def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    today = now.date().isoformat()
    checked_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    prev_models = load_json(OUT / "models.json") or {}
    prev_regions = prev_models.get("regions", {})
    changes: list[dict] = load_json(OUT / "changes.json") or []

    regions: dict[str, dict] = {}
    for r in REGIONS:
        raw = fetch_models(r)
        known = {m["modelId"] for m in raw}
        ms = sort_models([norm_model(m, known) for m in raw])
        regions[r] = {"count": len(ms), "models": ms}
        print(f"{r}: {len(ms)} models", file=sys.stderr)

    profiles = sorted((norm_profile(p) for p in fetch_profiles(PRIMARY)), key=lambda p: (p["scope"], p["id"]))
    print(f"{PRIMARY}: {len(profiles)} system-defined inference profiles", file=sys.stderr)

    # --- diff against the committed snapshot
    new_entries = []
    for r in REGIONS:
        if r not in prev_regions:
            new_entries.append({"date": today, "type": "baseline", "region": r, "count": regions[r]["count"]})
            continue
        d = diff_region(prev_regions[r]["models"], regions[r]["models"])
        if d["added"] or d["removed"] or d["changed"]:
            new_entries.append({"date": today, "type": "diff", "region": r, **d})
    existing = {(c["date"], c["region"]) for c in changes}  # re-run same day → no duplicate entry
    new_entries = [e for e in new_entries if (e["date"], e["region"]) not in existing]
    changes = new_entries + changes  # newest first
    for e in new_entries:
        summary = e.get("count") or f"+{len(e['added'])}/-{len(e['removed'])}/~{len(e['changed'])}"
        print(f"change {e['region']}: {summary}", file=sys.stderr)

    # --- primary-region view
    seoul_models = regions[PRIMARY]["models"]
    by_model_profiles: dict[str, list[str]] = {}
    for p in profiles:
        if PRIMARY not in p["regions"]:
            continue
        for mid in [p["model"]] if isinstance(p["model"], str) else p["model"]:
            by_model_profiles.setdefault(mid, []).append(p["id"])
    seoul_view = []
    for m in seoul_models:
        profs = sorted(by_model_profiles.get(m["id"], []))
        access = []
        if "ON_DEMAND" in m["inference"]:
            access.append("on-demand")
        if profs:
            access.append("cris")
        if "PROVISIONED" in m["inference"]:
            access.append("provisioned")
        seoul_view.append({**m, "profiles": profs, "access": access})

    seoul_bases = {m["base"] for m in seoul_models}
    missing: dict[str, dict] = {}
    for r in REFERENCE:
        for m in regions[r]["models"]:
            if m["base"] in seoul_bases:
                continue
            e = missing.setdefault(
                m["base"], {"base": m["base"], "name": m["name"], "provider": m["provider"], "regions": []}
            )
            if r not in e["regions"]:
                e["regions"].append(r)
    missing_list = sorted(missing.values(), key=lambda e: (e["provider"].lower(), e["name"].lower()))

    ref_bases = {r: {m["base"] for m in regions[r]["models"]} for r in REFERENCE}
    stats = {
        "primary_models": len(seoul_models),
        "primary_bases": len(seoul_bases),
        "reference": {
            r: {
                "models": regions[r]["count"],
                "bases": len(ref_bases[r]),
                "shared_bases": len(seoul_bases & ref_bases[r]),
                "coverage_pct": round(100 * len(seoul_bases & ref_bases[r]) / max(1, len(ref_bases[r])), 1),
            }
            for r in REFERENCE
        },
        "on_demand": sum(1 for m in seoul_view if "on-demand" in m["access"]),
        "cris_only": sum(1 for m in seoul_view if m["access"] == ["cris"]),
        "no_access_path": sum(1 for m in seoul_view if not m["access"]),
        "providers": sorted({m["provider"] for m in seoul_models}),
        "missing_bases": len(missing_list),
    }

    # --- write
    dump_json(OUT / "models.json", {"schema": SCHEMA, "primary_region": PRIMARY, "regions": regions})
    dump_json(
        OUT / "profiles.json", {"schema": SCHEMA, "region": PRIMARY, "count": len(profiles), "profiles": profiles}
    )
    dump_json(
        OUT / "seoul.json",
        {"schema": SCHEMA, "region": PRIMARY, "stats": stats, "models": seoul_view, "missing": missing_list},
    )
    dump_json(OUT / "changes.json", changes)
    (OUT / "feed.xml").write_text(rss(changes, checked_at))
    dump_json(
        OUT / "meta.json",
        {
            "schema": SCHEMA,
            "checked_at": checked_at,
            "primary_region": PRIMARY,
            "regions": REGIONS,
            "source": "bedrock:ListFoundationModels, bedrock:ListInferenceProfiles",
            "page": PAGE,
        },
    )
    print(f"wrote {OUT} (checked_at={checked_at}, {len(new_entries)} new change entries)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
