import shutil
import subprocess
from pathlib import Path

import pytest

from kb.review_api import STATIC_DIR

VENDOR = STATIC_DIR / "vendor"


def test_vendor_assets_exist():
    for rel in ["marked.min.js", "dompurify/purify.min.js",
                "katex/katex.min.js", "katex/katex.min.css"]:
        assert (VENDOR / rel).exists(), f"缺 vendor 资产: {rel}"
    assert list((VENDOR / "katex" / "fonts").glob("*.woff2")), "katex 字体缺失"


def test_page_references_renderer_and_math():
    html = (STATIC_DIR / "review.html").read_text(encoding="utf-8")
    assert "render.js" in html
    assert "katex" in html
    assert "marked" in html


def test_render_js_selftest():
    """node 直接跑渲染函数自测：markdown 语义 + LaTeX 渲染 + 上下标不被 markdown 吞。"""
    if not shutil.which("node"):
        pytest.skip("需要 node")
    r = subprocess.run(
        ["node", str(STATIC_DIR / "render_selftest.js")],
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, r.stdout + r.stderr
