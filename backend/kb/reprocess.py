"""版面质量返工：PaddleOCR-VL 整管线（版面+识别一体）重处理指定页。

触发场景：PP-DocLayoutV2 切块过碎/转录质量差，人工复核无价值。
整管线输出自带 block_content（公式已是 LaTeX），块内容直接入库，不再走分级解析。
例外：VL 把竖式谜识别成星号占位文本时（多行含 □＊*× 的 text 块）不可信，
改标 formula 且内容置 NULL，由 run_parse 用视觉模型升级转录。
破坏性（调用前需用户确认）：删指定页全部块（级联删 item_blocks/复核行），
并删页码范围相交章节的 items，由调用方随后重跑 structure 重建。
"""
from __future__ import annotations

import uuid
from pathlib import Path

from psycopg.types.json import Jsonb

from kb.config import Config
from kb.layout import crop_image, map_block_label
from kb.parse import starred_math


def _needs_vlm_upgrade(block_type: str, content: str) -> bool:
    """VL 直出的 text 块若多行含竖式符号，说明竖式被误识别成星号占位文本。"""
    return block_type == "text" and starred_math(content)


def _parsing_blocks(output) -> list[dict]:
    """取 PaddleOCR-VL predict 结果中的 parsing_res_list（已按阅读顺序排列）。"""
    res = output[0]
    data = res.json if hasattr(res, "json") else {}
    return (data.get("res") or data).get("parsing_res_list", [])


def reprocess_pages_paddleocr(conn, cfg: Config, doc_id: str, page_nos: list[int],
                              pipeline=None) -> dict:
    """重处理指定页。pipeline 可注入假模型；默认懒加载 PaddleOCRVL 整管线。"""
    if pipeline is None:
        from paddleocr import PaddleOCRVL
        pipeline = PaddleOCRVL(pipeline_version="v1.5")
    lo, hi = min(page_nos), max(page_nos)
    stats = {"blocks": 0, "items_deleted": 0}
    with conn.cursor() as cur:
        # 页码范围相交章节的 items 内容已失效，清掉等 structure 重建（级联 item_blocks）
        cur.execute(
            """DELETE FROM items WHERE document_id=%s AND chapter IN (
                   SELECT '第 ' || chapter_no || ' 讲 ' || title FROM chapters
                   WHERE document_id=%s
                     AND page_start IS NOT NULL AND page_start <= %s
                     AND page_end >= %s)""",
            (doc_id, doc_id, hi, lo),
        )
        stats["items_deleted"] = cur.rowcount
        for page_no in page_nos:
            cur.execute(
                "SELECT id, image_path FROM pages WHERE document_id=%s AND page_no=%s",
                (doc_id, page_no),
            )
            row = cur.fetchone()
            if not row:
                continue
            page_id, image_path = row
            cur.execute("DELETE FROM blocks WHERE page_id=%s", (page_id,))
            out_dir = Path(cfg.storage_dir) / "blocks" / str(page_id)
            out_dir.mkdir(parents=True, exist_ok=True)
            for i, b in enumerate(_parsing_blocks(pipeline.predict(str(image_path)))):
                bbox = tuple(b.get("block_bbox") or (0, 0, 0, 0))
                crop = out_dir / f"b{i:03d}.png"
                crop_image(image_path, bbox, crop)
                block_type = map_block_label(b.get("block_label"))
                content = (b.get("block_content") or "").strip() or None
                if content and _needs_vlm_upgrade(block_type, content):
                    block_type, content = "formula", None  # 星号竖式不可信，升级 VLM 重转录
                cur.execute(
                    """INSERT INTO blocks (id, page_id, block_type, bbox, crop_path,
                                         content_md, source_model)
                       VALUES (%s,%s,%s,%s,%s,%s,'paddleocr-vl-1.5')""",
                    (str(uuid.uuid4()), page_id, block_type,
                     Jsonb([float(v) for v in bbox]), str(crop), content),
                )
                stats["blocks"] += 1
            cur.execute(
                "UPDATE pages SET status='parsed', parse_error=NULL WHERE id=%s",
                (page_id,),
            )
    return stats
