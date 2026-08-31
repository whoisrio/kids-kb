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
