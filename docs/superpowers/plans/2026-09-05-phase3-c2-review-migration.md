# Phase 3-C2 复核迁移 React + 静态页退役 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 旧静态复核页（pipeline :8765）的全部高频操作迁到 React 复核页「资料」tab（待复核页/已通过页/条目/检索试搜四块），approve 保持「approve = 向量化」单一事实来源，然后整体退役 review_api.py 与 :8765。

**Architecture:** 依据 `docs/superpowers/specs/2026-09-05-phase3-c-design.md`（Workstream B）。读路径在 backend TS 直连 PostgreSQL（papers 路由同款风格），页图/裁图从 `storageRoot` 读盘回传（DB 里的相对路径按 pipeline 根解析）；纯 DB 写（块/条目编辑、打回、adopt）也在 TS；approve 与页级 VLM 走 pipeline internal（条目 approve 的 approve+向量化逻辑从 `review_api.approve_item` 迁入 `internal_api`，CLI 与 UI 共用）；flat 文档整页通过调 3-C4 的 `/internal/embed-flat-page`。旧页每次编辑即刷 `storage/` 镜像的行为按 B3 口径取消（镜像改由 `export` 重算，DB 仍是事实来源）。

**Tech Stack:** backend：hono + pg + vitest（真库 `KB_TEST_DATABASE_URL`）；pipeline：FastAPI + pytest（真库）；frontend：React + vitest(jsdom)；e2e：Playwright（真三服务 + ollama bge-m3 + PostgreSQL）。

**前置依赖（硬性）：** 3-C4 计划（`2026-09-05-phase3-c4-flat-ingest.md`）已合入——本计划的「flat 页级通过即向量化」直接调其 `/internal/embed-flat-page`，且 `documents.struct_mode`（migration 0014）已存在。**先跑 3-C4 再跑本计划。**

**执行顺序:** Task 1-2 是 pipeline internal（approve-item/page-vlm）→ Task 3-6 是 backend 路由（读/写/approve）→ Task 7-10 前端 → Task 11 退役 → Task 12 E2E → Task 13 文档回写。严格按序。

**测试约定:**

- pipeline：`cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_internal_api.py -q`
- backend：`cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
- frontend：`cd frontend && npm test`
- E2E：`cd e2e && npx playwright test specs/materials-review.spec.ts`

**Spec 偏差记录:**

- 页详情响应在 spec 列举字段外补 `page_md`/`page_md_model`/`adopted_source`，并新增 `POST /api/review/pages/:id/adopt`——旧静态页有「采用整页版/切块版」操作，且 3-C4 flat 文档的按页向量化依赖 `adopted_source`，删掉是功能回退。
- 旧页编辑块/条目时的 QC/接地复核行同步（`sync_block_reviews`/`sync_item_grounding`）不迁移：spec 把编辑定义为「纯 DB 写」，复核行统一在 approve 时关闭（页 approve 关全部 pending、条目 approve 关该条 pending），语义闭合；镜像即刷同此口径取消（B3）。
- PATCH 条目时同步作废旧向量（`DELETE FROM chunks WHERE item_id=`）——这本身是纯 DB 写，旧页行为保留。
- 旧页的复核行列表（`GET /api/review` 按行 approve/reject）不迁移：新 UI 以页为中心（spec B1 四块），行级粒度由「整页通过」覆盖。
- `POST /api/review/pages/:id/approve` 的 flat 向量化失败不回滚复核行（spec 错误处理：「页保持已通过、chunk 缺失可重试」），响应带 `embed_error` 字段供 UI 提示。

---

## 文件结构（本计划涉及的全部文件）

- Modify: `pipeline/kb/internal_api.py` —— `POST /internal/approve-item`、`POST /internal/page-vlm`
- Test: `pipeline/tests/test_internal_api.py`（追加）
- Create: `backend/src/routes/review.ts` —— 资料 API 全部端点（读/写/approve/图片）
- Create: `backend/src/routes/review.test.ts` —— 真库用例
- Modify: `backend/src/index.ts` —— 挂载 `/api/review`
- Create: `frontend/src/api/review.ts` —— 资料 API client + 类型
- Create: `frontend/src/api/review.test.ts`
- Modify: `frontend/src/views/ReviewView.tsx` —— 顶部 tab（试卷/资料）
- Create: `frontend/src/views/MaterialsView.tsx` —— 资料 tab 四块 + 文档下拉
- Create: `frontend/src/views/MaterialsView.test.tsx`
- Create: `frontend/src/components/PageDetail.tsx` —— 页图 + bbox 覆层 + 块面板 + 操作
- Create: `frontend/src/components/PageDetail.test.tsx`
- Create: `frontend/src/components/ItemDetail.tsx` —— 条目详情 + grounding 裁图 + 操作
- Create: `frontend/src/components/ItemDetail.test.tsx`
- Modify: `frontend/src/theme.css` —— 资料 tab 样式
- Delete: `pipeline/kb/review_api.py`、`pipeline/kb/static/`（review.html/render.js/render_selftest.js/vendor/）
- Delete: `pipeline/tests/test_review_api.py`、`test_review_pages.py`、`test_review_items.py`、`test_review_render.py`
- Modify: `pipeline/kb/cli.py` —— 删 `review` 子命令
- Create: `e2e/specs/materials-review.spec.ts`
- Docs: `README.md`

---

### Task 1: internal_api——POST /internal/approve-item（approve_item 逻辑迁入）

**Files:**

- Modify: `pipeline/kb/internal_api.py`
- Test: `pipeline/tests/test_internal_api.py`（追加）

- [ ] **Step 1: 写失败测试（追加到 test_internal_api.py 末尾）**

```python
class TestApproveItem:
    @pytest.fixture()
    def doc_item(self, conn):
        """1 文档 1 页 1 块 1 条 pending 条目（带 pending 复核行）。返回 (doc_id, item_id, block_id)。"""
        import uuid
        with conn.cursor() as cur:
            doc_id = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO documents (id, title, source_path) VALUES (%s,'测试书',%s)",
                (doc_id, f"/tmp/{doc_id}.pdf"),
            )
            page_id = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO pages (id, document_id, page_no, image_path, status) VALUES (%s,%s,1,'/tmp/x.png','parsed')",
                (page_id, doc_id),
            )
            block_id = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO blocks (id, page_id, block_type, crop_path, content_md) VALUES (%s,%s,'text','/tmp/c.png','例题内容')",
                (block_id, page_id),
            )
            item_id = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO items (id, document_id, content_type, label, content_md, qc_status) VALUES (%s,%s,'example','例1','例题内容','pending')",
                (item_id, doc_id),
            )
            cur.execute(
                "INSERT INTO review_queue (id, item_id, reason) VALUES (%s,%s,'ungrounded:例1 摘录')",
                (str(uuid.uuid4()), item_id),
            )
        return doc_id, item_id, block_id

    def test_approve_item_通过并即时向量化(self, conn, cfg, doc_item):
        """逻辑自 review_api.approve_item 迁入：qc_status=approved + 关 pending 行 + 即时向量化。"""
        from fastapi.testclient import TestClient
        from kb.db import connect
        from tests.test_internal_api import _FakeEmbedLike

        _doc_id, item_id, _block_id = doc_item
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg,
                                  embed_client=_FakeEmbedLike())
        r = TestClient(app).post("/internal/approve-item", params={"item_id": item_id})
        assert r.status_code == 200
        assert r.json() == {"id": item_id, "qc_status": "approved", "embedded": 1}
        row = conn.execute(
            """SELECT i.qc_status,
                      (SELECT status FROM review_queue WHERE item_id = i.id),
                      (SELECT count(*) FROM chunks WHERE item_id = i.id)
               FROM items i WHERE i.id = %s""", (item_id,)).fetchone()
        assert row == ("approved", "approved", 1)

    def test_approve_item_向量化失败不阻断(self, conn, cfg, doc_item):
        """embedding 抛错：approve 与关行已落库，embedded=None（可 kb.cli embed 补跑）。"""
        from fastapi.testclient import TestClient
        from kb.db import connect

        class _Boom:
            class embeddings:
                @staticmethod
                def create(model, input):
                    raise RuntimeError("ollama down")

        _doc_id, item_id, _block_id = doc_item
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg,
                                  embed_client=_Boom())
        r = TestClient(app).post("/internal/approve-item", params={"item_id": item_id})
        assert r.status_code == 200
        assert r.json()["embedded"] is None
        row = conn.execute("SELECT qc_status FROM items WHERE id=%s", (item_id,)).fetchone()
        assert row[0] == "approved"

    def test_approve_item_不存在_404(self, conn, cfg):
        from fastapi.testclient import TestClient
        from kb.db import connect
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg)
        r = TestClient(app).post("/internal/approve-item",
                                 params={"item_id": "00000000-0000-0000-0000-000000000000"})
        assert r.status_code == 404


class _FakeEmbedLike:
    """确定性假 embedding 客户端（同 tests/test_embed.py 手法，1024 维全 1）。"""

    class embeddings:
        @staticmethod
        def create(model, input):
            class D:
                embedding = [1.0] * 1024

            class R:
                data = [D()]

            return R()
```

（`_FakeEmbedLike` 定义在模块级供两个用例引用；`create_internal_app` 已带 `embed_client` 注入口——3-C4 Task 8 引入。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_internal_api.py -q -k ApproveItem`
Expected: FAIL——404（路由不存在，FastAPI 兜底）。

- [ ] **Step 3: 实现（internal_api.py：`/internal/recognize-page` 端点之后追加）**

```python
class PageVlmRequest(BaseModel):
    page_id: str
```

（`PageVlmRequest` 供 Task 2 用，本任务先建避免小步重复；若 lint 报未用，Task 2 立即消费。）

```python
    @app.post("/internal/approve-item")
    def approve_item_ep(item_id: str):
        """条目人工确认：qc_status=approved + 关 pending 复核行 + 即时向量化。
        逻辑自 review_api.approve_item 迁入（CLI approve 与 React 复核页共用同一实现）。
        向量化失败不阻断（embedded=None，可 kb.cli embed 补跑）。"""
        from kb.embed import embed_approved_items
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute("UPDATE items SET qc_status='approved', updated_at=now() WHERE id=%s RETURNING id", (item_id,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="item 不存在")
                cur.execute("UPDATE review_queue SET status='approved' WHERE item_id=%s AND status='pending'", (item_id,))
            try:
                n = embed_approved_items(conn, cfg, client=embed_client)
            except Exception as e:  # noqa: BLE001 - 向量化失败不阻断复核
                print(f"warn: 条目向量化失败({e}),可 kb.cli embed 补跑")
                n = None
            return {"id": item_id, "qc_status": "approved", "embedded": n}
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
        finally:
            conn.close()
```

（`create_internal_app` 签名在 3-C4 后已含 `embed_client=None`；若尚未合入 3-C4，先给签名补 `embed_client=None` 参数——本计划前置依赖已声明。）

- [ ] **Step 4: 跑测试确认通过 + internal 回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_internal_api.py -q`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/internal_api.py pipeline/tests/test_internal_api.py
git commit -m "feat(pipeline): /internal/approve-item——approve+向量化迁入 internal（CLI/UI 共用）"
```

---

### Task 2: internal_api——POST /internal/page-vlm（页级 VLM 重跑）

**Files:**

- Modify: `pipeline/kb/internal_api.py`
- Test: `pipeline/tests/test_internal_api.py`（追加）

- [ ] **Step 1: 写失败测试（TestApproveItem 之后追加）**

```python
class TestPageVlm:
    def test_重跑整页转录(self, conn, cfg, tmp_path):
        """transcribe_page 走假 VLM：page_md 覆盖、模型留痕；不刷镜像（B3：镜像 export 重算）。"""
        import uuid
        from fastapi.testclient import TestClient
        from kb.db import connect
        from tests.test_paper_pipeline import FakeVLM, _vlm_json

        with conn.cursor() as cur:
            doc_id = str(uuid.uuid4())
            cur.execute("INSERT INTO documents (id, title, source_path) VALUES (%s,'书',%s)",
                        (doc_id, f"/tmp/{doc_id}.pdf"))
            page_id = str(uuid.uuid4())
            png = tmp_path / "p.png"
            import base64
            png.write_bytes(base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
                "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))
            cur.execute(
                "INSERT INTO pages (id, document_id, page_no, image_path, status) VALUES (%s,%s,1,%s,'parsed')",
                (page_id, doc_id, str(png)))
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg,
                                  vlm_client=FakeVLM([_vlm_json("# 第 1 讲 口算\n\n整页稿")]))
        r = TestClient(app).post("/internal/page-vlm", json={"page_id": page_id})
        assert r.status_code == 200
        assert r.json()["page_md_len"] > 0
        row = conn.execute("SELECT page_md FROM pages WHERE id=%s", (page_id,)).fetchone()
        assert "口算" in row[0]

    def test_页不存在_404(self, conn, cfg):
        from fastapi.testclient import TestClient
        from kb.db import connect
        app = create_internal_app(get_conn=lambda: connect(cfg.database_url), cfg=cfg)
        r = TestClient(app).post("/internal/page-vlm",
                                 json={"page_id": "00000000-0000-0000-0000-000000000000"})
        assert r.status_code == 404
```

