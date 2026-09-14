"""集中配置：模型与端点全部走 .env / 环境变量，不写死。"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


LAYOUT_MODELS = ("PP-DocLayoutV2", "PP-DocLayoutV3")


@dataclass(frozen=True)
class Config:
    database_url: str
    storage_dir: Path
    vision_base_url: str
    vision_api_key: str
    vision_model: str
    dpi: int = 200
    layout_engine: str = "paddleocr"
    layout_model: str = "PP-DocLayoutV3"
    vision_compare_model: str | None = None
    doc_ognize_base_url: str | None = None  # 整理文档内容的模型渠道，留空回落 vision
    doc_ognize_api_key: str | None = None
    doc_ognize_model: str | None = None
    heading_base_url: str | None = None  # 标题层级判定的模型渠道，留空逐项回落 doc_ognize → vision
    heading_api_key: str | None = None
    heading_model: str | None = None
    embed_base_url: str = "http://localhost:11434"
    embed_model: str = "bge-m3"
    chunk_max_chars: int = 500
    chunk_overlap_ratio: float = 0.1
    layout_min_figure_ratio: float = 0.005  # figure 块面积占页比 < 此值视为小图标/装饰图丢弃；0 关闭
    trajectory_level: str = "simple"  # KB_TRAJECTORY_LEVEL: verbose|simple|off

    def doc_ognize_endpoint(self) -> tuple[str, str, str]:
        """整理文档内容模型的 (base_url, api_key, model)；未配置逐项回落 vision 渠道。"""
        return (
            self.doc_ognize_base_url or self.vision_base_url,
            self.doc_ognize_api_key or self.vision_api_key,
            self.doc_ognize_model or self.vision_model,
        )

    def heading_endpoint(self) -> tuple[str, str, str]:
        """标题层级判定模型的 (base_url, api_key, model)；未配置逐项回落 doc_ognize 渠道。"""
        base_url, api_key, model = self.doc_ognize_endpoint()
        return (
            self.heading_base_url or base_url,
            self.heading_api_key or api_key,
            self.heading_model or model,
        )


def load_config(env_path: str | os.PathLike[str] = ".env") -> Config:
    load_dotenv(env_path)
    db = os.environ.get("KB_DATABASE_URL")
    if not db:
        raise SystemExit("缺少 KB_DATABASE_URL（如 postgresql://localhost/kb）")
    layout_model = os.environ.get("KB_LAYOUT_MODEL", "PP-DocLayoutV3")
    if layout_model not in LAYOUT_MODELS:
        raise SystemExit(
            f"非法 KB_LAYOUT_MODEL: {layout_model}"
            f"（合法值: {' | '.join(LAYOUT_MODELS)}）"
        )
    return Config(
        database_url=db,
        storage_dir=Path(os.environ.get("KB_STORAGE_DIR", "storage")),
        vision_base_url=os.environ.get("KB_VISION_BASE_URL", "http://localhost:11434/v1"),
        vision_api_key=os.environ.get("KB_VISION_API_KEY", "ollama"),
        vision_model=os.environ.get("KB_VISION_MODEL", "qwen3:4b"),
        dpi=int(os.environ.get("KB_DPI", "200")),
        layout_engine=os.environ.get("KB_LAYOUT_ENGINE", "paddleocr"),
        layout_model=layout_model,
        vision_compare_model=os.environ.get("KB_VISION_COMPARE_MODEL") or None,
        doc_ognize_base_url=os.environ.get("DOC_OGNIZE_BASE_URL") or None,
        doc_ognize_api_key=os.environ.get("DOC_OGNIZE_API_KEY") or None,
        doc_ognize_model=os.environ.get("DOC_OGNIZE_MODEL") or None,
        heading_base_url=os.environ.get("HEADING_BASE_URL") or None,
        heading_api_key=os.environ.get("HEADING_API_KEY") or None,
        heading_model=os.environ.get("HEADING_MODEL") or None,
        embed_base_url=os.environ.get("KB_EMBED_BASE_URL", "http://localhost:11434"),
        embed_model=os.environ.get("KB_EMBED_MODEL", "bge-m3"),
        chunk_max_chars=int(os.environ.get("KB_CHUNK_MAX_CHARS", "500")),
        chunk_overlap_ratio=float(os.environ.get("KB_CHUNK_OVERLAP_RATIO", "0.1")),
        layout_min_figure_ratio=float(os.environ.get("KB_LAYOUT_MIN_FIGURE_RATIO", "0.005")),
        trajectory_level=os.environ.get("KB_TRAJECTORY_LEVEL", "simple"),
    )
