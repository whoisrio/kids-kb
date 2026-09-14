"""内部服务：只对 TS 后端暴露，不对前端。rerank 是唯一需要本地模型权重的环节。"""
from __future__ import annotations

from contextlib import contextmanager

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel


class RerankRequest(BaseModel):
    query: str
    docs: list[str]


class RecognizePageRequest(BaseModel):
    paper_id: str
    page_no: int


class EmbedFlatPageRequest(BaseModel):
    doc_id: str
    page_no: int


class PageVlmRequest(BaseModel):
    page_id: str


class IndexPreviewRequest(BaseModel):
    page_id: str


class PageExclusionRequest(BaseModel):
    page_id: str
    excluded: bool


class ApproveDocRequest(BaseModel):
    doc_id: str


class ReindexRequest(BaseModel):
    doc_id: str
    type: str
    id: str


class BlockRecropRequest(BaseModel):
    block_id: str


class BlockGeometryPreviewRequest(BaseModel):
    block_id: str
    bbox: list[float]


class BlockGeometryCommitRequest(BaseModel):
    block_id: str
    bbox: list[float]
    staging: str
    adopted_text: str
    source_model: str


class BlockCreateRequest(BaseModel):
    page_id: str
    bbox: list[float]
    block_type: str = "text"


class IngestDocRequest(BaseModel):
    source_path: str
    title: str
    subject: str | None = None
    grade: str | None = None
    doc_type: str = "workbook"