（`FakeVLM`/`_vlm_json` 跨文件导入，同 TestPaperEndpoints 先例。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql/kb_test uv run pytest tests/test_internal_api.py -q -k PageVlm`
Expected: FAIL——404（路由不存在）。

- [ ] **Step 3: 实现（internal_api.py：approve-item 端点之后追加）**

```python
    @app.post("/internal/page-vlm")
    def page_vlm_ep(body: PageVlmRequest):
        """页级 VLM 重跑（复核页「远端整页解析」）：覆盖旧 page_md，采用版本仍由 adopt 决定。
        镜像不在此刷新（B3：镜像改由 export 重算）。"""
        from kb.pagelvl import transcribe_page
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1 FROM pages WHERE id=%s", (body.page_id,))
                if not cur.fetchone():
                    raise HTTPException(status_code=404, detail="page 不存在")
            md = transcribe_page(conn, cfg, body.page_id, client=vlm_client)
            return {"page_id": body.page_id, "page_md_len": len(md)}
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
        finally:
            conn.close()
```

- [ ] **Step 4: 跑测试确认通过 + pagelvl 回归**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_internal_api.py tests/test_pagelvl.py -q`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/internal_api.py pipeline/tests/test_internal_api.py
git commit -m "feat(pipeline): /internal/page-vlm——页级 VLM 重跑通道（TS 复核页转发）"
```

---

### Task 3: backend review 路由——读路径（docs/页列表/页详情/图片）

**Files:**

- Create: `backend/src/routes/review.ts`
- Create: `backend/src/routes/review.test.ts`

- [ ] **Step 1: 写失败测试（review.test.ts 骨架 + 种子 + 读路径用例）**

```ts
/** 资料 API（旧静态复核页的 React 化）：读路径直连 PG，图片从 storageRoot 回传。 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Hono } from "hono";
import { resetDbForTest } from "../db.js";
import { reviewRoutes } from "./review.js";
import type { SearchHit } from "../retrieval/search.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

maybe("review API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  /** 模拟 pipeline 目录布局：<tmpRoot>/pipeline/storage/<doc>/pages/p0001.png */
  let tmpRoot: string;
  let storageRoot: string;
  let docId = "";
  let flatDocId = "";
  let page1 = "";
  let page2 = "";
  let block11 = "";
  let block12 = "";

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    tmpRoot = mkdtempSync(join(tmpdir(), "kb-review-test-"));
    storageRoot = join(tmpRoot, "pipeline", "storage");
    app = new Hono();
    app.route("/api/review", reviewRoutes(pool, {
      search: async () => [] as SearchHit[],
      pipelineUrl: "http://127.0.0.1:8766",
      storageRoot,
    }));

    // 种子：1 本 toc 文档（2 页：页 1 一块挂 pending 行，页 2 干净）+ 1 本 flat 文档（1 页有内容）
    const doc = await pool.query(
      `INSERT INTO documents (title, subject, doc_type, source_path, status)
       VALUES ('口算天天练','数学','workbook','/tmp/a.pdf','parsed') RETURNING id::text`);
    docId = doc.rows[0].id;
    const mkPage = async (pageNo: number) =>
      (await pool.query(
        `INSERT INTO pages (document_id, page_no, image_path, status)
         VALUES ($1,$2,$3,'parsed') RETURNING id::text`,
        [docId, pageNo, join("storage", docId, "pages", `p${String(pageNo).padStart(4, "0")}.png`)],
      )).rows[0].id;
    page1 = await mkPage(1);
    page2 = await mkPage(2);
    // 真实渲染到测试 storage 布局（相对路径按 pipeline 根解析的规则钉死在这里）
    const pagesDir = join(storageRoot, docId, "pages");
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(join(pagesDir, "p0001.png"), PNG_1PX);
    writeFileSync(join(pagesDir, "p0002.png"), PNG_1PX);
    const mkBlock = async (pageId: string, type: string, content: string | null, bbox: number[] | null) =>
      (await pool.query(
        `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md)
         VALUES ($1,$2,$3,$4,$5) RETURNING id::text`,
        [pageId, type, JSON.stringify(bbox), join("storage", docId, "blocks", `${pageId}-${type}.png`), content],
      )).rows[0].id;
    block11 = await mkBlock(page1, "text", "24+37=61", [10, 20, 200, 80]);
    block12 = await mkBlock(page1, "header", "第 1 页", null);
    const blocksDir = join(storageRoot, docId, "blocks");
    mkdirSync(blocksDir, { recursive: true });
    writeFileSync(join(blocksDir, `${page1}-text.png`), PNG_1PX);
    await pool.query(
      "INSERT INTO review_queue (block_id, reason) VALUES ($1,'empty')", [block12]);
    // 页 2 打过一次回（approved 历史行，不影响 pending 判定）
    await pool.query(
      "INSERT INTO review_queue (page_id, reason, status) VALUES ($1,'版面歪斜','approved')", [page2]);

    const flatDoc = await pool.query(
      `INSERT INTO documents (title, subject, doc_type, source_path, status, struct_mode)
       VALUES ('学霸提优大试卷','数学','exam','/tmp/b.pdf','parsed','flat') RETURNING id::text`);
    flatDocId = flatDoc.rows[0].id;
    const fp = await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, status, adopted_source, page_md)
       VALUES ($1,1,$2,'parsed','page_md','第二套 竖式计算') RETURNING id::text`,
      [flatDocId, join("storage", flatDocId, "pages", "p0001.png")]);
    const fDir = join(storageRoot, flatDocId, "pages");
    mkdirSync(fDir, { recursive: true });
    writeFileSync(join(fDir, "p0001.png"), PNG_1PX);
    await pool.query(
      "INSERT INTO chapters (document_id, chapter_no, title, content_md) VALUES ($1,1,'学霸提优大试卷','第二套 竖式计算')",
      [flatDocId]);
    void fp;
  });
  afterAll(async () => { await pool.end(); });

  it("GET /docs：文档列表带 pending_pages 徽标数", async () => {
    const resp = await app.request("/api/review/docs");
    expect(resp.status).toBe(200);
    const docs = (await resp.json()) as { id: string; title: string; pending_pages: number; struct_mode: string | null }[];
    const d = docs.find((x) => x.id === docId)!;
    expect(d).toMatchObject({ title: "口算天天练", subject: "数学", doc_type: "workbook", pending_pages: 1 });
    expect(docs.find((x) => x.id === flatDocId)!.struct_mode).toBe("flat");
  });

  it("GET /pages?status=pending|approved：按复核行推导分桶，可按 doc_id 过滤", async () => {
    const pending = (await (await app.request(`/api/review/pages?status=pending`)).json()) as {
      pages: { id: string; page_no: number; doc_title: string; pending_reasons: string[] }[];
    };
    expect(pending.pages.map((p) => p.page_no)).toEqual([1]); // 页 1 有 empty 行
    expect(pending.pages[0]).toMatchObject({ doc_title: "口算天天练", pending_reasons: ["empty"] });
    const approved = (await (await app.request(`/api/review/pages?status=approved&doc_id=${docId}`)).json())
      as { pages: { page_no: number }[] };
    expect(approved.pages.map((p) => p.page_no)).toEqual([2]);
  });

  it("GET /pages/:id：页详情（块含 pending 行明细，页级 pending 行单列）", async () => {
    const resp = await app.request(`/api/review/pages/${page1}`);
    expect(resp.status).toBe(200);
    const d = (await resp.json()) as {
      id: string; page_no: number; doc_title: string; image_url: string;
      blocks: { id: string; block_type: string; bbox: number[] | null; content_md: string | null; pending: { reason: string }[] }[];
      page_pending: { reason: string }[];
    };
    expect(d.page_no).toBe(1);
    expect(d.image_url).toBe(`/api/review/pages/${page1}/image`);
    expect(d.blocks).toHaveLength(2);
    const text = d.blocks.find((b) => b.id === block11)!;
    expect(text).toMatchObject({ block_type: "text", content_md: "24+37=61", bbox: [10, 20, 200, 80], pending: [] });
    expect(d.blocks.find((b) => b.id === block12)!.pending).toEqual([{ reason: "empty" }]);
  });

  it("GET /pages/:id/image 与 /blocks/:id/crop：相对路径按 pipeline 根解析回传 PNG；缺失 404", async () => {
    const img = await app.request(`/api/review/pages/${page1}/image`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    const crop = await app.request(`/api/review/blocks/${block11}/crop`);
    expect(crop.status).toBe(200);
    const ghost = await app.request(`/api/review/pages/${page2}/image`);
    void ghost; // page2 图片已种；用不存在页验 404：
    const missing = await app.request("/api/review/pages/00000000-0000-0000-0000-000000000000/image");
    expect(missing.status).toBe(404);
  });

  it("GET /pages/:id 不存在 → 404；id 非法 → 422", async () => {
    expect((await app.request("/api/review/pages/not-a-uuid")).status).toBe(422);
    expect((await app.request("/api/review/pages/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/review.test.ts`
Expected: FAIL——`Cannot find module './review.js'`。

- [ ] **Step 3: 实现（创建 review.ts 第一部分：读路径）**

```ts
/** 资料 API：旧静态复核页的 React 化。读路径直连 PostgreSQL，图片从 storageRoot 读盘回传。
    设计：docs/superpowers/specs/2026-09-05-phase3-c-design.md（Workstream B） */
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import type pg from "pg";
import type { SearchHit } from "../retrieval/search.js";

export interface ReviewDeps {
  /** 双路检索（试搜块复用检索主链路）。 */
  search: (q: string, filters?: Record<string, string>) => Promise<SearchHit[]>;
  /** pipeline internal 基址（approve-item/page-vlm/embed-flat-page 转发）。 */
  pipelineUrl: string;
  /** pipeline storage 根（页图/裁图读盘）。 */
  storageRoot: string;
}

/** 路由级统一：id 参数非法（非 UUID）一律 422。 */
function invalidId(c: Context, err: unknown): Response | null {
  return (err as { code?: string })?.code === "22P02"
    ? c.json({ error: "id 格式非法（须为 UUID）" }, 422)
    : null;
}

/** DB 里的图片路径可能是绝对（papers 管线）或相对（文档管线以 pipeline cwd 落库的
    "storage/<doc>/..."）——相对路径按 pipeline 根（storageRoot 的上一级）解析。 */
function resolveStoragePath(storageRoot: string, p: string): string {
  return isAbsolute(p) ? p : join(dirname(storageRoot), p);
}

export function reviewRoutes(pool: pg.Pool, deps: ReviewDeps): Hono {
  const app = new Hono({ strict: false });

  // ---- 读路径 ----

  app.get("/docs", async (c) => {
    const { rows } = await pool.query(
      `SELECT d.id::text, d.title, d.subject, d.doc_type, d.status, d.struct_mode,
              count(p.id) FILTER (WHERE coalesce(pr.n, 0) > 0)::int AS pending_pages
       FROM documents d
       LEFT JOIN pages p ON p.document_id = d.id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n FROM review_queue r
         WHERE r.status = 'pending' AND (
           r.page_id = p.id OR r.block_id IN (SELECT id FROM blocks WHERE page_id = p.id))
       ) pr ON true
       GROUP BY d.id ORDER BY d.created_at DESC`);
    return c.json(rows);
  });

  app.get("/pages", async (c) => {
    const status = c.req.query("status") ?? "pending";
    if (status !== "pending" && status !== "approved") {
      return c.json({ error: "status 取值: pending|approved" }, 422);
    }
    const docId = c.req.query("doc_id");
    const having = status === "pending" ? "coalesce(pr.n, 0) > 0" : "coalesce(pr.n, 0) = 0";
    const params: unknown[] = [];
    let docFilter = "";
    if (docId) { docFilter = "AND p.document_id = $1::uuid"; params.push(docId); }
    const { rows } = await pool.query(
      `SELECT p.id::text, p.page_no, d.title AS doc_title, pr.reasons
       FROM pages p
       JOIN documents d ON d.id = p.document_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n, array_agg(r.reason ORDER BY r.created_at) AS reasons
         FROM review_queue r
         WHERE r.status = 'pending' AND (
           r.page_id = p.id OR r.block_id IN (SELECT id FROM blocks WHERE page_id = p.id))
       ) pr ON true
       WHERE p.status = 'parsed' ${docFilter} AND ${having}
       ORDER BY d.title, p.page_no`, params);
    return c.json({ pages: rows.map((r) => ({ ...r, pending_reasons: r.reasons ?? [] })) });
  });

  app.get("/pages/:id", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        `SELECT p.id::text, p.page_no, d.title AS doc_title, p.page_md, p.page_md_model, p.adopted_source
         FROM pages p JOIN documents d ON d.id = p.document_id WHERE p.id = $1`,
        [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      const { rows: blocks } = await pool.query(
        `SELECT id::text, block_type, bbox, content_md, source_model
         FROM blocks WHERE page_id = $1 ORDER BY created_at, id`, [page.id]);
      const { rows: pendingRows } = await pool.query(
        `SELECT r.id::text, r.reason, r.block_id::text
         FROM review_queue r LEFT JOIN blocks b ON b.id = r.block_id
         WHERE r.status = 'pending' AND (r.page_id = $1 OR b.page_id = $1)
         ORDER BY r.created_at`, [page.id]);
      const byBlock = new Map<string, { id: string; reason: string }[]>();
      const pagePending: { id: string; reason: string }[] = [];
      for (const r of pendingRows) {
        if (r.block_id) (byBlock.get(r.block_id) ?? byBlock.set(r.block_id, []).get(r.block_id)!).push({ id: r.id, reason: r.reason });
        else pagePending.push({ id: r.id, reason: r.reason });
      }
      return c.json({
        id: page.id, page_no: page.page_no, doc_title: page.doc_title,
        image_url: `/api/review/pages/${page.id}/image`,
        page_md: page.page_md, page_md_model: page.page_md_model,
        adopted_source: page.adopted_source,
        blocks: blocks.map((b) => ({ ...b, pending: byBlock.get(b.id) ?? [] })),
        page_pending: pagePending,
      });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/pages/:id/image", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        "SELECT image_path FROM pages WHERE id = $1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      try {
        const buf = await readFile(resolveStoragePath(deps.storageRoot, page.image_path));
        return c.body(new Uint8Array(buf), 200, { "Content-Type": "image/png" });
      } catch {
        return c.json({ error: "页图缺失" }, 404);
      }
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/blocks/:id/crop", async (c) => {
    try {
      const { rows: [block] } = await pool.query(
        "SELECT crop_path FROM blocks WHERE id = $1", [c.req.param("id")]);
      if (!block) return c.json({ error: "block 不存在" }, 404);
      try {
        const buf = await readFile(resolveStoragePath(deps.storageRoot, block.crop_path));
        return c.body(new Uint8Array(buf), 200, { "Content-Type": "image/png" });
      } catch {
        return c.json({ error: "裁图缺失" }, 404);
      }
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  return app;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/review.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/review.test.ts
git commit -m "feat(backend): 资料 API 读路径——docs/页列表/页详情/页图/裁图"
```

