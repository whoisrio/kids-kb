# Phase 3-B 试卷 backlog 修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消化 `docs/superpowers/specs/2026-09-03-phase3-backlog.md` 全部条目——P0（解析失败看不到原件、坏上传死循环）与 P1 十条 Minor。

**Architecture:** P0 围绕"原件可见性"：backend 加 source.pdf 回传与页图清单两个只读端点，failed 详情页有图看图、无图嵌原件，成功卷补整卷入口；pipeline 改为先验证 PDF 再落盘，坏文件不再留下永远失败的残留。
P1 是十个小修复，各自独立、先测试后实现。

**Tech Stack:** hono（backend 路由）、pymupdf（pipeline 验证）、React（ReviewView/PaperQueue/UploadDialog）、PostgreSQL migration。

**前置依赖：** Phase 3-A（`2026-09-03-phase3-a-searchability.md`）已合入——Task 5 涉及的 `search.ts` 代码建立在 3-A 的章节 chunk 结构（`item_id::text, chapter_id::text, document_id::text` 列）之上。
若 3-A 未合入，Task 5 需按旧列结构改写 SQL。

**测试运行命令（全计划通用）：**

- pipeline：`cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
- backend：`cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
- frontend：`cd frontend && npm test`
- E2E：`cd e2e && npm test`

**注意：** pipeline 与 backend 的测试共用 `kb_test` 且各自 DROP SCHEMA，绝不能并行跑。
pipeline 服务（serve-internal）改代码必须重启进程；backend（tsx watch）与 frontend（Vite）热载。

---

## 文件结构（本计划涉及的全部文件）

- Modify: `backend/src/routes/papers.ts` — source.pdf 回传、页图清单、retry/re-recognize/pages-image 的 422 统一
- Modify: `backend/src/routes/paperQuestions.ts` — candidates/image 的 422 统一
- Modify: `backend/src/retrieval/search.ts`、`match.ts` — subject 下推 SQL + topK 10
- Modify: `backend/src/papers/jobs.ts` — re-recognize 后自动匹配限页
- Modify: `backend/src/papers/assemble.ts` — 坏 PDF 明确报错
- Modify: `backend/src/config.ts` — storageRoot 相对 import.meta.url
- Modify: `pipeline/kb/paper_pipeline.py` — 先验证再落盘
- Modify: `pipeline/kb/migrations/0012_papers_attempts_unique.sql` — ctid 决胜去重
- Modify: `frontend/src/api/papers.ts` — json() 读服务端 {error}、child_name、页图清单/原件 URL
- Modify: `frontend/src/views/ReviewView.tsx` — failed 原件预览、孩子过滤、键盘守卫、确认失败反馈、整卷入口
- Modify: `frontend/src/components/PaperQueue.tsx` — 队列显示孩子名、重试真按钮
- Modify: 对应 `*.test.ts(x)`、`pipeline/tests/test_paper_pipeline.py`、`test_db.py`
- Modify: `e2e/specs/paper-pipeline.spec.ts` — 坏上传 422 的 UI 文案断言

---

### Task 1: P0——backend 回传 source.pdf

**Files:**

- Modify: `backend/src/routes/papers.ts`
- Modify: `backend/src/routes/papers.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/src/routes/papers.test.ts` 的 describe 内追加（复用既有 `multipart`/`PNG_1PX` 与 seed 模式；`STORAGE_ROOT` 已指向 `/tmp/kb-papers-test`）：

```ts
  it("GET /:id/source.pdf 回传原件;缺失 404;非法 id 422", async () => {
    const { rows: [paper] } = await pool.query(
      `INSERT INTO papers (child_id, title, subject, status, page_count)
       VALUES ($1,'原件卷','数学','failed',0) RETURNING id::text`, [CHILD]);
    const srcDir = `${STORAGE_ROOT}/papers/${paper.id}`;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(`${srcDir}/source.pdf`, Buffer.from("%PDF-1.4 fake"));

    const ok = await app.request(`/api/papers/${paper.id}/source.pdf`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toContain("%PDF-1.4");

    // 缺失 404
    const { rows: [paper2] } = await pool.query(
      `INSERT INTO papers (child_id, title, subject, status, page_count)
       VALUES ($1,'无原件卷','数学','failed',0) RETURNING id::text`, [CHILD]);
    expect((await app.request(`/api/papers/${paper2.id}/source.pdf`)).status).toBe(404);

    // 非法 id 422(与 Task 4 的统一语义一致,此处先按 422 断言)
    expect((await app.request("/api/papers/not-a-uuid/source.pdf")).status).toBe(422);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/papers.test.ts`
Expected: 新用例 FAIL（404——路由不存在）

- [ ] **Step 3: 实现**

在 `backend/src/routes/papers.ts` 的 `app.get("/:id/pages/:page_no/image"` 之前加：

```ts
  app.get("/:id/source.pdf", async (c) => {
    try {
      const { rows: [paper] } = await pool.query(
        "SELECT id::text FROM papers WHERE id=$1", [c.req.param("id")]);
      if (!paper) return c.json({ error: "试卷不存在" }, 404);
      const path = join(cfg.storageRoot, "papers", paper.id, "source.pdf");
      const buf = await readFile(path);
      return c.body(new Uint8Array(buf), 200, { "Content-Type": "application/pdf" });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "22P02") return c.json({ error: "id 格式非法（须为 UUID）" }, 422);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "原件缺失" }, 404);
      }
      throw err;
    }
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/papers.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add backend/src/routes/papers.ts backend/src/routes/papers.test.ts
git commit -m "feat(papers): source.pdf 原件回传端点(比页图更可靠的存在锚点)"
```

---

### Task 2: P0——pipeline 先验证再落盘，坏上传不再死循环

**Files:**

- Modify: `pipeline/kb/paper_pipeline.py`
- Modify: `pipeline/tests/test_paper_pipeline.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_paper_pipeline.py` 追加（文件内已有 ingest_paper 直测用例，按其 conn/cfg fixture 风格对齐；坏 PDF 用纯垃圾字节）：

```python
def test_ingest_paper_rejects_bad_pdf_before_writing(conn, cfg, tmp_path):
    """坏 PDF:先验证后落盘——不写 source.pdf 残留,报可读错误,重试不再死循环。"""
    from kb.paper_pipeline import ingest_paper

    paper_id = str(uuid.uuid4())
    bad = b"this is not a pdf at all" * 10
    with pytest.raises(Exception, match="(?i)pdf"):
        ingest_paper(conn, cfg, paper_id, pdf_bytes=bad)
    # 关键断言:不留残留文件(旧行为:0 字节/垃圾 source.pdf 留在盘上,retry 永远同错)
    assert not (cfg.storage_dir / "papers" / paper_id / "source.pdf").exists()


def test_ingest_paper_accepts_valid_pdf_still_works(conn, cfg, tmp_path, monkeypatch):
    """正常 PDF 不受影响:落盘且 fitz 可开(复用既有用例语义,回归保护)。"""
    from kb.paper_pipeline import ingest_paper

    paper_id = str(uuid.uuid4())
    d = fitz.open()
    d.new_page()
    pdf = tmp_path / "ok.pdf"
    d.save(pdf)
    # 既有用例已覆盖 VLM 路径;此处 monkeypatch 掉 _recognize_page 只验证落盘顺序
    from kb import paper_pipeline
    monkeypatch.setattr(paper_pipeline, "_recognize_page",
                        lambda *a, **k: [])
    out = ingest_paper(conn, cfg, paper_id, pdf_bytes=pdf.read_bytes())
    assert out["pages"] == 1
    assert (cfg.storage_dir / "papers" / paper_id / "source.pdf").exists()
```

