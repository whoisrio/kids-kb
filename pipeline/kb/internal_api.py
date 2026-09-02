"""内部服务：只对 TS 后端暴露，不对前端。rerank 是唯一需要本地模型权重的环节。"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


class RerankRequest(BaseModel):
    query: str
    docs: list[str]


def create_internal_app(reranker_factory=None) -> FastAPI:
    """reranker_factory 可注入假实现；默认懒加载 kb.rerank.get_reranker。"""
    if reranker_factory is None:
        def reranker_factory():
            from kb.rerank import get_reranker
            return get_reranker()
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

    return app
