"""内部服务：/internal/rerank 供 TS 双路召回调用（本地重排模型权重的唯一出口）。"""
import pytest
from fastapi.testclient import TestClient

from kb.db import connect
from kb.internal_api import create_internal_app
from tests.test_flat import _FakeEmbed, flat_doc


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
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg, vlm_client=FakeVLM([
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

    def test_ingest_paper_500_detail_透传真实原因(self, conn, cfg, monkeypatch):
        """服务器端抛异常 → HTTPException(500, detail=str(e))，detail 可排查而非 "Internal Server Error"。"""
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        import kb.paper_pipeline as pp

        def boom(*a, **kw):
            raise RuntimeError("磁盘写满: /dev/sdb1")

        monkeypatch.setattr(pp, "ingest_paper", boom)
        client = TestClient(create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg),
                            raise_server_exceptions=False)
        r = client.post("/internal/ingest-paper?paper_id=00000000-0000-0000-0000-000000000000")
        assert r.status_code == 500
        assert r.json()["detail"] == "磁盘写满: /dev/sdb1"

    def test_ingest_paper_卷不存在_500_detail(self, conn, cfg):
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        # 服务器端抛异常返回 500 + 真实 detail，需关闭 raise_server_exceptions 才能断言到状态码
        client = TestClient(create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg),
                            raise_server_exceptions=False)
        r = client.post("/internal/ingest-paper?paper_id=00000000-0000-0000-0000-000000000000",
                        files={"file": ("s.pdf", b"not a pdf", "application/pdf")})
        assert r.status_code == 500
        body = r.json()
        assert isinstance(body.get("detail"), str) and body["detail"]

    def test_recognize_page(self, conn, child, cfg):
        from fastapi.testclient import TestClient
        from kb.internal_api import create_internal_app
        from tests.test_paper_pipeline import FakeVLM, _paper, _vlm_json

        pid = _paper(conn, child)
        # 先 ingest 一页一题
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg, vlm_client=FakeVLM([
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


class TestEmbedFlatPage:
    def test_rebuild_one_specified_page(self, conn, flat_doc):
        from kb.flat import build_flat_chapter

        doc_id, cfg = flat_doc
        build_flat_chapter(conn, doc_id)
        client = TestClient(create_internal_app(
            get_conn=lambda: conn, cfg=cfg, embed_client=_FakeEmbed()))
        resp = client.post("/internal/embed-flat-page",
                           json={"doc_id": doc_id, "page_no": 1})
        assert resp.status_code == 200
        assert resp.json() == {"chunks": 1}
        with conn.cursor() as cur:
            cur.execute(
                "SELECT meta->>'page_no' FROM chunks WHERE chapter_id IS NOT NULL"
            )
            rows = cur.fetchall()
        assert [row[0] for row in rows] == ["1"]

    def test_missing_flat_chapter_returns_500(self, conn, flat_doc):
        doc_id, cfg = flat_doc
        client = TestClient(create_internal_app(
            get_conn=lambda: conn, cfg=cfg), raise_server_exceptions=False)
        resp = client.post("/internal/embed-flat-page",
                           json={"doc_id": doc_id, "page_no": 1})
        assert resp.status_code == 500
        assert "flat" in resp.json()["detail"]


class _ConnSpy:
    """包裹真连接,数 close 调用次数。"""

    def __init__(self, inner):
        self.inner = inner
        self.closed = 0

    def close(self):
        self.closed += 1
        self.inner.close()

    def __getattr__(self, name):
        return getattr(self.inner, name)


def test_endpoints_close_connection(conn, cfg):
    """ingest-paper 端点用后即关(不再靠 GC);失败路径也关。"""
    from kb.db import connect
    from kb.config import Config as C
    from kb.internal_api import create_internal_app

    spy_holder = []

    def get_conn():
        c = _ConnSpy(connect(cfg.database_url))
        spy_holder.append(c)
        return c

    real_cfg = C(database_url=cfg.database_url, storage_dir=cfg.storage_dir,
                 vision_base_url="http://localhost:11434/v1",
                 vision_api_key="ollama", vision_model="qwen3:4b")
    app = create_internal_app(get_conn=get_conn, cfg=real_cfg)
    c = TestClient(app)
    # 不存在的卷 -> 500,但连接照样要关
    resp = c.post("/internal/ingest-paper?paper_id=00000000-0000-0000-0000-000000000000")
    assert resp.status_code >= 400
    assert spy_holder[-1].closed == 1
