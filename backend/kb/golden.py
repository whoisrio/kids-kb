"""黄金集工具。

golden extract: 把指定页当前解析结果导出为 golden/<doc_id>/pNNNN.md，人工逐字校对。
golden check:  重新转录黄金页（不写库），与校对稿做归一化字符级比对，报告 CER。
精度期的验收指标（区块识别率/条目一致率）在此工具上扩展。
"""
from __future__ import annotations

import difflib
from pathlib import Path


def normalize(text: str) -> str:
    return "".join(text.split())


def char_error_rate(expected: str, actual: str) -> float:
    expected, actual = normalize(expected), normalize(actual)
    if not expected:
        return 0.0 if not actual else 1.0
    return 1.0 - difflib.SequenceMatcher(None, expected, actual).ratio()


def extract(conn, doc_id: str, golden_dir: Path) -> list[Path]:
    golden_dir = golden_dir / doc_id
    golden_dir.mkdir(parents=True, exist_ok=True)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT p.page_no, b.content_md FROM blocks b
               JOIN pages p ON p.id = b.page_id
               WHERE p.document_id=%s AND b.content_md IS NOT NULL
               ORDER BY p.page_no""",
            (doc_id,),
        )
        out = []
        for page_no, content in cur.fetchall():
            path = golden_dir / f"p{page_no:04d}.md"
            path.write_text(content, encoding="utf-8")
            out.append(path)
    return out


def check(conn, cfg, doc_id: str, golden_dir: Path) -> float:
    """重转录黄金页并比对。返回平均 CER，打印逐页结果。"""
    from kb.parse import transcribe_image
    from openai import OpenAI

    client = OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    golden_dir = golden_dir / doc_id
    with conn.cursor() as cur:
        cur.execute(
            "SELECT page_no, image_path FROM pages WHERE document_id=%s ORDER BY page_no",
            (doc_id,),
        )
        pages = dict(cur.fetchall())
    rates = []
    for golden_file in sorted(golden_dir.glob("p*.md")):
        page_no = int(golden_file.stem[1:])
        actual = transcribe_image(client, cfg.vision_model, pages[page_no])
        rate = char_error_rate(golden_file.read_text(encoding="utf-8"), actual)
        rates.append(rate)
        print(f"page {page_no}: CER={rate:.3f}")
    avg = sum(rates) / len(rates) if rates else 1.0
    print(f"平均 CER={avg:.3f}（{len(rates)} 页）")
    return avg
