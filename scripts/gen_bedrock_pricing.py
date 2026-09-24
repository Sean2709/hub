#!/usr/bin/env python3
"""Bedrock on-demand token prices → public/data/bedrock/pricing.json (for /bedrock/cost/).

Source: AWS Price List *bulk* API — public, unauthenticated JSON
  https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<offer>/current/<region>/index.json
Offers: AmazonBedrock (Amazon & some open-weight models, priced per 1K tokens)
        AmazonBedrockFoundationModels (Marketplace-billed models such as Anthropic, priced per 1M tokens)

Only text token prices are kept (input / output / cache read / cache write), normalised to USD per 1M tokens,
keyed by "<scope>.<tier>":
  scope = region (in-Region on-demand) | global (global cross-Region inference profile)
  tier  = standard | batch | flex | priority
Skipped: reserved/TPM, image/video/audio units, custom-model, latency-optimized, long-context variants.
(The price list has no on-demand token prices for Geo (APAC) profiles, so no "geo" scope.)

Deterministic: the output only changes when AWS publishes new prices (no timestamps; `versions` = publication ids).
Standard library only. Usage: python3 scripts/gen_bedrock_pricing.py
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "bedrock" / "pricing.json"
BASE = "https://pricing.us-east-1.amazonaws.com"
OFFERS = ["AmazonBedrock", "AmazonBedrockFoundationModels"]
REGIONS = ["ap-northeast-2", "us-east-1"]
SCHEMA = 1

SKIP = re.compile(
    r"reserved|tpm|image|video|audio|speech|second|custom-?model|latency-?optimized|long-?context|lctx|provisioned|"
    r"customization|train|storage|guardrail|request"
)
# models the AmazonBedrock offer lists under the generic name "Amazon Bedrock": derive from the usagetype
TITAN = {
    "TitanEmbeddingV2-Text": "Titan Text Embeddings V2",
    "TitanEmbeddingsG1-Text": "Titan Embeddings G1 - Text",
    "TitanTextG1-Lite": "Titan Text G1 - Lite",
    "TitanTextG1-Express": "Titan Text G1 - Express",
    "TitanText-Premier": "Titan Text Premier",
}
PROVIDERS = [
    (r"^meta|^llama", "Meta"), (r"^claude", "Anthropic"), (r"^(nova|titan)", "Amazon"), (r"^cohere|^command|^embed", "Cohere"),
    (r"^twelvelabs", "TwelveLabs"), (r"^kimi", "Moonshot AI"), (r"^grok", "xAI"), (r"^llama", "Meta"),
    (r"^(mistral|mixtral|pixtral|magistral|ministral|devstral)", "Mistral AI"), (r"^deepseek", "DeepSeek"),
    (r"^qwen", "Qwen"), (r"^gpt|^openai", "OpenAI"), (r"^(jamba|jurassic)", "AI21 Labs"), (r"^minimax", "MiniMax"),
    (r"^gemma", "Google"), (r"^(palmyra|writer)", "Writer"), (r"^(glm|zai)", "Z.ai"),
]


def fetch(url: str, tries: int = 3) -> dict:
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 — network flake → retry
            if i == tries - 1:
                raise
            print(f"retry {url}: {e}", file=sys.stderr)
            time.sleep(3 * (i + 1))
    raise RuntimeError("unreachable")


def pretty(name: str) -> str:
    name = name.replace(" (Amazon Bedrock Edition)", "").strip()
    name = re.sub(r"\s+Model$", "", name)
    m = re.match(r"^[a-z0-9]+\.([a-z0-9][\w.-]*)$", name)  # e.g. "xai.grok-4.6" → "Grok 4.6"
    if m:
        parts = m.group(1).split("-")
        name = " ".join(p[:1].upper() + p[1:] for p in parts)
    return name


PROVIDER_ALIAS = {"Mistral": "Mistral AI", "Minimax AI": "MiniMax", "Z AI": "Z.ai"}


def provider_of(name: str, attr: str) -> str:
    if attr:
        return PROVIDER_ALIAS.get(attr, attr)
    low = name.lower()
    for pat, prov in PROVIDERS:
        if re.search(pat, low):
            return prov
    return ""


def classify(usagetype: str, itype: str):
    s = f"{usagetype} {itype}".lower().replace("_", "-")
    if SKIP.search(s):
        return None
    flat = s.replace("-", "").replace(" ", "")
    if re.search(r"cache.?read", s):
        kind = "cacheRead"
    elif re.search(r"cache.?write", s):
        kind = "cacheWrite1h" if re.search(r"1h", s) else "cacheWrite"
    elif "inputtoken" in flat or "inputtexttoken" in flat or "textinputtoken" in flat:
        kind = "in"
    elif re.search(r"(output|response)(text)?token", flat) or "textoutputtoken" in flat:
        kind = "out"
    else:
        return None
    scope = "global" if "global" in s else "region"
    tier = "batch" if "batch" in s else "priority" if "priority" in s else "flex" if "flex" in s else "standard"
    return kind, f"{scope}.{tier}"


def sig(x: float) -> float:
    return float(f"{x:.6g}")


def region_models(region: str, versions: dict) -> list[dict]:
    models: dict[str, dict] = {}
    for offer in OFFERS:
        idx = fetch(f"{BASE}/offers/v1.0/aws/{offer}/current/region_index.json")
        reg = idx.get("regions", {}).get(region)
        if not reg:
            continue
        d = fetch(BASE + reg["currentVersionUrl"])
        versions[f"{offer}/{region}"] = d.get("version", "")
        ondemand = d.get("terms", {}).get("OnDemand", {})
        for sku, p in d.get("products", {}).items():
            a = p.get("attributes", {})
            ut = a.get("usagetype", "")
            ut_short = ut.split("-", 1)[1] if re.match(r"^[A-Z0-9]+-", ut) else ut
            c = classify(ut_short, a.get("inferenceType", ""))
            if not c:
                continue
            raw = a.get("model") or a.get("servicename") or ""
            if raw == "Amazon Bedrock":
                key = next((k for k in TITAN if ut_short.startswith(k)), None)
                raw = TITAN.get(key) if key else ut_short.split("-input")[0].split("-output")[0]
            name = pretty(raw)
            for term in ondemand.get(sku, {}).values():
                for pd in term.get("priceDimensions", {}).values():
                    usd = float(pd.get("pricePerUnit", {}).get("USD", 0) or 0)
                    unit = pd.get("unit", "")
                    if unit == "1K tokens":
                        usd *= 1000
                    elif unit not in ("1M tokens", "Million Tokens"):
                        continue
                    m = models.setdefault(name, {"name": name, "provider": provider_of(name, a.get("provider", "")), "prices": {}})
                    if not m["provider"] and a.get("provider"):
                        m["provider"] = provider_of(name, a["provider"])
                    kind, key = c
                    m["prices"].setdefault(key, {})[kind] = sig(usd)
    out = []
    for m in models.values():
        prices = {k: v for k, v in m["prices"].items() if "in" in v}  # need at least an input price
        if not prices:
            continue
        has_out = any("out" in v for v in prices.values())
        m["kind"] = "text" if has_out else "embedding"
        m["prices"] = dict(sorted(prices.items(), key=lambda kv: (kv[0].split(".")[0] != "region", kv[0])))
        out.append(m)
    out.sort(key=lambda m: (m["provider"], m["name"]))
    return out


def main() -> int:
    versions: dict[str, str] = {}
    regions = {}
    for r in REGIONS:
        ms = region_models(r, versions)
        if r == REGIONS[0] and not ms:
            print("no models parsed for primary region — refusing to overwrite", file=sys.stderr)
            return 1
        regions[r] = {"count": len(ms), "models": ms}
    doc = {
        "schema": SCHEMA,
        "source": "AWS Price List bulk API (public), on-demand text tokens",
        "currency": "USD",
        "unit": "per 1M tokens",
        "primary_region": REGIONS[0],
        "versions": dict(sorted(versions.items())),
        "regions": regions,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    counts = ", ".join(f"{r}={v['count']}" for r, v in regions.items())
    print(f"wrote {OUT} ({counts})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