---

### Task 4: backend review 路由——读路径（条目列表/详情/试搜）

**Files:**

- Modify: `backend/src/routes/review.ts`
- Test: `backend/src/routes/review.test.ts`（追加）

- [ ] **Step 1: 写失败测试（beforeAll 种子区追加条目）**

beforeAll 里（flat 文档种子之后）追加：

```ts
    // 条目：挂 docId，配 item_blocks 溯源到 block11；qc pending + 一条 pending 复核行
    const item = await pool.query(
      `INSERT INTO items (document_id, content_type, label, content_md, chapter, taxonomy, tags, qc_status)
       VALUES ($1,'exercise','例 1','24+37=61','第 1 讲 加法','计算类',ARRAY['口算','进位加'],'pending')
       RETURNING id::text`, [docId]);
    itemId = item.rows[0].id;
    await pool.query(
      "INSERT INTO item_blocks (item_id, block_id, role) VALUES ($1,$2,'stem')", [itemId, block11]);
    await pool.query(
      "INSERT INTO review_queue (item_id, reason) VALUES ($1,'ungrounded:例 1 摘录')", [itemId]);
```

（`let itemId = "";` 声明加到顶部变量区。）用例追加：

```ts
  it("GET /items?doc_id=&status=pending：qc pending 或有 pending 复核行的条目", async () => {
    const resp = await app.request(`/api/review/items?doc_id=${docId}&status=pending`);
    expect(resp.status).toBe(200);
    const { items } = (await resp.json()) as {
      items: { id: string; label: string; chapter: string; qc_status: string; pending_reasons: string[] }[];
    };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: itemId, label: "例 1", chapter: "第 1 讲 加法", qc_status: "pending",
      pending_reasons: ["ungrounded:例 1 摘录"],
    });
  });

  it("GET /items/:id：详情 + grounding 块（带裁图 URL）+ 复核行", async () => {
    const resp = await app.request(`/api/review/items/${itemId}`);
    expect(resp.status).toBe(200);
    const d = (await resp.json()) as {
      content_md: string; taxonomy: string | null; tags: string[] | null;
      blocks: { id: string; role: string; content_md: string | null; crop_url: string }[];
      reviews: { reason: string; status: string }[];
    };
    expect(d.content_md).toBe("24+37=61");
    expect(d.taxonomy).toBe("计算类");
    expect(d.blocks).toEqual([
      { id: block11, role: "stem", block_type: "text", content_md: "24+37=61", source_model: null,
        crop_url: `/api/review/blocks/${block11}/crop` },
    ]);
    expect(d.reviews[0]).toMatchObject({ reason: "ungrounded:例 1 摘录", status: "pending" });
  });

  it("GET /search?q=：复用注入的检索（带 subject 过滤透传）", async () => {
    let seen: { q: string; filters?: Record<string, string> } | null = null;
    const a = new Hono();
    a.route("/api/review", reviewRoutes(pool, {
      search: async (q, filters) => { seen = { q, filters }; return [{ item_id: itemId, document_id: docId, content_md: "命中", score: 1 }]; },
      pipelineUrl: "http://x", storageRoot,
    }));
    const resp = await a.request("/api/review/search?q=竖式计算&subject=数学");
    expect(resp.status).toBe(200);
    expect((await resp.json()).hits).toHaveLength(1);
    expect(seen).toEqual({ q: "竖式计算", filters: { subject: "数学" } });
    expect((await a.request("/api/review/search?q=")).status).toBe(422);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/review.test.ts`
Expected: FAIL——`/api/review/items` 404。

- [ ] **Step 3: 实现（review.ts 的 `return app;` 之前追加）**

```ts
  app.get("/items", async (c) => {
    const docId = c.req.query("doc_id");
    const status = c.req.query("status");
    if (status !== undefined && status !== "pending") {
      return c.json({ error: "status 取值: pending" }, 422);
    }
    const params: unknown[] = [];
    let where = "";
    if (docId) { where = "WHERE i.document_id = $1::uuid"; params.push(docId); }
    if (status === "pending") {
      where += (where ? " AND " : "WHERE ") +
        "(i.qc_status = 'pending' OR pr.reasons IS NOT NULL)";
    }
    const { rows } = await pool.query(
      `SELECT i.id::text, i.content_type, i.label, i.chapter, i.qc_status, d.title AS doc_title,
              pr.reasons, i.content_md, i.source_model
       FROM items i
       JOIN documents d ON d.id = i.document_id
       LEFT JOIN LATERAL (
         SELECT array_agg(r.reason ORDER BY r.created_at) AS reasons
         FROM review_queue r WHERE r.item_id = i.id AND r.status = 'pending'
       ) pr ON true
       ${where} ORDER BY d.title, i.chapter, i.created_at`, params);
    return c.json({ items: rows.map((r) => ({ ...r, pending_reasons: r.reasons ?? [] })) });
  });

  app.get("/items/:id", async (c) => {
    try {
      const { rows: [item] } = await pool.query(
        `SELECT i.id::text, i.content_type, i.label, i.chapter, i.qc_status, i.content_md,
                i.taxonomy, i.tags, d.title AS doc_title, i.source_model
         FROM items i JOIN documents d ON d.id = i.document_id WHERE i.id = $1`,
        [c.req.param("id")]);
      if (!item) return c.json({ error: "item 不存在" }, 404);
      const { rows: blocks } = await pool.query(
        `SELECT b.id::text, ib.role, b.block_type, b.content_md, b.source_model
         FROM item_blocks ib JOIN blocks b ON b.id = ib.block_id
         WHERE ib.item_id = $1 ORDER BY b.created_at, b.id`, [item.id]);
      const { rows: reviews } = await pool.query(
        "SELECT id::text, reason, status FROM review_queue WHERE item_id = $1 ORDER BY created_at",
        [item.id]);
      return c.json({
        ...item,
        blocks: blocks.map((b) => ({ ...b, crop_url: `/api/review/blocks/${b.id}/crop` })),
        reviews,
      });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ error: "q 不能为空" }, 422);
    const subject = c.req.query("subject");
    const filters = subject ? { subject } : undefined;
    return c.json({ hits: await deps.search(q, filters) });
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/review.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/review.test.ts
git commit -m "feat(backend): 资料 API——条目列表/详情（grounding 裁图）+ 检索试搜"
```

---

### Task 5: backend review 路由——写路径（块/条目编辑、打回、adopt）

**Files:**

