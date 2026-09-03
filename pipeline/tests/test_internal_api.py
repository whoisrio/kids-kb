"""内部服务：/internal/rerank 供 TS 双路召回调用（本地重排模型权重的唯一出口）。"""
import pytest
from fastapi.testclient import TestClient

from kb.internal_api import create_internal_app


class _FakeReranker:
    def compute_score(self, pairs):
        return [float(len(q) + len(d)) for q, d in pairs]  # 可预测的假分数


@pytest.fixture()
def client():
    return TestClient(create_internal_app(reranker_factory=lambda: _FakeReranker()))


def test_rerank_returns_scores(client):
    resp = client.post("/internal/rerank",
                       json={"query": "ab", "docs": ["x", "xyz"]})
    assert resp.status_code == 200
    assert resp.json()["scores"] == [3.0, 5.0]


def test_rerank_empty_docs(client):
    resp = client.post("/internal/rerank", json={"query": "q", "docs": []})
    assert resp.status_code == 200 and resp.json()["scores"] == []


def test_rerank_503_when_model_unavailable():
    """未装 rerank 依赖时返回 503（TS 侧据此降级为不重排）。"""
    app = create_internal_app(
        reranker_factory=lambda: (_ for _ in ()).throw(ImportError("no FlagEmbedding")))
    resp = TestClient(app).post("/internal/rerank", json={"query": "q", "docs": ["d"]})
    assert resp.status_code == 503


@pytest.fixture()
def child(conn):
    import uuid
    cid = str(uuid.uuid4())
    with conn.cursor() as cur:
        cur.execute("INSERT INTO children (id, name) VALUES (%s,%s)", (cid, "小宝"))
    return cid


@pytest.fixture()
def cfg(tmp_path):
    from kb.config import Config
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="fake",
    )


class TestPaperEndpoints:
    def test_ingest_paper_收文件_全量替换_重复调用幂等(self, conn, child, cfg, tmp_path):
        """conn fixture 见 tests/conftest.py;helper(FakeVLM/_paper/_vlm_json)从 test_paper_pipeline 导入。"""
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        from tests.test_paper_pipeline import FakeVLM, _paper, _vlm_json

        pid = _paper(conn, child)
        app = create_internal_app(get_conn=lambda: conn, cfg=cfg, vlm_client=FakeVLM([
            _vlm_json([{"content_md": "题1", "bbox": None}]),
            _vlm_json([{"content_md": "题1", "bbox": None}]),  # 第二次调用(幂等重跑)
        ]))
        client = TestClient(app)
        import pymupdf as fitz
        doc = fitz.open(); doc.new_page()
        pdf_bytes = doc.tobytes()
        r = client.post(f"/internal/ingest-paper?paper_id={pid}",
                        files={"file": ("source.pdf", pdf_bytes, "application/pdf")})
        assert r.status_code == 200 and r.json() == {"pages": 1, "questions": 1}
        # 重驱动(不带文件)
        r2 = client.post(f"/internal/ingest-paper?paper_id={pid}")
        assert r2.status_code == 200
        n = conn.execute("SELECT count(*) FROM paper_questions WHERE paper_id=%s", (pid,)).fetchone()[0]
        assert n == 1

    def test_ingest_paper_卷不存在_500_detail(self, conn, cfg):
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        # 服务器端抛异常返回 500，需关闭 raise_server_exceptions 才能断言到状态码
        client = TestClient(create_internal_app(get_conn=lambda: conn, cfg=cfg),
                            raise_server_exceptions=False)
        r = client.post("/internal/ingest-paper?paper_id=00000000-0000-0000-0000-000000000000",
                        files={"file": ("s.pdf", b"not a pdf", "application/pdf")})
        assert r.status_code == 500

    def test_recognize_page(self, conn, child, cfg):
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        from tests.test_paper_pipeline import FakeVLM, _paper, _vlm_json

        pid = _paper(conn, child)
        # 先 ingest 一页一题
        app = create_internal_app(get_conn=lambda: conn, cfg=cfg, vlm_client=FakeVLM([
            _vlm_json([{"content_md": "旧", "bbox": None}]),
            _vlm_json([{"content_md": "新", "bbox": None}]),
        ]))
        client = TestClient(app)
        import pymupdf as fitz
        doc = fitz.open(); doc.new_page()
        client.post(f"/internal/ingest-paper?paper_id={pid}",
                    files={"file": ("s.pdf", doc.tobytes(), "application/pdf")})
        r = client.post("/internal/recognize-page",
                        json={"paper_id": pid, "page_no": 1})
        assert r.status_code == 200 and r.json() == {"pages": 1, "questions": 1}
        md = conn.execute(
            "SELECT content_md FROM paper_questions WHERE paper_id=%s", (pid,)).fetchone()[0]
        assert md == "新"
