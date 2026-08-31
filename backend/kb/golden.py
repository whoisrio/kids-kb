"""黄金集工具。

golden extract: 把指定页当前解析结果导出为 golden/<doc_id>/pNNNN.md，人工逐字校对。
golden check:  重新转录黄金页（不写库），与校对稿做归一化字符级比对，报告 CER。
精度期的验收指标（区块识别率/条目一致率）在此工具上扩展。
"""
from __future__ import annotations

import difflib
import json
from pathlib import Path


def normalize(text: str) -> str:
    return "".join(text.split())


def char_error_rate(expected: str, actual: str) -> float:
    expected, actual = normalize(expected), normalize(actual)
    if not expected:
        return 0.0 if not actual else 1.0
    return 1.0 - difflib.SequenceMatcher(None, expected, actual).ratio()


def iou(a, b) -> float:
    """两个 (x0,y0,x1,y1) 框的交并比。"""
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    area = lambda r: (r[2] - r[0]) * (r[3] - r[1])
    union = area(a) + area(b) - inter
    return inter / union if union > 0 else 0.0


def match_blocks(golden: list[dict], pred: list[dict], iou_threshold: float = 0.5):
    """贪心匹配：按 IoU 降序配对。返回 (matched 对列表, missing, extra)。"""
    pairs = []
    for gi, g in enumerate(golden):
        for pi, p in enumerate(pred):
            if g.get("bbox") and p.get("bbox"):
                pairs.append((iou(g["bbox"], p["bbox"]), gi, pi))
    pairs.sort(reverse=True)
    used_g, used_p, matched = set(), set(), []
    for score, gi, pi in pairs:
        if score < iou_threshold or gi in used_g or pi in used_p:
            continue
        used_g.add(gi)
        used_p.add(pi)
        matched.append((gi, pi))
    missing = [gi for gi in range(len(golden)) if gi not in used_g]
    extra = [pi for pi in range(len(pred)) if pi not in used_p]
    return matched, missing, extra


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


def annotate(conn, doc_id: str, golden_dir: Path) -> list[Path]:
    """导出当前区块预测为人工标注底稿 pNNNN.blocks.json。"""
    golden_dir = golden_dir / doc_id
    golden_dir.mkdir(parents=True, exist_ok=True)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT p.page_no, b.block_type, b.bbox, b.content_md FROM blocks b
               JOIN pages p ON p.id=b.page_id
               WHERE p.document_id=%s ORDER BY p.page_no, b.created_at""",
            (doc_id,),
        )
        pages: dict[int, list] = {}
        for page_no, btype, bbox, content in cur.fetchall():
            pages.setdefault(page_no, []).append(
                {"block_type": btype, "bbox": bbox, "content_md": content})
        out = []
        for page_no, blocks in pages.items():
            path = golden_dir / f"p{page_no:04d}.blocks.json"
            path.write_text(json.dumps(blocks, ensure_ascii=False, indent=2),
                            encoding="utf-8")
            out.append(path)
    return out


def check_blocks(conn, doc_id: str, golden_dir: Path) -> dict:
    """区块级回归：IoU 匹配率 / 类型准确率 / 内容 CER。打印并返回指标。"""
    golden_dir = golden_dir / doc_id
    all_matched = all_missing = all_extra = 0
    type_ok = 0
    cers = []
    with conn.cursor() as cur:
        for gf in sorted(golden_dir.glob("p*.blocks.json")):
            page_no = int(gf.stem.split(".")[0][1:])
            cur.execute(
                """SELECT b.block_type, b.bbox, b.content_md FROM blocks b
                   JOIN pages p ON p.id=b.page_id
                   WHERE p.document_id=%s AND p.page_no=%s ORDER BY b.created_at""",
                (doc_id, page_no),
            )
            pred = [{"block_type": t, "bbox": bb, "content_md": c} for t, bb, c in cur.fetchall()]
            golden = json.loads(gf.read_text(encoding="utf-8"))
            matched, missing, extra = match_blocks(golden, pred)
            all_matched += len(matched)
            all_missing += len(missing)
            all_extra += len(extra)
            for gi, pi in matched:
                if golden[gi]["block_type"] == pred[pi]["block_type"]:
                    type_ok += 1
                cers.append(char_error_rate(golden[gi].get("content_md", ""),
                                            pred[pi].get("content_md") or ""))
            print(f"page {page_no}: 匹配 {len(matched)} 漏 {len(missing)} 多 {len(extra)}")
    total = all_matched + all_missing
    metrics = {
        "match_rate": all_matched / total if total else 1.0,
        "type_accuracy": type_ok / all_matched if all_matched else 1.0,
        "content_cer": sum(cers) / len(cers) if cers else 1.0,
    }
    print(f"区块匹配率={metrics['match_rate']:.3f} "
          f"类型准确率={metrics['type_accuracy']:.3f} "
          f"内容CER={metrics['content_cer']:.3f}")
    return metrics
