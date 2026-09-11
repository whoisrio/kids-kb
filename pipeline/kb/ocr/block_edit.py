"""块几何编辑：调框 preview/commit 与合并/拆分后重裁（spec §6.3）。

preview 不落库（新旧文本 diff 由用户确认）；commit 才写 blocks 并标 stale。
bbox 一律页图像素、存用户/检测原始值；padding 只在裁图时加（pad.py）。
"""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from psycopg.types.json import Jsonb

from kb.core.paths import resolve_storage_path, storage_rel
from kb.ocr.layout import crop_image
from kb.ocr.pad import padded_px_bbox
from kb.ocr.parse import ocr_image, starred_math, transcribe_image

_OCRABLE_TYPES = {"text", "title", "header", "footer"}


def _page_and_neighbors(cur, block_id: str):
    cur.execute(
        """SELECT b.page_id::text, p.image_path, p.document_id::text
           FROM blocks b JOIN pages p ON p.id = b.page_id WHERE b.id=%s""",
        (block_id,),
    )
    row = cur.fetchone()
    if not row:
        raise KeyError(f"块不存在: {block_id}")
    page_id, image_path, doc_id = row
    cur.execute(
        "SELECT id::text, bbox, ordinal, block_type FROM blocks WHERE page_id=%s ORDER BY ordinal",
        (page_id,),
    )
    return page_id, image_path, doc_id, cur.fetchall()


def _neighbors_of(blocks, block_id: str | None, ordinal_hint: int | None):
    boxes = [(block[0], block[1], block[2]) for block in blocks if block[0] != block_id]
    previous = following = None
    for block_id_value, bbox, ordinal in boxes:
        if ordinal_hint is not None and ordinal < ordinal_hint:
            previous = bbox
        elif ordinal_hint is not None and ordinal > ordinal_hint and following is None:
            following = bbox
    return previous, following


def _recognize(cfg, block_type: str, crop_path: Path, client, ocr):
    ocr = ocr or ocr_image
    if client is None:
        from kb.ocr.parse import OpenAI

        client = OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    if block_type in _OCRABLE_TYPES:
        text = ocr(str(crop_path))
        if starred_math(text):
            text, _usage = transcribe_image(client, cfg.vision_model, str(crop_path))
            return text, cfg.vision_model
        return text, "rapidocr"
    text, _usage = transcribe_image(client, cfg.vision_model, str(crop_path))
    return text, cfg.vision_model


def preview_block_geometry(
    conn, cfg, block_id: str, bbox: list[float], client=None, ocr=None,
) -> dict:
    import pymupdf as fitz

    with conn.cursor() as cur:
        page_id, image_path, doc_id, blocks = _page_and_neighbors(cur, block_id)
        cur.execute("SELECT block_type, ordinal FROM blocks WHERE id=%s", (block_id,))
        block_type, ordinal = cur.fetchone()
    page_image = resolve_storage_path(cfg, image_path)
    pixmap = fitz.Pixmap(str(page_image))
    page_size = (pixmap.width, pixmap.height)
    del pixmap
    previous_bbox, next_bbox = _neighbors_of(blocks, block_id, ordinal)
    padded, padding = padded_px_bbox(
        tuple(bbox), block_type, cfg.dpi, page_size,
        prev_bbox=previous_bbox, next_bbox=next_bbox,
    )
    staging = (
        Path(cfg.storage_dir) / doc_id / "blocks" / page_id
        / f"staging_{uuid.uuid4().hex[:8]}.png"
    )
    staging.parent.mkdir(parents=True, exist_ok=True)
    crop_image(str(page_image), padded, staging)
    text, source_model = _recognize(cfg, block_type, staging, client, ocr)
    return {
        "text": text,
        "source_model": source_model,
        "crop_pad": padding,
        "staging": storage_rel(cfg, staging),
    }


