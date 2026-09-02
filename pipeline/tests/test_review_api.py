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


def test_patch_block_content_updates_db(client, seeded, conn):
    block_id, r_empty, r_trunc = seeded
    resp = client.patch(f"/api/blocks/{block_id}", json={"content_md": "修正后的转录。"})
    assert resp.status_code == 200
    # 编辑没引入新问题 -> 不建行；seeded 的两条失效行（empty/maybe_truncated）被自动关闭
    assert resp.json() == {"id": block_id, "content_md": "修正后的转录。", "new_reviews": 0}
    with conn.cursor() as cur:
        cur.execute("SELECT content_md FROM blocks WHERE id=%s", (block_id,))
        assert cur.fetchone()[0] == "修正后的转录。"
        cur.execute("SELECT status FROM review_queue WHERE id IN (%s,%s)", (r_empty, r_trunc))
        assert {r[0] for r in cur.fetchall()} == {"approved"}


def test_patch_auto_resolves_empty_review(client, seeded, conn):
    block_id, _r1, _r2 = seeded
    with conn.cursor() as cur:  # 再加一条 empty 行（内容置空，模拟真实的空转录遗留）
        cur.execute("UPDATE blocks SET content_md='' WHERE id=%s", (block_id,))
        cur.execute("INSERT INTO review_queue (block_id, reason) VALUES (%s,'empty')", (block_id,))
    resp = client.patch(f"/api/blocks/{block_id}", json={"content_md": "人工修复的内容。"})
    assert resp.json()["new_reviews"] == 0
    with conn.cursor() as cur:  # 修复后三条失效行全部自动关闭
        cur.execute("SELECT status FROM review_queue WHERE block_id=%s", (block_id,))
        assert {r[0] for r in cur.fetchall()} == {"approved"}


def test_patch_keeps_custom_reason_review(client, seeded, conn):
    block_id, _r1, _r2 = seeded
    with conn.cursor() as cur:
        cur.execute("INSERT INTO review_queue (block_id, reason) VALUES (%s,'幻觉前缀')", (block_id,))
    resp = client.patch(f"/api/blocks/{block_id}", json={"content_md": "改了别的段落，幻觉还在。"})
    # seeded 的 empty/maybe_truncated 两条失效行被关闭；自定义原因行必须人工显式处理
    assert resp.json()["new_reviews"] == 0
    with conn.cursor() as cur:
        cur.execute("SELECT status FROM review_queue WHERE reason='幻觉前缀'")
        assert cur.fetchone()[0] == "pending"  # 自定义原因必须人工显式处理


def test_patch_creates_row_when_edit_introduces_issue(client, seeded, conn):
    """已通过的页面人工改坏了也要能被发现：编辑引入截断 -> 新建 maybe_truncated 行。"""
    block_id, _r1, _r2 = seeded
    with conn.cursor() as cur:  # 清掉 seeded 行，模拟该块当前零问题的"已通过"状态
        cur.execute("DELETE FROM review_queue WHERE block_id=%s", (block_id,))
    resp = client.patch(f"/api/blocks/{block_id}", json={"content_md": "这句没说完，"})
    assert resp.status_code == 200
    assert resp.json()["new_reviews"] == 1
    with conn.cursor() as cur:
        cur.execute(
            "SELECT reason FROM review_queue WHERE block_id=%s AND status='pending'", (block_id,))
        assert cur.fetchall() == [("maybe_truncated",)]


def test_patch_missing_block_404(client):
    resp = client.patch("/api/blocks/00000000-0000-0000-0000-000000000000",
                        json={"content_md": "x"})
    assert resp.status_code == 404


def test_patch_invalid_body_422(client, seeded):
    block_id, _r1, _r2 = seeded
    assert client.patch(f"/api/blocks/{block_id}", json={}).status_code == 422


def test_list_reviews_includes_blockless_rows(client, conn):
    """missing_item 这类无块复核行也要能列出（LEFT JOIN）。"""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO review_queue (reason) VALUES ('missing_item:第 1 讲 第2题')"
        )
    data = client.get("/api/review").json()
    assert data["counts"]["pending"] == 1
    it = data["items"][0]
    assert it["reason"] == "missing_item:第 1 讲 第2题"
    assert it["block_id"] is None and it["content_md"] is None
