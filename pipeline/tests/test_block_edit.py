"""调框 preview/commit 与 recrop（验收 11 的 pipeline 侧）。"""
import uuid

import pymupdf as fitz
import pytest


@pytest.fixture()
def doc1(conn, tmp_path):
    cfg = _cfg(tmp_path)
    source = tmp_path / "a.pdf"
    document = fitz.open()
    document.new_page()
    document.save(source)
    from kb.ocr.render import render_document
    doc_id = render_document(conn, cfg, source, title="t")
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM pages WHERE document_id=%s", (doc_id,))
        (page_id,) = cur.fetchone()
        out_dir = cfg.storage_dir / doc_id / "blocks" / page_id
        out_dir.mkdir(parents=True, exist_ok=True)
        for ordinal, (bbox, text) in enumerate(
                [([100, 100, 500, 200], "上文"), ([100, 300, 500, 400], "中文")], start=1):
            crop = out_dir / f"b{ordinal - 1:03d}.png"
            crop.write_bytes(b"png")
            cur.execute(
                """INSERT INTO blocks (id, page_id, block_type, bbox, crop_path, content_md, ordinal)
                   VALUES (%s,%s,'text',%s,%s,%s,%s)""",
                (str(uuid.uuid4()), page_id, str(bbox),
                 f"{doc_id}/blocks/{page_id}/b{ordinal - 1:03d}.png", text, ordinal),
            )
    return doc_id, cfg


def _cfg(tmp_path):
    from kb.core.config import Config
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


def test_preview_crops_staging_and_recognizes_without_writing(doc1, conn):
    from kb.ocr.block_edit import preview_block_geometry

    _doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text, content_md FROM blocks ORDER BY ordinal LIMIT 1")
        block_id, old_text = cur.fetchone()
    output = preview_block_geometry(
        conn, cfg, block_id, [90, 95, 510, 210], ocr=lambda _path: "新识别文本")
    assert output["text"] == "新识别文本"
    assert output["source_model"] == "rapidocr"
    assert output["crop_pad"] == [6, 4]
    staging = cfg.storage_dir / output["staging"]
    assert staging.exists() and "staging_" in staging.name
    image = fitz.Pixmap(str(staging))
    assert (image.width, image.height) == (432, 123)
    with conn.cursor() as cur:
        cur.execute("SELECT content_md, geometry_revision FROM blocks WHERE id=%s", (block_id,))
        assert cur.fetchone() == (old_text, 1)


def test_preview_uses_configured_vlm_client_for_figure(doc1, conn, monkeypatch):
    from kb.ocr import block_edit, parse

    _doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute(
            """UPDATE blocks SET block_type='figure' WHERE id=(
                   SELECT id FROM blocks ORDER BY ordinal LIMIT 1)
               RETURNING id::text""")
        row = cur.fetchone()
        (block_id,) = row

    class FakeOpenAI:
        def __init__(self, base_url, api_key):
            assert base_url == cfg.vision_base_url
            assert api_key == cfg.vision_api_key

    monkeypatch.setattr(parse, "OpenAI", FakeOpenAI)

    def fake_transcribe(client, model, image_path):
        assert isinstance(client, FakeOpenAI)
        assert model == cfg.vision_model
        return "新识别文本", (None, None)

    monkeypatch.setattr(block_edit, "transcribe_image", fake_transcribe)

    output = block_edit.preview_block_geometry(conn, cfg, block_id, [90, 95, 510, 210])
    assert output["text"] == "新识别文本"
    assert output["source_model"] == cfg.vision_model