- Modify: `backend/src/routes/review.ts`
- Test: `backend/src/routes/review.test.ts`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```ts
  it("PATCH /blocks/:id：编辑转录（纯 DB 写，不刷镜像）", async () => {
    const resp = await app.request(`/api/review/blocks/${block11}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: "24+37=61（改）" }),
    });
    expect(resp.status).toBe(200);
    const row = (await pool.query("SELECT content_md FROM blocks WHERE id=$1", [block11])).rows[0];
    expect(row.content_md).toBe("24+37=61（改）");
    expect((await app.request("/api/review/blocks/00000000-0000-0000-0000-000000000000", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: "x" }),
    })).status).toBe(404);
  });

  it("PATCH /items/:id：编辑条目内容并作废旧向量", async () => {
    await pool.query(
      `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding)
       VALUES ($1,$2,'旧内容','{}'::jsonb, ARRAY[1.0])`, [itemId, docId]);
    const resp = await app.request(`/api/review/items/${itemId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_md: "24+37=61（条目改）" }),
    });
    expect(resp.status).toBe(200);
    expect((await pool.query("SELECT content_md FROM items WHERE id=$1", [itemId])).rows[0].content_md)
      .toBe("24+37=61（条目改）");
    expect((await pool.query("SELECT count(*)::int AS n FROM chunks WHERE item_id=$1", [itemId])).rows[0].n)
      .toBe(0); // 旧向量作废
  });

  it("POST /pages/:id/reject 与 /items/:id/reject：建 pending 复核行（body.reason 必填）", async () => {
    const r1 = await app.request(`/api/review/pages/${page2}/reject`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "缺题" }),
    });
    expect(r1.status).toBe(201);
    const row = (await pool.query(
      "SELECT reason, status FROM review_queue WHERE page_id=$1 ORDER BY created_at DESC LIMIT 1",
      [page2])).rows[0];
    expect(row).toMatchObject({ reason: "缺题", status: "pending" });
    const r2 = await app.request(`/api/review/items/${itemId}/reject`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "串章" }),
    });
    expect(r2.status).toBe(201);
    expect((await app.request(`/api/review/pages/${page2}/reject`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })).status).toBe(422);
  });

  it("POST /pages/:id/adopt：采用版本切换（page_md 需已有整页转录）", async () => {
    const bad = await app.request(`/api/review/pages/${page1}/adopt`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "page_md" }),
    });
    expect(bad.status).toBe(409); // 页 1 无整页转录
    await pool.query("UPDATE pages SET page_md='整页稿', page_md_model='qwen' WHERE id=$1", [page1]);
    const ok = await app.request(`/api/review/pages/${page1}/adopt`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "page_md" }),
    });
    expect(ok.status).toBe(200);
    expect((await pool.query("SELECT adopted_source FROM pages WHERE id=$1", [page1])).rows[0].adopted_source)
      .toBe("page_md");
  });```

（末条断言以 `pool.query` 直查为准。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/review.test.ts`
Expected: FAIL——PATCH 404。

- [ ] **Step 3: 实现（review.ts 追加；`return app;` 之前）**

```ts
  // ---- 写路径：纯 DB 写（编辑/打回/adopt）。复核行统一在 approve 时关闭，
  // 镜像不在此刷新（B3：镜像由 export 重算，DB 是事实来源）----

  async function readJson(c: Context): Promise<Record<string, unknown> | null> {
    try { return await c.req.json(); } catch { return null; }
  }

  app.patch("/blocks/:id", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.content_md !== "string") return c.json({ error: "content_md 必填" }, 422);
    try {
      const { rows: [b] } = await pool.query(
        "UPDATE blocks SET content_md=$2 WHERE id=$1 RETURNING id::text, content_md",
        [c.req.param("id"), body.content_md]);
      if (!b) return c.json({ error: "block 不存在" }, 404);
      return c.json(b);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.patch("/items/:id", async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ error: "请求体不是合法 JSON" }, 400);
    if (typeof body.content_md !== "string") return c.json({ error: "content_md 必填" }, 422);
    const id = c.req.param("id");
    try {
      const { rows: [item] } = await pool.query(
        "UPDATE items SET content_md=$2, updated_at=now() WHERE id=$1 RETURNING id::text, content_md",
        [id, body.content_md]);
      if (!item) return c.json({ error: "item 不存在" }, 404);
      await pool.query("DELETE FROM chunks WHERE item_id=$1", [id]); // 内容变了，旧向量作废
      return c.json(item);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/pages/:id/reject", async (c) => {
    const body = await readJson(c);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason 必填" }, 422);
    try {
      const { rows: [page] } = await pool.query(
        "SELECT id::text FROM pages WHERE id=$1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      const { rows: [row] } = await pool.query(
        `INSERT INTO review_queue (page_id, reason) VALUES ($1,$2)
         RETURNING id::text, status`, [page.id, reason]);
      return c.json(row, 201);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/items/:id/reject", async (c) => {
    const body = await readJson(c);
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) return c.json({ error: "reason 必填" }, 422);
    try {
      const { rows: [item] } = await pool.query(
        "SELECT id::text FROM items WHERE id=$1", [c.req.param("id")]);
      if (!item) return c.json({ error: "item 不存在" }, 404);
      const { rows: [row] } = await pool.query(
        `INSERT INTO review_queue (item_id, reason) VALUES ($1,$2)
         RETURNING id::text, status`, [item.id, reason]);
      return c.json(row, 201);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/pages/:id/adopt", async (c) => {
    const body = await readJson(c);
    const source = body?.source;
    if (source !== "blocks" && source !== "page_md") {
      return c.json({ error: "source 取值: blocks|page_md" }, 422);
    }
    try {
      const { rows: [page] } = await pool.query(
        "SELECT id::text, page_md FROM pages WHERE id=$1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      if (source === "page_md" && !page.page_md) {
        return c.json({ error: "该页还没有整页转录" }, 409);
      }
      await pool.query("UPDATE pages SET adopted_source=$2 WHERE id=$1", [page.id, source]);
      return c.json({ page_id: page.id, adopted_source: source });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/review.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/review.test.ts
git commit -m "feat(backend): 资料 API 写路径——块/条目编辑（旧向量作废）/打回/adopt"
```

---

### Task 6: backend review 路由——approve 转发（页 approve + flat 向量化 / 条目 approve / 页 VLM）+ 挂载

**Files:**

- Modify: `backend/src/routes/review.ts`、`backend/src/index.ts`
- Test: `backend/src/routes/review.test.ts`（追加）

- [ ] **Step 1: 写失败测试（追加）**

```ts
  it("POST /pages/:id/approve：关闭该页 pending 行；flat 文档同时调 /internal/embed-flat-page（失败不回滚行）", async () => {
    // pipeline 桩：记录 embed-flat-page 调用
    const calls: { doc_id: string; page_no: number }[] = [];
    const stubPipeline = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.endsWith("/internal/embed-flat-page")) {
        calls.push(JSON.parse(String(init?.body)));
        return jsonResponse({ chunks: 1 });
      }
      if (url.includes("/internal/")) return jsonResponse({});
      return new Response("no route", { status: 404 });
    };
    function jsonResponse(body: unknown, status = 200) {
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }
    const a = new Hono();
    a.route("/api/review", reviewRoutes(pool, {
      search: async () => [], pipelineUrl: "http://pipeline.test", storageRoot,
    }));
    // 用 vi.stubGlobal 换 fetch（路由内用全局 fetch 转发）
    const { vi } = await import("vitest");
    vi.stubGlobal("fetch", stubPipeline);
    try {
      // toc 文档页 1：只关行
      const r1 = await a.request(`/api/review/pages/${page1}/approve`, { method: "POST" });
      expect(r1.status).toBe(200);
      expect((await r1.json()).resolved).toBe(1);
      expect((await pool.query(
        "SELECT count(*)::int AS n FROM review_queue WHERE block_id=$1 AND status='pending'",
        [block12])).rows[0].n).toBe(0);
      expect(calls).toEqual([]); // 非 flat 不调向量化

      // flat 文档页：关行（无行也幂等）+ 调 embed-flat-page
      const flatPage = (await pool.query(
        "SELECT id::text FROM pages WHERE document_id=$1", [flatDocId])).rows[0].id;
      const r2 = await a.request(`/api/review/pages/${flatPage}/approve`, { method: "POST" });
      expect(r2.status).toBe(200);
      const body2 = await r2.json();
      expect(body2.embedded).toBe(1);
      expect(calls).toEqual([{ doc_id: flatDocId, page_no: 1 }]);

      // 向量化失败：行保持已通过，响应带 embed_error（幂等重入）
      vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
      const r3 = await a.request(`/api/review/pages/${flatPage}/approve`, { method: "POST" });
      expect(r3.status).toBe(200);
      const body3 = await r3.json();
      expect(body3.embed_error).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("POST /items/:id/approve 与 /pages/:id/page-vlm：转发 internal，透传响应/错误", async () => {
    const { vi } = await import("vitest");
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" || url.includes("approve-item") || url.includes("page-vlm")) {
        posts.push(url);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("no route", { status: 404 });
    });
    const a = new Hono();
    a.route("/api/review", reviewRoutes(pool, {
      search: async () => [], pipelineUrl: "http://pipeline.test", storageRoot,
    }));
    try {
      const r1 = await a.request(`/api/review/items/${itemId}/approve`, { method: "POST" });
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({ ok: true });
      const r2 = await a.request(`/api/review/pages/${page1}/page-vlm`, { method: "POST" });
      expect(r2.status).toBe(200);
      expect(posts[0]).toBe("http://pipeline.test/internal/approve-item?item_id=" + itemId);
      expect(posts[1]).toBe("http://pipeline.test/internal/page-vlm");
      // pipeline 挂了：502 带错误文案
      vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });
      const r3 = await a.request(`/api/review/items/${itemId}/approve`, { method: "POST" });
      expect(r3.status).toBe(502);
    } finally {
      vi.unstubAllGlobals();
    }
  });
```

`index.ts` 挂载（Task 6 一并接线）：

```ts
import { reviewRoutes } from "./routes/review.js";
// createApp 内 search 定义之后：
  app.route("/api/review", reviewRoutes(pool, {
    search, pipelineUrl: cfg.pipelineUrl, storageRoot: cfg.storageRoot,
  }));
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/review.test.ts`
Expected: FAIL——approve 404。

- [ ] **Step 3: 实现（review.ts 追加）**

```ts
  // ---- approve 走 pipeline internal：「approve = 向量化」单一事实来源 ----

  /** 转发 internal POST；pipeline 不可达/5xx → 502（papers 风格错误文案）。 */
  async function forwardInternal(c: Context, path: string, body?: unknown): Promise<Response> {
    try {
      const resp = await fetch(`${deps.pipelineUrl}${path}`, {
        method: "POST",
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      return c.newResponse(text.length ? text : null, resp.status, {
        "Content-Type": resp.headers.get("content-type") ?? "application/json",
      });
    } catch (err) {
      console.error("pipeline internal 调用失败", path, err);
      return c.json({ error: "内部服务不可达" }, 502);
    }
  }

  app.post("/pages/:id/approve", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        `SELECT p.id::text, p.page_no, d.id::text AS doc_id, d.struct_mode
         FROM pages p JOIN documents d ON d.id = p.document_id WHERE p.id = $1`,
        [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      // 关闭该页全部 pending 复核行（块级 + 页级）
      const { rows: closed } = await pool.query(
        `UPDATE review_queue SET status='approved' WHERE status='pending' AND (
           page_id=$1 OR block_id IN (SELECT id FROM blocks WHERE page_id=$1))
         RETURNING id`, [page.id]);
      // flat 文档：页级通过即向量化（3-C4 /internal/embed-flat-page，重建式幂等）
      if (page.struct_mode === "flat") {
        try {
          const resp = await fetch(`${deps.pipelineUrl}/internal/embed-flat-page`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ doc_id: page.doc_id, page_no: page.page_no }),
          });
          if (!resp.ok) throw new Error(await resp.text());
          const { chunks } = await resp.json() as { chunks: number };
          return c.json({ id: page.id, resolved: closed.length, embedded: chunks });
        } catch (err) {
          // 行保持已通过；chunk 缺失可重试（再次整页通过幂等重入）
          console.error("flat 页向量化失败", err);
          return c.json({ id: page.id, resolved: closed.length, embed_error: "向量化失败，可重新通过该页重试" });
        }
      }
      return c.json({ id: page.id, resolved: closed.length });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/items/:id/approve", async (c) => {
    try {
      // 先校验存在（404 前置，不空打 pipeline）
      const { rows: [item] } = await pool.query(
        "SELECT id::text FROM items WHERE id=$1", [c.req.param("id")]);
      if (!item) return c.json({ error: "item 不存在" }, 404);
      return forwardInternal(c, `/internal/approve-item?item_id=${encodeURIComponent(item.id)}`);
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });

  app.post("/pages/:id/page-vlm", async (c) => {
    try {
      const { rows: [page] } = await pool.query(
        "SELECT id::text FROM pages WHERE id=$1", [c.req.param("id")]);
      if (!page) return c.json({ error: "page 不存在" }, 404);
      return forwardInternal(c, "/internal/page-vlm", { page_id: page.id });
    } catch (err) {
      return invalidId(c, err) ?? (() => { throw err; })();
    }
  });
```

（`forwardInternal` 对 page-vlm 用 JSON body、对 approve-item 用 query 参数——与 Task 1/2 的 internal 端点签名对齐。）

- [ ] **Step 4: 跑测试确认通过 + backend 全量**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
Expected: 全部 PASS（index.ts 挂载后其余路由不受影响）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/review.test.ts backend/src/index.ts
git commit -m "feat(backend): 资料 API approve 转发——页通过(含 flat 向量化)/条目通过/页 VLM"
```

---

### Task 7: 前端 api/review.ts——client + 类型

**Files:**

- Create: `frontend/src/api/review.ts`
- Create: `frontend/src/api/review.test.ts`

- [ ] **Step 1: 写失败测试（review.test.ts）**

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import {
  adoptReviewPage, approveReviewItem, approveReviewPage, fetchReviewDocs, fetchReviewItems,
  fetchReviewPage, fetchReviewPages, pageVlm, rejectReviewPage, reviewSearch, updateReviewBlock,
  updateReviewItem,
} from "./review";

describe("api/review", () => {
  it("读路径：docs/pages/items/page 详情与 query 拼装", async () => {
    const fetchImpl = fetchRouter({
      "/api/review/docs": () => jsonResponse([{ id: "d1", title: "书", pending_pages: 2 }]),
      "/api/review/pages?status=pending&doc_id=d1": () => jsonResponse({ pages: [] }),
      "/api/review/items?doc_id=d1&status=pending": () => jsonResponse({ items: [] }),
      "/api/review/pages/p1": () => jsonResponse({ id: "p1", blocks: [] }),
    });
    expect((await fetchReviewDocs(fetchImpl))[0].pending_pages).toBe(2);
    expect(await fetchReviewPages("d1", "pending", fetchImpl)).toEqual({ pages: [] });
    expect(await fetchReviewItems("d1", "pending", fetchImpl)).toEqual({ items: [] });
    expect((await fetchReviewPage("p1", fetchImpl)).id).toBe("p1");
  });

  it("写路径：方法/路径/body 逐一对齐", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const rec = (url: string, method: string) => () => {
      calls.push({ method, url });
      return jsonResponse({});
    };
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return jsonResponse({});
    };
    await updateReviewBlock("b1", "改", fetchImpl);
    await updateReviewItem("i1", "改", fetchImpl);
    await rejectReviewPage("p1", "缺题", fetchImpl);
    await adoptReviewPage("p1", "page_md", fetchImpl);
    await approveReviewPage("p1", fetchImpl);
    await approveReviewItem("i1", fetchImpl);
    await pageVlm("p1", fetchImpl);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH /api/review/blocks/b1",
      "PATCH /api/review/items/i1",
      "POST /api/review/pages/p1/reject",
      "POST /api/review/pages/p1/adopt",
      "POST /api/review/pages/p1/approve",
      "POST /api/review/items/i1/approve",
      "POST /api/review/pages/p1/page-vlm",
    ]);
    expect(calls[0].body).toEqual({ content_md: "改" });
    expect(calls[2].body).toEqual({ reason: "缺题" });
    expect(calls[3].body).toEqual({ source: "page_md" });
    void rec;
  });

  it("reviewSearch：q/subject 拼装；空 q 由调用方拦", async () => {
    let seen = "";
    const fetchImpl = async (input: RequestInfo | URL) => {
      seen = String(input);
      return jsonResponse({ hits: [] });
    };
    await reviewSearch("竖式", "数学", fetchImpl);
    expect(seen).toBe("/api/review/search?q=" + encodeURIComponent("竖式") + "&subject=" + encodeURIComponent("数学"));
  });

  it("非 2xx 抛错（message 取 body.error）", async () => {
    const fetchImpl = fetchRouter({
      "/api/review/pages/nope": () => jsonResponse({ error: "page 不存在" }, 404),
    });
    await expect(fetchReviewPage("nope", fetchImpl)).rejects.toThrow("page 不存在");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/api/review.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现（api/review.ts）**

```ts
/** 资料 API（frontend 视角）：类型与 backend routes/review.ts 对齐。 */

export interface ReviewDoc {
  id: string; title: string; subject: string | null; doc_type: string;
  status: string; struct_mode: string | null; pending_pages: number;
}

export interface ReviewPageSummary {
  id: string; page_no: number; doc_title: string; pending_reasons: string[];
}

export interface ReviewBlock {
  id: string; block_type: string; bbox: number[] | null; content_md: string | null;
  source_model: string | null; pending: { id: string; reason: string }[];
}

export interface ReviewPageDetail {
  id: string; page_no: number; doc_title: string; image_url: string;
  page_md: string | null; page_md_model: string | null;
  adopted_source: "blocks" | "page_md";
  blocks: ReviewBlock[];
  page_pending: { id: string; reason: string }[];
}

export interface ReviewItemSummary {
  id: string; content_type: string; label: string | null; chapter: string | null;
  qc_status: string; doc_title: string; pending_reasons: string[];
  content_md: string | null; source_model: string | null;
}

export interface ReviewItemDetail {
  id: string; content_type: string; label: string | null; chapter: string | null;
  qc_status: string; content_md: string | null; taxonomy: string | null; tags: string[] | null;
  doc_title: string; source_model: string | null;
  blocks: { id: string; role: string; block_type: string; content_md: string | null; source_model: string | null; crop_url: string }[];
  reviews: { id: string; reason: string; status: string }[];
}

export interface ReviewSearchHit {
  item_id: string | null; chapter_id: string | null; document_id: string;
  content_md: string; score: number; doc_title?: string; chapter?: string;
  label?: string | null; subject?: string | null;
}

type FetchLike = typeof fetch;

async function req<T>(url: string, fetchImpl: FetchLike, init?: RequestInit): Promise<T> {
  const resp = await fetchImpl(url, init);
  if (!resp.ok) {
    let msg = `请求失败: ${resp.status}`;
    try { msg = ((await resp.json()) as { error?: string }).error ?? msg; } catch { /* 非 JSON 错误体 */ }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export function fetchReviewDocs(fetchImpl: FetchLike = fetch): Promise<ReviewDoc[]> {
  return req("/api/review/docs", fetchImpl);
}

export function fetchReviewPages(
  docId: string | undefined, status: "pending" | "approved", fetchImpl: FetchLike = fetch,
): Promise<{ pages: ReviewPageSummary[] }> {
  const q = new URLSearchParams({ status });
  if (docId) q.set("doc_id", docId);
  return req(`/api/review/pages?${q}`, fetchImpl);
}

export function fetchReviewPage(id: string, fetchImpl: FetchLike = fetch): Promise<ReviewPageDetail> {
  return req(`/api/review/pages/${encodeURIComponent(id)}`, fetchImpl);
}

export function fetchReviewItems(
  docId: string | undefined, status: "pending" | undefined, fetchImpl: FetchLike = fetch,
): Promise<{ items: ReviewItemSummary[] }> {
  const q = new URLSearchParams();
  if (docId) q.set("doc_id", docId);
  if (status) q.set("status", status);
  const s = q.toString();
  return req(`/api/review/items${s ? `?${s}` : ""}`, fetchImpl);
}

export function fetchReviewItem(id: string, fetchImpl: FetchLike = fetch): Promise<ReviewItemDetail> {
  return req(`/api/review/items/${encodeURIComponent(id)}`, fetchImpl);
}

export function updateReviewBlock(id: string, contentMd: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/blocks/${encodeURIComponent(id)}`, fetchImpl, json("PATCH", { content_md: contentMd }));
}

export function updateReviewItem(id: string, contentMd: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/items/${encodeURIComponent(id)}`, fetchImpl, json("PATCH", { content_md: contentMd }));
}

export function rejectReviewPage(id: string, reason: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/pages/${encodeURIComponent(id)}/reject`, fetchImpl, json("POST", { reason }));
}

