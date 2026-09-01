"""bge-reranker-v2-m3 cross-encoder 重排：Python 本地加载（ollama 无 rerank 接口）。

懒加载，首次从 HF 下载模型（~1GB）。装依赖：uv sync --extra rerank。
"""
from __future__ import annotations

_reranker = None


def get_reranker():
    global _reranker
    if _reranker is None:
        from FlagEmbedding import FlagReranker
        _reranker = FlagReranker("BAAI/bge-reranker-v2-m3")
    return _reranker
