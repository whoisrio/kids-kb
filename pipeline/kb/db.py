"""pg 连接与 migration 执行（migrations/*.sql 按文件名顺序，已执行的跳过）。"""
from __future__ import annotations

import os
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
_ENV_FILE = MIGRATIONS_DIR.parent.parent / ".env"  # pipeline/.env（kb/ 上一级的上级）


def _db_name(url: str) -> str:
    return url.rstrip("/").split("/")[-1]


def ensure_test_database(test_url: str) -> None:
    """DROP SCHEMA 前置守卫:测试库不得指向 .env 的 KB_DATABASE_URL 同库。
    库放空原因不明的一次教训:守卫必须先于任何破坏性操作。"""
    prod = os.environ.get("KB_DATABASE_URL")
    if prod is None:
        from dotenv import dotenv_values
        prod = dotenv_values(_ENV_FILE).get("KB_DATABASE_URL") if _ENV_FILE.exists() else None
    if prod and _db_name(prod) == _db_name(test_url):
        raise RuntimeError(
            f"测试库 {test_url} 指向了 KB_DATABASE_URL 同库({_db_name(test_url)}),"
            "拒绝 DROP SCHEMA——请用独立测试库(如 postgresql://localhost/kb_test)")


def connect(database_url: str) -> psycopg.Connection:
    return psycopg.connect(database_url, autocommit=True)


def migrate(conn: psycopg.Connection) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations "
            "(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
        )
        applied = {r[0] for r in cur.execute("SELECT name FROM schema_migrations")}
        ran = []
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.name in applied:
                continue
            cur.execute(path.read_text(encoding="utf-8"))
            cur.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
            ran.append(path.name)
        return ran
