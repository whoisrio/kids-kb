"""集中配置：模型与端点全部走 .env / 环境变量，不写死。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Config:
    database_url: str
    storage_dir: Path
    vision_base_url: str
    vision_api_key: str
    vision_model: str
    dpi: int = 200
    layout_engine: str = "whole_page"
    vision_compare_model: str | None = None
    doc_ognize_base_url: str | None = None  # 整理文档内容的模型渠道，留空回落 vision
    doc_ognize_api_key: str | None = None
    doc_ognize_model: str | None = None
    embed_base_url: str = "http://localhost:11434"
    embed_model: str = "bge-m3"

    def doc_ognize_endpoint(self) -> tuple[str, str, str]:
        """整理文档内容模型的 (base_url, api_key, model)；未配置逐项回落 vision 渠道。"""
        return (
            self.doc_ognize_base_url or self.vision_base_url,
            self.doc_ognize_api_key or self.vision_api_key,
            self.doc_ognize_model or self.vision_model,
        )


def load_config(env_path: str | os.PathLike[str] = ".env") -> Config:
    load_dotenv(env_path)
    db = os.environ.get("KB_DATABASE_URL")
    if not db:
        raise SystemExit("缺少 KB_DATABASE_URL（如 postgresql://localhost/kb）")
    return Config(
        database_url=db,
        storage_dir=Path(os.environ.get("KB_STORAGE_DIR", "storage")),
        vision_base_url=os.environ.get("KB_VISION_BASE_URL", "http://localhost:11434/v1"),
        vision_api_key=os.environ.get("KB_VISION_API_KEY", "ollama"),
        vision_model=os.environ.get("KB_VISION_MODEL", "qwen3:4b"),
        dpi=int(os.environ.get("KB_DPI", "200")),
        layout_engine=os.environ.get("KB_LAYOUT_ENGINE", "whole_page"),
        vision_compare_model=os.environ.get("KB_VISION_COMPARE_MODEL") or None,
        doc_ognize_base_url=os.environ.get("DOC_OGNIZE_BASE_URL") or None,
        doc_ognize_api_key=os.environ.get("DOC_OGNIZE_API_KEY") or None,
        doc_ognize_model=os.environ.get("DOC_OGNIZE_MODEL") or None,
        embed_base_url=os.environ.get("KB_EMBED_BASE_URL", "http://localhost:11434"),
        embed_model=os.environ.get("KB_EMBED_MODEL", "bge-m3"),
    )