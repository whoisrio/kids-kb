import os

import pymupdf as fitz
import pytest

from kb.layout import crop_image, map_block_label


def test_map_block_label():
    assert map_block_label("text") == "text"
    assert map_block_label("paragraph_title") == "title"
    assert map_block_label("doc_title") == "title"
    assert map_block_label("display_formula") == "formula"
    assert map_block_label("formula") == "formula"
    assert map_block_label("figure") == "figure"
    assert map_block_label("chart") == "figure"
    assert map_block_label("table") == "table"
    assert map_block_label("header") == "header"
    assert map_block_label("footer") == "footer"
    assert map_block_label("seal") == "figure"
    assert map_block_label("没见过的类型") == "text"  # 未知一律当正文，不丢内容


def test_crop_image(tmp_path):
    src = tmp_path / "page.png"
    d = fitz.open()
    pg = d.new_page(width=200, height=100)
    pg.insert_text((10, 20), "上部区域")
    pg.insert_text((10, 80), "下部区域")
    pg.get_pixmap(dpi=144).save(src)  # 200x100pt -> 400x200px

    def dark_ratio(path):
        pix = fitz.Pixmap(str(path))
        dark = sum(1 for i in range(0, len(pix.samples), pix.n) if pix.samples[i] < 128)
        return dark / (pix.width * pix.height)

    out = tmp_path / "crop.png"
    crop_image(src, (0, 100, 400, 200), out)  # 只裁下半（像素坐标）
    pix = fitz.Pixmap(str(out))
    assert (pix.width, pix.height) == (400, 100)
    assert dark_ratio(out) > 0  # 下半有字

    blank = tmp_path / "blank.png"
    crop_image(src, (0, 120, 400, 140), blank)  # 两行文字之间的空白带
    assert dark_ratio(blank) == 0  # 空白带无字


@pytest.mark.skipif(os.environ.get("KB_RUN_SLOW") != "1", reason="需要下载模型，KB_RUN_SLOW=1 才跑")
def test_paddleocr_layout_on_real_page(tmp_path):
    from kb.layout import PaddleOCRLayout

    layout = PaddleOCRLayout(blocks_dir=tmp_path / "blocks")
    drafts = layout.analyze("p0006", "../resources/2025秋7星学霸题中题数学4年级第7辑-第6页.png")
    types = {d.block_type for d in drafts}
    assert "text" in types  # 专题引导正文
    assert len(drafts) >= 5  # 标题/正文/例题/思维导图等
    for d in drafts:
        assert os.path.exists(d.crop_path)
