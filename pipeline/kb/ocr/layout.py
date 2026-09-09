"""阶段②版面分析：可插拔协议 + 整页占位实现（骨架期）+ PP-DocLayout 实现（精度期，模型版本可配）。"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import pymupdf as fitz
from psycopg.types.json import Jsonb

from kb.core.config import Config
from kb.core.paths import resolve_storage_path
from kb.core.paths import storage_rel
from kb.ocr.pad import padded_px_bbox

@dataclass
class BlockDraft:
    page_id: str
    block_type: str
    crop_path: str
    bbox: tuple[float, float, float, float] | None = None
    ordinal: int | None = None
    crop_pad: list[int] | None = None


_LABEL_MAP = {
    # 标签集来源：~/.paddlex/official_models/PP-DocLayoutV3/inference.yml 的 label_list（V2 同为这 25 个）
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
    # V3 有而此前未映射的 8 个：内容不能丢，全部显式归 text
    "abstract": "text",
    "algorithm": "text",
    "aside_text": "text",
    "content": "text",
    "formula_number": "text",
    "reference": "text",
    "reference_content": "text",
    "vertical_text": "text",
    "text": "text",
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
        return [
            BlockDraft(
                page_id=page_id,
                block_type="page",
                bbox=None,
                crop_path=image_path,
                ordinal=1,
            )
        ]


class PaddleOCRLayout:
    """PP-DocLayout 版面检测（只切块+分类，不识别内容；识别走③分级解析）。

    模型版本由 KB_LAYOUT_MODEL 配置（PP-DocLayoutV2 | PP-DocLayoutV3，默认 V3）。
    V2/V3 都带指针网络，返回 boxes 的顺序即阅读顺序。模型懒加载。
    选型记录：完整 PaddleOCR-VL 实测 353s/页（CPU）；版面专用模型 V2 实测 ~5s/页，
    V3 按官方 1.6× 推算约 7~8s/页，与本架构分工吻合。
    """

    def __init__(
        self,
        blocks_dir: Path,
        model_name: str = "PP-DocLayoutV3",
        dpi: int = 200,
        pipeline=None,
    ):
        self._blocks_dir = Path(blocks_dir)
        self._model_name = model_name
        self._dpi = dpi
        self._pipeline = pipeline  # 测试可注入假模型

    def _get_pipeline(self):
        if self._pipeline is None:
            try:
                from paddleocr import LayoutDetection
            except ImportError as e:
                raise SystemExit(
                    "缺少 paddle 依赖：请在 pipeline/ 下执行 `uv sync` 安装 "
                    "paddlepaddle/paddleocr（pyproject 已声明）；"
                    "或显式设 KB_LAYOUT_ENGINE=whole_page 回退整页模式"
                ) from e
            self._pipeline = LayoutDetection(model_name=self._model_name)
        return self._pipeline

    def analyze(self, page_id: str, image_path: str) -> list[BlockDraft]:
        output = self._get_pipeline().predict(str(image_path))
        data = output[0].json if hasattr(output[0], "json") else {}
        boxes = (data.get("res") or data).get("boxes", [])
        # PP-DocLayoutV2/V3 自带指针网络，boxes 返回顺序即阅读顺序，直接采用
        out_dir = self._blocks_dir / page_id
        out_dir.mkdir(parents=True, exist_ok=True)
        pix = fitz.Pixmap(str(image_path))
        page_size = (pix.width, pix.height)
        del pix
        raw = [tuple(b.get("coordinate") or (0, 0, 0, 0)) for b in boxes]
        drafts = []
        for i, b in enumerate(boxes, start=1):
            bbox = raw[i - 1]
            block_type = map_block_label(b.get("label"))
            padded, pad = padded_px_bbox(
                bbox, block_type, self._dpi, page_size,
                prev_bbox=raw[i - 2] if i > 1 else None,
                next_bbox=raw[i] if i < len(raw) else None,
            )
            crop = out_dir / f"b{i - 1:03d}.png"
            crop_image(image_path, padded, crop)
            drafts.append(BlockDraft(
                page_id=page_id,
                block_type=block_type,
                bbox=tuple(float(v) for v in bbox),
                crop_path=str(crop),
                ordinal=i,
                crop_pad=pad,
            ))
        return drafts


def run_layout(conn, doc_id: str, analyzer: LayoutAnalyzer | None = None,
               force: bool = False, cfg: Config | None = None) -> int:
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
               WHERE p.document_id=%s AND p.parse_status='rendered'
               AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.page_id=p.id)
               ORDER BY p.page_no""",
            (doc_id,),
        )
        rows = cur.fetchall()
        n = 0
        for page_id, image_path in rows:
            if cfg is not None:
                image_path = str(resolve_storage_path(cfg, image_path))
            for i, draft in enumerate(analyzer.analyze(str(page_id), image_path), start=1):
                cur.execute(
                    """INSERT INTO blocks (id, page_id, block_type, bbox, crop_path,
                                           ordinal, crop_pad)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    (str(uuid.uuid4()), page_id, draft.block_type,
                     Jsonb(list(draft.bbox)) if draft.bbox is not None else None,
                     storage_rel(cfg, draft.crop_path) if cfg is not None else draft.crop_path,
                     draft.ordinal or i,
                     Jsonb(draft.crop_pad) if draft.crop_pad else None),
                )
                n += 1
    return n


def make_layout_analyzer(cfg, doc_id: str | None = None) -> LayoutAnalyzer:
    """按配置选版面引擎。doc_id 传入时块图落 storage/<doc_id>/blocks/（spec §7.1）。"""
    if cfg.layout_engine == "paddleocr":
        blocks_dir = (Path(cfg.storage_dir) / doc_id / "blocks"
                      if doc_id else Path(cfg.storage_dir) / "blocks")
        return PaddleOCRLayout(blocks_dir=blocks_dir, model_name=cfg.layout_model,
                               dpi=cfg.dpi)
    return WholePageLayout()
