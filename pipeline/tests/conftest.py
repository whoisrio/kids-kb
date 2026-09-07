import os

import psycopg
import pytest

from kb.db import migrate


@pytest.fixture()
def clean_db():
    """重置 schema（含 schema_migrations）且不跑 migration，供直接测试 migrate 本身。

    每个测试拿到全新 schema，天然隔离，无需 truncate 清表。
    """
    from kb.db import ensure_test_database

    url = os.environ.get("KB_TEST_DATABASE_URL")
    if not url:
        pytest.skip("需要 KB_TEST_DATABASE_URL（如 postgresql://localhost/kb_test）")
    ensure_test_database(url)
    c = psycopg.connect(url, autocommit=True)
    with c.cursor() as cur:
        cur.execute("DROP SCHEMA public CASCADE")
        cur.execute("DROP EXTENSION IF EXISTS vector CASCADE")
        cur.execute("CREATE SCHEMA public")
    yield c
    c.close()


@pytest.fixture()
def conn(clean_db):
    """已迁移好全部表的干净连接。"""
    migrate(clean_db)
    return clean_db
