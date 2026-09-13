import pytest

from kb.core.config import load_config


def test_load_config_defaults(tmp_path, monkeypatch):
    monkeypatch.delenv("KB_DATABASE_URL", raising=False)
    monkeypatch.delenv("KB_VISION_BASE_URL", raising=False)
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.database_url == "postgresql://localhost/kb_test"
    assert cfg.vision_base_url == "http://localhost:11434/v1"
    assert cfg.vision_model == "qwen3:4b"
    assert cfg.dpi == 200


def test_load_config_requires_database_url(tmp_path, monkeypatch):
    monkeypatch.delenv("KB_DATABASE_URL", raising=False)
    with pytest.raises(SystemExit):
        load_config(tmp_path / "不存在.env")


def test_load_config_layout_engine(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    monkeypatch.delenv("KB_LAYOUT_ENGINE", raising=False)
    assert load_config(tmp_path / "不存在.env").layout_engine == "paddleocr"
    monkeypatch.setenv("KB_LAYOUT_ENGINE", "paddleocr")
    assert load_config(tmp_path / "不存在.env").layout_engine == "paddleocr"


def test_load_config_doc_ognize(tmp_path, monkeypatch):
    """整理文档内容的模型走 DOC_OGNIZE_* 配置，留空则回落 vision 渠道。"""
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    for v in ("DOC_OGNIZE_MODEL", "DOC_OGNIZE_BASE_URL", "DOC_OGNIZE_API_KEY"):
        monkeypatch.delenv(v, raising=False)
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.doc_ognize_model is None
    assert cfg.doc_ognize_base_url is None
    assert cfg.doc_ognize_api_key is None
    monkeypatch.setenv("DOC_OGNIZE_MODEL", "qwen3-32b")
    monkeypatch.setenv("DOC_OGNIZE_BASE_URL", "https://api.example.com/v1")
    monkeypatch.setenv("DOC_OGNIZE_API_KEY", "sk-x")
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.doc_ognize_model == "qwen3-32b"
    assert cfg.doc_ognize_base_url == "https://api.example.com/v1"
    assert cfg.doc_ognize_api_key == "sk-x"


def test_load_config_heading(tmp_path, monkeypatch):
    """标题层级判定的模型走 HEADING_* 配置，留空回落 DOC_OGNIZE_* → KB_VISION_*。"""
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    for v in ("HEADING_MODEL", "HEADING_BASE_URL", "HEADING_API_KEY",
              "DOC_OGNIZE_MODEL", "DOC_OGNIZE_BASE_URL", "DOC_OGNIZE_API_KEY"):
        monkeypatch.delenv(v, raising=False)
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.heading_model is None
    assert cfg.heading_base_url is None
    assert cfg.heading_api_key is None
    # 全留空：逐项回落到 vision 渠道
    assert cfg.heading_endpoint() == (
        cfg.vision_base_url, cfg.vision_api_key, cfg.vision_model)
    # doc_ognize 配了而 heading 没配：回落 doc_ognize 渠道
    monkeypatch.setenv("DOC_OGNIZE_BASE_URL", "https://api.example.com/v1")
    monkeypatch.setenv("DOC_OGNIZE_API_KEY", "sk-x")
    monkeypatch.setenv("DOC_OGNIZE_MODEL", "qwen3-32b")
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.heading_endpoint() == ("https://api.example.com/v1", "sk-x", "qwen3-32b")
    # heading 显式配置优先，且逐项回落
    monkeypatch.setenv("HEADING_MODEL", "qwen3:4b")
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.heading_endpoint() == ("https://api.example.com/v1", "sk-x", "qwen3:4b")
    monkeypatch.setenv("HEADING_BASE_URL", "http://localhost:11434/v1")
    monkeypatch.setenv("HEADING_API_KEY", "ollama")
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.heading_endpoint() == ("http://localhost:11434/v1", "ollama", "qwen3:4b")


def test_trajectory_level_default_simple(monkeypatch, tmp_path):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb")
    monkeypatch.delenv("KB_TRAJECTORY_LEVEL", raising=False)
    cfg = load_config(env_path=tmp_path / "nonexistent.env")
    assert cfg.trajectory_level == "simple"


def test_trajectory_level_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb")
    monkeypatch.setenv("KB_TRAJECTORY_LEVEL", "verbose")
    cfg = load_config(env_path=tmp_path / "nonexistent.env")
    assert cfg.trajectory_level == "verbose"


def test_load_config_chunk_defaults(tmp_path, monkeypatch):
    """章节 chunk 粒度可配：默认 500 字符 + 10% overlap。"""
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    monkeypatch.delenv("KB_CHUNK_MAX_CHARS", raising=False)
    monkeypatch.delenv("KB_CHUNK_OVERLAP_RATIO", raising=False)
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.chunk_max_chars == 500
    assert cfg.chunk_overlap_ratio == 0.1
    monkeypatch.setenv("KB_CHUNK_MAX_CHARS", "800")
    monkeypatch.setenv("KB_CHUNK_OVERLAP_RATIO", "0.2")
    cfg = load_config(tmp_path / "不存在.env")
    assert cfg.chunk_max_chars == 800
    assert cfg.chunk_overlap_ratio == 0.2


def test_load_config_layout_model(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    monkeypatch.delenv("KB_LAYOUT_MODEL", raising=False)
    assert load_config(tmp_path / "不存在.env").layout_model == "PP-DocLayoutV3"
    monkeypatch.setenv("KB_LAYOUT_MODEL", "PP-DocLayoutV2")
    assert load_config(tmp_path / "不存在.env").layout_model == "PP-DocLayoutV2"


def test_load_config_layout_model_invalid(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    monkeypatch.setenv("KB_LAYOUT_MODEL", "PP-DocLayoutV9")
    with pytest.raises(SystemExit) as exc:
        load_config(tmp_path / "不存在.env")
    assert "PP-DocLayoutV2" in str(exc.value)
    assert "PP-DocLayoutV3" in str(exc.value)


def test_load_config_min_figure_ratio(tmp_path, monkeypatch):
    """小图块过滤阈值：默认 0.005（图块面积占比 <0.5% 丢弃），0 关闭。"""
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb_test")
    monkeypatch.delenv("KB_LAYOUT_MIN_FIGURE_RATIO", raising=False)
    assert load_config(tmp_path / "不存在.env").layout_min_figure_ratio == 0.005
    monkeypatch.setenv("KB_LAYOUT_MIN_FIGURE_RATIO", "0.01")
    assert load_config(tmp_path / "不存在.env").layout_min_figure_ratio == 0.01
    monkeypatch.setenv("KB_LAYOUT_MIN_FIGURE_RATIO", "0")
    assert load_config(tmp_path / "不存在.env").layout_min_figure_ratio == 0.0