def create_internal_app(reranker_factory=None, get_conn=None, cfg=None,
                        vlm_client=None, embed_client=None) -> FastAPI:
    """reranker_factory / get_conn / cfg / vlm_client 均可注入假实现；默认懒加载真实依赖。"""
    if reranker_factory is None:
        def reranker_factory():
            from kb.rag.rerank import get_reranker
            return get_reranker()
    if cfg is None:
        from kb.core.config import load_config
        cfg = load_config()

    def _conn():
        if get_conn is not None:
            return get_conn()
        from kb.core.db import connect
        return connect(cfg.database_url)

    def _cfg():
        return cfg

    @contextmanager
    def conn_ctx():
        conn = _conn()
        try:
            yield conn
        finally:
            if get_conn is None:
                conn.close()

    app = FastAPI(title="kb-internal", docs_url=None, redoc_url=None)

    @app.post("/internal/rerank")
    def rerank(body: RerankRequest):
        if not body.docs:
            return {"scores": []}
        try:
            reranker = reranker_factory()
        except ImportError as e:
            raise HTTPException(status_code=503, detail=f"重排模型不可用: {e}")
        scores = reranker.compute_score([(body.query, d) for d in body.docs])
        if not isinstance(scores, list):  # 单对时库返回标量
            scores = [scores]
        return {"scores": [float(s) for s in scores]}

    @app.post("/internal/ingest-paper")
    def ingest_paper_ep(paper_id: str, file: UploadFile | None = File(default=None)):
        """整卷加工：首次带 file 上传；重驱动可不带(复用已存 source.pdf)。"""
        from kb.paper_pipeline import ingest_paper
        conn = _conn()
        try:
            data = file.file.read() if file is not None else None
            return ingest_paper(conn, cfg, paper_id, pdf_bytes=data, client=vlm_client)
        except HTTPException:
            raise
        except Exception as e:
            # 500 带真实原因:TS 侧 jobs.ts 读 detail 落 papers.error,纯 "Internal Server Error" 不可排查
            raise HTTPException(status_code=500, detail=str(e)) from e
        finally:
            conn.close()

    @app.post("/internal/ingest-doc")
    def ingest_doc_ep(body: IngestDocRequest):
        """资料库上传入库：documents 行由 TS 预插(parse_status='pending')，本端点按扩展名
        分流(pdf/docx/md 均以 source_path 为幂等键复用该行)并推进 doc 级 parse_status。"""
        with conn_ctx() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id FROM documents WHERE source_path=%s", (body.source_path,))
                row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="documents 行不存在(需先按 source_path 预插)")
            doc_id = str(row[0])
            lower = body.source_path.lower()
            if not lower.endswith((".pdf", ".docx", ".md")):
                raise HTTPException(status_code=422, detail=f"不支持的文件类型: {body.source_path}")
            with conn.cursor() as cur:
                cur.execute("UPDATE documents SET parse_status='parsing' WHERE id=%s", (doc_id,))
            try:
                if lower.endswith(".pdf"):
                    from kb.pdf_ingest import ingest
                    ingest(conn, _cfg(), body.source_path, body.title,
                           subject=body.subject, grade=body.grade,
                           doc_type=body.doc_type, client=vlm_client)
                elif lower.endswith(".docx"):
                    from kb.rag.docx_ingest import ingest_docx
                    ingest_docx(conn, _cfg(), body.source_path, body.title,
                                subject=body.subject, grade=body.grade,
                                doc_type=body.doc_type, client=embed_client)
                else:
                    from kb.rag.text_ingest import ingest_md
                    ingest_md(conn, _cfg(), body.source_path, body.title,
                              subject=body.subject, grade=body.grade,
                              doc_type=body.doc_type, client=embed_client)
            except Exception as e:
                # 失败置 failed 并透传真实原因:TS 侧据此呈现「检测失败」
                with conn.cursor() as cur:
                    cur.execute("UPDATE documents SET parse_status='failed' WHERE id=%s", (doc_id,))
                raise HTTPException(status_code=500, detail=str(e)) from e
            with conn.cursor() as cur:
                cur.execute("UPDATE documents SET parse_status='parsed' WHERE id=%s", (doc_id,))
            return {"doc_id": doc_id, "parse_status": "parsed"}

    @app.post("/internal/recognize-page")
    def recognize_page_ep(body: RecognizePageRequest):
        """单页重识别：只重建该页题目，其它页的人工确认不动。"""
        from kb.paper_pipeline import recognize_page
        conn = _conn()
        try:
            return recognize_page(conn, cfg, body.paper_id, body.page_no, client=vlm_client)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
        finally:
            conn.close()

    @app.post("/internal/embed-flat-page")
    def embed_flat_page_ep(body: EmbedFlatPageRequest):
        """复核页全量通过后 flat 单页向量化；重建式幂等。"""
        from kb.rag.flat import embed_flat_pages

        with conn_ctx() as conn:
            try:
                chunks = embed_flat_pages(
                    conn, _cfg(), body.doc_id, page_no=body.page_no,
                    client=embed_client)
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e)) from e
        return {"chunks": chunks}

    @app.post("/internal/approve-item")
    def approve_item_ep(item_id: str):
        """条目人工确认：qc_status=approved + 关 pending 复核行 + 即时向量化。
        approve 与向量化单一事实来源（CLI approve 与 React 复核页共用同一实现）。
        向量化失败不阻断（embedded=None，可 kb.cli embed 补跑）。"""
        from kb.rag.embed import embed_approved_items
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute("UPDATE items SET qc_status='approved', updated_at=now() WHERE id=%s RETURNING id", (item_id,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="item 不存在")
                cur.execute("UPDATE review_queue SET status='approved' WHERE item_id=%s AND status='pending'", (item_id,))
            try:
                n = embed_approved_items(conn, cfg, client=embed_client)
            except Exception as e:  # noqa: BLE001 - 向量化失败不阻断复核
                print(f"warn: 条目向量化失败({e}),可 kb.cli embed 补跑")
                n = None
            return {"id": item_id, "qc_status": "approved", "embedded": n}
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
        finally:
            conn.close()

    @app.post("/internal/approve-doc")
    def approve_doc_ep(body: ApproveDocRequest):
        """整本文档准备结构、人工批准并即时向量化；flat 与结构化文档共用 CLI 的实现。"""
        with conn_ctx() as conn:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """SELECT d.title, d.source_path, d.struct_mode, d.doc_type,
                                  EXISTS (
                                      SELECT 1 FROM chapters ch
                                      WHERE ch.document_id=d.id
                                        AND coalesce(trim(ch.content_md), '') <> ''
                                  ),
                                  EXISTS (SELECT 1 FROM chapters ch WHERE ch.document_id=d.id),
                                  EXISTS (SELECT 1 FROM pages p WHERE p.document_id=d.id)
                           FROM documents d WHERE d.id=%s""",
                        (body.doc_id,),
                    )
                    row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="文档不存在")
                title, source_path, struct_mode, doc_type, has_content, has_chapter, has_pages = row
                lower_source = str(source_path or "").lower()
                if lower_source.endswith((".docx", ".md")):
                    if not has_content and not has_pages:
                        if lower_source.endswith(".docx"):
                            from kb.rag.docx_ingest import ingest_docx
                            ingest_docx(conn, _cfg(), source_path, title, client=embed_client)
                        else:
                            from kb.rag.text_ingest import ingest_md
                            ingest_md(conn, _cfg(), source_path, title, client=embed_client)
                    if doc_type != "exam":  # 试卷走下方 run_structure 拆题，不直接批准章节
                        with conn.cursor() as cur:
                            cur.execute(
                                """SELECT EXISTS (
                                       SELECT 1 FROM chapters
                                       WHERE document_id=%s
                                         AND coalesce(trim(content_md), '') <> ''
                                   )""",
                                (body.doc_id,),
                            )
                            if not cur.fetchone()[0]:
                                raise HTTPException(
                                    status_code=409,
                                    detail="文档没有可入库内容，请重新上传或检查源文件",
                                )
                        from kb.rag.embed import approve_items
                        out = approve_items(conn, _cfg(), body.doc_id, client=embed_client)
                        with conn.cursor() as cur:
                            cur.execute(
                                """UPDATE chapters
                                   SET review_status='approved', manual_review_status='approved'
                                   WHERE document_id=%s""",
                                (body.doc_id,),
                            )
                        with conn.cursor() as cur:
                            cur.execute(
                                """UPDATE documents
                                   SET review_status='approved', struct_mode=NULL
                                   WHERE id=%s""",
                                (body.doc_id,),
                            )
                        return {"doc_id": body.doc_id, **out}
                if struct_mode is None:
                    from kb.rag.structure import run_structure
                    struct_mode = run_structure(conn, _cfg(), body.doc_id)["mode"]
                if struct_mode == "flat" and not has_chapter:
                    from kb.rag.flat import build_flat_chapter
                    build_flat_chapter(conn, body.doc_id)
                if struct_mode == "flat":
                    from kb.rag.flat import approve_flat_pages
                    out = approve_flat_pages(conn, _cfg(), body.doc_id, client=embed_client)
                    if not out.get("pages"):
                        raise HTTPException(
                            status_code=409,
                            detail="文档没有可入库内容，请重新上传或检查源文件",
                        )
                elif struct_mode in ("toc", "exam", "heading"):
                    from kb.rag.embed import approve_items
                    out = approve_items(conn, _cfg(), body.doc_id, client=embed_client)
                    with conn.cursor() as cur:
                        cur.execute(
                            """SELECT EXISTS (
                                   SELECT 1 FROM chapters
                                   WHERE document_id=%s
                                     AND (coalesce(trim(content_md), '') <> ''
                                          OR page_start IS NOT NULL)
                               )""",
                            (body.doc_id,),
                        )
                        if not cur.fetchone()[0]:
                            raise HTTPException(
                                status_code=409,
                                detail="文档没有可入库内容，请重新上传或检查源文件",
                            )
                    with conn.cursor() as cur:
                        cur.execute(
                            """UPDATE chapters
                               SET review_status='approved', manual_review_status='approved'
                               WHERE document_id=%s""",
                            (body.doc_id,),
                        )
                else:
                    raise HTTPException(status_code=422, detail="未知文档结构模式")
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE documents SET review_status='approved' WHERE id=%s",
                        (body.doc_id,))
                return {"doc_id": body.doc_id, **out}
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e)) from e

    @app.post("/internal/page-vlm")
    def page_vlm_ep(body: PageVlmRequest):
        """页级 VLM 重跑（复核页「远端整页解析」）：覆盖旧 page_md，采用版本仍由 adopt 决定。
        镜像不在此刷新（B3：镜像改由 export 重算）。"""
        from kb.ocr.pagelvl import transcribe_page
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM pages WHERE id=%s", (body.page_id,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="page 不存在")
            from kb.telemetry.traj import Recorder
            with conn.cursor() as cur:
                cur.execute("SELECT document_id FROM pages WHERE id=%s", (body.page_id,))
                doc_id = str(cur.fetchone()[0])
            rec = Recorder(conn, cfg, doc_id)
            rec.start("page_vlm", "手动整页 VLM 重跑", page_id=body.page_id)
            md = transcribe_page(conn, cfg, body.page_id, client=vlm_client,
                                 recorder=rec)
            rec.end("page_vlm", "手动整页 VLM 完成", page_id=body.page_id)
            return {"page_id": body.page_id, "page_md_len": len(md)}
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
        finally:
            conn.close()

    @app.post("/internal/index-preview")
    def index_preview_ep(body: IndexPreviewRequest):
        """预览单页 chunk 切分，不调用 embedding。"""
        from kb.rag.embed import segment_chapter
        from kb.rag.flat import page_contents, page_source_blocks

        with conn_ctx() as conn, conn.cursor() as cur:
            cur.execute(
                """SELECT id, document_id::text, page_no, excluded_from_index
                   FROM pages WHERE id=%s""", (body.page_id,))
            page = cur.fetchone()
            if not page:
                raise HTTPException(status_code=404, detail="page 不存在")
            page_id, doc_id, page_no, excluded = page
            if excluded:
                raise HTTPException(status_code=409, detail="该页已排除，不参与索引")
            contents = dict(page_contents(cur, doc_id))
            if page_no not in contents:
                return {"page_id": page_id, "page_no": page_no, "chunks": []}
            sources = page_source_blocks(cur, doc_id).get(page_no, [])
            chunks = []
            for seq, seg in enumerate(
                    segment_chapter(contents[page_no], max_chars=cfg.chunk_max_chars), start=1):
                chunks.append({
                    "seq": seq, "page_no": page_no,
                    "source_block_ids": sources,
                    "content_preview": seg[:240], "char_count": len(seg),
                })
            return {"page_id": page_id, "page_no": page_no, "chunks": chunks}

    @app.post("/internal/page-exclusion")
    def page_exclusion_ep(body: PageExclusionRequest):
        """排除/恢复页；flat 模式同步重建合成章并清理页相关 chunk。"""
        with conn_ctx() as conn:
            try:
                with conn.transaction(), conn.cursor() as cur:
                    cur.execute(
                        """SELECT p.document_id::text, p.page_no, d.struct_mode
                           FROM pages p JOIN documents d ON d.id=p.document_id
                           WHERE p.id=%s FOR UPDATE OF p""", (body.page_id,))
                    page = cur.fetchone()
                    if not page:
                        raise HTTPException(status_code=404, detail="page 不存在")
                    doc_id, page_no, struct_mode = page
                    cur.execute(
                        "UPDATE pages SET excluded_from_index=%s, index_status='not_indexed', index_error=NULL WHERE id=%s",
                        (body.excluded, body.page_id),
                    )
                    cur.execute(
                        """DELETE FROM chunks WHERE document_id=%s AND (
                             page_no=%s OR source_block_ids && ARRAY(
                                 SELECT id FROM blocks WHERE page_id=%s)
                             OR item_id IN (
                                 SELECT ib.item_id FROM item_blocks ib
                                 JOIN blocks b ON b.id = ib.block_id
                                 WHERE b.page_id=%s))""",
                        (doc_id, page_no, body.page_id, body.page_id),
                    )
                    deleted_chunks = cur.rowcount
                    if struct_mode == "flat":
                        from kb.rag.flat import build_flat_chapter
                        build_flat_chapter(conn, doc_id)
                    else:
                        cur.execute(
                            "UPDATE chapters SET index_status='not_indexed' WHERE document_id=%s",
                            (doc_id,),
                        )
                return {"page_id": body.page_id, "excluded": body.excluded,
                        "deleted_chunks": deleted_chunks, "affected_units": []}
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e)) from e

    @app.post("/internal/reindex")
    def reindex_ep(body: ReindexRequest):
        """手动重向量化：编辑后用户触发，重建该页或章节的 chunks。"""
        with conn_ctx() as conn:
            try:
                if body.type == "page":
                    from kb.rag.flat import embed_flat_pages
                    with conn.cursor() as cur:
                        cur.execute(
                            "SELECT page_no FROM pages WHERE id=%s AND document_id=%s",
                            (body.id, body.doc_id))
                        row = cur.fetchone()
                    if not row:
                        raise HTTPException(status_code=404, detail="page 不存在")
                    embed_flat_pages(conn, _cfg(), body.doc_id,
                                     page_no=row[0], client=embed_client)
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE pages SET index_status='indexed' WHERE id=%s", (body.id,))
                    return {"chunks": 1}
                if body.type == "chapter":
                    from kb.rag.embed import embed_chapters
                    with conn.cursor() as cur:
                        cur.execute("SELECT 1 FROM chapters WHERE id=%s AND document_id=%s",
                                    (body.id, body.doc_id))
                        if not cur.fetchone():
                            raise HTTPException(status_code=404, detail="chapter 不存在")
                        cur.execute("DELETE FROM chunks WHERE chapter_id=%s", (body.id,))
                    n = embed_chapters(conn, _cfg(), body.doc_id, client=embed_client)
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE chapters SET index_status='indexed' WHERE id=%s", (body.id,))
                    return {"chunks": n}
                raise HTTPException(status_code=422, detail="type 取值: page|chapter")
            except HTTPException:
                raise
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e)) from e

    @app.post("/internal/block-recrop")
    def block_recrop(body: BlockRecropRequest):
        from kb.ocr.block_edit import recrop_block

        with conn_ctx() as conn:
            try:
                return recrop_block(conn, _cfg(), body.block_id)
            except KeyError as e:
                raise HTTPException(status_code=404, detail="block 不存在") from e
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e)) from e

    @app.post("/internal/block-geometry-preview")
    def block_geometry_preview(body: BlockGeometryPreviewRequest):
        from kb.ocr.block_edit import preview_block_geometry

        with conn_ctx() as conn:
            try:
                return preview_block_geometry(conn, _cfg(), body.block_id, body.bbox, client=vlm_client)
            except KeyError as e:
                raise HTTPException(status_code=404, detail="block 不存在") from e
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e)) from e

    @app.post("/internal/block-geometry-commit")
    def block_geometry_commit(body: BlockGeometryCommitRequest):
        from kb.ocr.block_edit import commit_block_geometry

        with conn_ctx() as conn:
            try:
                return commit_block_geometry(
                    conn, _cfg(), body.block_id, body.bbox, body.staging,
                    body.adopted_text, body.source_model,
                )
            except KeyError as e:
                raise HTTPException(status_code=404, detail="block 不存在") from e
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e)) from e

    @app.post("/internal/block-create")
    def block_create(body: BlockCreateRequest):
        from kb.ocr.block_edit import create_block

        with conn_ctx() as conn:
            try:
                return create_block(conn, _cfg(), body.page_id, body.bbox, body.block_type,
                                    client=vlm_client)
            except KeyError as e:
                raise HTTPException(status_code=404, detail="page 不存在") from e
            except ValueError as e:
                raise HTTPException(status_code=422, detail=str(e)) from e
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e)) from e

    return app