（顶部如缺 `fitz`/`uuid`/`pytest` 导入则补齐，与文件既有导入合并。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_paper_pipeline.py -q -k "bad_pdf or valid_pdf"`
Expected: `test_ingest_paper_rejects_bad_pdf_before_writing` FAIL（旧代码先落盘后 fitz.open——残留文件存在）

- [ ] **Step 3: 实现**

`pipeline/kb/paper_pipeline.py` 的 `ingest_paper` 开头部分（从 `root = ...` 到 `doc = fitz.open(...)`）替换为：

```python
    root = cfg.storage_dir / "papers" / paper_id
    pages_dir, questions_dir = root / "pages", root / "questions"
    source = root / "source.pdf"
    if pdf_bytes is not None:
        # 先验证再落盘:坏 PDF 不留残留文件(否则 retry 复用坏文件永远同错,只能重传)
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        except Exception as e:
            raise ValueError(f"PDF 无法解析(文件损坏或加密): {e}") from e
        root.mkdir(parents=True, exist_ok=True)
        source.write_bytes(pdf_bytes)
    elif source.exists():
        doc = fitz.open(str(source))
    else:
        raise FileNotFoundError("source.pdf 不存在(重驱动须先上传)")
    pages_dir.mkdir(parents=True, exist_ok=True)
    questions_dir.mkdir(parents=True, exist_ok=True)
```

（后续 `for i, page in enumerate(doc, start=1):` 循环与事务块不动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_paper_pipeline.py tests/test_internal_api.py -q`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add pipeline/kb/paper_pipeline.py pipeline/tests/test_paper_pipeline.py
git commit -m "fix(paper): 坏 PDF 先验证再落盘,切断重试死循环"
```

---

### Task 3: P0——failed 详情原件预览 + 页图清单 + 成功卷整卷入口

**Files:**

- Modify: `backend/src/routes/papers.ts`（页图清单端点）
- Modify: `backend/src/routes/papers.test.ts`
- Modify: `frontend/src/api/papers.ts`
- Modify: `frontend/src/views/ReviewView.tsx`
- Modify: `frontend/src/views/ReviewView.test.tsx`

- [ ] **Step 1: 写失败测试（backend 页图清单）**

在 `backend/src/routes/papers.test.ts` 追加：

```ts
  it("GET /:id/pages 列出已渲染页图编号(供 failed 详情展示)", async () => {
    const { rows: [paper] } = await pool.query(
      `INSERT INTO papers (child_id, title, subject, status, page_count)
       VALUES ($1,'页图卷','数学','failed',3) RETURNING id::text`, [CHILD]);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const pagesDir = `${STORAGE_ROOT}/papers/${paper.id}/pages`;
    mkdirSync(pagesDir, { recursive: true });
    writeFileSync(`${pagesDir}/p0002.png`, Buffer.from("png"));
    writeFileSync(`${pagesDir}/p0001.png`, Buffer.from("png"));
    const resp = await app.request(`/api/papers/${paper.id}/pages`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ pages: [1, 2] });  // 升序,只列真实存在的
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/papers.test.ts`
Expected: FAIL（404，路由不存在）

- [ ] **Step 3: 实现页图清单端点**

在 `backend/src/routes/papers.ts` 的 source.pdf 路由后加（顶部补 `import { readdir } from "node:fs/promises";`）：

```ts
  app.get("/:id/pages", async (c) => {
    try {
      const { rows: [paper] } = await pool.query(
        "SELECT id::text FROM papers WHERE id=$1", [c.req.param("id")]);
      if (!paper) return c.json({ error: "试卷不存在" }, 404);
      let names: string[] = [];
      try {
        names = await readdir(join(cfg.storageRoot, "papers", paper.id, "pages"));
      } catch {
        return c.json({ pages: [] });  // 目录还没建(VLM 前/渲染前失败)
      }
      const pages = names
        .map((n) => Number(/^p(\d{4})\.png$/.exec(n)?.[1]))
        .filter((n) => Number.isInteger(n))
        .sort((a, b) => a - b);
      return c.json({ pages });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "22P02") return c.json({ error: "id 格式非法（须为 UUID）" }, 422);
      throw err;
    }
  });
```

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/papers.test.ts`
Expected: 全部 PASS

- [ ] **Step 4: 写失败测试（frontend）**

`frontend/src/api/papers.ts` 加两个纯函数（无网络，直接实现即可，不加测试）：

```ts
export function sourcePdfUrl(paperId: string): string {
  return `/api/papers/${encodeURIComponent(paperId)}/source.pdf`;
}

export function fetchPaperPages(paperId: string, fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/papers/${encodeURIComponent(paperId)}/pages`)
    .then((r) => json<{ pages: number[] }>(r));
}
```

在 `frontend/src/views/ReviewView.test.tsx` 追加：

```ts
  it("failed 详情:展示已渲染页图 + 原件内嵌兜底", async () => {
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("failed", { error: "VLM 超时" })] }),
      "/api/papers/p1": () => jsonResponse({ ...detail([]), status: "failed", error: "VLM 超时" }),
      "/api/papers/p1/pages": () => jsonResponse({ pages: [1] }),
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText(/处理失败/)).toBeInTheDocument());
    // 有页图:页图 <img> 指向页图端点
    expect(screen.getByAltText(/第 1 页/)).toHaveAttribute(
      "src", "/api/papers/p1/pages/1/image");
    // 原件兜底:iframe 内嵌 source.pdf
    expect(screen.getByTitle("试卷原件")).toHaveAttribute("src", "/api/papers/p1/source.pdf");
  });

  it("ready_for_review 详情:提供查看整卷原件入口", async () => {
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    const link = screen.getByRole("link", { name: "查看整卷原件" });
    expect(link).toHaveAttribute("href", "/api/papers/p1/source.pdf");
    expect(link).toHaveAttribute("target", "_blank");
  });
```

- [ ] **Step 5: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/views/ReviewView.test.tsx`
Expected: 两个新用例 FAIL（无页图/原件元素）

- [ ] **Step 6: 实现 ReviewView**

`frontend/src/views/ReviewView.tsx`：

顶部 import 修改：

```ts
import {
  confirmQuestion, fetchPaperDetail, fetchPaperPages, fetchPapers, pageImageUrl,
  reRecognizePaper, retryPaper, sourcePdfUrl,
  type PaperDetail, type PaperQuestion, type PaperSummary,
} from "../api/papers";
```

组件内新增状态与加载（放在 `const [busy, setBusy] = useState(false);` 之后）：

```ts
  const [failedPages, setFailedPages] = useState<number[]>([]);
```

failed 分支选中卷时加载页图清单（`loadDetail` 里）：

```ts
  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await fetchPaperDetail(id));
      setQIndex(0);
      if ((await fetchPaperDetail(id)).status === "failed") {
        setFailedPages((await fetchPaperPages(id)).pages);
      } else {
        setFailedPages([]);
      }
    } catch (err) {
      console.error("试卷详情加载失败", err);
    }
  }, []);
```

（若嫌两次请求，可先 `const d = await fetchPaperDetail(id); setDetail(d);` 再按 `d.status` 分支取页图清单——用后者，避免重复请求。）

