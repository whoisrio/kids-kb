"""阶段②版面分析：可插拔协议 + 整页占位实现（精度期换 PaddleOCR-VL，接口不变）。"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Protocol


@dataclass
class BlockDraft:
    page_id: str
    block_type: str
    crop_path: str
    bbox: tuple[float, float, float, float] | None = None


class LayoutAnalyzer(Protocol):
    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]: ...


class WholePageLayout:
    """骨架期占位：整页算一个 block，crop 直接用页面图。"""

    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]:
        return [BlockDraft(page_id=page_id, block_type="page", bbox=None, crop_path=image_path)]


def run_layout(conn, doc_id: str, analyzer: LayoutAnalyzer | None = None) -> int:
    analyzer = analyzer or WholePageLayout()
    with conn.cursor() as cur:
        cur.execute(
            """SELECT p.id, p.image_path FROM pages p
               WHERE p.document_id=%s AND p.status='rendered'
               AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.page_id=p.id)
               ORDER BY p.page_no""",
            (doc_id,),
        )
        rows = cur.fetchall()
        n = 0
        for page_id, image_path in rows:
            for draft in analyzer.analyze(str(page_id), image_path):
                cur.execute(
                    """INSERT INTO blocks (id, page_id, block_type, bbox, crop_path)
                       VALUES (%s,%s,%s,%s,%s)""",
                    (str(uuid.uuid4()), page_id, draft.block_type, draft.bbox, draft.crop_path),
                )
                n += 1
    return n
