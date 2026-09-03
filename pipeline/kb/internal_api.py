"""内部服务：只对 TS 后端暴露，不对前端。rerank 是唯一需要本地模型权重的环节。"""
from __future__ import annotations

from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel


class RerankRequest(BaseModel):
    query: str
    docs: list[str]


class RecognizePageRequest(BaseModel):
    paper_id: str
    page_no: int


def create_internal_app(reranker_factory=None, get_conn=None, cfg=None,
                        vlm_client=None) -> FastAPI:
    """reranker_factory / get_conn / cfg / vlm_client 均可注入假实现；默认懒加载真实依赖。"""
    if reranker_factory is None:
        def reranker_factory():
            from kb.rerank import get_reranker
            return get_reranker()
    if cfg is None:
        from kb.config import load_config
        cfg = load_config()

    def _conn():
        if get_conn is not None:
            return get_conn()
        from kb.db import connect
        return connect(cfg.database_url)

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
        data = file.file.read() if file is not None else None
        return ingest_paper(_conn(), cfg, paper_id, pdf_bytes=data, client=vlm_client)

    @app.post("/internal/recognize-page")
    def recognize_page_ep(body: RecognizePageRequest):
        """单页重识别：只重建该页题目，其它页的人工确认不动。"""
        from kb.paper_pipeline import recognize_page
        return recognize_page(_conn(), cfg, body.paper_id, body.page_no, client=vlm_client)

    return app
