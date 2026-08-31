import pytest
import pymupdf as fitz
from fastapi.testclient import TestClient

from kb.review_api import create_app


@pytest.fixture()
def client(conn):
    return TestClient(create_app(lambda: conn))


@pytest.fixture()
def seeded(conn, tmp_path):
    """1 本书 1 页 1 块（含真实渲染图）+ 2 条待复核记录。返回 (block_id, r_empty, r_trunc)。"""
    from kb.config import Config
    from kb.layout import run_layout
    from kb.render import render_document

    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    p = tmp_path / "s.pdf"
    d = fitz.open()
    d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="测试书")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET status='parsed'")
        cur.execute("UPDATE blocks SET content_md='第一页内容'")
        cur.execute("SELECT id FROM blocks")
        block_id = str(cur.fetchone()[0])
        ids = []
        for reason in ("empty", "maybe_truncated"):
            cur.execute(
                "INSERT INTO review_queue (block_id, reason) VALUES (%s,%s) RETURNING id",
                (block_id, reason),
            )
            ids.append(str(cur.fetchone()[0]))
    return (block_id, *ids)


def test_list_pending_reviews(client, seeded):
    _block, _r1, _r2 = seeded
    resp = client.get("/api/review")
    assert resp.status_code == 200
    data = resp.json()
    assert data["counts"] == {"pending": 2, "approved": 0, "rejected": 0}
    items = data["items"]
    assert len(items) == 2
    it = items[0]
    assert it["doc_title"] == "测试书"
    assert it["page_no"] == 1
    assert it["content_md"] == "第一页内容"
    assert it["block_id"]
    assert it["reason"] in ("empty", "maybe_truncated")
    assert it["status"] == "pending"


def test_approve_updates_status(client, seeded, conn):
    _block, r_empty, _r2 = seeded
    resp = client.post(f"/api/review/{r_empty}/approve")
    assert resp.status_code == 200
    assert resp.json() == {"id": r_empty, "status": "approved"}
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue WHERE id=%s", (r_empty,))
        assert cur.fetchone()[0] == "approved"
    # 默认 pending 列表不再包含它
    assert all(i["id"] != r_empty for i in client.get("/api/review").json()["items"])


def test_reject_updates_status_and_filter(client, seeded, conn):
    _block, _r1, r_trunc = seeded
    resp = client.post(f"/api/review/{r_trunc}/reject")
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"
    rejected = client.get("/api/review?status=rejected").json()["items"]
    assert [i["id"] for i in rejected] == [r_trunc]


def test_act_on_missing_review_returns_404(client):
    resp = client.post("/api/review/00000000-0000-0000-0000-000000000000/approve")
    assert resp.status_code == 404


def test_crop_image_served(client, seeded):
    block_id, _r1, _r2 = seeded
    resp = client.get(f"/api/blocks/{block_id}/crop")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/png")
    assert resp.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_index_serves_review_page(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    assert "复核" in resp.text
