"""路径基准：DB 存相对 KB_STORAGE_DIR，读取侧解析回文件系统路径。"""
from pathlib import Path

from kb.core.config import Config


def _cfg(tmp_path):
    return Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )


def test_resolve_storage_path_relative(tmp_path):
    from kb.core.paths import resolve_storage_path

    cfg = _cfg(tmp_path)
    assert resolve_storage_path(cfg, "abc/pages/p0001.png") == tmp_path / "storage" / "abc/pages/p0001.png"


def test_resolve_storage_path_absolute_passthrough(tmp_path):
    from kb.core.paths import resolve_storage_path

    cfg = _cfg(tmp_path)
    assert resolve_storage_path(cfg, "/abs/x.png") == Path("/abs/x.png")


def test_storage_rel_roundtrip(tmp_path):
    from kb.core.paths import resolve_storage_path, storage_rel

    cfg = _cfg(tmp_path)
    abs_p = tmp_path / "storage" / "abc" / "blocks" / "p1" / "b000.png"
    assert storage_rel(cfg, abs_p) == "abc/blocks/p1/b000.png"
    assert resolve_storage_path(cfg, storage_rel(cfg, abs_p)) == abs_p
