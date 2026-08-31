"""阶段②版面分析：可插拔协议 + 整页占位实现（骨架期）+ PaddleOCR-VL 实现（精度期）。"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import pymupdf as fitz
from psycopg.types.json import Jsonb


@dataclass
class BlockDraft:
    page_id: str
    block_type: str
    crop_path: str
    bbox: tuple[float, float, float, float] | None = None


_LABEL_MAP = {
    "doc_title": "title",
    "paragraph_title": "title",
    "title": "title",
    "display_formula": "formula",
    "formula": "formula",
    "inline_formula": "formula",
    "figure": "figure",
    "figure_title": "figure",
    "chart": "figure",
    "seal": "figure",
    "image": "figure",
    "vision_footnote": "figure",
    "table": "table",
    "header": "header",
    "header_image": "header",
    "footer": "footer",
    "footer_image": "footer",
    "footnote": "footer",
    "number": "footer",
}


def map_block_label(label: str) -> str:
    """PaddleOCR-VL 区块标签 -> 我们的 block_type；未知一律 text（不丢内容）。"""
    return _LABEL_MAP.get((label or "").lower(), "text")


def crop_image(src_path, bbox, out_path) -> None:
    """把页面图按 bbox=(x0,y0,x1,y1)（像素）裁出区块图。

    fitz 打开位图时页面坐标是 pt（随内嵌 DPI 变），需换算回像素空间。
    """
    doc = fitz.open(str(src_path))
    page = doc[0]
    pix = fitz.Pixmap(str(src_path))  # 原图像素尺寸
    sx = page.rect.width / pix.width
    sy = page.rect.height / pix.height
    x0, y0, x1, y1 = bbox
    rect = fitz.Rect(x0 * sx, y0 * sy, x1 * sx, y1 * sy) & page.rect  # 防越界
    mat = fitz.Matrix(1 / sx, 1 / sy)  # pt 换回像素，保持原分辨率
    page.get_pixmap(matrix=mat, clip=rect).save(str(out_path))


class LayoutAnalyzer(Protocol):
    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]: ...


class WholePageLayout:
    """骨架期占位：整页算一个 block，crop 直接用页面图。"""

    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]:
        return [BlockDraft(page_id=page_id, block_type="page", bbox=None, crop_path=image_path)]


class PaddleOCRLayout:
    """PP-DocLayoutV2 版面检测（只切块+分类，不识别内容；识别走③分级解析）。

    选型记录：完整 PaddleOCR-VL 实测 353s/页（CPU），其中逐块 VLM 识别我们并不需要；
    版面专用模型 PP-DocLayoutV2 实测 ~5s/页，与本架构分工吻合。模型懒加载。
    """

    def __init__(self, blocks_dir: Path, pipeline=None):
        self._blocks_dir = Path(blocks_dir)
        self._pipeline = pipeline  # 测试可注入假模型

    def _get_pipeline(self):
        if self._pipeline is None:
            from paddleocr import LayoutDetection
            self._pipeline = LayoutDetection(model_name="PP-DocLayoutV2")
        return self._pipeline

    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]:
        output = self._get_pipeline().predict(str(image_path))
        data = output[0].json if hasattr(output[0], "json") else {}
        boxes = (data.get("res") or data).get("boxes", [])
        # 阅读顺序：从上到下，同带内从左到右（单栏教辅够用；多栏由黄金集验收兜底）
        boxes = sorted(boxes,
                       key=lambda b: (round((b.get("coordinate") or [0])[1] / 20),
                                      (b.get("coordinate") or [0, 0])[0]))
        out_dir = self._blocks_dir / page_id
        out_dir.mkdir(parents=True, exist_ok=True)
        drafts = []
        for i, b in enumerate(boxes):
            bbox = tuple(b.get("coordinate") or (0, 0, 0, 0))
            crop = out_dir / f"b{i:03d}.png"
            crop_image(image_path, bbox, crop)
            drafts.append(BlockDraft(
                page_id=page_id,
                block_type=map_block_label(b.get("label")),
                bbox=tuple(float(v) for v in bbox),
                crop_path=str(crop),
            ))
        return drafts


def run_layout(conn, doc_id: str, analyzer: LayoutAnalyzer | None = None,
               force: bool = False) -> int:
    analyzer = analyzer or WholePageLayout()
    with conn.cursor() as cur:
        if force:
            # 只清没有复核引用的块；有复核记录的页保持原样（人工痕迹不丢）
            cur.execute(
                """DELETE FROM blocks b USING pages p
                   WHERE b.page_id = p.id AND p.document_id=%s
                   AND NOT EXISTS (SELECT 1 FROM review_queue r WHERE r.block_id=b.id)""",
                (doc_id,),
            )
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
                    (str(uuid.uuid4()), page_id, draft.block_type,
                     Jsonb(list(draft.bbox)) if draft.bbox is not None else None,
                     draft.crop_path),
                )
                n += 1
    return n


def make_layout_analyzer(cfg) -> LayoutAnalyzer:
    """按配置选版面引擎。"""
    if cfg.layout_engine == "paddleocr":
        return PaddleOCRLayout(blocks_dir=cfg.storage_dir / "blocks")
    return WholePageLayout()
