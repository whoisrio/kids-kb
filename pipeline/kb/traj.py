"""Trajectory 事件记录：pipeline_events 表 + JSONL 镜像；记录失败只警告不阻塞主链路。

级别：verbose 记完整 payload（prompt/输出/diff），simple 只记摘要与元信息，off 不记。
JSONL 镜像在 storage/<doc_id>/trajectory/<run_id>.jsonl，只写归档，DB 是事实来源。
"""
from __future__ import annotations

import json
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

from psycopg.types.json import Jsonb


def new_run_id() -> str:
    return str(uuid.uuid4())


class Recorder:
    """一次操作（run）的事件记录器；level=off 时全部方法为 no-op。"""

    def __init__(self, conn, cfg, document_id: str, run_id: str | None = None,
                 actor: str = "pipeline"):
        self._conn = conn
        self._doc_id = str(document_id)
        self.run_id = run_id or new_run_id()
        self._actor = actor
        self._level = getattr(cfg, "trajectory_level", "simple") if cfg else "simple"
        self._storage_dir = Path(cfg.storage_dir) if cfg else None

    @property
    def enabled(self) -> bool:
        return self._level != "off"

    def start(self, stage: str, summary: str, *, page_id=None, payload=None) -> float:
        self._emit(stage, "stage_start", summary, page_id=page_id, payload=payload)
        return time.monotonic()

    def end(self, stage: str, summary: str, *, started: float | None = None,
            page_id=None, item_id=None, payload=None, status: str = "ok") -> None:
        duration_ms = int((time.monotonic() - started) * 1000) if started else None
        self._emit(stage, "stage_end", summary, page_id=page_id, item_id=item_id,
                   payload=payload, duration_ms=duration_ms, status=status)

    def llm_call(self, stage: str, summary: str, *, page_id=None, item_id=None,
                 model=None, usage=(None, None), duration_ms=None,
                 prompt=None, output=None, status: str = "ok") -> None:
        payload = None
        if prompt is not None or output is not None:
            payload = {"prompt": prompt, "output": output}
        self._emit(stage, "llm_call", summary, page_id=page_id, item_id=item_id,
                   payload=payload, model=model, usage=usage,
                   duration_ms=duration_ms, status=status)

    def decision(self, stage: str, summary: str, *, page_id=None, item_id=None,
                 payload=None) -> None:
        self._emit(stage, "decision", summary, page_id=page_id, item_id=item_id,
                   payload=payload)

    def error(self, stage: str, summary: str, *, page_id=None, exc=None) -> None:
        payload = {"traceback": traceback.format_exc()} if exc is not None else None
        self._emit(stage, "error", summary, page_id=page_id, payload=payload,
                   status="error")

    def _emit(self, stage, event_type, summary, *, page_id=None, item_id=None,
              payload=None, model=None, usage=(None, None), duration_ms=None,
              status="ok") -> None:
        if not self.enabled:
            return
        if self._level != "verbose":
            payload = None
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO pipeline_events
                       (run_id, document_id, page_id, item_id, stage, event_type,
                        summary, payload, model, prompt_tokens, completion_tokens,
                        duration_ms, status, actor)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (self.run_id, self._doc_id,
                     str(page_id) if page_id else None,
                     str(item_id) if item_id else None,
                     stage, event_type, summary,
                     Jsonb(payload) if payload is not None else None,
                     model, usage[0], usage[1], duration_ms, status, self._actor),
                )
        except Exception as e:  # noqa: BLE001 - 记录失败不阻塞主链路
            print(f"[traj] 事件写库失败（忽略）: {e}")
            return
        self._mirror(stage, event_type, summary, page_id=page_id, item_id=item_id,
                     payload=payload, model=model, usage=usage,
                     duration_ms=duration_ms, status=status)

    def _mirror(self, stage, event_type, summary, **kw) -> None:
        if self._storage_dir is None:
            return
        try:
            path = (self._storage_dir / self._doc_id / "trajectory"
                    / f"{self.run_id}.jsonl")
            path.parent.mkdir(parents=True, exist_ok=True)
            line = {
                "run_id": self.run_id, "document_id": self._doc_id,
                "stage": stage, "event_type": event_type, "summary": summary,
                "actor": self._actor,
                "created_at": datetime.now(timezone.utc).isoformat(),
                **kw,
            }
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(line, ensure_ascii=False, default=str) + "\n")
        except Exception as e:  # noqa: BLE001 - 镜像失败不阻塞主链路
            print(f"[traj] JSONL 镜像写入失败（忽略）: {e}")