export function rejectReviewItem(id: string, reason: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/items/${encodeURIComponent(id)}/reject`, fetchImpl, json("POST", { reason }));
}

export function adoptReviewPage(id: string, source: "blocks" | "page_md", fetchImpl: FetchLike = fetch) {
  return req(`/api/review/pages/${encodeURIComponent(id)}/adopt`, fetchImpl, json("POST", { source }));
}

export function approveReviewPage(id: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/pages/${encodeURIComponent(id)}/approve`, fetchImpl, { method: "POST" });
}

export function approveReviewItem(id: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/items/${encodeURIComponent(id)}/approve`, fetchImpl, { method: "POST" });
}

export function pageVlm(id: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/pages/${encodeURIComponent(id)}/page-vlm`, fetchImpl, { method: "POST" });
}

export function reviewSearch(q: string, subject: string | undefined, fetchImpl: FetchLike = fetch) {
  const params = new URLSearchParams({ q });
  if (subject) params.set("subject", subject);
  return req<{ hits: ReviewSearchHit[] }>(`/api/review/search?${params}`, fetchImpl);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/api/review.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/review.ts frontend/src/api/review.test.ts
git commit -m "feat(frontend): 资料 API client——类型与端点对齐"
```

---

### Task 8: 前端 MaterialsView——文档下拉 + 四块（页列表/条目列表/试搜）

**Files:**

- Modify: `frontend/src/views/ReviewView.tsx`
- Create: `frontend/src/views/MaterialsView.tsx`
- Create: `frontend/src/views/MaterialsView.test.tsx`
- Modify: `frontend/src/theme.css`

- [ ] **Step 1: 写失败测试（MaterialsView.test.tsx）**

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { MaterialsView } from "./MaterialsView";

const DOCS = [
  { id: "d1", title: "口算天天练", subject: "数学", doc_type: "workbook", status: "parsed", struct_mode: null, pending_pages: 2 },
  { id: "d2", title: "学霸提优", subject: "数学", doc_type: "exam", status: "parsed", struct_mode: "flat", pending_pages: 0 },
];

function stub(over: Record<string, (init?: RequestInit) => Response> = {}) {
  return fetchRouter({
    "/api/review/docs": () => jsonResponse(DOCS),
    "/api/review/pages?status=pending": () => jsonResponse({
      pages: [{ id: "p1", page_no: 3, doc_title: "口算天天练", pending_reasons: ["empty"] }],
    }),
    "/api/review/pages?status=approved": () => jsonResponse({ pages: [] }),
    "/api/review/items?status=pending": () => jsonResponse({
      items: [{ id: "i1", content_type: "exercise", label: "例 1", chapter: "第 1 讲", qc_status: "pending", doc_title: "口算天天练", pending_reasons: ["ungrounded:例 1"], content_md: "24+37", source_model: null }],
    }),
    ...over,
  });
}

describe("MaterialsView", () => {
  it("挂载加载文档下拉（含待复核徽标），默认待复核页块列出页卡", async () => {
    render(<MaterialsView fetchImpl={stub()} />);
    const select = await screen.findByRole("combobox", { name: "选择文档" });
    expect(select).toHaveValue(""); // 全部文档
    expect(screen.getByText("口算天天练")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // 徽标
    expect(await screen.findByText(/第 3 页/)).toBeInTheDocument();
    expect(screen.getByText("empty")).toBeInTheDocument();
  });

  it("四块切换：已通过页/条目/试搜", async () => {
    render(<MaterialsView fetchImpl={stub()} />);
    await screen.findByText(/第 3 页/);
    fireEvent.click(screen.getByRole("button", { name: "已通过页" }));
    expect(await screen.findByText("没有已通过页")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "条目" }));
    expect(await screen.findByText("例 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "试搜" }));
    expect(screen.getByPlaceholderText(/语义检索/)).toBeInTheDocument();
  });

  it("选中页卡进入页详情（PageDetail 挂载）", async () => {
    render(<MaterialsView fetchImpl={stub({
      "/api/review/pages/p1": () => jsonResponse({
        id: "p1", page_no: 3, doc_title: "口算天天练", image_url: "/api/review/pages/p1/image",
        page_md: null, page_md_model: null, adopted_source: "blocks",
        blocks: [], page_pending: [],
      }),
    })} />);
    fireEvent.click(await screen.findByText(/第 3 页/));
    await waitFor(() => expect(screen.getByRole("button", { name: "✓ 整页通过" })).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/views/MaterialsView.test.tsx`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现**

`ReviewView.tsx` 顶部改造（其余不动）：组件开头加 tab 状态并包住返回值：

```tsx
export function ReviewView() {
  const [tab, setTab] = useState<"papers" | "materials">("papers");
  // …既有全部 state/逻辑不动…
  if (tab === "materials") {
    return (
      <div className="review-wrap materials">
        <div className="mat-tabs">
          <button className={tab === "papers" ? "" : "active"} onClick={() => setTab("papers")}>试卷</button>
          <button className="active">资料</button>
        </div>
        <MaterialsView />
      </div>
    );
  }
  return (
    <div className="review-wrap">
      <div className="mat-tabs">
        <button className="active">试卷</button>
        <button onClick={() => setTab("materials")}>资料</button>
      </div>
      {/* …既有 JSX 原样（PaperQueue/child-filter/review-detail…）… */}
    </div>
  );
}
```

（import 区补 `import { MaterialsView } from "./MaterialsView.js";`——实际为 `"./MaterialsView"`。既有 JSX 整体保留，只在最外层加 `mat-tabs`。）

`MaterialsView.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  fetchReviewDocs, fetchReviewItems, fetchReviewPages, fetchReviewItem, rejectReviewItem,
  reviewSearch, type ReviewDoc, type ReviewItemDetail, type ReviewItemSummary,
  type ReviewPageSummary, type ReviewSearchHit,
} from "../api/review";
import { ItemDetail } from "../components/ItemDetail";
import { PageDetail } from "../components/PageDetail";

type Block = "pending" | "approved" | "items" | "search";

const BLOCKS: [Block, string][] = [
  ["pending", "待复核页"], ["approved", "已通过页"], ["items", "条目"], ["search", "试搜"],
];

/** 资料 tab：文档下拉（待复核徽标）+ 四块（对应旧静态页）。 */
export function MaterialsView({ fetchImpl = fetch }: { fetchImpl?: typeof fetch }) {
  const [docs, setDocs] = useState<ReviewDoc[]>([]);
  const [docId, setDocId] = useState("");
  const [block, setBlock] = useState<Block>("pending");
  const [pages, setPages] = useState<ReviewPageSummary[]>([]);
  const [items, setItems] = useState<ReviewItemSummary[]>([]);
  const [pageId, setPageId] = useState<string | null>(null);
  const [item, setItem] = useState<ReviewItemDetail | null>(null);
  const [q, setQ] = useState("");
  const [subject, setSubject] = useState("");
  const [hits, setHits] = useState<ReviewSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reloadDocs = useCallback(async () => {
    try { setDocs(await fetchReviewDocs(fetchImpl)); } catch (e) { console.error(e); }
  }, [fetchImpl]);

  const reloadBlock = useCallback(async () => {
    setError("");
    try {
      if (block === "pending" || block === "approved") {
        setPages((await fetchReviewPages(docId || undefined, block, fetchImpl)).pages);
      } else if (block === "items") {
        setItems((await fetchReviewItems(docId || undefined, "pending", fetchImpl)).items);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [block, docId, fetchImpl]);

  useEffect(() => { void reloadDocs(); }, [reloadDocs]);
  useEffect(() => { void reloadBlock(); }, [reloadBlock]);

  const openItem = async (id: string) => {
    try { setItem(await fetchReviewItem(id, fetchImpl)); } catch (e) { console.error(e); }
  };

  const doSearch = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    try { setHits((await reviewSearch(q.trim(), subject || undefined, fetchImpl)).hits); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="materials">
      <div className="mat-toolbar">
        <select aria-label="选择文档" value={docId} onChange={(e) => setDocId(e.target.value)}>
          <option value="">全部文档</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}{d.pending_pages > 0 ? `（待复核 ${d.pending_pages} 页）` : ""}
            </option>
          ))}
        </select>
        <div className="mat-blocks">
          {BLOCKS.map(([b, label]) => (
            <button key={b} className={block === b ? "active" : ""} onClick={() => { setBlock(b); setHits(null); }}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}

      {pageId && (
        <PageDetail
          pageId={pageId}
          fetchImpl={fetchImpl}
          onExit={() => { setPageId(null); void reloadBlock(); void reloadDocs(); }}
          onError={setError}
        />
      )}
      {item && (
        <ItemDetail
          item={item}
          onReload={async () => { await openItem(item.id); void reloadBlock(); void reloadDocs(); }}
          onExit={() => { setItem(null); void reloadBlock(); void reloadDocs(); }}
          onError={setError}
          fetchImpl={fetchImpl}
        />
      )}

      {!pageId && !item && (block === "pending" || block === "approved") && (
        <div className="page-cards">
          {pages.length === 0 && (
            <div className="chat-empty">{block === "pending" ? "没有待复核页" : "没有已通过页"}</div>
          )}
          {pages.map((p) => (
            <button key={p.id} className="page-card" onClick={() => setPageId(p.id)}>
              <img src={`/api/review/pages/${p.id}/image`} alt={`第 ${p.page_no} 页`} loading="lazy" />
              <div className="meta">
                <span className="doc">{p.doc_title} · 第 {p.page_no} 页</span>
                {p.pending_reasons.map((r) => <span key={r} className="badge">{r}</span>)}
              </div>
            </button>
          ))}
        </div>
      )}

      {!pageId && !item && block === "items" && (
        <div className="item-rows">
          {items.length === 0 && <div className="chat-empty">没有待复核条目</div>}
          {items.map((it) => (
            <button key={it.id} className="item-row" onClick={() => void openItem(it.id)}>
              <span className="label">{it.label ?? it.content_type}</span>
              <span className="chap">{it.doc_title} · {it.chapter ?? "-"}</span>
              <span className="content">{(it.content_md ?? "").slice(0, 60)}</span>
              {it.pending_reasons.map((r) => <span key={r} className="badge">{r.slice(0, 40)}</span>)}
            </button>
          ))}
        </div>
      )}

      {!pageId && !item && block === "search" && (
        <div className="mat-search">
          <input placeholder="语义检索，如：除法竖式谜 倒推法" value={q}
                 onChange={(e) => setQ(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") void doSearch(); }} />
          <select aria-label="科目" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">全部科目</option>
            {["语文", "数学", "英语"].map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="primary" onClick={() => void doSearch()} disabled={busy || !q.trim()}>检索</button>
          {hits && (hits.length === 0
            ? <div className="chat-empty">没有命中</div>
            : <ul className="hits">
                {hits.map((h, i) => (
                  <li key={h.item_id ?? h.chapter_id ?? i}>
                    <span className="src">《{h.doc_title}》{h.chapter ?? ""}{h.label ? ` · ${h.label}` : ""}</span>
                    <p>{h.content_md.slice(0, 120)}</p>
                  </li>
                ))}
              </ul>)}
        </div>
      )}
    </div>
  );
}
```

（`rejectReviewItem` import 暂未用可去掉——ItemDetail 内部处理；以最终编译无未用 import 为准。）

`theme.css` 追加：

```css
/* ---- 3-C2 资料 tab ---- */
.mat-tabs { display: flex; gap: 6px; padding: 0 0 10px; border-bottom: 1px solid var(--line); margin-bottom: 10px; }
.mat-tabs button { border: none; background: none; padding: 6px 14px; border-radius: 8px;
  cursor: pointer; font-size: 14px; color: var(--pencil); }
.mat-tabs button.active { background: var(--ink); color: #fff; }
.materials { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.mat-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.mat-toolbar select { border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; background: var(--card); }
.mat-blocks { display: flex; gap: 4px; }
.mat-blocks button { border: 1px solid var(--line); background: var(--card); border-radius: 8px;
  padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
.mat-blocks button.active { border-color: var(--redpen); color: var(--redpen); background: var(--redpen-soft); font-weight: 500; }
.page-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; overflow-y: auto; }
.page-card { border: 1px solid var(--line); border-radius: 10px; background: var(--card);
  padding: 8px; text-align: left; cursor: pointer; }
.page-card:hover { border-color: var(--redpen); }
.page-card img { width: 100%; border-radius: 6px; background: #f3f1ec; min-height: 60px; }
.page-card .meta { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.page-card .doc { font-size: 12.5px; }
.badge { font-size: 11px; color: var(--redpen); border: 1px solid var(--redpen);
  border-radius: 999px; padding: 1px 8px; background: var(--redpen-soft); }
.item-rows { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.item-row { border: 1px solid var(--line); border-radius: 10px; background: var(--card);
  padding: 10px 12px; text-align: left; cursor: pointer; display: grid;
  grid-template-columns: auto 1fr; gap: 2px 10px; }
.item-row:hover { border-color: var(--redpen); }
.item-row .label { font-weight: 500; }
.item-row .chap { color: var(--pencil); font-size: 12px; }
.item-row .content { color: var(--pencil); font-size: 12.5px; grid-column: 1 / -1; }
.mat-search { display: flex; flex-direction: column; gap: 8px; }
.mat-search input, .mat-search select { border: 1px solid var(--line); border-radius: 8px;
  padding: 7px 10px; background: var(--card); }
.mat-search .hits { list-style: none; margin: 0; padding: 0; display: flex;
  flex-direction: column; gap: 8px; overflow-y: auto; }
.mat-search .hits li { border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 8px 12px; }
.mat-search .hits .src { font-size: 12px; color: var(--pencil); }
.mat-search .hits p { margin: 4px 0 0; font-size: 13px; }
.primary { background: var(--ink); color: #fff; border: none; border-radius: 8px;
  padding: 6px 16px; cursor: pointer; align-self: flex-start; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/views/MaterialsView.test.tsx`
Expected: 全部 PASS（PageDetail/ItemDetail 尚未创建——本步先建最小骨架让编译过，Task 9/10 充实；骨架见下）。

`PageDetail.tsx` 最小骨架（Task 9 整体替换）：

```tsx
export function PageDetail(_props: { pageId: string; fetchImpl?: typeof fetch; onExit: () => void; onError: (e: string) => void }) {
  return <div className="page-detail">（Task 9 实现）</div>;
}
```

`ItemDetail.tsx` 同理。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/ReviewView.tsx frontend/src/views/MaterialsView.tsx frontend/src/views/MaterialsView.test.tsx frontend/src/components/PageDetail.tsx frontend/src/components/ItemDetail.tsx frontend/src/theme.css
git commit -m "feat(frontend): 资料 tab——文档下拉 + 四块骨架（页卡/条目/试搜）"
```

---

### Task 9: 前端 PageDetail——页图 + bbox 覆层 + 块面板 + 操作

**Files:**

- Modify: `frontend/src/components/PageDetail.tsx`
- Create: `frontend/src/components/PageDetail.test.tsx`
- Modify: `frontend/src/theme.css`

- [ ] **Step 1: 写失败测试（PageDetail.test.tsx）**

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { PageDetail } from "./PageDetail";

const DETAIL = {
  id: "p1", page_no: 3, doc_title: "口算天天练", image_url: "/api/review/pages/p1/image",
  page_md: "整页稿", page_md_model: "qwen3", adopted_source: "blocks",
  blocks: [
    { id: "b1", block_type: "text", bbox: [100, 200, 500, 400], content_md: "24+37=61", source_model: null, pending: [] },
    { id: "b2", block_type: "text", bbox: null, content_md: null, source_model: null, pending: [{ id: "r1", reason: "empty" }] },
  ],
  page_pending: [{ id: "r9", reason: "版面歪斜" }],
};

function stub(over: Record<string, (init?: RequestInit) => Response> = {}) {
  return fetchRouter({
    "/api/review/pages/p1": () => jsonResponse(DETAIL),
    ...over,
  });
}

describe("PageDetail", () => {
  it("页图 + bbox 覆层按图片自然尺寸百分比定位；pending 块高亮", async () => {
    render(<PageDetail pageId="p1" fetchImpl={stub()} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    expect(screen.getByText("24+37=61")).toBeInTheDocument();
    // 页级 pending 行展示
    expect(screen.getByText(/版面歪斜/)).toBeInTheDocument();
  });

  it("块编辑：点编辑变输入框，保存走 PATCH 后刷新详情", async () => {
    let patched = "";
    const fetchImpl = fetchRouter({
      "/api/review/pages/p1": () => jsonResponse(DETAIL),
      "/api/review/blocks/b1": () => { patched = "b1"; return jsonResponse({ id: "b1" }); },
    });
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByText("24+37=61");
    fireEvent.click(screen.getAllByRole("button", { name: "✎ 编辑" })[0]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "24+37=61（改）" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(patched).toBe("b1"));
  });

  it("整页通过走 approve 并 onExit 刷新；打回建页级行", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return jsonResponse({ resolved: 1 });
    };
    const onExit = vi.fn();
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={onExit} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    fireEvent.click(screen.getByRole("button", { name: "✓ 整页通过" }));
    await waitFor(() => expect(calls).toContain("POST /api/review/pages/p1/approve"));
    await waitFor(() => expect(onExit).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "✗ 打回本页" }));
    fireEvent.change(screen.getByRole("textbox", { name: "打回原因" }), { target: { value: "缺题" } });
    fireEvent.click(screen.getByRole("button", { name: "提交打回" }));
    await waitFor(() => expect(calls).toContain("POST /api/review/pages/p1/reject"));
  });

  it("整页解析（VLM）与采用版本切换按钮存在且可点", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      return jsonResponse({ page_md_len: 10 });
    };
    render(<PageDetail pageId="p1" fetchImpl={fetchImpl} onExit={vi.fn()} onError={vi.fn()} />);
    await screen.findByAltText("第 3 页");
    fireEvent.click(screen.getByRole("button", { name: /远端整页解析/ }));
    await waitFor(() => expect(calls).toContain("/api/review/pages/p1/page-vlm"));
    fireEvent.click(screen.getByRole("button", { name: "✓ 采用整页版" }));
    await waitFor(() => expect(calls).toContain("/api/review/pages/p1/adopt"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/PageDetail.test.tsx`
Expected: FAIL——无内容渲染。

- [ ] **Step 3: 实现（PageDetail.tsx 整体替换）**

```tsx
import { useEffect, useRef, useState } from "react";
import {
  adoptReviewPage, approveReviewPage, fetchReviewPage, pageVlm, rejectReviewPage,
  updateReviewBlock, type ReviewPageDetail,
} from "../api/review";

/** 页详情：页图 + bbox 覆层（按图片自然尺寸百分比定位）+ 块面板（编辑/待复核高亮）
    + 整页通过/打回/远端整页解析/采用版本。 */
export function PageDetail({ pageId, fetchImpl = fetch, onExit, onError }: {
  pageId: string; fetchImpl?: typeof fetch; onExit: () => void; onError: (e: string) => void;
}) {
  const [data, setData] = useState<ReviewPageDetail | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const reload = async () => {
    try { setData(await fetchReviewPage(pageId, fetchImpl)); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pageId]);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); after?.(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const saveBlock = (blockId: string) =>
    act(async () => { await updateReviewBlock(blockId, draft, fetchImpl); }, () => { setEditing(null); void reload(); });

  if (!data) return <div className="page-detail"><div className="chat-empty">加载中…</div></div>;
  const pendingBlockIds = new Set(data.blocks.flatMap((b) => b.pending.map(() => b.id)));

  return (
    <div className="page-detail">
      <div className="pd-head">
        <button className="ghost" onClick={onExit}>← 返回列表</button>
        <span>《{data.doc_title}》第 {data.page_no} 页</span>
        <button className="primary" disabled={busy}
                onClick={() => void act(async () => { await approveReviewPage(pageId, fetchImpl); }, onExit)}>
          ✓ 整页通过
        </button>
        <button className="ghost" disabled={busy} onClick={() => setRejecting(!rejecting)}>✗ 打回本页</button>
      </div>
      {data.page_pending.length > 0 && (
        <div className="pd-pending">页级待复核：{data.page_pending.map((r) => r.reason).join("、")}</div>
      )}
      {rejecting && (
        <div className="pd-reject">
          <input aria-label="打回原因" placeholder="打回原因，如「缺题/版面歪斜」"
                 value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          <button className="primary" disabled={busy || !rejectReason.trim()}
                  onClick={() => void act(async () => {
                    await rejectReviewPage(pageId, rejectReason.trim(), fetchImpl);
                  }, () => { setRejecting(false); setRejectReason(""); })}>
            提交打回
          </button>
        </div>
      )}
      <div className="pd-body">
        <div className="pd-image">
          <img ref={imgRef} src={data.image_url} alt={`第 ${data.page_no} 页`}
               onLoad={() => setImgSize({ w: imgRef.current!.naturalWidth, h: imgRef.current!.naturalHeight })} />
          {imgSize && data.blocks.map((b) => b.bbox && (
            <button key={b.id}
              className={`bbox${pendingBlockIds.has(b.id) ? " has-issue" : ""}${selected === b.id ? " selected" : ""}`}
              style={{
                left: `${(b.bbox[0] / imgSize.w) * 100}%`,
                top: `${(b.bbox[1] / imgSize.h) * 100}%`,
                width: `${((b.bbox[2] - b.bbox[0]) / imgSize.w) * 100}%`,
                height: `${((b.bbox[3] - b.bbox[1]) / imgSize.h) * 100}%`,
              }}
              onClick={() => setSelected(b.id)}
              aria-label={`块 ${b.id}`}
            />
          ))}
        </div>
        <div className="pd-panel">
          <div className="pd-pagemd">
            <div className="meta">整页转录（{data.page_md_model ?? "-"}）</div>
            {data.page_md
              ? <pre>{data.page_md.slice(0, 500)}</pre>
              : <div className="hint">本页还没有整页转录。</div>}
            <button className="ghost" disabled={busy}
                    onClick={() => void act(async () => { await pageVlm(pageId, fetchImpl); }, () => void reload())}>
              🔄 {data.page_md ? "重新" : ""}远端整页解析
            </button>
            {data.page_md && (data.adopted_source === "blocks"
              ? <button className="primary" disabled={busy}
                  onClick={() => void act(async () => { await adoptReviewPage(pageId, "page_md", fetchImpl); }, () => void reload())}>
                  ✓ 采用整页版
                </button>
              : <><button className="ghost" disabled={busy}
                  onClick={() => void act(async () => { await adoptReviewPage(pageId, "blocks", fetchImpl); }, () => void reload())}>
                  改用切块版
                </button><span className="hint">当前采用：整页转录</span></>)}
          </div>
          <div className="pd-blocks">
            {data.blocks.map((b) => (
              <div key={b.id}
                   className={`blockitem${pendingBlockIds.has(b.id) ? " has-issue" : ""}${selected === b.id ? " selected" : ""}`}
                   onClick={() => setSelected(b.id)}>
                <div className="bt">{b.block_type}{b.source_model ? ` · ${b.source_model}` : ""}</div>
                {editing === b.id ? (
                  <>
                    <textarea aria-label="编辑转录" value={draft} onChange={(e) => setDraft(e.target.value)} />
                    <div className="row">
                      <button className="primary" disabled={busy} onClick={() => void saveBlock(b.id)}>保存</button>
                      <button className="ghost" onClick={() => setEditing(null)}>取消</button>
                    </div>
                  </>
                ) : (
                  <div className="bc">{b.content_md ?? "（空）"}</div>
                )}
                {b.pending.length > 0 && <div className="badges">{b.pending.map((r) => <span key={r.id} className="badge">{r.reason}</span>)}</div>}
                {editing !== b.id && (
                  <div className="row">
                    <button className="ghost" onClick={(e) => {
                      e.stopPropagation();
                      setDraft(b.content_md ?? "");
                      setEditing(b.id);
                    }}>✎ 编辑</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
```

`theme.css` 追加：

```css
.page-detail { display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1; }
.pd-head { display: flex; gap: 10px; align-items: center; }
.pd-head .primary { align-self: auto; }
.pd-pending { font-size: 12.5px; color: var(--redpen); }
.pd-reject { display: flex; gap: 8px; }
.pd-reject input { flex: 1; border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
.pd-body { display: grid; grid-template-columns: minmax(280px, 44%) 1fr; gap: 14px; min-height: 0; flex: 1; }
.pd-image { position: relative; overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
.pd-image img { display: block; width: 100%; }
.pd-image .bbox { position: absolute; border: 1.5px dashed #9ca3af; border-radius: 2px;
  cursor: pointer; background: transparent; padding: 0; }
.pd-image .bbox:hover { border-color: #2563eb; background: rgba(37, 99, 235, .06); }
.pd-image .bbox.has-issue { border: 2px solid var(--redpen); background: rgba(224, 60, 40, .07); }
.pd-image .bbox.selected { border: 2.5px solid #2563eb; background: rgba(37, 99, 235, .1); }
.pd-panel { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; min-height: 0; }
.pd-pagemd { border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 10px; }
.pd-pagemd .meta { font-size: 12px; color: var(--pencil); margin-bottom: 6px; }
.pd-pagemd pre { margin: 0 0 8px; font-size: 12.5px; white-space: pre-wrap; max-height: 160px; overflow-y: auto; }
.pd-pagemd .hint { font-size: 12.5px; color: var(--pencil); margin-bottom: 8px; }
.pd-blocks { display: flex; flex-direction: column; gap: 8px; }
.blockitem { border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 8px 10px; cursor: pointer; }
.blockitem.has-issue { border-color: var(--redpen); }
.blockitem.selected { border-color: #2563eb; }
.blockitem .bt { font-size: 11.5px; color: var(--pencil); margin-bottom: 4px; }
.blockitem .bc { font-size: 13px; white-space: pre-wrap; }
.blockitem textarea { width: 100%; min-height: 56px; border: 1px solid var(--line);
  border-radius: 8px; padding: 6px; font: inherit; }
.blockitem .row { display: flex; gap: 6px; margin-top: 6px; }
.blockitem .badges { margin-top: 4px; display: flex; gap: 4px; flex-wrap: wrap; }
.ghost { border: 1px solid var(--line); background: var(--card); border-radius: 8px;
  padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
.ghost:hover { border-color: var(--redpen); color: var(--redpen); }
.row { display: flex; gap: 6px; align-items: center; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/components/PageDetail.test.tsx`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PageDetail.tsx frontend/src/components/PageDetail.test.tsx frontend/src/theme.css
git commit -m "feat(frontend): PageDetail——页图 bbox 覆层/块编辑/整页通过/打回/VLM/adopt"
```

---

### Task 10: 前端 ItemDetail——条目详情 + grounding 裁图 + 操作

**Files:**

- Modify: `frontend/src/components/ItemDetail.tsx`
- Create: `frontend/src/components/ItemDetail.test.tsx`

- [ ] **Step 1: 写失败测试（ItemDetail.test.tsx）**

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { ItemDetail } from "./ItemDetail";

const ITEM = {
  id: "i1", content_type: "exercise", label: "例 1", chapter: "第 1 讲 加法",
  qc_status: "pending", content_md: "24+37=61", taxonomy: "计算类",
  tags: ["口算", "进位加"], doc_title: "口算天天练", source_model: "qwen3.8-27b",
  blocks: [
    { id: "b1", role: "stem", block_type: "text", content_md: "24+37=", source_model: null, crop_url: "/api/review/blocks/b1/crop" },
  ],
  reviews: [{ id: "r1", reason: "ungrounded:例 1 摘录", status: "pending" }],
};

describe("ItemDetail", () => {
  it("详情展示：内容/分类/标签/溯源块裁图/复核行", async () => {
    render(<ItemDetail item={ITEM} onReload={vi.fn()} onExit={vi.fn()} onError={vi.fn()} />);
    expect(screen.getByText("24+37=61")).toBeInTheDocument();
    expect(screen.getByText("计算类")).toBeInTheDocument();
    expect(screen.getByText("口算")).toBeInTheDocument();
    expect(screen.getByAltText("块 b1")).toHaveAttribute("src", "/api/review/blocks/b1/crop");
    expect(screen.getByText(/ungrounded/)).toBeInTheDocument();
  });

  it("编辑保存走 PATCH；确认走 approve（内部转发）；打回建行", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return jsonResponse({ id: "i1" });
    };
    const onExit = vi.fn();
    render(<ItemDetail item={ITEM} onReload={vi.fn()} onExit={onExit} onError={vi.fn()} fetchImpl={fetchImpl} />);
    fireEvent.click(screen.getByRole("button", { name: "✎ 编辑" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "24+37=61（改）" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls).toContain("PATCH /api/review/items/i1"));
    fireEvent.click(screen.getByRole("button", { name: "✓ 确认" }));
    await waitFor(() => expect(calls).toContain("POST /api/review/items/i1/approve"));
    fireEvent.click(screen.getByRole("button", { name: "✗ 打回" }));
    fireEvent.change(screen.getByRole("textbox", { name: "打回原因" }), { target: { value: "串章" } });
    fireEvent.click(screen.getByRole("button", { name: "提交打回" }));
    await waitFor(() => expect(calls).toContain("POST /api/review/items/i1/reject"));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/ItemDetail.test.tsx`
Expected: FAIL——无内容渲染。

- [ ] **Step 3: 实现（ItemDetail.tsx 整体替换）**

```tsx
import { useState } from "react";
import {
  approveReviewItem, rejectReviewItem, updateReviewItem, type ReviewItemDetail,
} from "../api/review";

/** 条目详情：LLM 拆条结果的核对——内容编辑、grounding 溯源块（裁图+转录）、确认（即时向量化）、打回。 */
export function ItemDetail({ item, onReload, onExit, onError, fetchImpl = fetch }: {
  item: ReviewItemDetail;
  onReload: () => Promise<void> | void;
  onExit: () => void;
  onError: (e: string) => void;
  fetchImpl?: typeof fetch;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content_md ?? "");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); after?.(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="item-detail">
      <div className="pd-head">
        <button className="ghost" onClick={onExit}>← 返回条目</button>
        <span>《{item.doc_title}》{item.chapter ? ` ${item.chapter} · ` : ""}{item.label ?? item.content_type}</span>
        <button className="primary" disabled={busy}
                onClick={() => void act(() => approveReviewItem(item.id, fetchImpl), onExit)}>
          ✓ 确认
        </button>
        <button className="ghost" disabled={busy} onClick={() => setRejecting(!rejecting)}>✗ 打回</button>
      </div>
      {rejecting && (
        <div className="pd-reject">
          <input aria-label="打回原因" placeholder="打回原因，如「串章/漏题」"
                 value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          <button className="primary" disabled={busy || !rejectReason.trim()}
                  onClick={() => void act(async () => {
                    await rejectReviewItem(item.id, rejectReason.trim(), fetchImpl);
                  }, () => { setRejecting(false); setRejectReason(""); void onReload(); })}>
            提交打回
          </button>
        </div>
      )}
      <div className="id-body">
        <div className="id-content">
          <div className="meta">
            {item.taxonomy ?? "（无分类）"} · {(item.tags ?? []).join(" / ") || "（无标签）"}
            {item.source_model ? ` · ${item.source_model}` : ""}
          </div>
          {editing ? (
            <>
              <textarea aria-label="编辑条目" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="row">
                <button className="primary" disabled={busy}
                        onClick={() => void act(async () => {
                          await updateReviewItem(item.id, draft, fetchImpl);
                        }, () => { setEditing(false); void onReload(); })}>
                  保存
                </button>
                <button className="ghost" onClick={() => setEditing(false)}>取消</button>
              </div>
            </>
          ) : (
            <>
              <pre>{item.content_md ?? "（空）"}</pre>
              <div className="row">
                <button className="ghost" onClick={() => { setDraft(item.content_md ?? ""); setEditing(true); }}>✎ 编辑</button>
              </div>
            </>
          )}
          {item.reviews.length > 0 && (
            <div className="id-reviews">
              {item.reviews.map((r) => (
                <div key={r.id} className={r.status}>
                  <span className="badge">{r.status === "pending" ? "待复核" : r.status}</span> {r.reason}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="id-blocks">
          {item.blocks.length === 0 && <div className="hint">无溯源块（docx/整页路径）。</div>}
          {item.blocks.map((b) => (
            <div key={b.id} className={`blockitem role-${b.role}`}>
              <div className="bt">{b.role} · {b.block_type}</div>
              {b.block_type !== "text" && <img src={b.crop_url} alt={`块 ${b.id}`} loading="lazy" />}
              <div className="bc">{b.content_md ?? "（空）"}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

`theme.css` 追加：

```css
.item-detail { display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1; }
.id-body { display: grid; grid-template-columns: 1fr minmax(240px, 40%); gap: 14px; min-height: 0; flex: 1; }
.id-content { border: 1px solid var(--line); border-radius: 10px; background: var(--card); padding: 12px; overflow-y: auto; }
.id-content .meta { font-size: 12px; color: var(--pencil); margin-bottom: 8px; }
.id-content pre { white-space: pre-wrap; font: inherit; margin: 0 0 8px; }
.id-content textarea { width: 100%; min-height: 120px; border: 1px solid var(--line);
  border-radius: 8px; padding: 8px; font: inherit; }
.id-reviews { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.id-reviews .approved { color: var(--pencil); }
.id-blocks { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
.id-blocks img { max-width: 100%; border-radius: 6px; border: 1px solid var(--line); }
```

- [ ] **Step 4: 跑前端全量确认通过**

Run: `cd frontend && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ItemDetail.tsx frontend/src/components/ItemDetail.test.tsx frontend/src/theme.css
git commit -m "feat(frontend): ItemDetail——条目编辑/确认（即时向量化）/打回/grounding 裁图"
```

---

### Task 11: B4 退役——删 review_api.py / static/ / CLI review / :8765

**Files:**

- Delete: `pipeline/kb/review_api.py`、`pipeline/kb/static/`（整目录）、`pipeline/tests/test_review_api.py`、`pipeline/tests/test_review_pages.py`、`pipeline/tests/test_review_items.py`、`pipeline/tests/test_review_render.py`
- Modify: `pipeline/kb/cli.py`、`README.md`

- [ ] **Step 1: 确认无残余引用**

Run: `cd /Users/rio/repos/myprjs/kids-knowledge-base && grep -rn "review_api\|kb.cli review\|8765" --include="*.py" --include="*.ts" --include="*.md" --include="*.mjs" backend/src frontend/src pipeline/kb pipeline/tests e2e scripts README.md | grep -v node_modules | grep -v docs/superpowers`
Expected: 仅 `pipeline/kb/cli.py`（review 分支与 import）与 `README.md`（:8765 行）。

- [ ] **Step 2: 删除文件与 CLI 分支**

```bash
git rm -r pipeline/kb/review_api.py pipeline/kb/static pipeline/tests/test_review_api.py pipeline/tests/test_review_pages.py pipeline/tests/test_review_items.py pipeline/tests/test_review_render.py
```

`pipeline/kb/cli.py`：

- 删除 parser 段：

```python
    p_review = sub.add_parser("review", help="启动复核 web 页")
    p_review.add_argument("--host", default="127.0.0.1")
    p_review.add_argument("--port", type=int, default=8765)
```

- 删除运行分支：

```python
    if args.cmd == "review":
        import uvicorn
        from kb.review_api import create_app
        uvicorn.run(create_app(), host=args.host, port=args.port)
        return
```

- [ ] **Step 3: README 复核章节改指 React 复核页**

`README.md` 中：

```markdown
cd pipeline && uv run python -m kb.cli review   # http://127.0.0.1:8765
```

所在小节整体替换为：

```markdown
打开 http://127.0.0.1:5200 的「复核」页：试卷 tab 确认对错与题库匹配；资料 tab
（待复核页 / 已通过页 / 条目 / 试搜）覆盖旧静态复核页的全部高频操作——块编辑、
整页通过（flat 文档页级通过即向量化）、条目确认即时可检索、检索试搜。
```

（若该小节还有相邻的 `:8765` 提法一并清理；保留 `serve-internal` :8766 说明。）

- [ ] **Step 4: 全量回归（pipeline + backend + frontend）**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS（approve 语义已由 test_internal_api.py 的 ApproveItem/PageVlm 用例承接；镜像即刷测试随行为取消一并删除）。

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
Expected: 全部 PASS。

Run: `cd frontend && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A pipeline README.md
git commit -m "chore(pipeline)!: 退役旧静态复核页——review_api/static/:8765 下线，approve 语义已迁 internal"
```

---

### Task 12: E2E——资料复核全链路

**Files:**

- Create: `e2e/specs/materials-review.spec.ts`

- [ ] **Step 1: 写 spec（DB 种子不经 VLM，真实 embedding 走 ollama bge-m3）**

```typescript
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test } from "@playwright/test";

/** 3-C2 资料复核全链路：页图 bbox/块编辑/页通过（flat 页级向量化）/条目 approve 即时可检索/试搜。
    真实栈（三服务 + ollama bge-m3 + PostgreSQL）；种子直插 DB + 落盘页图（不跑 VLM 渲染解析）。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const PIPELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../pipeline");
const STORAGE_ROOT = path.resolve(PIPELINE_DIR, "storage");

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const TITLE = `E2E-${RUN}-口算书`;
const FLAT_TITLE = `E2E-${RUN}-学霸卷`;
const KEYWORD = `E2E${RUN}魔法词`;

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let docId = "";
let flatDocId = "";
let flatPageId = "";
let blockId = "";
let itemId = "";

test.beforeAll(async () => {
  // 文档 1（toc）：2 页，页 1 两个块（text 挂 pending empty 行 + header），页 2 干净
  const { rows: [doc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path, status)
     VALUES ($1,'数学','workbook',$2,'parsed') RETURNING id::text`,
    [TITLE, `/tmp/e2e-${RUN}-a.pdf`]);
  docId = doc.id;
  const pagesDir = path.join(STORAGE_ROOT, docId, "pages");
  mkdirSync(pagesDir, { recursive: true });
  for (const [no, content] of [[1, `${KEYWORD} 24+37=`], [2, "第二页内容"]] as [number, string][]) {
    writeFileSync(path.join(pagesDir, `p${String(no).padStart(4, "0")}.png`), PNG_1PX);
    const { rows: [page] } = await pool.query(
      `INSERT INTO pages (document_id, page_no, image_path, status)
       VALUES ($1,$2,$3,'parsed') RETURNING id::text`,
      [docId, no, `storage/${docId}/pages/p${String(no).padStart(4, "0")}.png`]);
    if (no === 1) {
      const { rows: [b] } = await pool.query(
        `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md)
         VALUES ($1,'text',$2,$3,$4) RETURNING id::text`,
        [page.id, JSON.stringify([10, 20, 300, 120]), `storage/${docId}/blocks/b1.png`, content]);
      blockId = b.id;
      const blocksDir = path.join(STORAGE_ROOT, docId, "blocks");
      mkdirSync(blocksDir, { recursive: true });
      writeFileSync(path.join(blocksDir, "b1.png"), PNG_1PX);
      await pool.query("INSERT INTO review_queue (block_id, reason) VALUES ($1,'empty')", [blockId]);
    }
  }
  // 条目（pending）挂 block
  const { rows: [item] } = await pool.query(
    `INSERT INTO items (document_id, content_type, label, content_md, chapter, qc_status)
     VALUES ($1,'exercise','例 1',$2,'第 1 讲 进位加','pending') RETURNING id::text`,
    [docId, `${KEYWORD} 24+37=61`]);
  itemId = item.id;
  await pool.query("INSERT INTO item_blocks (item_id, block_id, role) VALUES ($1,$2,'stem')", [itemId, blockId]);

  // 文档 2（flat）：1 页整页稿 + 合成章
  const { rows: [flatDoc] } = await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path, status, struct_mode)
     VALUES ($1,'数学','exam',$2,'parsed','flat') RETURNING id::text`,
    [FLAT_TITLE, `/tmp/e2e-${RUN}-b.pdf`]);
  flatDocId = flatDoc.id;
  const fDir = path.join(STORAGE_ROOT, flatDocId, "pages");
  mkdirSync(fDir, { recursive: true });
  writeFileSync(path.join(fDir, "p0001.png"), PNG_1PX);
  const { rows: [fp] } = await pool.query(
    `INSERT INTO pages (document_id, page_no, image_path, status, adopted_source, page_md)
     VALUES ($1,1,$2,'parsed','page_md',$3) RETURNING id::text`,
    [flatDocId, `storage/${flatDocId}/pages/p0001.png`, `${KEYWORD} 退位减法专项卷`]);
  flatPageId = fp.id;
  await pool.query(
    "INSERT INTO chapters (document_id, chapter_no, title, content_md) VALUES ($1,1,$2,$3)",
    [flatDocId, FLAT_TITLE, `${KEYWORD} 退位减法专项卷`]);
});

test("t1 页复核：页卡/页图 bbox/块编辑/整页通过（flat 页级向量化）", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核" }).click();
  await page.getByRole("button", { name: "资料" }).click();
  // 文档下拉含两本文档（徽标数）
  const docSelect = page.getByRole("combobox", { name: "选择文档" });
  await expect(docSelect).toContainText(TITLE);
  // 待复核页：toc 文档页 1（empty 行）
  await expect(page.locator(".page-card")).toHaveCount(1);
  await expect(page.locator(".page-card .badge")).toContainText("empty");
  // 打开页详情：页图 + bbox 覆层 + pending 块高亮
  await page.locator(".page-card").click();
  await expect(page.getByAltText("第 1 页")).toBeVisible();
  await expect(page.locator(".pd-image .bbox.has-issue")).toHaveCount(1);
  // 块编辑：清掉 empty 的块填上内容
  await page.locator(".blockitem.has-issue").getByRole("button", { name: "✎ 编辑" }).click();
  await page.getByRole("textbox").fill(`${KEYWORD} 24+37=61（人工修正）`);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".blockitem .bc")).toContainText("人工修正");
  const dbBlock = await pool.query("SELECT content_md FROM blocks WHERE id=$1", [blockId]);
  expect(dbBlock.rows[0].content_md).toContain("人工修正");
  // 整页通过（toc 文档）：复核行关闭
  await page.getByRole("button", { name: "✓ 整页通过" }).click();
  await page.getByRole("button", { name: "待复核页" }).click();
  await expect(page.locator(".page-card")).toHaveCount(0); // 该页移出待复核
  const rows = await pool.query(
    "SELECT count(*)::int AS n FROM review_queue WHERE block_id=$1 AND status='pending'", [blockId]);
  expect(rows.rows[0].n).toBe(0);

  // flat 文档整页通过 → 页级向量化（真实 bge-m3）
  await page.getByRole("combobox", { name: "选择文档" }).selectOption(flatDocId);
  await expect(page.locator(".page-card")).toHaveCount(1);
  await page.locator(".page-card").click();
  await page.getByRole("button", { name: "✓ 整页通过" }).click();
  await expect(page.locator(".page-card")).toHaveCount(0);
  const chunks = await pool.query(
    "SELECT seg_no, meta->>'page_no' AS page_no FROM chunks WHERE document_id=$1", [flatDocId]);
  expect(chunks.rows.map((c) => [c.seg_no, c.page_no])).toEqual([[1001, "1"]]);
});

test("t2 条目 approve 即时可检索 + 试搜", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核" }).click();
  await page.getByRole("button", { name: "资料" }).click();
  await page.getByRole("combobox", { name: "选择文档" }).selectOption(docId);
  await page.getByRole("button", { name: "条目" }).click();
  await expect(page.locator(".item-row")).toHaveCount(1);
  await page.locator(".item-row").click();
  // 溯源块裁图回传
  await expect(page.getByAltText(`块 ${blockId}`)).toBeVisible();
  // 确认 → internal approve-item → 即时向量化（真实 bge-m3）
  await page.getByRole("button", { name: "✓ 确认" }).click();
  await expect(page.locator(".item-row")).toHaveCount(0);
  const db = await pool.query(
    "SELECT qc_status, (SELECT count(*)::int FROM chunks WHERE item_id=i.id) AS chunks FROM items i WHERE i.id=$1",
    [itemId]);
  expect(db.rows[0]).toMatchObject({ qc_status: "approved", chunks: 1 });
  // 试搜命中（走 backend hybridSearch 主链路）
  await page.getByRole("button", { name: "试搜" }).click();
  await page.getByPlaceholder(/语义检索/).fill(`${KEYWORD} 24+37`);
  await page.getByRole("button", { name: "检索" }).click();
  await expect(page.locator(".hits li").first()).toContainText("24+37");
});

test.afterAll(async () => {
  // DB 级联（pages/blocks/items/chunks/review_queue/chapters）；storage 种子文件手工清
  if (docId) await pool.query("DELETE FROM documents WHERE id = ANY($1)", [[docId, flatDocId]]);
  for (const d of [docId, flatDocId]) {
    if (d) rmSync(path.join(STORAGE_ROOT, d), { recursive: true, force: true });
  }
  await pool.end();
});
```

- [ ] **Step 2: 跑 E2E 确认通过**

Run: `cd e2e && npx playwright test specs/materials-review.spec.ts`
Expected: 2 passed（真实 embedding 约 10-30s）。

- [ ] **Step 3: Commit**

```bash
git add e2e/specs/materials-review.spec.ts
git commit -m "test(e2e): 资料复核全链路——页通过/块编辑/条目 approve 即时可检索/试搜/flat 页级向量化"
```

---

### Task 13: 文档回写 + 全量回归

**Files:**

- Modify: `README.md`（复核章节已在 Task 11 改；此处查漏）

- [ ] **Step 1: README 查漏**

Run: `grep -n "8765\|kb.cli review" README.md`
Expected: 无输出（Task 11 已清理；若有残余一并改掉）。

- [ ] **Step 2: 全量回归（三侧 + E2E 全量）**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS。

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
Expected: 全部 PASS。

Run: `cd frontend && npm test`
Expected: 全部 PASS。

Run: `cd e2e && npm test`
Expected: 全部 passed（chat-session/searchability/paper-pipeline/flat-ingest 不受波及）。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: 复核迁移收尾——React 复核页为唯一入口"
```

---

## Self-Review 记录

- **Spec 覆盖**：B1 前端结构（Task 8 tab/四块/文档下拉）、B2 API 全部端点（Task 3-6：docs/pages/pages:id/image/crop/items/items:id/search/PATCH blocks/PATCH items/reject×2/approve page+flat/approve item/page-vlm，adopt 为记录在案的补充）、B3 镜像偏差（写路径不刷镜像，Task 5 注记）、B4 退役（Task 11）、e2e（Task 12）——Workstream B 全条目有对应任务。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码；Task 8 的 PageDetail/ItemDetail 骨架是显式跨任务手法（Task 9/10 整体替换为真实现）。
- **类型一致性**：`ReviewDeps`（search/pipelineUrl/storageRoot）在 Task 3 定义、Task 6/8 与 index.ts 挂载一致；internal 端点签名（approve-item query 参数、page-vlm/embed-flat-page JSON body）与 Task 6 的 forwardInternal 调用一致；前端 `api/review.ts` 类型与后端响应字段（`pending_reasons`/`image_url`/`crop_url`/`page_pending`）逐一对齐。
- **已知取舍**：条目打回后 `onReload` 重拉详情（行仍 pending 显示新行）；页打回提交后留在详情页让复核员看到页级行出现（`reload` 不自动触发——打回行在 `page_pending` 里，需手动刷新，e2e 不覆盖此细节）；旧页的行级 approve/reject 与 QC/接地同步不迁移（偏差记录第 2/4 条）。
