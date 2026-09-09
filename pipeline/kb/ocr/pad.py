"""裁图外扩（padding）：按物理毫米定义（spec §5.2），页边界 + 相邻块 clamp（§5.3）。

bbox 存库一律是原始值，padding 只在裁图时加，实际生效量记 blocks.crop_pad。
dy 取上下两侧 clamp 后的较小值（邻居夹紧时两侧可不等）。
"""
from __future__ import annotations


PAD_MM = {"figure": (1.5, 1.0)}
_DEFAULT_PAD_MM = (0.8, 0.5)


def pad_mm_for(block_type: str) -> tuple[float, float]:
    return PAD_MM.get(block_type, _DEFAULT_PAD_MM)


def mm_to_px(mm: float, dpi: int) -> int:
    return round(mm / 25.4 * dpi)


def padded_px_bbox(
    bbox: tuple[float, float, float, float],
    block_type: str,
    dpi: int,
    page_size: tuple[int, int],
    prev_bbox: tuple[float, float, float, float] | None = None,
    next_bbox: tuple[float, float, float, float] | None = None,
) -> tuple[tuple[float, float, float, float], list[int]]:
    """页图像素坐标。prev/next 为同页阅读序相邻块的原始 bbox。
    返回 (外扩并 clamp 后的 bbox, [dx, dy] 实际生效外扩量)。"""
    pad_h_mm, pad_v_mm = pad_mm_for(block_type)
    dx = mm_to_px(pad_h_mm, dpi)
    top = bottom = mm_to_px(pad_v_mm, dpi)
    x0, y0, x1, y1 = bbox
    if prev_bbox is not None:
        top = max(0, min(top, int((y0 - prev_bbox[3]) / 2)))
    if next_bbox is not None:
        bottom = max(0, min(bottom, int((next_bbox[1] - y1) / 2)))
    page_width, page_height = page_size
    padded = (max(0.0, x0 - dx), max(0.0, y0 - top),
              min(float(page_width), x1 + dx),
              min(float(page_height), y1 + bottom))
    return padded, [dx, min(top, bottom)]
