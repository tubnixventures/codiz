"""Codiz Knowledge Ingestion Worker — Polite Documentation Scraper for Cloud Run Jobs."""

from __future__ import annotations

import hashlib
import os
import re
import urllib.robotparser
import urllib.request
from typing import Any


def can_fetch_url(url: str, user_agent: str = "CodizKnowledgeBot/1.0") -> bool:
    from urllib.parse import urlparse

    parsed = urlparse(url)
    rp = urllib.robotparser.RobotFileParser()
    rp.set_url(f"{parsed.scheme}://{parsed.netloc}/robots.txt")
    try:
        rp.read()
        return rp.can_fetch(user_agent, url)
    except Exception:
        return True


def strip_html(html: str) -> str:
    no_script = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", no_script)
    return re.sub(r"\s+", " ", text).strip()


def ingest_url_to_gateway(gateway_url: str, api_token: str, collection: str, url: str) -> dict[str, Any]:
    if not can_fetch_url(url):
        return {"skipped": True, "reason": "robots.txt disallowed", "url": url}

    req = urllib.request.Request(url, headers={"User-Agent": "CodizKnowledgeBot/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read().decode("utf-8", errors="ignore")

    clean = strip_html(raw)[:150_000]
    digest = hashlib.sha256(clean.encode("utf-8")).hexdigest()[:12]
    import json

    payload = json.dumps(
        {
            "collection": collection,
            "title": f"{collection} docs ({digest})",
            "sourceUrl": url,
            "rawContent": clean,
        }
    ).encode("utf-8")

    post_req = urllib.request.Request(
        f"{gateway_url.rstrip('/')}/api/knowledge/ingest",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_token}",
        },
        method="POST",
    )
    with urllib.request.urlopen(post_req, timeout=15) as post_resp:
        return json.loads(post_resp.read().decode("utf-8"))


if __name__ == "__main__":
    gw = os.getenv("CODIZ_GATEWAY_URL", "http://localhost:3000")
    tok = os.getenv("CODIZ_API_TOKEN", "")
    target = os.getenv("INGEST_URL", "")
    col = os.getenv("INGEST_COLLECTION", "cloudflare")
    if target and tok:
        print(ingest_url_to_gateway(gw, tok, col, target))
