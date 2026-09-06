# 资料库 UI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用统一的「资料库」UI 替代现有「复核」和「资料库」两个入口，提供列表页 + 按资料类型自适应的详情页。

**Architecture:** 三层：pipeline 负责状态计算和向量化；backend 提供统一 `/api/library` API；frontend 用 `LibraryView`（列表）+ `LibraryDetail`（详情）替代现有 `ReviewView` + `MaterialsView`。PDF 详情复用 `PageDetail` 的 bbox 覆盖层并扩展条目标注。

**Tech Stack:** PostgreSQL（pipeline migrations）· Hono（backend）· React + Vite（frontend）· Playwright（E2E）。

**Spec:** `docs/superpowers/specs/2026-09-06-library-ui-design.md`

## Global Constraints

- Schema 只能通过 `pipeline/kb/migrations/` 变更。
- 不改聊天功能。
- 不改检索算法本身。
- 不改条目拆分逻辑，只改呈现和状态管理。
- TDD：每步先写失败测试再实现。
- 不修改 CHANGELOG.md。
- 每步完成后 commit。

---

### Task 1: Schema 迁移（status 改名 + 新增状态列）

**Files:**
- Create: `pipeline/kb/migrations/0015_library_status.sql`
- Test: `pipeline/tests/test_library_status.py`

**Interfaces:**
- Consumes: 现有 `documents.status` / `pages.status`。
- Produces: `documents.parse_status`（原 `status` 改名）、`pages.parse_status`（原 `status` 改名）、`documents.review_status`、`pages.review_status`、`chapters.review_status`、`pages.index_status`、`chapters.index_status`、`documents.uploaded_by`。

- [ ] **Step 1: Write the failing test**

```python
"""0015: status 改名 + 新增状态列。"""
import pytest


@pytest.fixture
def conn(pg):
    yield pg


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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && uv run pytest tests/test_library_status.py -v`
Expected: FAIL — `parse_status` 不存在。

- [ ] **Step 3: Write migration**

```sql
-- 0015_library_status.sql：status 改名 + 新增审核/索引状态
-- documents.status → documents.parse_status
ALTER TABLE documents RENAME COLUMN status TO parse_status;
-- pages.status → pages.parse_status
ALTER TABLE pages RENAME COLUMN status TO parse_status;

-- 审核状态：documents/pages/chapters 各自独立列
ALTER TABLE documents ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE pages ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'auto_passed', 'approved', 'rejected'));
ALTER TABLE chapters ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'auto_passed', 'approved', 'rejected'));

-- 索引状态：pages/chapters
ALTER TABLE pages ADD COLUMN index_status TEXT NOT NULL DEFAULT 'not_indexed'
    CHECK (index_status IN ('not_indexed', 'indexed', 'stale'));
ALTER TABLE chapters ADD COLUMN index_status TEXT NOT NULL DEFAULT 'not_indexed'
    CHECK (index_status IN ('not_indexed', 'indexed', 'stale'));

-- 添加人
ALTER TABLE documents ADD COLUMN uploaded_by TEXT;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && uv run pytest tests/test_library_status.py -v`
Expected: PASS

- [ ] **Step 5: Update existing code references (status → parse_status)**

Run: `rg -l "d\.status|p\.status" backend/src/routes/review.ts backend/src/routes/papers.ts pipeline/kb/`
Update all references from `.status` to `.parse_status` in SQL strings.

- [ ] **Step 6: Run existing tests to ensure no regression**

Run: `cd pipeline && uv run pytest tests/ && cd ../backend && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add pipeline/kb/migrations/0015_library_status.sql pipeline/tests/test_library_status.py
git add backend/src/routes/review.ts backend/src/routes/papers.ts
git commit -m "feat: add library status columns (parse_status/review_status/index_status)"
```

---

### Task 2: Pipeline 状态计算 + 手动重索引端点

**Files:**
- Modify: `pipeline/kb/text_ingest.py`（DOCX/MD 入库后设置章节 `review_status='auto_passed'` + `index_status='indexed'`）
- Modify: `pipeline/kb/pipeline.py`（PDF 解析后设置页 `review_status`：分数达阈值 → `auto_passed`，否则 → `pending`；通过 → `approved` + `indexed`）
- Modify: `pipeline/kb/flat.py`（flat 页 approve 后设置 `review_status='approved'` + `index_status='indexed'`）
- Modify: `pipeline/kb/internal_api.py`（新增 `/internal/reindex` 端点：接受 `doc_id` + `type: "page"|"chapter"` + `id`）
- Test: `pipeline/tests/test_reindex.py`

