"""页级复核 API：pending/approved 页列表、页详情（块+bbox+复核行）、页图、页打回。"""
import uuid

import pymupdf as fitz
import pytest
from fastapi.testclient import TestClient

from kb.review_api import create_app


@pytest.fixture()
def client(conn):
    return TestClient(create_app(lambda: conn))


@pytest.fixture()
def doc2(conn, tmp_path):
    """2 页文档：第 1 页有 pending 复核行，第 2 页干净（应进已通过）。"""
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
    for _ in range(2):
        d.new_page()
    d.save(p)
    doc_id = render_document(conn, cfg, p, title="测试书")
    run_layout(conn, doc_id)
    with conn.cursor() as cur:
        cur.execute("UPDATE pages SET status='parsed'")
        cur.execute("UPDATE blocks SET content_md='内容'")
        cur.execute(
            """INSERT INTO review_queue (block_id, reason)
               SELECT b.id, 'empty' FROM blocks b
               JOIN pages p ON p.id=b.page_id WHERE p.page_no=1"""
        )
    return doc_id


def test_pages_split_by_derived_status(client, doc2):
    """页状态由复核行推导：有 pending 行 -> 待复核；干净 parsed 页 -> 已通过。"""
    resp = client.get("/api/pages?status=pending")
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) == 1 and items[0]["page_no"] == 1
    assert items[0]["pending_reasons"] == ["empty"]

    approved = client.get("/api/pages?status=approved").json()["items"]
    assert len(approved) == 1 and approved[0]["page_no"] == 2


def test_page_detail_blocks_and_rows(client, doc2, conn):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM pages WHERE page_no=1")
        page_id = str(cur.fetchone()[0])
    data = client.get(f"/api/pages/{page_id}").json()
    assert data["page_no"] == 1
    assert data["doc_title"] == "测试书"
    assert data["width"] > 0 and data["height"] > 0  # 前端 overlay 需要页图尺寸
    assert len(data["blocks"]) == 1
    assert data["blocks"][0]["content_md"] == "内容"
    assert "source_model" in data["blocks"][0]  # 解析来源透出给前端
    assert "prompt_tokens" in data["blocks"][0]
    assert len(data["reviews"]) == 1
    assert data["reviews"][0]["reason"] == "empty"


def test_page_detail_includes_covering_items(client, doc2, conn):
    """页详情带落在该页的条目（按 item_blocks 溯源关联），供"区块/整理后"切换呈现。"""
    with conn.cursor() as cur:
        cur.execute("SELECT document_id, id FROM pages WHERE page_no=1")
        doc_id, page_id = cur.fetchone()
        cur.execute("SELECT id FROM blocks WHERE page_id=%s", (page_id,))
        block_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md,
                                  chapter, page_start, page_end)
               VALUES (%s,%s,'example','例1','**例1** 整理后内容','第 1 讲',1,2)
               RETURNING id""",
            (str(uuid.uuid4()), doc_id),
        )
        item_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO item_blocks (item_id, block_id, role) VALUES (%s,%s,'stem')",
            (item_id, block_id),
        )
        # 例9 章范围覆盖第 1 页但无块落在该页 -> 不应出现
        cur.execute(
            """INSERT INTO items (id, document_id, content_type, label, content_md, page_start, page_end)
               VALUES (%s,%s,'example','例9','别的章',1,2)""",
            (str(uuid.uuid4()), doc_id),
        )
    data = client.get(f"/api/pages/{page_id}").json()
    assert [i["label"] for i in data["items"]] == ["例1"]
    assert data["items"][0]["content_md"].startswith("**例1**")
    assert data["items"][0]["pages"] == [1]  # 条目实际覆盖的页（跨页标识用）
    with conn.cursor() as cur:  # 例1 再加一个第 2 页的块 -> 跨页 [1,2]
        cur.execute("SELECT id FROM pages WHERE page_no=2")
        page2 = str(cur.fetchone()[0])
        cur.execute("SELECT id FROM blocks WHERE page_id=%s", (page2,))
        b2 = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO item_blocks (item_id, block_id, role) VALUES (%s,%s,'solution')",
            (item_id, b2),
        )
    data = client.get(f"/api/pages/{page_id}").json()
    assert data["items"][0]["pages"] == [1, 2]
    data2 = client.get(f"/api/pages/{page2}").json()
    assert [i["label"] for i in data2["items"]] == ["例1"]  # 跨页条目也出现在第 2 页


def test_page_image_served(client, doc2, conn):
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM pages WHERE page_no=2")
        page_id = str(cur.fetchone()[0])
    resp = client.get(f"/api/pages/{page_id}/image")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"


def test_reject_approved_page_creates_page_level_row(client, doc2, conn):
    """已通过页发现问题 -> 人工打回建页级自定义行，该页回到待复核。"""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM pages WHERE page_no=2")
        page_id = str(cur.fetchone()[0])
    resp = client.post(f"/api/pages/{page_id}/reject", json={"reason": "竖式识别错了"})
    assert resp.status_code == 200
    with conn.cursor() as cur:
        cur.execute("SELECT reason, block_id, page_id FROM review_queue WHERE status='pending'")
        rows = cur.fetchall()
    assert any(r[0] == "竖式识别错了" and r[1] is None and str(r[2]) == page_id for r in rows)
    pendings = client.get("/api/pages?status=pending").json()["items"]
    assert {p["page_no"] for p in pendings} == {1, 2}


def test_approve_page_closes_its_pending_rows(client, doc2, conn):
    """整页通过：关掉该页所有 pending 行（块级+页级）。"""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM pages WHERE page_no=1")
        page_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO review_queue (page_id, reason) VALUES (%s,'layout_gap')", (page_id,))
    resp = client.post(f"/api/pages/{page_id}/approve")
    assert resp.status_code == 200
    with conn.cursor() as cur:
        cur.execute(
            """SELECT count(*) FROM review_queue r
               LEFT JOIN blocks b ON b.id=r.block_id
               WHERE r.status='pending' AND (r.page_id=%s OR b.page_id=%s)""",
            (page_id, page_id),
        )
        assert cur.fetchone()[0] == 0


def test_pending_reasons_not_duplicated_by_block_fanout(client, doc2, conn):
    """页级复核行 × N 个块的 JOIN 扇出不能把同一 reason 重复 N 次。"""
    with conn.cursor() as cur:
        cur.execute("SELECT id FROM pages WHERE page_no=1")
        page_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO blocks (page_id, block_type, crop_path, content_md)
               SELECT %s, 'text', '/tmp/x.png', '块' FROM generate_series(1, 5)""",
            (page_id,),
        )
        cur.execute(
            "INSERT INTO review_queue (page_id, reason) VALUES (%s,'layout_overlap')",
            (page_id,),
        )
    items = client.get("/api/pages?status=pending").json()["items"]
    page1 = next(i for i in items if i["page_no"] == 1)
    assert sorted(page1["pending_reasons"]) == ["empty", "layout_overlap"]
