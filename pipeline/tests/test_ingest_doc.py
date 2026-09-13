"""POST /internal/ingest-doc：资料库上传入库（md/docx/pdf 分流 + doc 级 parse_status 推进）。"""
import uuid

import pytest
from fastapi.testclient import TestClient

from kb.core.config import Config
from kb.internal_api import create_internal_app
from tests.test_md_ingest import _FakeEmbed


@pytest.fixture()
def cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="fake",
    )


def _preinsert(conn, source_path, title="测试书"):
    """模拟 backend 预插：上传落盘后 documents 行先以 pending 建档。"""
    doc_id = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (id, title, source_path, parse_status) VALUES (%s,%s,%s,'pending')",
            (doc_id, title, str(source_path)),
        )
    return doc_id


def _client(conn, cfg):
    return TestClient(
        create_internal_app(get_conn=lambda: conn, cfg=cfg, embed_client=_FakeEmbed()),
        raise_server_exceptions=False,
    )


class TestIngestDoc:
    def test_md_走通_chapters落库_状态推进到parsed(self, conn, cfg, tmp_path):
        md = tmp_path / "grammar.md"
        md.write_text(
            "# 一、修辞手法\n\n比喻句:本体是燕子。\n\n# 二、标点\n\n省略号表示语意未尽。\n",
            encoding="utf-8",
        )
        doc_id = _preinsert(conn, md.resolve(), title="语法讲义")
        r = _client(conn, cfg).post("/internal/ingest-doc", json={
            "source_path": str(md.resolve()), "title": "语法讲义",
            "subject": "语文", "doc_type": "workbook",
        })
        assert r.status_code == 200
        assert r.json() == {"doc_id": doc_id, "parse_status": "parsed"}
        with conn.cursor() as cur:
            cur.execute("SELECT parse_status FROM documents WHERE id=%s", (doc_id,))
            assert cur.fetchone()[0] == "parsed"
            cur.execute(
                "SELECT title FROM chapters WHERE document_id=%s ORDER BY chapter_no", (doc_id,))
            assert [row[0] for row in cur.fetchall()] == ["一、修辞手法", "二、标点"]
            # 入库即章节向量化（假 embed client）
            cur.execute("SELECT count(*) FROM chunks WHERE document_id=%s", (doc_id,))
            assert cur.fetchone()[0] > 0

    def test_source_path未建档_404(self, conn, cfg, tmp_path):
        r = _client(conn, cfg).post("/internal/ingest-doc", json={
            "source_path": str(tmp_path / "ghost.md"), "title": "不存在",
        })
        assert r.status_code == 404

    def test_不支持的扩展名_422(self, conn, cfg, tmp_path):
        doc_id = _preinsert(conn, (tmp_path / "a.txt").resolve())
        r = _client(conn, cfg).post("/internal/ingest-doc", json={
            "source_path": str((tmp_path / "a.txt").resolve()), "title": "t",
        })
        assert r.status_code == 422
        with conn.cursor() as cur:  # 未进入 parse，状态保持 pending
            cur.execute("SELECT parse_status FROM documents WHERE id=%s", (doc_id,))
            assert cur.fetchone()[0] == "pending"

    def test_入库异常_500_且状态置failed(self, conn, cfg, tmp_path):
        # 行已预插但源文件被删：ingest_md 读文件抛错
        doc_id = _preinsert(conn, (tmp_path / "gone.md").resolve())
        r = _client(conn, cfg).post("/internal/ingest-doc", json={
            "source_path": str((tmp_path / "gone.md").resolve()), "title": "t",
        })
        assert r.status_code == 500 and r.json()["detail"]
        with conn.cursor() as cur:
            cur.execute("SELECT parse_status FROM documents WHERE id=%s", (doc_id,))
            assert cur.fetchone()[0] == "failed"