def test_commit_applies_geometry_and_marks_stale(doc1, conn):
    from kb.ocr.block_edit import commit_block_geometry, preview_block_geometry

    doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM blocks ORDER BY ordinal LIMIT 1")
        (block_id,) = cur.fetchone()
        cur.execute(
            "INSERT INTO items (document_id, content_type, content_md) VALUES (%s,'exercise','题') RETURNING id::text",
            (doc_id,),
        )
        (item_id,) = cur.fetchone()
        cur.execute(
            "INSERT INTO chunks (document_id, item_id, content_md, embedding, source_block_ids)"
            " VALUES (%s,%s,'题',%s,ARRAY[%s::uuid])",
            (doc_id, item_id, [1.0] * 1024, block_id),
        )
    preview = preview_block_geometry(
        conn, cfg, block_id, [90, 95, 510, 210], ocr=lambda _path: "新识别文本")
    output = commit_block_geometry(
        conn, cfg, block_id, [90, 95, 510, 210], preview["staging"], "新识别文本", "rapidocr")
    assert output["ok"] is True
    with conn.cursor() as cur:
        cur.execute(
            "SELECT bbox, crop_pad, content_md, geometry_revision FROM blocks WHERE id=%s",
            (block_id,))
        bbox, crop_pad, content_md, revision = cur.fetchone()
        assert bbox == [90, 95, 510, 210]
        assert crop_pad == [6, 4]
        assert content_md == "新识别文本"
        assert revision == 2
        cur.execute("SELECT state FROM chunks WHERE item_id=%s", (item_id,))
        assert cur.fetchone()[0] == "stale"
        cur.execute(
            "SELECT 1 FROM pipeline_events WHERE stage='user_edit' AND event_type='block_geometry'")
        assert cur.fetchone() is not None
    assert not (cfg.storage_dir / preview["staging"]).exists()


def test_commit_moves_crop_inside_transaction(doc1, conn, monkeypatch):
    from kb.ocr import block_edit
    from psycopg.pq import TransactionStatus

    _doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM blocks ORDER BY ordinal LIMIT 1")
        (block_id,) = cur.fetchone()
    preview = block_edit.preview_block_geometry(
        conn, cfg, block_id, [90, 95, 510, 210], ocr=lambda _path: "新识别文本")
    transaction_statuses = []
    original_move = block_edit.shutil.move

    def observe_move(source, destination, *args, **kwargs):
        transaction_statuses.append(conn.info.transaction_status)
        return original_move(source, destination, *args, **kwargs)

    monkeypatch.setattr(block_edit.shutil, "move", observe_move)
    block_edit.commit_block_geometry(
        conn, cfg, block_id, [90, 95, 510, 210], preview["staging"],
        "新识别文本", "rapidocr")
    assert transaction_statuses == [TransactionStatus.INTRANS]


def test_commit_normalizes_adopted_latex(doc1, conn):
    """commit 落库前过 normalize_latex：adopted_text 含 KaTeX 不支持的命令也要归一化
    （否则调框确认后的 LaTeX 如 \\begin{array}{r@{\\quad}l} 在前端渲染不出来）。"""
    from kb.ocr.block_edit import commit_block_geometry, preview_block_geometry

    _doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM blocks ORDER BY ordinal LIMIT 1")
        (block_id,) = cur.fetchone()
    preview = preview_block_geometry(
        conn, cfg, block_id, [90, 95, 510, 210], ocr=lambda _p: "新识别文本")
    commit_block_geometry(
        conn, cfg, block_id, [90, 95, 510, 210], preview["staging"],
        "$$\\begin{array}{r@{\\quad}l} 1 \\end{array}$$ 与 \\cline{1-2}", "qwen3:4b")
    with conn.cursor() as cur:
        cur.execute("SELECT content_md FROM blocks WHERE id=%s", (block_id,))
        stored = cur.fetchone()[0]
    assert "@{" not in stored
    assert "\\cline" not in stored
    assert "\\hline" in stored


def test_recrop_uses_neighbor_clamp(doc1, conn):
    from kb.ocr.block_edit import recrop_block

    _doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM blocks ORDER BY ordinal LIMIT 1")
        (block_id,) = cur.fetchone()
    output = recrop_block(conn, cfg, block_id)
    assert output["crop_pad"] == [6, 4]
    with conn.cursor() as cur:
        cur.execute("SELECT crop_pad FROM blocks WHERE id=%s", (block_id,))
        assert cur.fetchone()[0] == [6, 4]


