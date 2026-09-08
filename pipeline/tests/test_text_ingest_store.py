"""文本入库落库契约：空章节不得入库，既有空章可被重新解析补齐。"""
from contextlib import contextmanager

import pytest

from kb.config import Config


class RecordingCursor:
    def __init__(self, calls):
        self.calls = calls

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        return False


class RecordingConn:
    def __init__(self):
        self.calls = []

    def cursor(self):
        return RecordingCursor(self.calls)


@pytest.fixture()
def cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


def test_store_document_chapters_upserts_existing_empty_chapter(cfg, monkeypatch):
    from kb.text_ingest import store_document_chapters

    monkeypatch.setattr("kb.text_ingest.export_chapter_mds", lambda *_: 1)
    monkeypatch.setattr("kb.embed.embed_chapters", lambda *_args, **_kwargs: 1)
    conn = RecordingConn()
    doc_id = store_document_chapters(
        conn, cfg, "/tmp/source.docx", "语法二阶", "英语", None, "exam",
        [("语法二阶", "一、单项选择\n( ) 1. The dog is ___ now.")],
        doc_id="doc1", client="embed",
    )

    assert doc_id == "doc1"
    chapter_sql, chapter_params = next(
        (sql, params) for sql, params in conn.calls
        if "INSERT INTO chapters" in sql
    )
    assert "ON CONFLICT (document_id, chapter_no) DO UPDATE" in chapter_sql
    assert chapter_params[-1] == "一、单项选择\n( ) 1. The dog is ___ now."


def test_store_document_chapters_rejects_empty_chapters(cfg, monkeypatch):
    from kb.text_ingest import store_document_chapters

    monkeypatch.setattr("kb.text_ingest.export_chapter_mds", lambda *_: 0)
    conn = RecordingConn()
    with pytest.raises(ValueError, match="文档没有可入库内容"):
        store_document_chapters(
            conn, cfg, "/tmp/source.docx", "语法二阶", "英语", None, "exam",
            [("语法二阶", "   ")], doc_id="doc1",
        )
    assert not conn.calls