failed 渲染分支替换为：

```tsx
        {detail?.status === "failed" && (
          <div className="fail-box">
            <div>处理失败:{detail.error}</div>
            {failedPages.map((n) => (
              <img key={n} className="fail-page" alt={`第 ${n} 页`}
                   src={pageImageUrl(detail.id, n)} />
            ))}
            <iframe className="fail-source" title="试卷原件"
                    src={sourcePdfUrl(detail.id)} />
            <button className="primary" onClick={() => {
              void retryPaper(detail.id).then(() => {
                setDetail({ ...detail, status: "processing", error: null });
                void loadPapers();
              });
            }}>重试</button>
          </div>
        )}
```

`rd-head` 内（"重识别本页"按钮之前）加整卷入口：

```tsx
              <a className="ghost" href={sourcePdfUrl(detail.id)} target="_blank"
                 rel="noreferrer">查看整卷原件</a>
```

`frontend/src/index.css` 补样式（文件末尾追加）：

```css
.fail-box .fail-page { max-width: 100%; border: 1px solid var(--line, #ddd); border-radius: 4px; margin: 8px 0; }
.fail-box .fail-source { width: 100%; height: 420px; border: 1px solid var(--line, #ddd); border-radius: 4px; margin: 8px 0; }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/views/ReviewView.test.tsx`
Expected: 全部 PASS

- [ ] **Step 8: 提交**

```bash
git add backend/src/routes/papers.ts backend/src/routes/papers.test.ts frontend/src/api/papers.ts frontend/src/views/ReviewView.tsx frontend/src/views/ReviewView.test.tsx frontend/src/index.css
git commit -m "feat(review): failed 详情页图+原件内嵌,成功卷整卷原件入口"
```

---

### Task 4: P1#1——非 UUID id 全族统一 422

**Files:**

- Modify: `backend/src/routes/papers.ts`、`backend/src/routes/paperQuestions.ts`
- Modify: `backend/src/routes/papers.test.ts`、`backend/src/routes/paperQuestions.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/src/routes/papers.test.ts` 追加：

```ts
  it("非 UUID id 全族统一 422(retry/re-recognize/pages image)", async () => {
    for (const path of [
      "/api/papers/not-a-uuid/retry",
      "/api/papers/not-a-uuid/re-recognize",
      "/api/papers/not-a-uuid/pages/1/image",
      "/api/papers/not-a-uuid/source.pdf",
      "/api/papers/not-a-uuid/pages",
    ]) {
      const method = path.endsWith("/retry") || path.endsWith("/re-recognize") ? "POST" : "GET";
      const resp = await app.request(path, method === "POST" ? { method: "POST" } : undefined);
      expect(resp.status, path).toBe(422);
      expect((await resp.json()).error).toContain("UUID");
    }
  });
```

`backend/src/routes/paperQuestions.test.ts` 追加（对齐该文件既有构造方式；若其 app 构造不同，按文件现状调整）：

```ts
  it("非 UUID id 统一 422(candidates/image)", async () => {
    expect((await app.request("/api/paper-questions/not-a-uuid/candidates")).status).toBe(422);
    expect((await app.request("/api/paper-questions/not-a-uuid/image")).status).toBe(422);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/papers.test.ts src/routes/paperQuestions.test.ts`
Expected: 新用例 FAIL（retry/re-recognize/pages-image/candidates/image 返回 500）

- [ ] **Step 3: 实现**

`backend/src/routes/papers.ts`：

抽公共守卫（放在 `mapPgError` 旁）：

```ts
/** 路由级统一:id 参数非法(非 UUID)一律 422,不再 500。 */
function invalidId(c: Context, err: unknown): Response | null {
  return (err as { code?: string })?.code === "22P02"
    ? c.json({ error: "id 格式非法（须为 UUID）" }, 422)
    : null;
}
```

`POST /:id/retry` 整体包 try/catch：

```ts
  app.post("/:id/retry", async (c) => {
    try {
      const { rows: [paper] } = await pool.query(
        "SELECT id::text, status FROM papers WHERE id=$1", [c.req.param("id")]);
      if (!paper) return c.json({ error: "试卷不存在" }, 404);
      if (paper.status !== "failed") return c.json({ error: "只有 failed 卷可重试" }, 409);
      await pool.query(
        "UPDATE papers SET status='processing', error=NULL, updated_at=now() WHERE id=$1", [paper.id]);
      void drivePaper(pool, deps, paper.id);
      return c.json({ id: paper.id, status: "processing" });
    } catch (err) {
      return invalidId(c, err) ?? mapPgError(c, err);
    }
  });
```

`POST /:id/re-recognize` 与 `GET /:id/pages/:page_no/image` 同样包 try/catch，catch 块统一 `return invalidId(c, err) ?? mapPgError(c, err);`（函数体不动，只加包裹）。

`backend/src/routes/paperQuestions.ts`：

文件顶部补 `import type { Context } from "hono";`（若未导入），加同款 `invalidId` helper，`GET /:id/candidates` 与 `GET /:id/image` 包 try/catch：

```ts
  app.get("/:id/candidates", async (c) => {
    try {
      const { rows: [q] } = await pool.query(
        `SELECT pq.content_md, p.subject FROM paper_questions pq
         JOIN papers p ON p.id = pq.paper_id WHERE pq.id=$1`, [c.req.param("id")]);
      if (!q) return c.json({ error: "题目不存在" }, 404);
      const { candidates } = await matchQuestion(
        pool, { embed: deps.embed, rerank: deps.rerank }, q.content_md, q.subject, deps.matchThreshold);
      return c.json({ candidates });
    } catch (err) {
      return invalidId(c, err) ?? ((err as { code?: string })?.code === "23503"
        ? c.json({ error: "item_id 不存在" }, 404) : (() => { throw err; })());
    }
  });
```

（`GET /:id/image` 同样包裹，catch 直接 `return invalidId(c, err) ?? (() => { throw err; })();`——若嫌别扭，可只在 catch 里处理 22P02 后 rethrow。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add backend/src/routes/papers.ts backend/src/routes/paperQuestions.ts backend/src/routes/papers.test.ts backend/src/routes/paperQuestions.test.ts
git commit -m "fix(api): 试卷族非 UUID id 统一 422,错误语义一致"
```

---

### Task 5: P1#2——matchQuestion topK=10 + subject 下推 SQL

**Files:**

- Modify: `backend/src/retrieval/search.ts`、`backend/src/retrieval/match.ts`
- Modify: `backend/src/retrieval/search.test.ts`、`backend/src/retrieval/match.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/src/retrieval/search.test.ts` 追加（beforeAll 里建一个新 doc "英语书" + 21 条英语 chunk，内容与查询词高度重合）：

beforeAll 追加种子（顶部补 `import { randomUUID } from "node:crypto";`）：

```ts
    await pool.query(
      `INSERT INTO documents (id, title, subject, source_path) VALUES
        ('77777777-7777-7777-7777-777777777777', '英语书', '英语', '/tmp/c.pdf')`,
    );
    for (let i = 0; i < 21; i++) {
      await pool.query(
        `INSERT INTO chunks (item_id, document_id, content_md, meta, embedding)
         VALUES ($1, '77777777-7777-7777-7777-777777777777',
                 '英语阅读理解 exercise long padding text number ' || $2,
                 '{"subject":"英语","doc_title":"英语书"}', $3::vector)`,
        [randomUUID(), String(i), V2],
      );
    }