def commit_block_geometry(
    conn, cfg, block_id: str, bbox: list[float], staging: str,
    adopted_text: str, source_model: str,
) -> dict:
    import pymupdf as fitz

    staging_path = resolve_storage_path(cfg, staging)
    with conn.cursor() as cur:
        page_id, image_path, doc_id, blocks = _page_and_neighbors(cur, block_id)
        cur.execute(
            "SELECT block_type, ordinal, crop_path FROM blocks WHERE id=%s", (block_id,))
        block_type, ordinal, crop_path = cur.fetchone()
    page_image = resolve_storage_path(cfg, image_path)
    pixmap = fitz.Pixmap(str(page_image))
    page_size = (pixmap.width, pixmap.height)
    del pixmap
    previous_bbox, next_bbox = _neighbors_of(blocks, block_id, ordinal)
    _padded, padding = padded_px_bbox(
        tuple(bbox), block_type, cfg.dpi, page_size,
        prev_bbox=previous_bbox, next_bbox=next_bbox,
    )
    crop_path = resolve_storage_path(cfg, crop_path)
    final_temporary_path = crop_path.with_name(
        f".{uuid.uuid4().hex}-{crop_path.name}")
    backup_path = crop_path.with_name(f".{uuid.uuid4().hex}-{crop_path.name}.bak")
    shutil.copy2(crop_path, backup_path)
    moved = False
    try:
        with conn.transaction(), conn.cursor() as cur:
            cur.execute(
                """UPDATE blocks SET bbox=%s, crop_pad=%s, content_md=%s, source_model=%s,
                       geometry_revision=geometry_revision+1
                   WHERE id=%s""",
                (Jsonb([float(value) for value in bbox]), Jsonb(padding), adopted_text,
                 source_model, block_id),
            )
            cur.execute(
                "UPDATE chunks SET state='stale' WHERE source_block_ids && ARRAY[%s::uuid]",
                (block_id,),
            )
            cur.execute(
                "UPDATE pages SET index_status='stale', index_error=NULL WHERE id=%s", (page_id,))
            cur.execute(
                """INSERT INTO pipeline_events (run_id, document_id, page_id, stage, event_type,
                                                actor, summary, payload, status)
                   VALUES (gen_random_uuid(), %s,%s,'user_edit','block_geometry','user',%s,%s,'ok')""",
                (doc_id, page_id, f"调框 {block_id[:8]} → rev+1",
                 Jsonb({"block_id": block_id, "bbox": bbox, "crop_pad": padding})),
            )
            shutil.move(str(staging_path), str(final_temporary_path))
            final_temporary_path.replace(crop_path)
            moved = True
    except Exception:
        if moved:
            shutil.copy2(backup_path, crop_path)
        raise
    finally:
        backup_path.unlink(missing_ok=True)
        final_temporary_path.unlink(missing_ok=True)
    return {"ok": True, "crop_pad": padding}


def recrop_block(conn, cfg, block_id: str) -> dict:
    import pymupdf as fitz

    with conn.cursor() as cur:
        page_id, image_path, _doc_id, blocks = _page_and_neighbors(cur, block_id)
        cur.execute(
            "SELECT bbox, block_type, ordinal, crop_path FROM blocks WHERE id=%s", (block_id,))
        bbox, block_type, ordinal, crop_path = cur.fetchone()
    page_image = resolve_storage_path(cfg, image_path)
    pixmap = fitz.Pixmap(str(page_image))
    page_size = (pixmap.width, pixmap.height)
    del pixmap
    previous_bbox, next_bbox = _neighbors_of(blocks, block_id, ordinal)
    padded, padding = padded_px_bbox(
        tuple(bbox), block_type, cfg.dpi, page_size,
        prev_bbox=previous_bbox, next_bbox=next_bbox,
    )
    crop_image(str(page_image), padded, str(resolve_storage_path(cfg, crop_path)))
    with conn.cursor() as cur:
        cur.execute("UPDATE blocks SET crop_pad=%s WHERE id=%s", (Jsonb(padding), block_id))
    return {"ok": True, "crop_pad": padding}


