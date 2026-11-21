"""Codiz Independent Benchmark & Security Evaluation Runner."""

from __future__ import annotations

import ast
import json
import sys
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass
class BenchmarkCase:
    id: str
    category: str
    prompt: str
    expected_keywords: list[str]
    forbidden_patterns: list[str]


BENCHMARK_SUITE: list[BenchmarkCase] = [
    BenchmarkCase(
        id="cf-hono-d1",
        category="cloudflare",
        prompt="Write a Hono Cloudflare Worker GET route querying a D1 users table safely by id.",
        expected_keywords=["prepare", "bind", "SELECT"],
        forbidden_patterns=["${", "innerHTML", "eval("],
    ),
    BenchmarkCase(
        id="meta-webhook-hmac",
        category="meta",
        prompt="Write a Python function verifying X-Hub-Signature-256 using hmac.compare_digest.",
        expected_keywords=["hmac", "sha256", "compare_digest"],
        forbidden_patterns=["==", "md5"],
    ),
]


def check_python_ast(code: str) -> bool:
    try:
        ast.parse(code)
        return True
    except SyntaxError:
        return False


def evaluate_endpoint(inference_url: str, model_id: str) -> dict[str, Any]:
    passed = 0
    results: list[dict[str, Any]] = []

    for case in BENCHMARK_SUITE:
        payload = json.dumps(
            {
                "model": model_id,
                "messages": [{"role": "user", "content": case.prompt}],
                "max_tokens": 512,
                "temperature": 0.1,
            }
        ).encode("utf-8")

        req = urllib.request.Request(
            f"{inference_url.rstrip('/')}/v1/chat/completions",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        content: str = data["choices"][0]["message"]["content"]
        has_keywords = all(kw in content for kw in case.expected_keywords)
        clean_security = not any(bad in content for bad in case.forbidden_patterns)
        ok = has_keywords and clean_security
        if ok:
            passed += 1
        results.append({"id": case.id, "category": case.category, "passed": ok})

    score = round((passed / len(BENCHMARK_SUITE)) * 100.0, 2)
    return {"overallScore": score, "passed": passed, "total": len(BENCHMARK_SUITE), "results": results}


if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080"
    model = sys.argv[2] if len(sys.argv) > 2 else "Qwen/Qwen3-4B-Instruct"
    print(json.dumps(evaluate_endpoint(url, model), indent=2))