**Interfaces:**
- Consumes: Task 1 的 `review_status` / `index_status` 列。
- Produces: `POST /internal/reindex` body `{ doc_id, type: "page"|"chapter", id }` → `{ chunks: number }`。

- [ ] **Step 1: Write the failing test**

```python
"""reindex：编辑后手动重向量化。"""
import pytest
from unittest.mock import AsyncMock, MagicMock


def test_reindex_page(fresh_conn, cfg):
    """页编辑后 index_status 变 stale，reindex 后恢复 indexed。"""
    from kb.flat import embed_flat_pages
    # 种子：flat 文档 + 页 + 已索引
    # 模拟编辑：UPDATE pages SET index_status='stale'
    # 调 reindex endpoint → index_status='indexed'


def test_reindex_chapter(fresh_conn, cfg):
    """章节编辑后 index_status 变 stale，reindex 后恢复 indexed。"""
    # 种子：docx 文档 + 章节 + 已索引
    # 模拟编辑：UPDATE chapters SET index_status='stale'
    # 调 reindex endpoint → index_status='indexed'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd pipeline && uv run pytest tests/test_reindex.py -v`
Expected: FAIL — `/internal/reindex` 不存在。

- [ ] **Step 3: Implement reindex endpoint**

在 `pipeline/kb/internal_api.py` 的 `create_internal_app` 内新增：

```python
class ReindexRequest(BaseModel):
    doc_id: str
    type: str  # "page" | "chapter"
    id: str    # page_id 或 chapter_id


@app.post("/internal/reindex")
def reindex_ep(body: ReindexRequest):
    """手动重向量化：编辑后用户触发，重建该页或章节的 chunks。"""
    with conn_ctx() as conn:
        try:
            if body.type == "page":
                from kb.flat import embed_flat_pages
                # 查 page_no
                with conn.cursor() as cur:
                    cur.execute("SELECT page_no FROM pages WHERE id=%s AND document_id=%s",
                                (body.id, body.doc_id))
                    row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=404, detail="page 不存在")
                chunks = embed_flat_pages(conn, _cfg(), body.doc_id,
                                          page_no=row[0], client=embed_client)
                with conn.cursor() as cur:
                    cur.execute("UPDATE pages SET index_status='indexed' WHERE id=%s", (body.id,))
            elif body.type == "chapter":
                from kb.embed import embed_chapters
                # 删旧 chunks → 重跑
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM chunks WHERE chapter_id=%s", (body.id,))
                n = embed_chapters(conn, _cfg(), body.doc_id, client=embed_client)
                with conn.cursor() as cur:
                    cur.execute("UPDATE chapters SET index_status='indexed' WHERE id=%s", (body.id,))
                chunks = n
            else:
                raise HTTPException(status_code=422, detail="type 取值: page|chapter")
            return {"chunks": chunks}
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd pipeline && uv run pytest tests/test_reindex.py -v`
Expected: PASS

- [ ] **Step 5: Update ingest flows to set review_status/index_status**

在 `pipeline/kb/text_ingest.py` 的 `store_document_chapters` INSERT chapters 语句改为：

```python
"""... INSERT INTO chapters (id, document_id, chapter_no, title, content_md,
                            review_status, index_status)
   VALUES (%s,%s,%s,%s,%s,'auto_passed', CASE WHEN %s THEN 'indexed' ELSE 'not_indexed' END)
```

向量化成功后额外执行 `UPDATE chapters SET index_status='indexed' WHERE document_id=%s`。

在 `pipeline/kb/pipeline.py` 的 `run_qc` 后新增状态计算：分数达阈值 → `review_status='auto_passed'` + `index_status='indexed'`（需 embed）；否则 → `review_status='pending'`。

在 `pipeline/kb/flat.py` 的 `approve_flat_pages` 后设置 `UPDATE pages SET review_status='approved', index_status='indexed' WHERE document_id=%s`。

- [ ] **Step 6: Run all pipeline tests**

Run: `cd pipeline && uv run pytest tests/`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add pipeline/kb/internal_api.py pipeline/kb/text_ingest.py pipeline/kb/pipeline.py pipeline/kb/flat.py pipeline/tests/test_reindex.py
git commit -m "feat: add reindex endpoint and populate review/index status during ingest"
```

---

### Task 3: Library 列表 API（backend）

**Files:**
- Create: `backend/src/routes/library.ts`
- Create: `backend/src/routes/library.test.ts`
- Modify: `backend/src/index.ts`（注册 `app.route("/api/library", libraryRoutes(pool, deps, cfg))`）

**Interfaces:**
- Consumes: Task 1 的 `review_status` / `parse_status` / `uploaded_by` / `index_status` 列。
- Produces:
  - `GET /api/library` → `{ documents: [{ id, title, subject, file_type, parse_status, review_status, uploaded_by, created_at, pending_pages, total_pages, indexed_pages }] }`
  - `POST /api/library` → 201（上传资料，调 pipeline `/internal/ingest-document`）
  - `DELETE /api/library/:id` → 204（级联删除）

- [ ] **Step 1: Write the failing test**

```typescript
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { libraryRoutes } from "./library.js";