```

用例：

```ts
  it("subject 下推 SQL:其他学科刷满窗口也不挤掉同学科命中", async () => {
    // 21 条英语 chunk 都含查询词,BM25 全局 top-20 会被英语占满;
    // 数学真命中必须仍在窗口内(SQL 预过滤,而非融合后过滤)
    const hits = await hybridSearch(pool, deps, "英语阅读理解", {
      topK: 10, filters: { subject: "数学" },
    });
    expect(hits.every((h) => h.subject === "数学")).toBe(true);
    expect(hits.some((h) => h.item_id === "22222222-2222-2222-2222-222222222222")).toBe(true);
  });
```

`backend/src/retrieval/match.test.ts` 追加：

```ts
  it("topK=10:候选窗口按 spec 放宽到 10", async () => {
    const { candidates } = await matchQuestion(pool, deps, "135 ÷ 5 = 27", "数学", 0.88);
    expect(candidates.length).toBeLessThanOrEqual(10);
    // 该测试库条目少,断言上限即可;下限由 seed 数决定,不做硬断言
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/retrieval/search.test.ts src/retrieval/match.test.ts`
Expected: 新用例 FAIL（英语 chunk 挤满 top-20 后，数学条目不在融合窗口，post-filter 后为空）

- [ ] **Step 3: 实现**

`backend/src/retrieval/search.ts`：

`vectorHits` 加 subject 参数：

```ts
async function vectorHits(
  pool: pg.Pool, vec: number[], topN: number, itemsOnly: boolean, subject: string | undefined,
): Promise<ChunkRow[]> {
  const conds = [itemsOnly && "c.item_id IS NOT NULL", subject && "c.meta->>'subject' = $3"]
    .filter(Boolean) as string[];
  const params: unknown[] = [`[${vec.join(",")}]`, topN];
  if (subject) params.push(subject);
  const { rows } = await pool.query(
    `SELECT c.item_id::text, c.chapter_id::text, c.document_id::text, c.content_md, c.meta,
            1 - (c.embedding <=> $1::vector) AS score
     FROM chunks c ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
     ORDER BY c.embedding <=> $1::vector LIMIT $2`,
    params,
  );
  return rows;
}
```

`hybridSearch` 中调用与 BM25 全量查询改为：

```ts
  const topK = opts.topK ?? 5;
  const itemsOnly = opts.itemsOnly ?? false;
  const subject = opts.filters?.subject;
  const [vec] = await deps.embed([query]);
  const vecHits = await vectorHits(pool, vec, 20, itemsOnly, subject);
  const bm25Conds = [itemsOnly && "item_id IS NOT NULL", subject && "meta->>'subject' = $1"]
    .filter(Boolean) as string[];
  const bm25Params: unknown[] = subject ? [subject] : [];
  const { rows: allChunks } = await pool.query(
    `SELECT item_id::text, chapter_id::text, document_id::text, content_md, meta
     FROM chunks ${bm25Conds.length ? `WHERE ${bm25Conds.join(" AND ")}` : ""}`,
    bm25Params,
  );
```

（filters 的 meta 后置过滤保留——防御 meta 与 SQL 不一致的边角；主窗口由 SQL 保证。）

`backend/src/retrieval/match.ts` 的 topK 改 10：

```ts
  const candidates = await hybridSearch(pool, deps, content, {
    topK: 10,
    filters: { subject },
    itemsOnly: true,  // 试卷匹配只对题库条目;章节分段是检索底座,不是可关联的题
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/retrieval/ src/agent/`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add backend/src/retrieval/search.ts backend/src/retrieval/match.ts backend/src/retrieval/search.test.ts backend/src/retrieval/match.test.ts
git commit -m "fix(search): subject 过滤下推 SQL(两路召回同学科窗口)+ 匹配 topK 放宽到 10"
```

---

### Task 6: P1#3——re-recognize 自动匹配限页

**Files:**

- Modify: `backend/src/papers/jobs.ts`
- Modify: `backend/src/papers/jobs.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backend/src/papers/jobs.test.ts` 追加：

```ts
  it("re-recognize 只重匹配该页:其它页家长清除过的匹配不被自动重挂", async () => {
    // 卷 ready_for_review:页 1 一条普通题;页 2 一条与 ITEM 同文、但家长人工清除了匹配(NULL)
    const paperId = await seedPaper("ready_for_review");
    await seedQuestion(paperId, "246 × 37 =");  // 页 1,普通未匹配
    const { rows: [cleared] } = await pool.query(
      `INSERT INTO paper_questions (paper_id, page_no, seq_in_page, content_md, matched_item_id)
       VALUES ($1, 2, 1, '135 ÷ 5 =', NULL) RETURNING id::text`, [paperId]);
    await drivePaper(pool, { ...deps, fetchImpl: vi.fn(async () =>
      new Response(JSON.stringify({ pages: 1, questions: 1 }))) as unknown as typeof fetch },
      paperId, { pageNo: 1 });
    await waitSettled(paperId, "ready_for_review");
    // 页 2 与 ITEM 同文(余弦 1):旧代码全卷重扫会把它重新挂上——这就是回归点
    const { rows: [row] } = await pool.query(
      "SELECT matched_item_id::text FROM paper_questions WHERE id=$1", [cleared.id]);
    expect(row.matched_item_id).toBeNull();  // 新行为:不在重识别页,不参与自动匹配
  });
```

（说明：核心回归点是“重识别页之外的题目不再被全卷重扫”。
页 2 的题与 ITEM chunk 同文且被家长清除过匹配——旧代码不限页会重新挂上，新代码不会。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/papers/jobs.test.ts`
Expected: 新用例 FAIL（旧代码不限页，页 2 的 NULL 匹配被重新挂上）

- [ ] **Step 3: 实现**

`backend/src/papers/jobs.ts` 的自动匹配查询改为按 `opts.pageNo` 限定：

```ts
  // 逐题自动匹配(失败不致命:人工匹配兜底)。
  // 页级重识别只重匹配该页:其它页人工清除过的匹配不得被自动匹配重新挂上
  const { rows: questions } = await pool.query<{ id: string; content_md: string; subject: string }>(
    `SELECT pq.id::text, pq.content_md, p.subject FROM paper_questions pq
     JOIN papers p ON p.id = pq.paper_id
     WHERE pq.paper_id = $1 AND pq.matched_item_id IS NULL
       AND ($2::int IS NULL OR pq.page_no = $2)`,
    [paperId, opts.pageNo ?? null],
  );
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/papers/jobs.test.ts`
Expected: 全部 PASS（含既有"成功路径"用例——`opts.pageNo` undefined → `$2 IS NULL` → 全卷，行为不变）

- [ ] **Step 5: 提交**

```bash
git add backend/src/papers/jobs.ts backend/src/papers/jobs.test.ts
git commit -m "fix(paper): 页级重识别只重匹配该页,人工清除的匹配不被自动重挂"
```

---

### Task 7: P1#4——坏 PDF 上传 422 + 前端读服务端错误文案

**Files:**

- Modify: `backend/src/papers/assemble.ts`
- Modify: `backend/src/papers/assemble.test.ts`
- Modify: `backend/src/routes/papers.ts`
- Modify: `backend/src/routes/papers.test.ts`
- Modify: `frontend/src/api/papers.ts`

- [ ] **Step 1: 写失败测试**

`backend/src/papers/assemble.test.ts` 追加：

```ts
  it("坏 PDF(垃圾字节)报可读错误而非 pdf-lib 内部报错", async () => {
    await expect(assemblePdf([
      { name: "corrupt.pdf", bytes: new TextEncoder().encode("junk junk junk") },
    ])).rejects.toThrow(/PDF 无法解析.*corrupt\.pdf/);
  });
```

`backend/src/routes/papers.test.ts` 追加：

```ts
  it("上传坏 PDF 返回 422 且 error 带文件名", async () => {
    const resp = await app.request("/api/papers", { method: "POST", body: multipart(
      { child_id: CHILD, title: "坏卷", subject: "数学" },
      [{ name: "corrupt.pdf", bytes: new TextEncoder().encode("junk") }],
    )});
    expect(resp.status).toBe(422);
    expect((await resp.json()).error).toContain("corrupt.pdf");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/papers/assemble.test.ts src/routes/papers.test.ts`
Expected: FAIL（pdf-lib 抛英文内部错误 → 路由 500）

- [ ] **Step 3: 实现**

`backend/src/papers/assemble.ts` 的 PDF 分支包 try/catch：

```ts
    if (/\.pdf$/i.test(f.name)) {
      let src: import("pdf-lib").PDFDocument;
      try {
        src = await PDFDocument.load(f.bytes);
      } catch (e) {
        throw new Error(`PDF 无法解析(文件损坏或加密): ${f.name}`);
      }
      const pages = await doc.copyPages(src, src.getPageIndices());
      pages.forEach((p) => doc.addPage(p));
    } else if (/\.jpe?g$/i.test(f.name)) {
```

（catch 变量 `e` 不使用会 lint 报错——写成 `catch {`。）

`backend/src/routes/papers.ts` 的 POST `/` 错误分支正则扩为：

```ts
      if (err instanceof Error && /不支持的文件类型|至少上传|PDF 无法解析/.test(err.message)) {
        return c.json({ error: err.message }, 422);
      }
```

`frontend/src/api/papers.ts` 的 `json()` 改为透传服务端文案：

```ts
async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `请求失败: ${resp.status}`);
  }
  return (await resp.json()) as T;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test && cd ../frontend && npm test`
Expected: 全部 PASS（frontend 若有依赖旧文案"请求失败"的测试，同步更新断言）

- [ ] **Step 5: 提交**

```bash
git add backend/src/papers/assemble.ts backend/src/papers/assemble.test.ts backend/src/routes/papers.ts backend/src/routes/papers.test.ts frontend/src/api/papers.ts
git commit -m "fix(upload): 坏 PDF 上传 422 带文件名;前端透传服务端错误文案"
```

---

### Task 8: P1#5——internal_api 连接 try/finally 关闭

**Files:**

- Modify: `pipeline/kb/internal_api.py`
- Modify: `pipeline/tests/test_internal_api.py`

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_internal_api.py` 追加：

```python
class _ConnSpy:
    """包裹真连接,数 close 调用次数。"""

    def __init__(self, inner):
        self.inner = inner
        self.closed = 0

    def close(self):
        self.closed += 1
        self.inner.close()

    def __getattr__(self, name):
        return getattr(self.inner, name)


def test_endpoints_close_connection(conn, cfg):
    """ingest-paper 端点用后即关(不再靠 GC);失败路径也关。"""
    import psycopg
    from kb.db import connect
    from kb.config import Config as C

    spy_holder = []

    def get_conn():
        c = _ConnSpy(connect(cfg.database_url))
        spy_holder.append(c)
        return c

    real_cfg = C(database_url=cfg.database_url, storage_dir=cfg.storage_dir,
                 vision_base_url="http://localhost:11434/v1",
                 vision_api_key="ollama", vision_model="qwen3:4b")
    app = create_internal_app(get_conn=get_conn, cfg=real_cfg)
    c = TestClient(app)
    # 不存在的卷 -> 500,但连接照样要关
    resp = c.post("/internal/ingest-paper?paper_id=00000000-0000-0000-0000-000000000000")
    assert resp.status_code >= 400
    assert spy_holder[-1].closed == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_internal_api.py -q -k close_connection`
Expected: FAIL（`closed == 0`，连接没关）

- [ ] **Step 3: 实现**

`pipeline/kb/internal_api.py` 的两个端点改为"开—用—关"：

```python
    @app.post("/internal/ingest-paper")
    def ingest_paper_ep(paper_id: str, file: UploadFile | None = File(default=None)):
        """整卷加工：首次带 file 上传；重驱动可不带(复用已存 source.pdf)。"""
        from kb.paper_pipeline import ingest_paper
        conn = _conn()
        try:
            data = file.file.read() if file is not None else None
            return ingest_paper(conn, cfg, paper_id, pdf_bytes=data, client=vlm_client)
        except HTTPException:
            raise
        except Exception as e:
            # 500 带真实原因:TS 侧 jobs.ts 读 detail 落 papers.error,纯 "Internal Server Error" 不可排查
            raise HTTPException(status_code=500, detail=str(e)) from e
        finally:
            conn.close()

    @app.post("/internal/recognize-page")
    def recognize_page_ep(body: RecognizePageRequest):
        """单页重识别：只重建该页题目，其它页的人工确认不动。"""
        from kb.paper_pipeline import recognize_page
        conn = _conn()
        try:
            return recognize_page(conn, cfg, body.paper_id, body.page_no, client=vlm_client)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e)) from e
        finally:
            conn.close()
```

注意：既有类用例若以 `get_conn=lambda: conn` 注入共享连接，会被 finally 关掉而互相影响——
把这些用例的注入改为 `get_conn=lambda: connect(<url>)`（每请求新开），或注入 spy。
先跑全文件看哪些用例受影响，逐一调整。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_internal_api.py -q`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add pipeline/kb/internal_api.py pipeline/tests/test_internal_api.py
git commit -m "fix(internal): 内部端点连接 try/finally 即时关闭,不靠 GC"
```

---

### Task 9: P1#6——试卷队列孩子维度

**Files:**

- Modify: `backend/src/routes/papers.ts`（列表 SQL 加 child_name）
- Modify: `backend/src/routes/papers.test.ts`
- Modify: `frontend/src/api/papers.ts`（PaperSummary.child_name）
- Modify: `frontend/src/views/ReviewView.tsx`（孩子过滤下拉）
- Modify: `frontend/src/components/PaperQueue.tsx`（队列显示孩子名）
- Modify: `frontend/src/views/ReviewView.test.tsx`

- [ ] **Step 1: 写失败测试**

`backend/src/routes/papers.test.ts` 追加：

```ts
  it("列表带 child_name(队列显示用)", async () => {
    const { rows: [paper] } = await pool.query(
      `INSERT INTO papers (child_id, title, subject, status, page_count)
       VALUES ($1,'孩子卷','数学','ready_for_review',1) RETURNING id::text`, [CHILD]);
    const resp = await app.request("/api/papers");
    const row = ((await resp.json()) as { papers: { id: string; child_name: string }[] })
      .papers.find((p) => p.id === paper.id);
    expect(row?.child_name).toBe("小宝");
  });
```

`frontend/src/views/ReviewView.test.tsx` 追加：

```ts
  it("队列按孩子过滤:切换下拉只显示该孩子的卷,队列项显示孩子名", async () => {
    const papers = [
      paper("ready_for_review", { id: "p1", child_name: "小宝" }),
      paper("ready_for_review", { id: "p2", title: "英语卷", subject: "英语", child_name: "二宝" }),
    ];
    let filterQs = "";
    stub({
      "/api/children": () => jsonResponse({ children: [
        ...CHILDREN, { id: "c2", name: "二宝", grade: null, created_at: "2026-01-02" }] }),
      "/api/papers": (init) => {
        filterQs = new URL(String(init instanceof Request ? init.url : "")).search; // vitest stub 传 init
        return jsonResponse({ papers });
      },
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("英语卷")).toBeInTheDocument());
    expect(screen.getByText("小宝")).toBeInTheDocument();  // 队列项带孩子的名字
    fireEvent.change(screen.getByLabelText("孩子"), { target: { value: "c1" } });
    await waitFor(() => expect(filterQs).toContain("child_id=c1"));
    await waitFor(() => expect(screen.queryByText("英语卷")).not.toBeInTheDocument());
  });
```

（stub 的 fetchRouter 如何透传 URL 以该文件的 `fetchRouter` 实现为准——先读 `frontend/src/test/support.ts`，若路由表按 path 精确匹配，需要为 `/api/papers?child_id=c1` 增加独立路由条目并记录调用。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npx vitest run src/routes/papers.test.ts && cd ../frontend && npx vitest run src/views/ReviewView.test.tsx`
Expected: 新用例 FAIL

- [ ] **Step 3: 实现**

`backend/src/routes/papers.ts` 列表 SQL 加 JOIN：

```ts
  app.get("/", async (c) => {
    const childId = c.req.query("child_id");
    const params: unknown[] = [];
    let where = "";
    if (childId) { where = "WHERE p.child_id=$1"; params.push(childId); }
    const { rows } = await pool.query(
      `SELECT p.id::text, p.title, p.subject, p.status, p.error, p.page_count, p.created_at,
              ch.name AS child_name,
              count(q.id)::int AS total_questions,
              count(q.id) FILTER (WHERE q.confirmed_result IS NOT NULL)::int AS confirmed_questions
       FROM papers p
       JOIN children ch ON ch.id = p.child_id
       LEFT JOIN paper_questions q ON q.paper_id = p.id
       ${where} GROUP BY p.id, ch.name ORDER BY p.created_at DESC`, params);
    return c.json({ papers: rows });
  });
```

`frontend/src/api/papers.ts`：`PaperSummary` 加 `child_name: string;`；`fetchPapers` 已支持 childId 参数（不变）。

`frontend/src/views/ReviewView.tsx`：

新增状态：

```ts
  const [childFilter, setChildFilter] = useState("");
```

`loadPapers` 改为依赖 childFilter：

```ts
  const loadPapers = useCallback(async () => {
    try {
      const { papers: list } = await fetchPapers(childFilter || undefined);
      setPapers(list);
    } catch (err) {
      console.error("试卷列表加载失败", err);
    }
  }, [childFilter]);
```

（既有 `useEffect([loadPapers])` 与轮询逻辑自动跟随。）

在 `<PaperQueue` 之前插入过滤下拉（放在 review-detail 顶部或 queue 上方，视觉对齐现有 select 风格）：

```tsx
      <div className="child-filter">
        <select aria-label="孩子" value={childFilter}
                onChange={(e) => setChildFilter(e.target.value)}>
          <option value="">全部孩子</option>
          {kids.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
        </select>
      </div>
```

`frontend/src/components/PaperQueue.tsx` 的 `.m` 行内加孩子名：

```tsx
            <span className="m">
              <span className={`status ${p.status}`}>{STATUS_TEXT[p.status]}</span>
              {p.child_name && <span>{p.child_name}</span>}
              {p.status === "failed" && <span className="err" title={p.error ?? ""}>重试</span>}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test && cd ../frontend && npm test`
Expected: 全部 PASS（ReviewView 既有用例的 paper() 工厂缺 child_name 字段——给工厂默认加 `child_name: "小宝"`）

- [ ] **Step 5: 提交**

```bash
git add backend/src/routes/papers.ts backend/src/routes/papers.test.ts frontend/src/api/papers.ts frontend/src/views/ReviewView.tsx frontend/src/views/ReviewView.test.tsx frontend/src/components/PaperQueue.tsx
git commit -m "feat(review): 试卷队列孩子维度——过滤下拉 + 队列显示孩子名"
```

---

### Task 10: P1#7——匹配浮层键盘守卫 + 确认失败 UI 反馈

**Files:**

- Modify: `frontend/src/views/ReviewView.tsx`
- Modify: `frontend/src/views/ReviewView.test.tsx`

- [ ] **Step 1: 写失败测试**

`frontend/src/views/ReviewView.test.tsx` 追加：

```ts
  it("匹配浮层打开时按 1/2/3 不确认底层题", async () => {
    const confirms: unknown[] = [];
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1, Q2])),
      "/api/paper-questions/q1/candidates": () => jsonResponse({ candidates: [] }),
      "/api/paper-questions/q1/confirm": (init) => {
        confirms.push(JSON.parse(String(init?.body)));
        return jsonResponse({ id: "q1", paper_status: "ready_for_review" });
      },
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    fireEvent.click(screen.getByText(/待匹配/));  // 打开匹配浮层
    await waitFor(() => expect(screen.getByRole("dialog", { name: "选择题库条目" })).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "1" });     // 浮层开着:不得确认底层题
    expect(confirms).toEqual([]);
  });

  it("确认失败给 UI 反馈(不再只有 console.error)", async () => {
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("ready_for_review")] }),
      "/api/papers/p1": () => jsonResponse(detail([Q1])),
      "/api/paper-questions/q1/confirm": () => jsonResponse({ error: "服务器开小差" }, 502),
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByText("期中卷"));
    await waitFor(() => expect(screen.getByText("135 ÷ 5 =")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /✗ 错/ }));
    await waitFor(() =>
      expect(screen.getByText(/确认失败/)).toBeInTheDocument());
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/views/ReviewView.test.tsx`
Expected: 两个新用例 FAIL

- [ ] **Step 3: 实现**

`frontend/src/views/ReviewView.tsx`：

新增状态：

```ts
  const [confirmError, setConfirmError] = useState("");
