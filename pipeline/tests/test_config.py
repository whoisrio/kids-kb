"""KB_TRAJECTORY_LEVEL 配置加载。"""
from kb.config import load_config


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
