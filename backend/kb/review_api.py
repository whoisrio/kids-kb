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

    return app