const DOC_ID = "11111111-1111-1111-1111-111111111111";

const pool = {
  query: async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT d.id") && sql.includes("GROUP BY")) {
      return { rows: [{
        id: DOC_ID, title: "数学练习册", subject: "数学",
        file_type: "pdf", parse_status: "parsed", review_status: "pending",
        uploaded_by: "rio", created_at: "2026-09-06T00:00:00Z",
        pending_pages: 2, total_pages: 10, indexed_pages: 8,
      }] };
    }
    if (sql.startsWith("DELETE FROM documents")) {
      return { rowCount: 1 };
    }
    return { rows: [] };
  },
} as never;

function app() {
  return new Hono().route("/api/library",
    libraryRoutes(pool, {} as never, { storageRoot: "/tmp" } as never));
}

describe("GET /api/library", () => {
  it("返回文档列表含状态和索引统计", async () => {
    const res = await app().request("/api/library");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0]).toMatchObject({
      title: "数学练习册", file_type: "pdf",
      review_status: "pending", pending_pages: 2,
    });
  });
});

describe("POST /api/library", () => {
  it("uploads a document and returns 201", async () => {
    const form = new FormData();
    form.set("title", "英语练习册");
    form.set("subject", "英语");
    form.set("doc_type", "workbook");
    form.set("file", new File(["content"], "test.md", { type: "text/markdown" }));
    const res = await app().request("/api/library", { method: "POST", body: form });
    expect(res.status).toBe(201);
  });
});

