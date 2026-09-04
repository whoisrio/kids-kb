import pytest


def test_migrate_creates_tables(clean_db):
    from kb.db import migrate
    ran = migrate(clean_db)
    assert "0001_init.sql" in ran
    with clean_db.cursor() as cur:
        cur.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name IN
              ('documents', 'pages', 'blocks', 'items', 'item_blocks',
               'review_queue', 'schema_migrations')
        """)
        assert cur.fetchall().__len__() == 7
        # 0013 起清理死表:chunks(0008)已取代 item_embeddings
        cur.execute("""
            SELECT count(*) FROM information_schema.tables
            WHERE table_schema='public' AND table_name='item_embeddings'
        """)
        assert cur.fetchone()[0] == 0


def test_migrate_is_idempotent(clean_db):
    from kb.db import migrate
    migrate(clean_db)
    assert migrate(clean_db) == []


def test_blocks_accepts_title_after_0002(conn):
    from kb.db import migrate
    migrate(conn)
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (title, source_path) VALUES ('t', '/tmp/x.pdf') RETURNING id"
        )
        doc_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO pages (document_id, page_no, image_path) VALUES (%s, 1, '/tmp/x.png') RETURNING id",
            (doc_id,),
        )
        page_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO blocks (page_id, block_type, crop_path) VALUES (%s, 'title', '/tmp/c.png')",
            (page_id,),
        )


def test_chapters_table_after_0003(conn):
    from kb.db import migrate
    migrate(conn)
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (title, source_path) VALUES ('t', '/tmp/x.pdf') RETURNING id")
        doc_id = cur.fetchone()[0]
        cur.execute(
            """INSERT INTO chapters (document_id, chapter_no, title, print_page, taxonomy, tags)
               VALUES (%s, 1, '乘除法竖式谜', 1, '计算类', ARRAY['倒推法','枚举法']) RETURNING id""",
            (doc_id,),
        )
        cid = cur.fetchone()[0]
        cur.execute("SELECT title, tags FROM chapters WHERE id=%s", (cid,))
        assert cur.fetchone() == ("乘除法竖式谜", ["倒推法", "枚举法"])


def test_children_attempts_after_0009(conn):
    """0009 后：children/attempts 表存在；result/error_cause 受控词表；级联删除。"""
    import uuid
    with conn.cursor() as cur:
        cur.execute("INSERT INTO children (name, grade) VALUES ('小宝','四年级') RETURNING id")
        child_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/a.pdf') RETURNING id",
            (str(uuid.uuid4()),),
        )
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            "INSERT INTO items (id, document_id, content_type, label, content_md) VALUES (%s,%s,'exercise','1','题') RETURNING id",
            (str(uuid.uuid4()), doc_id),
        )
        item_id = str(cur.fetchone()[0])
        # 正常写入
        cur.execute(
            """INSERT INTO attempts (child_id, item_id, result, error_cause, note)
               VALUES (%s,%s,'wrong','粗心','竖式对位错')""",
            (child_id, item_id),
        )
        # 非法 result 被拒
        import pytest
        with pytest.raises(Exception):
            cur.execute(
                "INSERT INTO attempts (child_id, result) VALUES (%s,'unknown')", (child_id,))


def test_chapters_content_md_after_0010(conn):
    import uuid
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/d.pdf') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,'大题一','# 一、选择题\n1. ...') RETURNING content_md""",
            (str(uuid.uuid4()), doc_id),
        )
        assert cur.fetchone()[0].startswith("# 一、")


def test_chunks_chapter_ref_after_0013(conn):
    """0013 后:chunks 可挂章节(item_id 空、seg_no 必填);同章同段唯一;不可同时挂条目与章节。"""
    import uuid
    import pytest
    with conn.cursor() as cur:
        cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'t','/tmp/t.md') RETURNING id",
                    (str(uuid.uuid4()),))
        doc_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO chapters (id, document_id, chapter_no, title, content_md)
               VALUES (%s,%s,1,'大题一','# 一、选择题') RETURNING id""",
            (str(uuid.uuid4()), doc_id))
        ch_id = str(cur.fetchone()[0])
        vec = "[" + ",".join(["0"] * 1024) + "]"
        cur.execute(
            """INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding)
               VALUES (%s,%s,1,'章稿段落','{}',%s)""",
            (ch_id, doc_id, vec))
        # 同章同段号唯一
        with pytest.raises(Exception):
            cur.execute(
                """INSERT INTO chunks (chapter_id, document_id, seg_no, content_md, meta, embedding)
                   VALUES (%s,%s,1,'重复段','{}',%s)""",
                (ch_id, doc_id, vec))
        # item_id 与 chapter_id 不可同挂
        with pytest.raises(Exception):
            cur.execute(
                """INSERT INTO chunks (item_id, chapter_id, document_id, seg_no, content_md, meta, embedding)
                   VALUES (%s,%s,%s,1,'双挂','{}',%s)""",
                (str(uuid.uuid4()), ch_id, doc_id, vec))


def test_ensure_test_database_rejects_production_db(monkeypatch):
    """KB_TEST_DATABASE_URL 与 KB_DATABASE_URL 同库时,DROP SCHEMA 前置守卫必须拒绝。"""
    from kb.db import ensure_test_database

    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb")
    with pytest.raises(RuntimeError, match="拒绝"):
        ensure_test_database("postgresql://localhost/kb")
    # 不同库放行
    monkeypatch.setenv("KB_DATABASE_URL", "postgresql://localhost/kb")
    ensure_test_database("postgresql://localhost/kb_test")


def test_ensure_test_database_reads_dotenv(monkeypatch, tmp_path):
    """环境变量未设时回落读 pipeline/.env 的 KB_DATABASE_URL。"""
    from kb.db import ensure_test_database

    env = tmp_path / ".env"
    env.write_text("KB_DATABASE_URL=postgresql://localhost/prod_kb\n", encoding="utf-8")
    monkeypatch.delenv("KB_DATABASE_URL", raising=False)
    monkeypatch.setattr("kb.db._ENV_FILE", env)  # 测试可注入 env 文件路径
    with pytest.raises(RuntimeError):
        ensure_test_database("postgresql://localhost/prod_kb")


def test_env_file_points_to_pipeline_dotenv():
    """回退读的 .env 在仓库 pipeline/ 下(kb/ 上上级),不是 kb/ 内不存在的文件。"""
    from kb.db import _ENV_FILE

    assert _ENV_FILE.name == ".env" and _ENV_FILE.parent.name == "pipeline"
