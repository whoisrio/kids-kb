"""内部服务：/internal/rerank 供 TS 双路召回调用（本地重排模型权重的唯一出口）。"""
import pytest
from fastapi.testclient import TestClient

from kb.internal_api import create_internal_app


class _FakeReranker:
    def compute_score(self, pairs):
        return [float(len(q) + len(d)) for q, d in pairs]  # 可预测的假分数


@pytest.fixture()
def client():
    return TestClient(create_internal_app(reranker_factory=lambda: _FakeReranker()))


def test_rerank_returns_scores(client):
    resp = client.post("/internal/rerank",
                       json={"query": "ab", "docs": ["x", "xyz"]})
    assert resp.status_code == 200
    assert resp.json()["scores"] == [3.0, 5.0]


def test_rerank_empty_docs(client):
    resp = client.post("/internal/rerank", json={"query": "q", "docs": []})
    assert resp.status_code == 200 and resp.json()["scores"] == []


def test_rerank_503_when_model_unavailable():
    """未装 rerank 依赖时返回 503（TS 侧据此降级为不重排）。"""
    app = create_internal_app(
        reranker_factory=lambda: (_ for _ in ()).throw(ImportError("no FlagEmbedding")))
    resp = TestClient(app).post("/internal/rerank", json={"query": "q", "docs": ["d"]})
    assert resp.status_code == 503