```

`doConfirm` 的 catch 改为：

```ts
    } catch (err) {
      console.error("确认失败", err);
      setConfirmError(err instanceof Error ? err.message : String(err));
    } finally {
```

成功路径清掉旧错误（`setBusy(true)` 后加 `setConfirmError("");`）。

键盘 onKey 开头（焦点守卫之后）加浮层守卫：

```ts
      if (matchOpen || uploadOpen) return;  // 浮层开着:快捷键不落到底层题
```

verdict 区尾部（`.keyhint` 之前）加反馈：

```tsx
            {confirmError && <div className="form-error" role="alert">确认失败:{confirmError}</div>}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npm test`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add frontend/src/views/ReviewView.tsx frontend/src/views/ReviewView.test.tsx
git commit -m "fix(review): 浮层键盘守卫补全 + 确认失败 UI 反馈"
```

---

### Task 11: P1#8——storageRoot 相对 import.meta.url 解析

**Files:**

- Modify: `backend/src/config.ts`
- Modify: `backend/src/config.test.ts`

- [ ] **Step 1: 写失败测试**

`backend/src/config.test.ts` 的 storageRoot 用例改为（原用例断言"相对 backend cwd"）：

```ts
  it("storageRoot 缺省指向仓库 pipeline/storage(相对本文件解析,不依赖 cwd)", () => {
    const cfg = loadConfig({ KB_DATABASE_URL: "postgresql://x/kb" } as NodeJS.ProcessEnv);
    expect(cfg.storageRoot).toBe(
      fileURLToPath(new URL("../../pipeline/storage", import.meta.url)),
    );
  });
```

（顶部补 `import { fileURLToPath } from "node:url";`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/config.test.ts`
Expected: FAIL（旧实现 `pathResolve("../pipeline/storage")` 相对 cwd，从别的 cwd 跑不相等）

- [ ] **Step 3: 实现**

`backend/src/config.ts`：

导入改：

```ts
import { resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
```

（`pathResolve` 若仅 storageRoot 用，可整体移除。）storageRoot 行改为：

```ts
    // 试卷页图/题图在 pipeline/storage 下;相对本文件解析(src 与 dist 同深),从任意 cwd 启动都对
    storageRoot: pick(env.KB_STORAGE_ROOT)
      ?? fileURLToPath(new URL("../../pipeline/storage", import.meta.url)),
```

- [ ] **Step 4: 跑测试确认通过 + 从仓库根启动冒烟**

Run: `cd backend && npx vitest run src/config.test.ts && npm test`
Expected: PASS

冒烟（旧行为的坑位复现）：

```bash
cd /Users/rio/repos/myprjs/kids-knowledge-base && node backend/dist/index.js &
sleep 2 && curl -s http://127.0.0.1:8787/api/health && kill %1
```

（若 dist 未构建，先 `cd backend && npm run build`。）
Expected: health OK；旧代码从仓库根启动时 storageRoot 指向仓库外。

- [ ] **Step 5: 提交**

```bash
git add backend/src/config.ts backend/src/config.test.ts
git commit -m "fix(config): storageRoot 相对 import.meta.url 解析,任意 cwd 启动都对"
```

---

### Task 12: P1#9——migration 0012 去重 ctid 决胜

**Files:**

- Modify: `pipeline/kb/migrations/0012_papers_attempts_unique.sql`
- Modify: `pipeline/tests/test_db.py`

**说明：** 历史重复行 `created_at` 完全相同时，`a.created_at < b.created_at` 互不小于 → 双双保留 → 建唯一索引失败。
该 migration 每次测试库重建都会重放，编辑在案的 0012 是唯一修法（若它失败，后续 migration 全部跑不到）；
生产库 `kb` 已成功应用 0012（索引 `attempts_paper_question_id_key` 已存在，已验证），不重放、无影响。

- [ ] **Step 1: 写失败测试**

在 `pipeline/tests/test_db.py` 追加：

```python
def test_0012_dedup_ties_same_timestamp(clean_db, tmp_path):
    """0012 对 created_at 完全相同的重复行也能去重(ctid 决胜),唯一索引必成。"""
    from kb.db import migrate
    from pathlib import Path

    migrate(clean_db)  # 先全量建好(含 0012),再构造 0012 之前的状态
    with clean_db.cursor() as cur:
        cur.execute("DROP INDEX IF EXISTS attempts_paper_question_id_key")
        cur.execute("DELETE FROM schema_migrations WHERE name='0012_papers_attempts_unique.sql'")
        # 种子:一个孩子 + 一份卷一道题
        cur.execute("INSERT INTO children (name) VALUES ('小宝') RETURNING id")
        child_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO papers (id, child_id, title, subject) VALUES (gen_random_uuid(),%s,'卷','数学') RETURNING id""",
            (child_id,))
        paper_id = str(cur.fetchone()[0])
        cur.execute(
            """INSERT INTO paper_questions (id, paper_id, page_no, seq_in_page, content_md)
               VALUES (gen_random_uuid(),%s,1,1,'题') RETURNING id""", (paper_id,))
        pq_id = str(cur.fetchone()[0])
        # 两条同 paper_question、created_at 完全相同的重复 attempt(触发旧行为双双保留)
        cur.execute(
            """INSERT INTO attempts (child_id, paper_question_id, result)
               VALUES (%s,%s,'wrong'),(%s,%s,'wrong')""",
            (child_id, pq_id, child_id, pq_id))
        cur.execute(
            "UPDATE attempts SET created_at='2026-01-01T00:00:00Z' WHERE paper_question_id=%s",
            (pq_id,))
    ran = migrate(clean_db)  # 重放 0012
    assert "0012_papers_attempts_unique.sql" in ran
    with clean_db.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM attempts WHERE paper_question_id=%s", (pq_id,))
        assert cur.fetchone()[0] == 1
        cur.execute(
            "SELECT count(*) FROM pg_indexes WHERE indexname='attempts_paper_question_id_key'")
        assert cur.fetchone()[0] == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/test_db.py -q -k 0012`
Expected: FAIL（旧行为保留 2 条，建索引抛 unique 冲突 → migrate 报错）

- [ ] **Step 3: 实现**

`pipeline/kb/migrations/0012_papers_attempts_unique.sql` 追加决胜段（文件末尾）：

```sql
-- created_at 完全相同的重复行:保留 ctid 最小的一条(物理位置决胜,确定性去重)
DELETE FROM attempts a
WHERE a.paper_question_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM attempts b
              WHERE b.paper_question_id = a.paper_question_id
                AND b.created_at = a.created_at
                AND b.ctid < a.ctid);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS（全量重放含 0012）

- [ ] **Step 5: 生产库核验不受影响**

Run: `psql "postgresql://localhost/kb" -c "SELECT indexname FROM pg_indexes WHERE indexname='attempts_paper_question_id_key';" -c "SELECT count(*) FROM schema_migrations WHERE name='0012_papers_attempts_unique.sql';"`
Expected: 索引存在 + 已记账（kb 不重放 0012，编辑无副作用）

- [ ] **Step 6: 提交**

```bash
git add pipeline/kb/migrations/0012_papers_attempts_unique.sql pipeline/tests/test_db.py
git commit -m "fix(migration): 0012 去重加 ctid 决胜,同时间戳重复行不再炸索引"
```

---

### Task 13: P1#10——队列 failed「重试」变真按钮

**Files:**

- Modify: `frontend/src/components/PaperQueue.tsx`
- Modify: `frontend/src/views/ReviewView.tsx`
- Modify: `frontend/src/views/ReviewView.test.tsx`

- [ ] **Step 1: 写失败测试**

`frontend/src/views/ReviewView.test.tsx` 追加：

```ts
  it("队列里 failed 卷的重试可直接点击并触发 retry", async () => {
    const retries: string[] = [];
    stub({
      "/api/children": () => jsonResponse(CHILDREN_RES),
      "/api/papers": () => jsonResponse({ papers: [paper("failed", { error: "VLM 挂了" })] }),
      "/api/papers/p1/retry": () => { retries.push("p1"); return jsonResponse({ id: "p1", status: "processing" }); },
    });
    render(<ReviewView />);
    await waitFor(() => expect(screen.getByText("期中卷")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "重试" }));  // 队列项上的真按钮
    await waitFor(() => expect(retries).toEqual(["p1"]));
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/views/ReviewView.test.tsx`
Expected: FAIL（重试是 span，`getByRole("button")` 找不到）

- [ ] **Step 3: 实现**

`frontend/src/components/PaperQueue.tsx`：

Props 加 `onRetry`，failed 行的 span 换按钮，且外层 `paper-item` 本身是 button（嵌套 button 非法）——
把队列项根元素从 `<button>` 改为 `<div role="button" tabIndex={0}>`（或在 `.m` 行用 `e.stopPropagation()` 的内层按钮；
取后者改动最小，但 HTML 嵌套 button 不合法——**采用前者**）：

```tsx
interface PaperQueueProps {
  papers: PaperSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUpload: () => void;
  onRetry: (id: string) => void;
}

export function PaperQueue({ papers, selectedId, onSelect, onUpload, onRetry }: PaperQueueProps) {
  return (
    <aside className="papers-queue">
      <div className="pq-head">
        <span className="label">试卷</span>
        <button className="new-btn" onClick={onUpload}>＋ 上传试卷</button>
      </div>
      <div className="pq-list">
        {papers.length === 0 && <div className="empty">还没有上传试卷</div>}
        {papers.map((p) => (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            className={`paper-item${p.id === selectedId ? " active" : ""}`}
            onClick={() => onSelect(p.id)}
            onKeyDown={(e) => { if (e.key === "Enter") onSelect(p.id); }}
          >
            <span className="t">{p.title}</span>
            <span className="m">
              <span className={`status ${p.status}`}>{STATUS_TEXT[p.status]}</span>
              {p.child_name && <span>{p.child_name}</span>}
              {p.status === "failed" && (
                <button className="err retry-btn" title={p.error ?? ""}
                        onClick={(e) => { e.stopPropagation(); onRetry(p.id); }}>重试</button>
              )}
              {p.total_questions > 0 && (
                <span>{p.confirmed_questions}/{p.total_questions}</span>
              )}
              <span>{p.subject}</span>
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}
```

（若 Task 9 未先做，`p.child_name` 行按当时的 PaperQueue 现状合并。）
样式补 `.paper-item` 的焦点态与 `.retry-btn`（`frontend/src/index.css`）：

```css
.paper-item { cursor: pointer; }
.paper-item:focus-visible { outline: 2px solid #E03C28; outline-offset: -2px; }
.retry-btn { background: none; border: none; color: #E03C28; cursor: pointer; padding: 0; text-decoration: underline; }
```

`frontend/src/views/ReviewView.tsx` 接线：

```tsx
      <PaperQueue
        papers={papers}
        selectedId={selectedId}
        onSelect={(id) => { setSelectedId(id); void loadDetail(id); }}
        onUpload={() => setUploadOpen(true)}
        onRetry={(id) => {
          void retryPaper(id).then(() => {
            void loadPapers();
            if (id === selectedId) void loadDetail(id);
          }).catch((err) => console.error("重试失败", err));
        }}
      />
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npm test`
Expected: 全部 PASS（既有用例若用 `getByText("期中卷")` 点选队列项，div role=button 仍可 click，不受影响）

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/PaperQueue.tsx frontend/src/views/ReviewView.tsx frontend/src/views/ReviewView.test.tsx frontend/src/index.css
git commit -m "fix(review): 队列 failed 重试改为可点按钮,直达 retry 接口"
```

---

### Task 14: E2E——坏上传 422 文案到 UI

**Files:**

- Modify: `e2e/specs/paper-pipeline.spec.ts`

- [ ] **Step 1: 写用例**

在 `e2e/specs/paper-pipeline.spec.ts` 追加（对齐既有上传流程的 helper；垃圾字节 + .pdf 后缀）：

```ts
test("坏 PDF 上传:422 文案直达 UI,不进队列", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "复核" }).click();
  await page.getByRole("button", { name: "上传试卷" }).click();
  await page.getByLabel("孩子").selectOption({ index: 0 });
  await page.getByLabel("标题").fill(`E2E-${RUN}-坏卷`);
  await page.getByLabel("科目").selectOption("数学");
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByLabel("文件").click(),
  ]);
  await fileChooser.setFiles({
    name: "corrupt.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("junk junk junk"),
  });
  await page.getByRole("button", { name: "提交" }).click();
  await expect(page.locator(".form-error")).toContainText(/corrupt\.pdf|PDF 无法解析/);
  // 没有生成队列项
  await expect(page.getByText(`E2E-${RUN}-坏卷`)).toHaveCount(0);
});
```

（选择器名以实际 UI 为准——先跑一遍看上传弹层的 label/按钮文案；`提交` 若为 `上传` 等按实际改。）

- [ ] **Step 2: 运行**

Run: `cd e2e && npx playwright test specs/paper-pipeline.spec.ts`
Expected: 全部 PASS

- [ ] **Step 3: 全量回归**

Run: `cd e2e && npm test && cd ../pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q && cd ../backend && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test npm test && cd ../frontend && npm test`
Expected: 四套全绿

- [ ] **Step 4: 提交**

```bash
git add e2e/specs/paper-pipeline.spec.ts
git commit -m "feat(e2e): 坏 PDF 上传 422 文案直达 UI 的回归用例"
```

---

### Task 15: backlog 清账

**Files:**

- Modify: `docs/superpowers/specs/2026-09-03-phase3-backlog.md`

- [ ] **Step 1: 划掉已消化条目**

按 backlog 文件头部的约定（"逐项消化后从本文件划掉"），将 P0 两项与 P1 十条全部标记完成（条目前加 `~~删除线~~` 或整段移除，保留文件头说明）。
若本计划执行中有条目被判定不做/改设计，在 backlog 里注明原因而不是划掉。

- [ ] **Step 2: 提交**

```bash
git add docs/superpowers/specs/2026-09-03-phase3-backlog.md
git commit -m "docs: Phase 3 backlog 清账(P0 x2 + P1 x10 由 3-B 计划消化)"
```

---

## Self-Review 记录

- **Spec 覆盖**：backlog P0 两项（Task 1/2/3）与 P1 十条（#1→Task 4、#2→Task 5、#3→Task 6、#4→Task 7、#5→Task 8、#6→Task 9、#7→Task 10、#8→Task 11、#9→Task 12、#10→Task 13）全部有对应任务；Task 14 为 P1#4 的 UI 层回归；Task 15 清账。
- **占位符扫描**：无 TBD；所有代码步骤给完整代码。两处显式标注"以文件现状为准"的（paperQuestions.test 构造、fetchRouter 透传），均给出了核对路径与后备写法——执行者必须先读文件再落码。
- **类型一致性**：`invalidId(c, err)` 在 papers.ts 与 paperQuestions.ts 各自定义（路由内聚，不跨文件共享）；`fetchPaperPages`/`sourcePdfUrl` 在 Task 3 定义、Task 3/10/13 使用一致；`PaperSummary.child_name` 在 Task 9 定义后，Task 13 的 PaperQueue 直接使用。
- **顺序依赖**：Task 5 依赖 3-A 的 search.ts 新结构（已标注）；Task 9 与 Task 13 都改 PaperQueue/ReviewView，按任务顺序执行避免冲突；Task 1 先于 Task 3/4（source.pdf 路由与 422 用例都涉及它）。
- **风险**：Task 8 会改变 internal_api 对注入连接的生命周期语义（finally 关闭），既有类用例需同步调整注入方式——已在步骤内写明；Task 12 编辑已应用的 migration，前提是生产库已成功应用（已验证索引存在），执行时需先跑 Step 5 的核验。
