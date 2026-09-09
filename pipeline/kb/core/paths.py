"""图片路径基准：DB 一律存相对 KB_STORAGE_DIR 的 POSIX 相对路径（spec §7.1）。

绝对路径原样透传（兼容 documents.source_path / papers.source_path 与历史数据）。
"""
from __future__ import annotations

from pathlib import Path


def resolve_storage_path(cfg, p: str) -> Path:
    """DB 路径 -> 文件系统路径。相对者以 storage_dir 为基准。"""
    path = Path(p)
    return path if path.is_absolute() else Path(cfg.storage_dir) / path


def storage_rel(cfg, p) -> str:
    """文件系统路径 -> 落库形态（相对 storage_dir 的 POSIX 字符串）。"""
    return Path(p).resolve().relative_to(Path(cfg.storage_dir).resolve()).as_posix()
