import fitz
import pytest

from kb.config import Config
from kb.render import detect_text_layer, render_document


@pytest.fixture()
def cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


@pytest.fixture()
def text_pdf(tmp_path):
    p = tmp_path / "text.pdf"
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "你好，世界")
    doc.save(p)
    return p


@pytest.fixture()
def scanned_pdf(tmp_path):
    p = tmp_path / "scan.pdf"
    doc = fitz.open()
    doc.new_page()
    doc.new_page()
    doc.save(p)
    return p


def test_detect_text_layer(text_pdf, scanned_pdf):
    assert detect_text_layer(fitz.open(text_pdf)) is True
    assert detect_text_layer(fitz.open(scanned_pdf)) is False


def test_render_document_creates_rows_and_images(conn, cfg, scanned_pdf):
    doc_id = render_document(conn, cfg, scanned_pdf, title="测试卷", doc_type="exam")
    with conn.cursor() as cur:
        cur.execute("SELECT page_count, has_text_layer FROM documents WHERE id=%s", (doc_id,))
        page_count, has_tl = cur.fetchone()
        assert (page_count, has_tl) == (2, False)
        cur.execute("SELECT page_no, image_path, status FROM pages ORDER BY page_no")
        rows = cur.fetchall()
    assert [r[0] for r in rows] == [1, 2]
    assert all(r[2] == "rendered" for r in rows)
    for _, img, _ in rows:
        assert (cfg.storage_dir.parent / img).exists()


def test_render_document_is_idempotent(conn, cfg, scanned_pdf):
    id1 = render_document(conn, cfg, scanned_pdf, title="测试卷", doc_type="exam")
    id2 = render_document(conn, cfg, scanned_pdf, title="测试卷", doc_type="exam")
    assert id1 == id2
    with conn.cursor() as cur:
        cur.execute("SELECT count(*) FROM pages WHERE document_id=%s", (id1,))
        assert cur.fetchone()[0] == 2
