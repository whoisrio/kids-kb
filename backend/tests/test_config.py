import pytest

from kb.config import load_config


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
    assert load_config(tmp_path / "不存在.env").layout_engine == "whole_page"
    monkeypatch.setenv("KB_LAYOUT_ENGINE", "paddleocr")
    assert load_config(tmp_path / "不存在.env").layout_engine == "paddleocr"
