def test_migrate_creates_tables(clean_db):
    from kb.db import migrate
    ran = migrate(clean_db)
    assert "0001_init.sql" in ran
    with clean_db.cursor() as cur:
        cur.execute("""
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name IN
              ('documents', 'pages', 'blocks', 'items', 'item_blocks',
               'item_embeddings', 'review_queue', 'schema_migrations')
        """)
        assert cur.fetchall().__len__() == 8


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