def create_block(
    conn, cfg, page_id: str, bbox: list[float], block_type: str = "text",
    client=None, ocr=None,
) -> dict:
    import pymupdf as fitz

    if block_type not in {"text", "title", "formula", "figure", "table", "header", "footer"}:
        raise ValueError(f"非法 block_type: {block_type}")
    with conn.cursor() as cur:
        cur.execute("SELECT image_path, document_id::text FROM pages WHERE id=%s", (page_id,))
        row = cur.fetchone()
        if not row:
            raise KeyError(f"页不存在: {page_id}")
        image_path, doc_id = row
        cur.execute(
            "SELECT id::text, bbox, ordinal FROM blocks WHERE page_id=%s ORDER BY ordinal",
            (page_id,),
        )
        blocks = cur.fetchall()
    page_image = resolve_storage_path(cfg, image_path)
    pixmap = fitz.Pixmap(str(page_image))
    page_size = (pixmap.width, pixmap.height)
    del pixmap
    x0 = max(0.0, min(float(bbox[0]), page_size[0]))
    y0 = max(0.0, min(float(bbox[1]), page_size[1]))
    x1 = max(0.0, min(float(bbox[2]), page_size[0]))
    y1 = max(0.0, min(float(bbox[3]), page_size[1]))
    if x1 - x0 < 2 or y1 - y0 < 2:
        raise ValueError("框太小（<2px），不是有效块")
    insertion_ordinal = 1 + sum(
        1 for _block_id, block_bbox, _ordinal in blocks
        if block_bbox and float(block_bbox[1]) < y0
    )
    previous_bbox = next(
        (block_bbox for _block_id, block_bbox, ordinal in reversed(blocks)
         if ordinal < insertion_ordinal and block_bbox),
        None,
    )
    next_bbox = next(
        (block_bbox for _block_id, block_bbox, ordinal in blocks
         if ordinal >= insertion_ordinal and block_bbox),
        None,
    )
    padded, padding = padded_px_bbox(
        (x0, y0, x1, y1), block_type, cfg.dpi, page_size,
        prev_bbox=previous_bbox, next_bbox=next_bbox,
    )
    new_id = str(uuid.uuid4())
    crop = Path(cfg.storage_dir) / doc_id / "blocks" / page_id / f"b-{new_id}.png"
    crop.parent.mkdir(parents=True, exist_ok=True)
    crop_image(str(page_image), padded, crop)
    text, source_model = _recognize(cfg, block_type, crop, client, ocr)
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            "UPDATE blocks SET ordinal=ordinal+1 WHERE page_id=%s AND ordinal>=%s",
            (page_id, insertion_ordinal),
        )
        cur.execute(
            """INSERT INTO blocks (id, page_id, block_type, bbox, crop_path, crop_pad,
                                   content_md, source_model, ordinal, origin)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'manual')""",
            (new_id, page_id, block_type, Jsonb([x0, y0, x1, y1]),
             storage_rel(cfg, crop), Jsonb(padding), text, source_model, insertion_ordinal),
        )
        cur.execute(
            "UPDATE pages SET index_status='stale', index_error=NULL WHERE id=%s", (page_id,))
        cur.execute(
            """INSERT INTO pipeline_events (run_id, document_id, page_id, stage, event_type,
                                            actor, summary, payload, status)
               VALUES (gen_random_uuid(), %s,%s,'user_edit','block_create','user',%s,%s,'ok')""",
            (doc_id, page_id, f"补画块 {new_id[:8]}",
             Jsonb({"block_id": new_id, "bbox": [x0, y0, x1, y1], "block_type": block_type})),
        )
    return {
        "block": {
            "id": new_id,
            "origin": "manual",
            "content_md": text,
            "ordinal": insertion_ordinal,
            "crop_path": storage_rel(cfg, crop),
            "crop_pad": padding,
        }
    }