def test_preview_escalates_mathy_ocr_to_vlm(doc1, conn, monkeypatch):
    """调框重识别：OCR 文本疑似公式（等式/丢上标）必须升级 VLM（公式一律 LaTeX），
    且输出过 normalize_latex 归一化。"""
    from kb.ocr import block_edit

    _doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM blocks ORDER BY ordinal LIMIT 1")
        (block_id,) = cur.fetchone()

    def fake_transcribe(client, model, image_path):
        assert model == cfg.vision_model
        return "$$\\begin{array}{r}24+37\\\\\\cline{1-2}61\\end{array}$$", (None, None)

    monkeypatch.setattr(block_edit, "transcribe_image", fake_transcribe)
    output = block_edit.preview_block_geometry(
        conn, cfg, block_id, [90, 95, 510, 210], ocr=lambda _p: "24+37=61")
    assert output["source_model"] == cfg.vision_model
    assert "\\hline" in output["text"]  # cline 被归一化
    assert "\\cline" not in output["text"]


def test_preview_escalates_empty_ocr_to_vlm(doc1, conn, monkeypatch):
    """调框重识别：OCR 空结果升级 VLM（与 run_parse 同口径）。"""
    from kb.ocr import block_edit

    _doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM blocks ORDER BY ordinal LIMIT 1")
        (block_id,) = cur.fetchone()
    monkeypatch.setattr(
        block_edit, "transcribe_image",
        lambda client, model, image_path: ("VLM 补救内容", (None, None)))
    output = block_edit.preview_block_geometry(
        conn, cfg, block_id, [90, 95, 510, 210], ocr=lambda _p: "  ")
    assert output["source_model"] == cfg.vision_model
    assert output["text"] == "VLM 补救内容"


def test_preview_plain_prose_stays_on_rapidocr(doc1, conn, monkeypatch):
    """普通行文不升级 VLM（不浪费模型调用）。"""
    from kb.ocr import block_edit

    _doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM blocks ORDER BY ordinal LIMIT 1")
        (block_id,) = cur.fetchone()

    def boom(*_args, **_kwargs):
        raise AssertionError("不应调用 VLM")

    monkeypatch.setattr(block_edit, "transcribe_image", boom)
    output = block_edit.preview_block_geometry(
        conn, cfg, block_id, [90, 95, 510, 210], ocr=lambda _p: "第 2 课 课文朗读")
    assert output["source_model"] == "rapidocr"
    assert output["text"] == "第 2 课 课文朗读"


def test_create_block_manual_origin_and_ordinal(doc1, conn):
    from kb.ocr.block_edit import create_block

    doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM pages WHERE document_id=%s", (doc_id,))
        (page_id,) = cur.fetchone()
    output = create_block(conn, cfg, page_id, [100, 220, 500, 280], "text",
                          ocr=lambda _path: "补画内容")
    assert output["block"]["origin"] == "manual"
    assert output["block"]["content_md"] == "补画内容"
    assert output["block"]["ordinal"] == 2
    with conn.cursor() as cur:
        cur.execute(
            "SELECT ordinal, origin FROM blocks WHERE page_id=%s ORDER BY ordinal", (page_id,))
        rows = cur.fetchall()
    assert [(row[0], row[1]) for row in rows] == [(1, "layout"), (2, "manual"), (3, "layout")]
    crop_path = output["block"]["crop_path"]
    assert (cfg.storage_dir / crop_path).exists()
    assert f"/blocks/{page_id}/b-" in crop_path
    with conn.cursor() as cur:
        cur.execute("SELECT crop_pad FROM blocks WHERE id=%s", (output["block"]["id"],))
        assert cur.fetchone()[0] == output["block"]["crop_pad"]
