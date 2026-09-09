"""裁图 padding：物理毫米定义（spec §5.2），页边界 + 相邻块 clamp（§5.3）。

A4@200dpi 基准值（spec 表）：text 6px 横/4px 纵，figure 12px 横/8px 纵。
"""
from kb.ocr.pad import mm_to_px, pad_mm_for, padded_px_bbox

A4_200 = (1654, 2339)


def test_pad_mm_for():
    assert pad_mm_for("figure") == (1.5, 1.0)
    assert pad_mm_for("text") == (0.8, 0.5)
    assert pad_mm_for("table") == (0.8, 0.5)


def test_mm_to_px():
    assert mm_to_px(0.8, 200) == 6
    assert mm_to_px(1.5, 200) == 12
    assert mm_to_px(1.0, 200) == 8


def test_padded_no_neighbors():
    bbox, pad = padded_px_bbox((100, 210, 500, 500), "figure", 200, A4_200)
    assert bbox == (88, 202, 512, 508)
    assert pad == [12, 8]


def test_padded_neighbor_clamp():
    prev = (100, 100, 500, 200)
    nxt = (100, 514, 500, 600)
    bbox, pad = padded_px_bbox((100, 210, 500, 500), "figure", 200, A4_200,
                               prev_bbox=prev, next_bbox=nxt)
    assert bbox == (88, 205, 512, 507)
    assert pad == [12, 5]


def test_padded_overlapping_neighbor_clamps_to_zero():
    prev = (100, 100, 500, 220)
    bbox, pad = padded_px_bbox((100, 210, 500, 500), "text", 200, A4_200, prev_bbox=prev)
    assert bbox[1] == 210
    assert pad == [6, 0]


def test_padded_page_bounds_clamp():
    bbox, _pad = padded_px_bbox((0, 0, 100, 100), "figure", 200, A4_200)
    assert bbox == (0, 0, 112, 108)
