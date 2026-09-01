"""条目级复核 API：items 列表/详情（含溯源块裁图）/编辑/通过与打回。"""
import uuid

import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient

from kb.review_api import create_app


@pytest.fixture()
def client(conn):
    return TestClient(create_app(lambda: conn))


@pytest.fixture()
def doc_with_items(conn, tmp_path):
    """1 本书 1 页 1 块 + 2 条 item（例1 引用该块为 stem）。"""
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
    doc_id = render_document(conn, cfg, p, title="7星学霸")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET status='parsed'")
        cur.execute("UPDATE blocks SET content_md='块内容' RETURNING id")
        block_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md, chapter)
               VALUES (%s,%s,'example','例1','**例1** 竖式题干','第 1 讲 乘除法竖式谜') RETURNING id""",
            (str(uuid.uuid4()), doc_id),
        )
        item_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO item_blocks (item_id, block_id, role) VALUES (%s,%s,'stem')",
            (item_id, block_id),
        )
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md, chapter)
               VALUES (%s,%s,'exercise','1-1','**1-1** 练习题','第 1 讲 乘除法竖式谜')""",
            (str(uuid.uuid4()), doc_id),
        )
    return doc_id, item_id


def test_list_items_grouped_by_chapter(client, doc_with_items):
    doc_id, _item = doc_with_items
    data = client.get(f"/api/items?doc_id={doc_id}").json()
    assert len(data["items"]) == 2
    it = data["items"][0]
    assert it["chapter"] == "第 1 讲 乘除法竖式谜"
    assert it["label"] == "例1"
    assert it["content_type"] == "example"
    assert it["qc_status"] == "pending"


def test_item_detail_with_source_blocks(client, doc_with_items):
    _doc_id, item_id = doc_with_items
    data = client.get(f"/api/items/{item_id}").json()
    assert data["label"] == "例1"
    assert data["content_md"].startswith("**例1**")
    assert len(data["blocks"]) == 1  # 溯源块：裁图给前端展示
    assert data["blocks"][0]["role"] == "stem"
    assert data["blocks"][0]["content_md"] == "块内容"


def test_patch_item_content(client, doc_with_items, conn):
    _doc_id, item_id = doc_with_items
    resp = client.patch(f"/api/items/{item_id}", json={"content_md": "**例1** 人工修正"})
    assert resp.status_code == 200
    with conn.cursor() as cur:
        cur.execute("SELECT content_md FROM items WHERE id=%s", (item_id,))
        assert cur.fetchone()[0] == "**例1** 人工修正"


def test_approve_item_sets_qc_status(client, doc_with_items, conn):
    """人工确认 -> qc_status=approved（向量化门禁用）。"""
    _doc_id, item_id = doc_with_items
    assert client.post(f"/api/items/{item_id}/approve").status_code == 200
    with conn.cursor() as cur:
        cur.execute("SELECT qc_status FROM items WHERE id=%s", (item_id,))
        assert cur.fetchone()[0] == "approved"


def test_reject_item_creates_item_level_row(client, doc_with_items, conn):
    _doc_id, item_id = doc_with_items
    resp = client.post(f"/api/items/{item_id}/reject", json={"reason": "串章：混入第 2 讲内容"})
    assert resp.status_code == 200
    with conn.cursor() as cur:
        cur.execute(
            "SELECT reason, item_id, block_id FROM review_queue WHERE status='pending'")
        reason, rid, bid = cur.fetchone()
    assert reason == "串章：混入第 2 讲内容"
    assert str(rid) == item_id and bid is None  # item 级行不锚定块


def test_pending_items_endpoint(client, doc_with_items, conn):
    """待复核条目 = qc_status 待确认或有 pending 复核行；返回 content_md 供 markdown 呈现。"""
    doc_id, item_id = doc_with_items
    items = client.get("/api/items?status=pending").json()["items"]
    assert len(items) == 2  # fixture 两条 qc_status 都是 pending
    assert items[0]["content_md"].startswith("**例1**")
    client.post(f"/api/items/{item_id}/reject", json={"reason": "串章"})
    items = client.get("/api/items?status=pending").json()["items"]
    assert next(i for i in items if i["id"] == item_id)["pending_reasons"] == ["串章"]
    # 全部确认后待复核条目清零（有打回行的除外——上面那条 reject 已被 approve 连带关闭）
    client.post(f"/api/items/{item_id}/approve")
    items = client.get("/api/items?status=pending").json()["items"]
    assert [i["label"] for i in items] == ["1-1"]
