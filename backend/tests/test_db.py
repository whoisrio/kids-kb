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
