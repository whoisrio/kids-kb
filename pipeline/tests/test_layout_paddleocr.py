import os

import pymupdf as fitz
import pytest

from kb.ocr.layout import crop_image, map_block_label


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
    assert map_block_label("image") == "figure"
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
    from kb.ocr.layout import PaddleOCRLayout

    layout = PaddleOCRLayout(blocks_dir=tmp_path / "blocks")
    drafts = layout.analyze("p0006", "../resources/2025秋7星学霸题中题数学4年级第7辑-第6页.png")
    types = {d.block_type for d in drafts}
    assert "text" in types  # 专题引导正文
    assert len(drafts) >= 5  # 标题/正文/例题/思维导图等
    for d in drafts:
        assert os.path.exists(d.crop_path)


def test_paddleocr_layout_loads_configured_model(tmp_path, monkeypatch):
    """model_name 透传给 LayoutDetection（验收 15/16）。"""
    import sys
    import types

    calls = {}

    class FakeLayoutDetection:
        def __init__(self, model_name):
            calls["model_name"] = model_name

    monkeypatch.setitem(
        sys.modules, "paddleocr",
        types.SimpleNamespace(LayoutDetection=FakeLayoutDetection),
    )
    from kb.ocr.layout import PaddleOCRLayout

    PaddleOCRLayout(blocks_dir=tmp_path, model_name="PP-DocLayoutV2")._get_pipeline()
    assert calls["model_name"] == "PP-DocLayoutV2"


def test_paddleocr_layout_default_model_is_v3(tmp_path, monkeypatch):
    """不显式指定时默认 PP-DocLayoutV3（验收 15）。"""
    import sys
    import types

    calls = {}

    class FakeLayoutDetection:
        def __init__(self, model_name):
            calls["model_name"] = model_name

    monkeypatch.setitem(
        sys.modules, "paddleocr",
        types.SimpleNamespace(LayoutDetection=FakeLayoutDetection),
    )
    from kb.ocr.layout import PaddleOCRLayout

    PaddleOCRLayout(blocks_dir=tmp_path)._get_pipeline()
    assert calls["model_name"] == "PP-DocLayoutV3"


def test_make_layout_analyzer_passes_model(tmp_path):
    """make_layout_analyzer 把 cfg.layout_model 透传给分析器。"""
    from kb.core.config import Config
    from kb.ocr.layout import PaddleOCRLayout, make_layout_analyzer

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path,
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
        layout_engine="paddleocr",
        layout_model="PP-DocLayoutV2",
    )
    analyzer = make_layout_analyzer(cfg)
    assert isinstance(analyzer, PaddleOCRLayout)
    assert analyzer._model_name == "PP-DocLayoutV2"


def test_paddleocr_missing_dependency_message(tmp_path, monkeypatch):
    """缺 paddle 依赖时报错带安装指引，不静默降级（验收：无静默 whole_page 降级）。"""
    import sys

    monkeypatch.setitem(sys.modules, "paddleocr", None)
    from kb.ocr.layout import PaddleOCRLayout

    with pytest.raises(SystemExit) as exc:
        PaddleOCRLayout(blocks_dir=tmp_path)._get_pipeline()
    assert "uv sync" in str(exc.value)


def _write_test_page(path):
    d = fitz.open()
    pg = d.new_page(width=1000, height=1000)
    pg.insert_text((10, 20), "内容")
    pg.get_pixmap(dpi=144).save(path)


def test_analyze_keeps_model_reading_order(tmp_path):
    """boxes 坐标乱序返回时，drafts 保持模型返回顺序，ordinal=1..N（验收 18）。"""
    from kb.ocr.layout import PaddleOCRLayout

    class _FakeOutput:
        json = {"res": {"boxes": [
            {"label": "text", "coordinate": [0, 500, 100, 550]},
            {"label": "paragraph_title", "coordinate": [0, 0, 100, 50]},
            {"label": "footer", "coordinate": [0, 900, 100, 950]},
        ]}}

    class FakePipeline:
        def predict(self, _path):
            return [_FakeOutput()]

    src = tmp_path / "page.png"
    _write_test_page(src)
    layout = PaddleOCRLayout(blocks_dir=tmp_path / "blocks", pipeline=FakePipeline())
    drafts = layout.analyze("p1", str(src))
    assert [d.block_type for d in drafts] == ["text", "title", "footer"]
    assert [d.ordinal for d in drafts] == [1, 2, 3]


def test_analyze_empty_boxes_returns_no_drafts(tmp_path):
    """模型输出为空时不产生块（与 y/x 兜底行为等价，验收 18 后半）。"""
    from kb.ocr.layout import PaddleOCRLayout

    class _FakeOutput:
        json = {"res": {"boxes": []}}

    class FakePipeline:
        def predict(self, _path):
            return [_FakeOutput()]

    src = tmp_path / "page.png"
    _write_test_page(src)
    layout = PaddleOCRLayout(blocks_dir=tmp_path / "blocks", pipeline=FakePipeline())
    assert layout.analyze("p1", str(src)) == []


@pytest.mark.skipif(os.environ.get("KB_RUN_SLOW") != "1", reason="需要真实模型，KB_RUN_SLOW=1 才跑")
def test_doclayoutv3_labels_covered_on_real_page(tmp_path):
    """真图跑 V3：输出 label 全部有映射（验收 19），ordinal 单调（验收 18）。"""
    from kb.ocr.layout import _LABEL_MAP, PaddleOCRLayout

    page = "../resources/2025秋7星学霸题中题数学4年级第7辑-第6页.png"
    layout = PaddleOCRLayout(blocks_dir=tmp_path / "blocks")
    drafts = layout.analyze("p0006", page)
    assert len(drafts) >= 5
    assert [d.ordinal for d in drafts] == list(range(1, len(drafts) + 1))
    for d in drafts:
        assert os.path.exists(d.crop_path)

    raw = layout._get_pipeline().predict(page)
    data = raw[0].json if hasattr(raw[0], "json") else {}
    labels = {b.get("label") for b in (data.get("res") or data).get("boxes", [])}
    unknown = {label for label in labels if (label or "").lower() not in _LABEL_MAP}
    assert not unknown, f"V3 出现未映射标签（会静默归 text）: {unknown}"


def test_label_map_covers_doclayout_v3_labelset():
    """_LABEL_MAP 显式覆盖 PP-DocLayoutV3 全部 25 个标签（spec §3.1，审核缺口）。"""
    from kb.ocr.layout import _LABEL_MAP

    v3_labels = {
        "abstract", "algorithm", "aside_text", "chart", "content",
        "display_formula", "doc_title", "figure_title", "footer",
        "footer_image", "footnote", "formula_number", "header",
        "header_image", "image", "inline_formula", "number",
        "paragraph_title", "reference", "reference_content", "seal",
        "table", "text", "vertical_text", "vision_footnote",
    }
    missing = v3_labels - set(_LABEL_MAP)
    assert not missing, f"V3 标签无显式映射（会静默归 text）: {missing}"
