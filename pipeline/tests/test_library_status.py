"""0015: status 改名 + 新增状态列。需要 KB_TEST_DATABASE_URL。"""


def test_parse_status_renamed(conn):
    """documents.status 和 pages.status 改名为 parse_status。"""
    cur = conn.cursor()
    cur.execute("""
        SELECT column_name FROM information_schema.columns
        WHERE table_name='documents' AND column_name='parse_status'
    """)
    assert cur.fetchone() is not None
    cur.execute("""
        SELECT column_name FROM information_schema.columns
        WHERE table_name='pages' AND column_name='parse_status'
    """)
    assert cur.fetchone() is not None
    cur.execute("""
        SELECT column_name FROM information_schema.columns
        WHERE table_name='documents' AND column_name='status'
    """)
    assert cur.fetchone() is None


def test_review_status_columns(conn):
    """documents/pages/chapters 各有 review_status。"""
    cur = conn.cursor()
    for table in ("documents", "pages", "chapters"):
        cur.execute(f"""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='{table}' AND column_name='review_status'
        """)
        assert cur.fetchone() is not None, f"{table} 缺 review_status"


def test_index_status_columns(conn):
    """pages/chapters 各有 index_status。"""
    cur = conn.cursor()
    for table in ("pages", "chapters"):
        cur.execute(f"""
            SELECT column_name FROM information_schema.columns
            WHERE table_name='{table}' AND column_name='index_status'
        """)
        assert cur.fetchone() is not None, f"{table} 缺 index_status"


def test_uploaded_by(conn):
    """documents 有 uploaded_by。"""
    cur = conn.cursor()
    cur.execute("""
        SELECT column_name FROM information_schema.columns
        WHERE table_name='documents' AND column_name='uploaded_by'
    """)
    assert cur.fetchone() is not None
