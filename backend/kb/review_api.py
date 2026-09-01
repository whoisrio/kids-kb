"""最简复核 UI：待复核队列 + 裁图/转录并排 + 通过/打回。

设计文档 §3⑤“本地 web 页（裁图与解析文本并排）”的最小实现。
通过/打回只回写 review_queue.status；打回后的重解析走既有断点重跑机制。
"""
from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from typing import Callable

import psycopg
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from kb.config import load_config

STATIC_DIR = Path(__file__).parent / "static"


class BlockContent(BaseModel):
    """人工编辑转录的请求体。"""

    content_md: str


class PageReject(BaseModel):
    """页级人工打回的请求体。"""

    reason: str


def create_app(get_conn: Callable[[], psycopg.Connection] | None = None) -> FastAPI:
    """get_conn 可注入测试连接（不关闭）；默认每个请求从 .env 配置开新连接并关闭。"""
    own = get_conn is None
    if get_conn is None:
        def get_conn() -> psycopg.Connection:  # type: ignore[misc]
            from kb.db import connect
            return connect(load_config().database_url)

    @contextmanager
    def conn_ctx():
        c = get_conn()
        try:
            yield c
        finally:
            if own:
                c.close()

    app = FastAPI(title="kb-review", docs_url=None, redoc_url=None)
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/api/review")
    def list_reviews(status: str = "pending"):
        if status not in ("pending", "approved", "rejected", "all"):
            raise HTTPException(status_code=422, detail="status 取值: pending/approved/rejected/all")
        where, params = ("", []) if status == "all" else ("WHERE r.status=%s", [status])
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute(
                f"""SELECT r.id, r.reason, r.status, r.created_at,
                           d.title AS doc_title, p.page_no, b.id AS block_id, b.content_md
                    FROM review_queue r
                    LEFT JOIN blocks b ON b.id = r.block_id
                    LEFT JOIN pages p ON p.id = b.page_id
                    LEFT JOIN documents d ON d.id = p.document_id
                    {where}
                    ORDER BY r.created_at""",
                params,
            )
            rows = cur.fetchall()
            cur.execute("SELECT status, count(*) FROM review_queue GROUP BY status")
            counts = dict(cur.fetchall())
        items = [
            {
                "id": str(r[0]), "reason": r[1], "status": r[2], "created_at": r[3].isoformat(),
                "doc_title": r[4], "page_no": r[5],
                "block_id": str(r[6]) if r[6] else None, "content_md": r[7],
            }
            for r in rows
        ]
        full = Counter(counts)
        return {
            "items": items,
            "counts": {s: full.get(s, 0) for s in ("pending", "approved", "rejected")},
        }

    def _act(review_id: str, status: str) -> dict:
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE review_queue SET status=%s WHERE id=%s RETURNING id, status",
                (status, review_id),
            )
            row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="review 记录不存在")
        return {"id": str(row[0]), "status": row[1]}

    @app.post("/api/review/{review_id}/approve")
    def approve(review_id: str):
        return _act(review_id, "approved")

    @app.post("/api/review/{review_id}/reject")
    def reject(review_id: str):
        return _act(review_id, "rejected")

    @app.patch("/api/blocks/{block_id}")
    def update_block(block_id: str, body: BlockContent):
        """人工修正转录内容；同步复核行：可检测问题修复后自动关闭，编辑引入的新问题也会建行。"""
        from kb.qc import sync_block_reviews
        with conn_ctx() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE blocks SET content_md=%s WHERE id=%s RETURNING id, content_md",
                    (body.content_md, block_id),
                )
                row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="block 不存在")
            new_rows = sync_block_reviews(conn, block_id)
        return {"id": str(row[0]), "content_md": row[1], "new_reviews": new_rows}

    @app.get("/api/blocks/{block_id}/crop")
    def block_crop(block_id: str):
        """按 block_id 从库里取裁图路径回传（路径不经过用户输入，避免穿越）。"""
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute("SELECT crop_path FROM blocks WHERE id=%s", (block_id,))
            row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="block 不存在")
        path = Path(row[0])
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"裁图文件缺失: {row[0]}")
        return FileResponse(path, media_type="image/png")

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "review.html", media_type="text/html")

    # ---- 页级复核：状态由复核行推导（有 pending 行=待复核，干净 parsed 页=已通过）----

    @app.get("/api/pages")
    def list_pages(status: str = "pending", doc_id: str | None = None):
        if status not in ("pending", "approved"):
            raise HTTPException(status_code=422, detail="status 取值: pending/approved")
        having = "pr.n > 0" if status == "pending" else "coalesce(pr.n, 0) = 0"
        params: list = []
        doc_filter = ""
        if doc_id:
            doc_filter = "AND p.document_id = %s"
            params.append(doc_id)
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute(
                f"""SELECT p.id, p.page_no, d.title, pr.reasons
                    FROM pages p
                    JOIN documents d ON d.id = p.document_id
                    LEFT JOIN LATERAL (
                        SELECT count(*) AS n,
                               array_agg(r.reason ORDER BY r.created_at) AS reasons
                        FROM review_queue r
                        WHERE r.status = 'pending' AND (
                            r.page_id = p.id OR r.block_id IN (
                                SELECT id FROM blocks WHERE page_id = p.id))
                    ) pr ON true
                    WHERE p.status = 'parsed' {doc_filter} AND {having}
                    ORDER BY d.title, p.page_no""",
                params,
            )
            rows = cur.fetchall()
        return {"items": [
            {"page_id": str(r[0]), "page_no": r[1], "doc_title": r[2],
             "pending_reasons": r[3] or []}
            for r in rows
        ]}

    @app.get("/api/pages/{page_id}")
    def page_detail(page_id: str):
        import pymupdf as fitz
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute(
                """SELECT p.page_no, p.image_path, d.title FROM pages p
                   JOIN documents d ON d.id = p.document_id WHERE p.id=%s""",
                (page_id,),
            )
            page = cur.fetchone()
            if not page:
                raise HTTPException(status_code=404, detail="page 不存在")
            cur.execute(
                """SELECT id, block_type, bbox, content_md, source_model,
                          prompt_tokens, completion_tokens FROM blocks
                   WHERE page_id=%s ORDER BY created_at, id""",
                (page_id,),
            )
            blocks = cur.fetchall()
            cur.execute(
                """SELECT r.id, r.reason, r.status, r.block_id FROM review_queue r
                   LEFT JOIN blocks b ON b.id = r.block_id
                   WHERE r.page_id=%s OR b.page_id=%s ORDER BY r.created_at""",
                (page_id, page_id),
            )
            reviews = cur.fetchall()
            # 落在该页的条目（按 item_blocks 溯源关联），前端"区块/整理后"切换用
            cur.execute(
                """SELECT DISTINCT i.id, i.content_type, i.label, i.content_md, i.qc_status
                   FROM items i
                   JOIN item_blocks ib ON ib.item_id = i.id
                   JOIN blocks b ON b.id = ib.block_id
                   WHERE b.page_id=%s
                   ORDER BY i.label""",
                (page_id,),
            )
            items = cur.fetchall()
        path = Path(page[1])
        if not path.is_absolute():
            path = Path.cwd() / path
        width = height = 0
        if path.exists():
            pix = fitz.Pixmap(str(path))
            width, height = pix.width, pix.height
        return {
            "page_id": page_id, "page_no": page[0], "doc_title": page[2],
            "width": width, "height": height,
            "blocks": [
                {"id": str(b[0]), "block_type": b[1], "bbox": b[2], "content_md": b[3],
                 "source_model": b[4], "prompt_tokens": b[5], "completion_tokens": b[6]}
                for b in blocks
            ],
            "reviews": [
                {"id": str(r[0]), "reason": r[1], "status": r[2],
                 "block_id": str(r[3]) if r[3] else None}
                for r in reviews
            ],
            "items": [
                {"id": str(i[0]), "content_type": i[1], "label": i[2],
                 "content_md": i[3], "qc_status": i[4]}
                for i in items
            ],
        }

    @app.get("/api/pages/{page_id}/image")
    def page_image(page_id: str):
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute("SELECT image_path FROM pages WHERE id=%s", (page_id,))
            row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="page 不存在")
        path = Path(row[0])
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"页图缺失: {row[0]}")
        return FileResponse(path, media_type="image/png")

    @app.post("/api/pages/{page_id}/reject")
    def reject_page(page_id: str, body: PageReject):
        """已通过页发现问题 -> 页级自定义复核行（不锚定块，机器不自动关闭）。"""
        import uuid
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pages WHERE id=%s", (page_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="page 不存在")
            cur.execute(
                "INSERT INTO review_queue (id, page_id, reason) VALUES (%s,%s,%s) RETURNING id",
                (str(uuid.uuid4()), page_id, body.reason),
            )
            row_id = cur.fetchone()[0]
        return {"id": str(row_id), "status": "pending"}

    @app.post("/api/pages/{page_id}/approve")
    def approve_page(page_id: str):
        """整页通过：关闭该页所有 pending 行（块级+页级）。"""
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute(
                """UPDATE review_queue SET status='approved' WHERE status='pending' AND (
                       page_id=%s OR block_id IN (SELECT id FROM blocks WHERE page_id=%s))
                   RETURNING id""",
                (page_id, page_id),
            )
            n = len(cur.fetchall())
        return {"id": page_id, "resolved": n}

    # ---- 条目级：LLM 整理结果（章节拆条）的可视化与人工确认 ----

    @app.get("/api/items")
    def list_items(doc_id: str | None = None, status: str | None = None):
        where, params = ("WHERE i.document_id = %s", [doc_id]) if doc_id else ("", [])
        if status == "pending":  # 待复核条目：qc_status 待确认，或有 pending 复核行
            where += (" AND " if where else "WHERE ") + (
                "(i.qc_status = 'pending' OR pr.reasons IS NOT NULL)")
        elif status:
            raise HTTPException(status_code=422, detail="status 取值: pending")
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute(
                f"""SELECT i.id, i.content_type, i.label, i.chapter, i.qc_status, d.title,
                           pr.reasons, i.content_md
                    FROM items i
                    JOIN documents d ON d.id = i.document_id
                    LEFT JOIN LATERAL (
                        SELECT array_agg(r.reason ORDER BY r.created_at) AS reasons
                        FROM review_queue r
                        WHERE r.item_id = i.id AND r.status = 'pending'
                    ) pr ON true
                    {where} ORDER BY d.title, i.chapter, i.created_at""",
                params,
            )
            rows = cur.fetchall()
        return {"items": [
            {"id": str(r[0]), "content_type": r[1], "label": r[2], "chapter": r[3],
             "qc_status": r[4], "doc_title": r[5], "pending_reasons": r[6] or [],
             "content_md": r[7]}
            for r in rows
        ]}

    @app.get("/api/items/{item_id}")
    def item_detail(item_id: str):
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute(
                """SELECT i.content_type, i.label, i.chapter, i.qc_status, i.content_md,
                          i.taxonomy, i.tags, d.title, i.source_model
                   FROM items i JOIN documents d ON d.id = i.document_id WHERE i.id=%s""",
                (item_id,),
            )
            item = cur.fetchone()
            if not item:
                raise HTTPException(status_code=404, detail="item 不存在")
            cur.execute(
                """SELECT b.id, ib.role, b.block_type, b.content_md, b.source_model
                   FROM item_blocks ib JOIN blocks b ON b.id = ib.block_id
                   WHERE ib.item_id=%s ORDER BY b.created_at, b.id""",
                (item_id,),
            )
            blocks = cur.fetchall()
            cur.execute(
                "SELECT id, reason, status FROM review_queue WHERE item_id=%s ORDER BY created_at",
                (item_id,),
            )
            reviews = cur.fetchall()
        return {
            "id": item_id, "content_type": item[0], "label": item[1], "chapter": item[2],
            "qc_status": item[3], "content_md": item[4], "taxonomy": item[5],
            "tags": item[6], "doc_title": item[7], "source_model": item[8],
            "blocks": [
                {"id": str(b[0]), "role": b[1], "block_type": b[2], "content_md": b[3],
                 "source_model": b[4]}
                for b in blocks
            ],
            "reviews": [
                {"id": str(r[0]), "reason": r[1], "status": r[2]} for r in reviews
            ],
        }

    @app.patch("/api/items/{item_id}")
    def update_item(item_id: str, body: BlockContent):
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE items SET content_md=%s WHERE id=%s RETURNING id",
                (body.content_md, item_id),
            )
            row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="item 不存在")
        return {"id": str(row[0]), "content_md": body.content_md}

    @app.post("/api/items/{item_id}/approve")
    def approve_item(item_id: str):
        """人工确认条目 -> qc_status=approved（向量化的准入门槛）。"""
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE items SET qc_status='approved' WHERE id=%s RETURNING id",
                (item_id,),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="item 不存在")
            cur.execute(
                "UPDATE review_queue SET status='approved' WHERE item_id=%s AND status='pending'",
                (item_id,),
            )
        return {"id": item_id, "qc_status": "approved"}

    @app.post("/api/items/{item_id}/reject")
    def reject_item(item_id: str, body: PageReject):
        """条目打回：item 级自定义复核行（如串章/漏题），机器不自动关闭。"""
        import uuid
        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM items WHERE id=%s", (item_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="item 不存在")
            cur.execute(
                "INSERT INTO review_queue (id, item_id, reason) VALUES (%s,%s,%s) RETURNING id",
                (str(uuid.uuid4()), item_id, body.reason),
            )
            row_id = cur.fetchone()[0]
        return {"id": str(row_id), "status": "pending"}

    return app