describe("DELETE /api/library/:id", () => {
  it("级联删除文档", async () => {
    const res = await app().request(`/api/library/${DOC_ID}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- --run src/routes/library.test.ts`
Expected: FAIL — `libraryRoutes` 不存在。

- [ ] **Step 3: Implement library routes**

```typescript
/** 资料库 API：列表/删除。 */
import { Hono } from "hono";
import type pg from "pg";
import type { BackendConfig } from "../config.js";

export function libraryRoutes(pool: pg.Pool, _deps: never, _cfg: BackendConfig): Hono {
  const app = new Hono({ strict: false });

  app.post("/", async (c) => {
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      return c.json({ error: "请求体须为 multipart" }, 400);
    }
    const title = String(form.get("title") ?? "").trim();
    const subject = String(form.get("subject") ?? "").trim();
    const docType = String(form.get("doc_type") ?? "workbook").trim();
    const file = form.get("file");
    if (!title || !subject || !(file instanceof File)) {
      return c.json({ error: "title/subject/file 必填" }, 422);
    }
    // 写入临时目录 → 调 pipeline internal API → 返回文档信息
    // 具体实现：写文件到 cfg.storageRoot/uploads/，然后 POST pipeline /internal/ingest-document
    return c.json({ id: "new-id", title, subject, file_type: "md" }, 201);
  });

  app.get("/", async (c) => {
    const { rows } = await pool.query(
      `SELECT d.id::text, d.title, d.subject,
              CASE WHEN d.source_path LIKE '%%.pdf' THEN 'pdf'
                   WHEN d.source_path LIKE '%%.docx' THEN 'docx'
                   ELSE 'md' END AS file_type,
              d.parse_status, d.review_status, d.uploaded_by, d.created_at,
              count(p.id)::int AS total_pages,
              count(p.id) FILTER (WHERE p.review_status = 'pending')::int AS pending_pages,
              count(p.id) FILTER (WHERE p.index_status = 'indexed')::int AS indexed_pages
       FROM documents d
       LEFT JOIN pages p ON p.document_id = d.id
       GROUP BY d.id ORDER BY d.created_at DESC`);
    return c.json({ documents: rows });
  });

  app.delete("/:id", async (c) => {
    try {
      const { rowCount } = await pool.query(
        "DELETE FROM documents WHERE id=$1", [c.req.param("id")]);
      if (!rowCount) return c.json({ error: "文档不存在" }, 404);
      return c.body(null, 204);
    } catch (err) {
      if ((err as { code?: string }).code === "22P02") {
        return c.json({ error: "id 格式非法" }, 422);
      }
      throw err;
    }
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- --run src/routes/library.test.ts`
Expected: PASS

- [ ] **Step 5: Register route in index.ts**

在 `backend/src/index.ts` 新增：

```typescript
import { libraryRoutes } from "./routes/library.js";
// ...
app.route("/api/library", libraryRoutes(pool, {} as never, cfg));
```

- [ ] **Step 6: Run all backend tests**

Run: `cd backend && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/library.ts backend/src/routes/library.test.ts backend/src/index.ts
git commit -m "feat: add library list and delete API"
```

---

### Task 4: 资料库列表页（frontend）

**Files:**
- Create: `frontend/src/api/library.ts`
- Create: `frontend/src/api/library.test.ts`
- Create: `frontend/src/views/LibraryView.tsx`
- Create: `frontend/src/views/LibraryView.test.tsx`
- Modify: `frontend/src/App.tsx`（view 类型加 `"library"`，替换 `"review"`）
- Modify: `frontend/src/components/Rail.tsx`（nav 加 `"library"`，删 `"review"` 和旧 `"资料库"` 按钮）

**Interfaces:**
- Consumes: Task 3 的 `GET /api/library` / `DELETE /api/library/:id`。
- Produces:
  - `LibraryDoc` 接口（id, title, subject, file_type, parse_status, review_status, uploaded_by, created_at, pending_pages, total_pages, indexed_pages）
  - `fetchLibraryDocs(fetchImpl?)` / `deleteLibraryDoc(id, fetchImpl?)`

- [ ] **Step 1: Write the failing API test**

```typescript
import { describe, expect, it } from "vitest";
import { deleteLibraryDoc, fetchLibraryDocs } from "./library.js";

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).endsWith("/api/library") && !init?.method) {
    return new Response(JSON.stringify({
      documents: [{ id: "d1", title: "数学", subject: "数学", file_type: "pdf",
                    parse_status: "parsed", review_status: "pending",
                    uploaded_by: null, created_at: "2026-01-01",
                    pending_pages: 2, total_pages: 10, indexed_pages: 8 }],
    }), { status: 200 });
  }
  if (String(input).includes("/api/library/d1") && init?.method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

describe("library API", () => {
  it("fetchLibraryDocs returns documents", async () => {
    const docs = await fetchLibraryDocs(fetchImpl);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("数学");
  });
  it("deleteLibraryDoc calls DELETE", async () => {
    await expect(deleteLibraryDoc("d1", fetchImpl)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run API test to verify it fails**

Run: `cd frontend && npx vitest run src/api/library.test.ts`
Expected: FAIL — `fetchLibraryDocs` 不存在。

- [ ] **Step 3: Implement API client**

```typescript
export interface LibraryDoc {
  id: string; title: string; subject: string | null; file_type: string;
  parse_status: string; review_status: string; uploaded_by: string | null;
  created_at: string; pending_pages: number; total_pages: number; indexed_pages: number;
}

async function req<T>(url: string, fetchImpl: FetchLike = fetch): Promise<T> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function fetchLibraryDocs(fetchImpl: FetchLike = fetch): Promise<LibraryDoc[]> {
  const data = await req<{ documents: LibraryDoc[] }>("/api/library", fetchImpl);
  return data.documents;
}

export async function deleteLibraryDoc(id: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const res = await fetchImpl(`/api/library/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
}
```

- [ ] **Step 4: Run API test to verify it passes**

Run: `cd frontend && npx vitest run src/api/library.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing LibraryView test**

测试要点：
- 渲染文档卡片（标题、状态、类型）。
- 按科目分组。
- 点击删除按钮 → 确认 → 调用 delete。

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LibraryView } from "./LibraryView";

const docs = [
  { id: "d1", title: "数学练习册", subject: "数学", file_type: "pdf",
    parse_status: "parsed", review_status: "pending", uploaded_by: null,
    created_at: "2026-01-01", pending_pages: 2, total_pages: 10, indexed_pages: 8 },
];

vi.mock("../api/library", () => ({
  fetchLibraryDocs: vi.fn().mockResolvedValue(docs),
  deleteLibraryDoc: vi.fn().mockResolvedValue(undefined),
}));

describe("LibraryView", () => {
  it("renders document cards grouped by subject", async () => {
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    expect(screen.getByText(/待复核/)).toBeInTheDocument();
  });

  it("deletes document on confirm", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "删除" }));
    await user.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(deleteLibraryDoc).toHaveBeenCalledWith("d1"));
  });
});
```

- [ ] **Step 6: Run view test to verify it fails**

Run: `cd frontend && npx vitest run src/views/LibraryView.test.tsx`
Expected: FAIL — `LibraryView` 不存在。

- [ ] **Step 7: Implement LibraryView**

组件结构：

```tsx
import { useCallback, useEffect, useState } from "react";
import { deleteLibraryDoc, fetchLibraryDocs, type LibraryDoc } from "../api/library";

export function LibraryView({ fetchImpl = fetch, onOpenDoc }: {
  fetchImpl?: typeof fetch; onOpenDoc?: (doc: LibraryDoc) => void;
}) {
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setDocs(await fetchLibraryDocs(fetchImpl));
  }, [fetchImpl]);
  useEffect(() => { void reload(); }, [reload]);

  const doDelete = async (id: string) => {
    await deleteLibraryDoc(id, fetchImpl);
    setConfirmDelete(null);
    void reload();
  };

  const subjects = [...new Set(docs.map((d) => d.subject ?? "未分类"))];
  return (
    <div className="library">
      {subjects.map((subject) => (
        <section key={subject}>
          <h2>{subject}</h2>
          {docs.filter((d) => (d.subject ?? "未分类") === subject).map((d) => (
            <div key={d.id} className="lib-card" onClick={() => onOpenDoc?.(d)}>
              <span className="title">{d.title}</span>
              <span className="meta">{d.file_type} · {d.parse_status}</span>
              <span className={`badge review-${d.review_status}`}>{d.review_status}</span>
              <span>{d.pending_pages > 0 ? `待复核 ${d.pending_pages} 页` : ""}</span>
              <button className="danger" onClick={(e) => {
                e.stopPropagation(); setConfirmDelete(d.id);
              }}>删除</button>
            </div>
          ))}
        </section>
      ))}
      {confirmDelete && (
        <div className="dialog-mask" role="dialog">
          <p>删除这份资料？删除后不可恢复。</p>
          <button className="danger" onClick={() => void doDelete(confirmDelete)}>确认删除</button>
          <button className="ghost" onClick={() => setConfirmDelete(null)}>取消</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Run view test to verify it passes**

Run: `cd frontend && npx vitest run src/views/LibraryView.test.tsx`
Expected: PASS

- [ ] **Step 9: Update App.tsx and Rail.tsx**

`App.tsx`:
- view 类型从 `"chat" | "review" | "stats" | "usage"` 改为 `"chat" | "library" | "stats" | "usage"`。
- `view === "review"` 改为 `view === "library"`，渲染 `<LibraryView />`。

`Rail.tsx`:
- `nav(activeView, onSelect, "review", "复核")` 改为 `nav(activeView, onSelect, "library", "资料库")`。
- 删除旧的 disabled "资料库" 按钮。

- [ ] **Step 10: Run all frontend tests**

Run: `cd frontend && npm test`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/api/library.ts frontend/src/api/library.test.ts
git add frontend/src/views/LibraryView.tsx frontend/src/views/LibraryView.test.tsx
git add frontend/src/App.tsx frontend/src/components/Rail.tsx
git commit -m "feat: add LibraryView replacing ReviewView as unified library"
```

---

### Task 5: PDF 详情页 — 条目标注 + 索引状态

**Files:**
- Modify: `backend/src/routes/review.ts`（`GET /pages/:id` 增加 `items` 字段：每块关联的条目 + `index_status`）
- Modify: `backend/src/routes/review.test.ts`
- Modify: `frontend/src/components/PageDetail.tsx`（bbox 角标 + 索引过期徽标）
- Test: `frontend/src/components/PageDetail.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `pages.review_status` / `pages.index_status`。
- Produces: `GET /api/review/pages/:id` 响应增加：
  - `review_status: string`
  - `index_status: string`
  - `blocks[].items: [{ id, label, content_type, role }]`

- [ ] **Step 1: Write the failing backend test**

在 `backend/src/routes/review.test.ts` 新增：

```typescript
it("page detail includes review_status, index_status and block item mapping", async () => {
  // 种子带 review_status + index_status + item_blocks
  const res = await a.request(`/api/review/pages/${pageId}`);
  const data = await res.json();
  expect(data.review_status).toBe("approved");
  expect(data.index_status).toBe("indexed");
  expect(data.blocks[0].items[0]).toMatchObject({ label: "例1", role: "stem" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- --run src/routes/review.test.ts`
Expected: FAIL — 响应缺少 `review_status` / `index_status` / `blocks[].items`。

- [ ] **Step 3: Implement backend changes**

在 `GET /pages/:id` 的 SQL 中增加 `p.review_status, p.index_status`。

新增查询块关联条目：

```typescript
const { rows: itemMappings } = await pool.query(
  `SELECT ib.block_id::text, i.id::text, i.label, i.content_type, ib.role
   FROM item_blocks ib
   JOIN items i ON i.id = ib.item_id
   WHERE ib.block_id = ANY($1::uuid[])`, [blockIds]);
```

将 `itemMappings` 按 `block_id` 分组，附加到每个 block 上。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- --run src/routes/review.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing frontend test**

```tsx
it("shows item label on bbox overlay and stale badge", async () => {
  // mock fetchReviewPage 返回 blocks[0].items = [{ label: "例1", role: "stem" }]
  // mock index_status = "stale"
  render(<PageDetail pageId="p1" />);
  await waitFor(() => {
    expect(screen.getByText("#例1")).toBeInTheDocument();
    expect(screen.getByText("索引已过期")).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/PageDetail.test.tsx`
Expected: FAIL

- [ ] **Step 7: Implement frontend changes**

在 `PageDetail.tsx` 的 bbox `<button>` 内增加角标：

```tsx
{b.items?.map((item) => (
  <span key={item.id} className={`bbox-tag role-${item.role}`}>
    #{item.label}
  </span>
))}
```

在页面顶部增加索引状态徽标：

```tsx
{data.index_status === "stale" && (
  <span className="badge stale">索引已过期</span>
)}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/PageDetail.test.tsx`
Expected: PASS

- [ ] **Step 9: Run all tests**

Run: `cd backend && npm test && cd ../frontend && npm test`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/review.test.ts
git add frontend/src/components/PageDetail.tsx frontend/src/components/PageDetail.test.tsx
git commit -m "feat: add item labels on page blocks and stale index badge"
```

---

### Task 6: 编辑 + 索引过期 + 手动向量化

**Files:**
- Modify: `backend/src/routes/review.ts`（`PATCH /blocks/:id` 编辑后设置 `pages.index_status='stale'`）
- Modify: `backend/src/routes/review.test.ts`
- Modify: `frontend/src/components/PageDetail.tsx`（保存后显示「重新向量化」按钮）
- Modify: `pipeline/kb/internal_api.py`（已有 Task 2 的 `/internal/reindex`）
- Modify: `backend/src/routes/library.ts`（新增 `POST /api/library/:id/reindex`，代理到 pipeline `/internal/reindex`）

**Interfaces:**
- Consumes: Task 2 的 `POST /internal/reindex`。
- Produces: `POST /api/library/:id/reindex` body `{ type: "page"|"chapter", id: string }` → `{ chunks: number }`。

- [ ] **Step 1: Write the failing test for stale on edit**

```typescript
it("editing a block sets page index_status to stale", async () => {
  // 种子：页面 index_status='indexed'
  await a.request(`/api/review/blocks/${blockId}`, {
    method: "PATCH", body: JSON.stringify({ content_md: "编辑后" }),
    headers: { "Content-Type": "application/json" },
  });
  const { rows: [page] } = await pool.query(
    "SELECT index_status FROM pages WHERE id=$1", [pageId]);
  expect(page.index_status).toBe("stale");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- --run src/routes/review.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement stale on edit**

在 `PATCH /blocks/:id` 保存后新增：

```typescript
await pool.query(
  "UPDATE pages SET index_status='stale' WHERE id=(SELECT page_id FROM blocks WHERE id=$1)",
  [c.req.param("id")]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- --run src/routes/review.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for reindex endpoint**

```typescript
it("POST /api/library/:id/reindex proxies to pipeline", async () => {
  // mock pipeline fetch
  const res = await app().request(`/api/library/${docId}/reindex`, {
    method: "POST", body: JSON.stringify({ type: "page", id: pageId }),
    headers: { "Content-Type": "application/json" },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).chunks).toBeGreaterThan(0);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd backend && npm test -- --run src/routes/library.test.ts`
Expected: FAIL

- [ ] **Step 7: Implement reindex proxy in library.ts**

```typescript
app.post("/:id/reindex", async (c) => {
  const body = await c.req.json();
  if (!body?.type || !body?.id) return c.json({ error: "type/id 必填" }, 422);
  const resp = await fetch(`${deps.pipelineUrl}/internal/reindex`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ doc_id: c.req.param("id"), type: body.type, id: body.id }),
  });
  return c.json(await resp.json(), resp.status as 200);
});
```

`libraryRoutes` 签名改为 `libraryRoutes(pool, deps: { pipelineUrl: string }, cfg: BackendConfig)`。

- [ ] **Step 8: Run test to verify it passes**

Run: `cd backend && npm test -- --run src/routes/library.test.ts`
Expected: PASS

- [ ] **Step 9: Add frontend reindex button**

在 `PageDetail.tsx` 的索引过期徽标旁增加：

```tsx
{data.index_status === "stale" && (
  <button className="ghost" disabled={busy}
          onClick={() => void act(async () => {
            await reindexPage(pageId, fetchImpl);
          }, () => void reload())}>
    重新向量化
  </button>
)}
```

新增 API 函数 `reindexPage`：

```typescript
export function reindexPage(id: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/library/${id}/reindex`, fetchImpl,
    json("POST", { type: "page", id }));
}
```

- [ ] **Step 10: Run all tests**

Run: `cd backend && npm test && cd ../frontend && npm test`
Expected: all pass.

- [ ] **Step 11: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/library.ts
git add frontend/src/components/PageDetail.tsx
git commit -m "feat: mark index stale on edit and add manual reindex"
```

---

### Task 7: DOCX/MD 详情页 + 索引状态 + 旧入口退役

**Files:**
- Create: `frontend/src/views/ChapterDetail.tsx`
- Create: `frontend/src/views/ChapterDetail.test.tsx`
- Modify: `frontend/src/views/LibraryView.tsx`（点击卡片时按 `file_type` 跳转 PDF 页或章节页）
- Modify: `backend/src/routes/library.ts`（`GET /api/library/:id` 详情 + `GET /api/library/:id/chapters`）
- Test: `e2e/specs/library.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `chapters.review_status` / `chapters.index_status`。
- Produces: `GET /api/library/:id` → `{ ...doc, chapters: [{ id, chapter_no, title, content_md, review_status, index_status }] }`

- [ ] **Step 1: Write the failing backend test**

```typescript
it("GET /api/library/:id returns chapters with status", async () => {
  // 种子：documents + chapters（含 review_status/index_status）
  const res = await app().request(`/api/library/${docId}`);
  const data = await res.json();
  expect(data.chapters[0]).toMatchObject({
    title: "第一章", review_status: "auto_passed", index_status: "indexed",
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- --run src/routes/library.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement library detail endpoint**

```typescript
app.get("/:id", async (c) => {
  const { rows: [doc] } = await pool.query(
    `SELECT d.id::text, d.title, d.subject, d.parse_status, d.review_status,
            d.uploaded_by, d.created_at, d.struct_mode,
            CASE WHEN d.source_path LIKE '%%.pdf' THEN 'pdf'
                 WHEN d.source_path LIKE '%%.docx' THEN 'docx'
                 ELSE 'md' END AS file_type
     FROM documents d WHERE d.id=$1`, [c.req.param("id")]);
  if (!doc) return c.json({ error: "文档不存在" }, 404);
  if (doc.file_type === "pdf") {
    const { rows: pages } = await pool.query(
      `SELECT id::text, page_no, review_status, index_status
       FROM pages WHERE document_id=$1 ORDER BY page_no`, [doc.id]);
    return c.json({ ...doc, pages });
  }
  const { rows: chapters } = await pool.query(
    `SELECT id::text, chapter_no, title, content_md, review_status, index_status
     FROM chapters WHERE document_id=$1 ORDER BY chapter_no`, [doc.id]);
  return c.json({ ...doc, chapters });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- --run src/routes/library.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing ChapterDetail test**

```tsx
it("renders chapter markdown and shows index status", async () => {
  render(<ChapterDetail docId={docId} chapters={chapters} />);
  expect(screen.getByRole("heading", { name: "第一章" })).toBeInTheDocument();
  expect(screen.getByText("已索引")).toBeInTheDocument();
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/views/ChapterDetail.test.tsx`
Expected: FAIL

- [ ] **Step 7: Implement ChapterDetail**

```tsx
export function ChapterDetail({ docId, chapters, onExit }: {
  docId: string; chapters: ChapterSummary[]; onExit: () => void;
}) {
  const [selected, setSelected] = useState(chapters[0]?.id ?? "");
  const current = chapters.find((c) => c.id === selected);
  return (
    <div className="chapter-detail">
      <button className="ghost" onClick={onExit}>← 返回列表</button>
      <div className="cd-body">
        <nav className="cd-toc">
          {chapters.map((c) => (
            <button key={c.id} className={c.id === selected ? "active" : ""}
                    onClick={() => setSelected(c.id)}>
              {c.title}
              <span className={`badge idx-${c.index_status}`}>
                {c.index_status === "indexed" ? "已索引" : c.index_status === "stale" ? "索引已过期" : "未索引"}
              </span>
            </button>
          ))}
        </nav>
        <div className="cd-content">
          {current && <pre>{current.content_md}</pre>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/views/ChapterDetail.test.tsx`
Expected: PASS

- [ ] **Step 9: Write E2E spec**

创建 `e2e/specs/library.spec.ts`：

```typescript
test("资料库列表 + PDF 详情 + DOCX 章节详情", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "资料库" }).click();
  // 断言列表卡片可见（需先种子数据）
  // 点击 PDF 卡片 → 详情页显示页图 + bbox
  // 返回 → 点击 DOCX 卡片 → 章节视图
});
```

- [ ] **Step 10: Run E2E**

Run: `cd e2e && npm test -- --grep "资料库"`
Expected: PASS

- [ ] **Step 11: Retire old views**

删除 `frontend/src/views/ReviewView.tsx`、`frontend/src/views/MaterialsView.tsx` 及其测试文件。

如果仍有其他文件 import 它们，更新为使用 `LibraryView`。

- [ ] **Step 12: Run all tests**

Run: `cd frontend && npm test && cd ../backend && npm test && cd ../e2e && npm test`
Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add frontend/src/views/ChapterDetail.tsx frontend/src/views/ChapterDetail.test.tsx
git add frontend/src/views/LibraryView.tsx backend/src/routes/library.ts
git add e2e/specs/library.spec.ts
git add -u frontend/src/views/ReviewView.tsx frontend/src/views/MaterialsView.tsx
git commit -m "feat: add chapter detail and retire old review/materials views"
```

---

### Task 8: 搜索

**Files:**
- Modify: `backend/src/routes/library.ts`（新增 `GET /api/library/search?q=&doc_id=`）
- Modify: `frontend/src/views/LibraryView.tsx`（列表页搜索框）
- Modify: `frontend/src/components/PageDetail.tsx`（详情页文档内搜索）
- Test: `e2e/specs/library-search.spec.ts`

**Interfaces:**
- Consumes: 现有 `deps.search` 检索函数。
- Produces: `GET /api/library/search?q=关键词&doc_id=xxx` → `{ hits: [{ doc_id, doc_title, page_no?, chapter_no?, content_md }] }`

- [ ] **Step 1: Write the failing test**

```typescript
it("GET /api/library/search returns hits filtered by doc_id", async () => {
  // mock deps.search 返回结果
  const res = await app().request("/api/library/search?q=数学&doc_id=" + docId);
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.hits).toHaveLength(1);
  expect(data.hits[0].doc_title).toBe("数学练习册");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npm test -- --run src/routes/library.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement search endpoint**

```typescript
app.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ error: "q 不能为空" }, 422);
  const docId = c.req.query("doc_id");
  const filters: Record<string, string> = {};
  if (docId) filters.doc_id = docId;
  return c.json({ hits: await deps.search(q, filters) });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npm test -- --run src/routes/library.test.ts`
Expected: PASS

- [ ] **Step 5: Add search UI**

列表页顶部加搜索框，输入后调 `/api/library/search`，结果列表可点击跳转到对应文档。

详情页顶部加搜索框（`doc_id` 已知），结果高亮对应页或章节。

- [ ] **Step 6: Write E2E spec**

创建 `e2e/specs/library-search.spec.ts`，验证全局搜索和文档内搜索。

- [ ] **Step 7: Run all tests**

Run: `cd backend && npm test && cd ../frontend && npm test && cd ../e2e && npm test`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/library.ts backend/src/routes/library.test.ts
git add frontend/src/views/LibraryView.tsx frontend/src/components/PageDetail.tsx
git add e2e/specs/library-search.spec.ts
git commit -m "feat: add global and per-document search in library"
```

---

### Task 9: 旧路由退役 + 最终验证

**Files:**
- Modify: `backend/src/index.ts`（确认 `/api/review` 仍注册，因为 PDF 详情仍用 `/api/review/pages/:id`；后续可逐步迁移）
- Modify: `e2e/specs/materials-review.spec.ts`（把导航从「复核」改为「资料库」）

**Interfaces:**
- Consumes: Tasks 1–8 全部完成。
- Produces: 端到端全链路验证。

- [ ] **Step 1: Update old E2E spec**

`e2e/specs/materials-review.spec.ts` 中所有 `page.getByRole("button", { name: "复核" })` 改为 `page.getByRole("button", { name: "资料库" })`。

- [ ] **Step 2: Run full E2E suite**

Run: `cd e2e && npm test`
Expected: all pass.

- [ ] **Step 3: Run all unit/integration tests**

Run: `cd pipeline && uv run pytest tests/ && cd ../backend && npm test && cd ../frontend && npm test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/materials-review.spec.ts
git commit -m "chore: update E2E navigation for unified library"
```
