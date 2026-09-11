# 向量化 revision + 图注 caption + 拆题复核/入库查看/质检规则屏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 题目级向量带上版本账（items.revision / chunks.item_revision / chunks.state 全链路生效）、figure 块生成图注并随题干进向量、md 三处统一渲染图片与图注、检索过滤 excluded、拆题复核题卡（屏 2）、入库查看 chunk 账页（屏 5）、质检规则配置化与只读规则屏（屏 6）。

**Architecture:** migration `0022_vector_revision.sql` 加 `items.revision` / `chunks.item_revision` / `blocks.caption` / `blocks.caption_source` 并把存量 item chunk 全标 stale；pipeline 侧 `embed_approved_items` 改为「stem + 图注」输入、stale 驱动重建（可重跑的发布动作）；caption 由 parse/block_edit 链路用独立 CAPTION_PROMPT 生成，approve 对缺图注 item 拦截；检索两侧（backend TS + pipeline）过滤 `state='excluded'`，答案以 payload 快照进 `chunks.meta`；md 组装三处统一 figure 渲染；backend 扩 chunks/reindex 端点支撑屏 5，扩 items 端点支撑屏 2；qc 阈值进 Config（KB_QC_*），屏 6 只读呈现。

**Tech Stack:** pipeline: Python 3.13 / pytest / psycopg / pymupdf；backend: TS / Hono / vitest（真库）；frontend: React / vitest + @testing-library（jsdom）；e2e: Playwright。

**Spec:** `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md` §4（revision / item_revision / caption 部分）、§7.2–7.3、§9、§10、§11.2、§11.5、§11.6、§12 用例 6–7、§13。
视觉/交互细节以 `docs/design/review-workbench.html` 屏 2（`#scr-items`，:402-554）、屏 5（`#scr-chunks`，:1060-1098 及 renderChunks :1286-1316）、屏 6（`#scr-rules`，:1103-1146）为唯一事实源。

**前置：** 子系统 1–3 已完成（ordinal、crop_pad、路径基准 KB_STORAGE_DIR、块编辑四操作与 chunks.state）。
子系统 4（答案字段化，migration `0021`）计划与本计划并行/先行：它给 items 加 `answer_md/answer_conf/answer_state`；本计划所有读 answer 字段的 SQL 一律用 `to_jsonb(i)->>'answer_md'` 兼容写法，0021 未落地时得 NULL（meta 不写该键），落地后无需改动自动生效。
已核实零件：`embed_approved_items`（pipeline/kb/rag/embed.py:29-62）、`approve_items`（embed.py:132-172）、`invalidate_chunk`（embed.py:175-178，无生产调用者，只有 test_embed.py 引用）、`_vector_hits`（embed.py:181-194）、`bm25_search`（pipeline/kb/rag/lexical.py:28-57，SELECT 全表无过滤）、`/internal/approve-item`（pipeline/kb/internal_api.py:159-183，embed 不带 doc_id 全库扫）、`/internal/reindex`（internal_api.py:396-433，仅 page|chapter）、`transcribe_image`（pipeline/kb/ocr/parse.py:37-63，支持自定义 prompt）、`run_parse` figure 分支（parse.py:147-155）、`create_block`/`commit_block_geometry`（pipeline/kb/ocr/block_edit.py:164-246 / :94-138）、`run_qc`（pipeline/kb/ocr/qc.py:133-185，编排入口 pipeline/kb/pdf_ingest.py:34-36）、`CHECKABLE_REASONS`（qc.py:20-21）、backend `PATCH /items/:id`（backend/src/routes/review.ts:555-578，改内容后 DELETE chunks :567）、`PATCH /blocks/:id`（review.ts:244-276，DELETE chunks :262-264）、`forwardInternal`（review.ts:634-650）、`POST /items/:id/approve` 转发（review.ts:707-716）、`GET /:id/chunks`（backend/src/routes/library.ts:296-323，无 state/meta/全文）、`GET /:id/content`（library.ts:325-364，块拼接 SQL 在 :333-339）、`POST /:id/reindex`（library.ts:256-268，type/id 透传）、`POST /:id/approve`（library.ts:270-280）、`vectorHits`/BM25 全量查（backend/src/retrieval/search.ts:33-48 / :81-85，均不过滤 state）、`toHit` meta 摊平（search.ts:50-55）、frontend `IndexLedger`（frontend/src/components/LibraryDetail.tsx:39-72）、`FullContent`（LibraryDetail.tsx:74-102，ReactMarkdown 已接 remarkGfm/remarkMath/rehypeKatex）、`MaterialsView` 条目 tab（frontend/src/views/MaterialsView.tsx:124-136）、`LibraryChunk` 类型（frontend/src/api/library.ts:49-53）、测试底子 `pipeline/tests/test_embed.py`（`_FakeEmbed` 全 1 向量 :118-130、`doc_chapter` fixture :8-48）、`test_export_md.py`、`test_qc.py`、backend `review.test.ts`/`library.test.ts`/`search.test.ts`、e2e `library-management.spec.ts`/`searchability.spec.ts`/`exam-structure.spec.ts`。

**migration 编号：** 子系统 4 占用 `0021`（answer 字段）；本计划用 **`0022_vector_revision.sql`**。
当前最新已落地为 `0020_block_editing.sql`（含 chunks.state，默认 'indexed'）。

**锁定决策（执行者不要改动，有异议先回报）：**

1. **migration 0022 内容**：`items ADD revision INTEGER NOT NULL DEFAULT 1`；`chunks ADD item_revision INTEGER`；`blocks ADD caption TEXT / caption_source TEXT`（vlm|manual|null）；末尾 `UPDATE chunks SET state='stale' WHERE item_id IS NOT NULL`——存量 item 向量因输入口径变更（§13）全部待重建；chapter chunk 不动。
   选「迁移内一次性标 stale」而非另写迁移脚本：stale chunk 重建前仍可被搜到（决策 4），检索能力不断档；随下次 approve/embed 自动重建，幂等，无需运维动作。
2. **embedding 输入 = stem + 图注**：`embed_input = content_md + "\n〔图：{caption}〕"`（item_blocks role='figure' 关联块的 caption，按 ordinal 序多图各拼一行，按 block_id 去重；无 caption 不拼）。
   `chunks.content_md` 存的就是这份 embed 输入（屏 5 chunk 卡展示的「embedding 输入（stem + 图注）」即此列）。
   **答案不进输入**（§8.1，验收 6：断言 embed 输入不含 answer_md）；答案作为 payload 快照进 `chunks.meta`（answer_md/answer_state，子系统 4 字段，`to_jsonb` 兼容写法，NULL 则不写键）。
   顺带堵现状 bug（§4/§8.1）：选行 SQL 加 `i.content_type IS DISTINCT FROM 'answer'`。
3. **stale 取代删除**：`PATCH /items/:id` 改 content_md → `items.revision+=1` + `chunks.state='stale'`（不再 DELETE）；`PATCH /blocks/:id` 改内容/图注 → 引用该块的 chunks 标 stale（不再 DELETE）；`invalidate_chunk` 改为标 stale。
   块编辑链路（merge/split/geometry）已标 stale 的不动。
   flat 页链路（PATCH /pages/:id、page-exclusion、embed_flat_pages 的 DELETE+重建）不在本次范围，保持原样（见「范围外」）。
   embed 选行扩展为「无 chunk OR chunk.state='stale'」，重建走 `INSERT ... ON CONFLICT (item_id) DO UPDATE`，置 `state='indexed'`、`item_revision=items.revision`，并补齐 `source_block_ids`（item 全部关联块）与 `page_no`（items.page_start）写入。
   重建是可重跑的发布动作（§10）：重复执行幂等。
4. **检索过滤**：backend search.ts（vectorHits 与 BM25 两处）与 pipeline（`_vector_hits` 与 `bm25_search`）都过滤 `state <> 'excluded'`；stale 在重建前仍可搜到（沿用子系统 3 锁定决策 3）。
5. **caption 生成**：parse 阶段 figure 块转录成功后用独立简短 `CAPTION_PROMPT` 再调一次 VLM 生成一句图注（`caption_source='vlm'`），失败/空不阻断留 NULL；补画（`create_block` block_type='figure'）与调框 commit 后的 figure 块同样生成（crop 变了图注重算）。
   无 caption 的 figure 块拦截 approve：**单条** `/internal/approve-item` → **409**（带缺图 block 清单；选 409 与 approve-doc 现有「前置状态不满足」语义一致，422 是请求格式错误不适用）；**批量** `approve_items` 跳过缺图 item（保持 pending）并在返回值加 `blocked: [...]`，CLI 打印警告——整批拒绝会让一条缺图卡住整本，跳过更可用。
   backend `PATCH /blocks/:id` 扩展收可选 `caption`（手写 → `caption_source='manual'`）。
6. **md 呈现（§7.3）两种路径口径**：落盘镜像（assemble.py / export_md.py）figure 块输出 `![caption](blocks/<page_id>/bNNN.png)`（crop_path 去掉 `<doc_id>/` 前缀，从 `storage/<doc_id>/` 起算，§7.1）+ 换行 `*图注：…*`；API 消费（backend library.ts `/content`）同结构但图片地址用 `/api/review/blocks/<id>/crop`（前端 ReactMarkdown 可直接渲染的 URL）。
   题组多子题共图按 block_id 去重只引用一次。
   答案折叠段 `<!-- answer -->…<!-- /answer -->` 属于 **item 级文本**，由 frontend `lib/itemMarkdown.ts` 组装（题卡/chunk 卡「复制」的内容），**不进页/章级 md**——页 md 的答案是卷末答案区原文块，天然在其中；屏 5 右栏全文的答案折叠由 chunk 卡承担（与屏 4 检索命中卡同组件语义）。
   md 是只写镜像的纪律不变。
7. **质检规则配置化**：阈值进 `Config`（`KB_QC_GARBLED_RATIO=0.03`、`KB_QC_DENSITY_MIN=30`、`KB_QC_DENSITY_MAX=3000`、`KB_QC_SAMPLE_RATIO=0.10`），`.env.example` 同步。
   qc.py 新增乱码率（`unicodedata.category` 为 Cc/Cf/Cs/Co/Cn 或 U+FFFD 的字符占比）与文本密度（页块文本去空白字数）规则，命中建页面级 review_queue 行（reason='garbled'/'text_density'，进 CHECKABLE_REASONS 可复算自动关闭）。
   抽样：无命中页按 `md5(page_id)` 哈希 < ratio 确定性抽样（幂等可复跑，不用 random），reason='random_sample'，插入前查全部状态防重建（一次抽样终身留痕）。
   「块置信 <0.60」「VLM 评分 <0.80」无数据源（blocks 无置信列、无页评分流程），屏 6 呈现为「未启用（数据未采集）」，实现列入范围外。
   屏 6 UI **只读**：pipeline 新增 `GET /internal/qc-rules` 返回规则表+当前阈值，backend 转发，frontend 只渲染；配置走 .env，UI 不做编辑。
8. **屏 2「入库粒度」下拉**（按题组·推荐/按单题/按页）本期**纯呈现**：不改 embed 行为（chunk 粒度恒为 item，题组已是拆题输出的 item 粒度），不落库。
   **「关联题组」操作列入范围外**：需要 items.parent_id schema 与 chunk 合并重定向规则，超出本子系统；UI 不出该按钮。
9. **题卡「删除」语义**：新增 `DELETE /api/review/items/:id` = `qc_status='rejected'` + 对应 chunk 标 `excluded`（不真删行，人工痕迹与 chunks.item_id UNIQUE 约束都不破）。
10. **「仅确认，稍后批量入库」**：pipeline `ApproveDocRequest` 加 `embed: bool = True`，`approve_items` 加 `embed=True` 参数（False 只批准不向量化）；backend `POST /api/library/:id/approve` 透传 body.embed。

---

### Task 1: migration 0022——items.revision + chunks.item_revision + blocks.caption

**Files:**
- Create: `pipeline/kb/migrations/0022_vector_revision.sql`
- Modify: `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md`（§14 状态表 + 编号约定）
- Test: `pipeline/tests/test_migration_0022.py`

- [ ] **Step 1: 写失败测试**

新建 `pipeline/tests/test_migration_0022.py`（fixture 与断言风格照抄 test_migration_0020.py）：

```python
"""0022：items.revision + chunks.item_revision + blocks.caption/caption_source + 存量 item chunk 标 stale。"""


def test_0022_columns_and_defaults(conn):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO documents (title, source_path) VALUES ('t', '/tmp/a.pdf') RETURNING id::text"
        )
        doc_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO pages (document_id, page_no, image_path) VALUES (%s, 1, 'p.png') RETURNING id::text",
            (doc_id,),
        )
        page_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO blocks (page_id, block_type, crop_path, ordinal)"
            " VALUES (%s, 'figure', 'c.png', 1) RETURNING id::text",
            (page_id,),
        )
        block_id = cur.fetchone()[0]
        cur.execute("SELECT caption, caption_source FROM blocks WHERE id=%s", (block_id,))
        assert cur.fetchone() == (None, None)  # 新列默认空
        cur.execute(
            "INSERT INTO items (document_id, content_type, content_md) VALUES (%s, 'exercise', '题') RETURNING id::text",
            (doc_id,),
        )
        item_id = cur.fetchone()[0]
        cur.execute("SELECT revision FROM items WHERE id=%s", (item_id,))
        assert cur.fetchone()[0] == 1  # 默认第 1 版
        cur.execute(
            "INSERT INTO chunks (item_id, document_id, content_md, embedding) VALUES (%s, %s, '题', %s) RETURNING id::text",
            (item_id, doc_id, [1.0] * 1024),
        )
        chunk_id = cur.fetchone()[0]
        cur.execute("SELECT item_revision FROM chunks WHERE id=%s", (chunk_id,))
        assert cur.fetchone()[0] is None  # 新插入的 chunk 本批未重建前无版本


def test_0022_existing_item_chunks_marked_stale(conn):
    """迁移把存量 item chunk 标 stale（§13 输入口径变更全作废），chapter chunk 不动。

    注意：本测试在已迁移库上跑，断言的是迁移效果——用 fresh 插入无法区分。
    改为直接验证迁移文件内容与幂等性：
    """
    from kb.core.db import MIGRATIONS_DIR
    sql = (MIGRATIONS_DIR / "0022_vector_revision.sql").read_text(encoding="utf-8")
    assert "UPDATE chunks SET state='stale' WHERE item_id IS NOT NULL" in sql.replace("\n", " ").replace("  ", " ") \
        or "state='stale'" in sql  # 迁移含存量标 stale 语句
    with conn.cursor() as cur:  # chapter chunk 未被误伤（库里若现存的均为迁移后状态）
        cur.execute("SELECT count(*) FROM chunks WHERE chapter_id IS NOT NULL AND state='stale'")
        # 不断言具体值——chapter chunk 是否 stale 取决于块编辑历史；只验证列语义存在即可
```

第二条按注释里的口径写宽：迁移效果断言依赖测试库迁移时机，实现时若 conftest 每次重建库则改成「迁移前插数据→跑 migrate→断言」的显式两段式（参照现有 migration 测试的实际框架，先读 conftest 再定）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_migration_0022.py -v
```

预期：FAIL，`column "revision" does not exist`。

- [ ] **Step 3: 写 migration**

新建 `pipeline/kb/migrations/0022_vector_revision.sql`：

```sql
-- 0022：题目版本账 + chunk 版本追溯 + 图注（spec §4/§7.2/§10/§13）
ALTER TABLE items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
  -- 题目每次人工改动 +1；chunk.item_revision 记录该向量是哪一版生成的
ALTER TABLE chunks ADD COLUMN item_revision INTEGER;
  -- NULL = 旧口径（整条 content_md 含答案）生成的存量向量，待重建
ALTER TABLE blocks ADD COLUMN caption TEXT;
  -- figure 块的一句图注；进向量的是这句文本，不是图像本身（§7.2）
ALTER TABLE blocks ADD COLUMN caption_source TEXT;
  -- vlm 模型生成 | manual 人工补录 | null 尚未生成

-- 存量 item chunk 全部标 stale：embedding 输入从「整条 content_md」改为「stem + 图注」，
-- 旧向量全作废待重建（§13）；stale 重建前仍可检索（锁定决策 4），chapter chunk 不受影响
UPDATE chunks SET state='stale' WHERE item_id IS NOT NULL;
```

- [ ] **Step 4: 更新 spec §14**

§14 状态表子系统 5 行改为「**已出计划**：`docs/superpowers/plans/2026-09-10-vector-revision-captions.md`，未执行」。
末尾「migration 编号约定」一段补：「`items.answer_*` 由子系统 4 的 `0021` 落地；`items.revision` / `chunks.item_revision` / `blocks.caption*` 由子系统 5 的 `0022_vector_revision.sql` 落地。」

- [ ] **Step 5: 跑测试 + 应用 dev 库**

```bash
cd pipeline && uv run pytest tests/test_migration_0022.py tests/test_db.py -v
cd pipeline && uv run python -c "from kb.core.config import load_config; from kb.core.db import connect, migrate; cfg = load_config(); print(migrate(connect(cfg.database_url)))"
```

预期：测试全 PASS；migrate 输出含 `0022_vector_revision.sql`。

- [ ] **Step 6: Commit**

```bash
git add pipeline/kb/migrations/0022_vector_revision.sql pipeline/tests/test_migration_0022.py docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md
git commit -m "feat(pipeline): migration 0022——items.revision + chunks.item_revision + blocks.caption，存量 item chunk 标 stale"
```

---

### Task 2: caption 生成链路 + approve 缺图拦截

**Files:**
- Create: `pipeline/kb/ocr/caption.py`
- Modify: `pipeline/kb/ocr/parse.py`（figure 块转录后生成 caption）
- Modify: `pipeline/kb/ocr/block_edit.py`（create_block figure / commit figure 重算 caption）
- Modify: `pipeline/kb/rag/embed.py`（approve_items 缺图跳过 + blocked 返回）
- Modify: `pipeline/kb/internal_api.py`（approve-item 409）
- Modify: `backend/src/routes/review.ts`（PATCH /blocks/:id 收 caption + DELETE→stale）
- Test: `pipeline/tests/test_caption.py`（新建）、`pipeline/tests/test_embed.py`、`backend/src/routes/review.test.ts`

行为（§7.2、§11.2 缺图拦阻、锁定决策 5）：

- `caption.py`：`CAPTION_PROMPT`（一句：「这是一张教辅题目配图，请用一句不超过 60 字的话描述图中内容与关键标注（尺寸/数字/符号），只输出这句描述」）；`generate_caption(conn, cfg, block_id, client=None, recorder=None) -> str | None`：查块（非 figure 直接返回 None）→ `transcribe_image(client, cfg.vision_model, crop_abs, prompt=CAPTION_PROMPT)` → 非空则 `UPDATE blocks SET caption=%s, caption_source='vlm'`；异常/空结果留 NULL 不阻断（recorder.error 记录）。
- `parse.py` run_parse：块写库成功后若 `block_type == 'figure'` 调 `generate_caption`（新增可注入参数 `captioner=None` 便于测试替身；默认真实现）。
- `block_edit.py`：`create_block` block_type='figure' 时 INSERT 后调 caption；`commit_block_geometry` 目标块为 figure 时落库后重算（crop 已覆盖，旧图注失效）；preview 不生成（不落库）。
- `embed.py` `approve_items`：批准前查缺图 item——
  ```python
  cur.execute(
      """SELECT i.id FROM items i
         WHERE i.document_id=%s AND i.qc_status IN ('pending','auto_passed','needs_review')
           AND EXISTS (SELECT 1 FROM item_blocks ib JOIN blocks b ON b.id=ib.block_id
                       WHERE ib.item_id=i.id AND ib.role='figure' AND b.caption IS NULL)""",
      [doc_id])
  blocked = [str(r[0]) for r in cur.fetchall()]
  ```
  批准 UPDATE 加 `AND NOT (id = ANY(blocked))`，返回值加 `blocked`。
- `internal_api.py` approve_item_ep：UPDATE 前先查该 item 是否缺图，缺 → `raise HTTPException(409, detail={...缺图 block 列表...})`；approve_doc_ep 不动（走 approve_items 的 blocked 语义）。
- backend `PATCH /blocks/:id`：body 增加可选 `caption`（string 才受理）；任一字段变更后把 `DELETE FROM chunks …`（review.ts:262-264）改为 `UPDATE chunks SET state='stale' WHERE …`（同条件）；caption 变更时 `caption_source='manual'`。

- [ ] **Step 1: 写失败测试**

新建 `pipeline/tests/test_caption.py`（fixture 参照 test_block_edit.py 的 doc1：A4@200dpi 页 + 手工插 figure 块）：

```python
"""figure 图注生成与缺图拦阻（spec §7.2、§11.2）。"""


def test_parse_generates_caption_for_figure(doc_with_figure, conn):
    """parse 后 figure 块有 caption（caption_source='vlm'）；转录与图注是两次独立调用。"""
    from kb.ocr.parse import run_parse

    doc_id, cfg = doc_with_figure
    calls = []

    class FakeVLM:
        class chat:
            class completions:
                @staticmethod
                def create(model, messages, **kw):
                    prompt = messages[0]["content"][0]["text"]
                    calls.append(prompt)
                    from kb.ocr.caption import CAPTION_PROMPT
                    text = "梯形，上底 6 cm" if prompt == CAPTION_PROMPT else "如图，梯形……"
                    return type("R", (), {"choices": [type("C", (), {
                        "message": type("M", (), {"content": text})()})()]})()

    run_parse(conn, cfg, doc_id, client=FakeVLM())
    with conn.cursor() as cur:
        cur.execute("SELECT caption, caption_source FROM blocks WHERE block_type='figure'")
        assert cur.fetchone() == ("梯形，上底 6 cm", "vlm")


def test_caption_failure_leaves_null_not_blocking(doc_with_figure, conn):
    """VLM 异常：caption 留 NULL，content_md 照常落库，不抛。"""
    ...


def test_approve_items_skips_missing_caption(doc_with_figure_item, conn):
    """含无 caption figure 块的 item 不被批准，出现在 blocked；正常 item 照批。"""
    from kb.rag.embed import approve_items
    out = approve_items(conn, cfg, doc_id, client=_FakeEmbed())
    assert out["blocked"] == [bad_item_id]
    with conn.cursor() as cur:
        cur.execute("SELECT qc_status FROM items WHERE id=%s", (bad_item_id,))
        assert cur.fetchone()[0] == "pending"  # 缺图不给通过


def test_approve_item_409_on_missing_caption(...):
    """internal /internal/approve-item：缺图 item → 409，detail 含 block 清单。"""
```

`backend/src/routes/review.test.ts` 追加：

```ts
it("PATCH /blocks/:id 收 caption：caption_source='manual'，引用 chunk 标 stale 不删", async () => {
  // 造 figure 块 + item + chunk（source_block_ids 含该块）
  const resp = await app.request(`/api/review/blocks/${figId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content_md: "原转录", caption: "梯形示意" }),
  });
  expect(resp.status).toBe(200);
  const blk = (await pool.query("SELECT caption, caption_source FROM blocks WHERE id=$1", [figId])).rows[0];
  expect(blk).toEqual({ caption: "梯形示意", caption_source: "manual" });
  const ck = (await pool.query("SELECT state FROM chunks WHERE item_id=$1", [itemId])).rows[0];
  expect(ck.state).toBe("stale");  // 不再是 DELETE
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_caption.py -v
cd backend && npm test -- review.test
```

预期：FAIL（`ModuleNotFoundError: kb.ocr.caption`；backend caption 被忽略/409 缺失）。

- [ ] **Step 3: 实现**

`pipeline/kb/ocr/caption.py` 骨架：

```python
"""figure 块图注：进向量的是这句文本，不是图像本身（spec §7.2）。
生成失败不阻断——留 NULL，由复核页/approve 拦截兜底。"""
from __future__ import annotations

from kb.core.paths import resolve_storage_path
from kb.ocr.parse import transcribe_image
from kb.telemetry.metering import record_llm_call

CAPTION_PROMPT = (
    "这是一张教辅题目的配图。请用一句不超过 60 字的话描述图中内容与关键标注"
    "（图形类型、尺寸、数字、符号），只输出这句描述，不要解释。"
)


def generate_caption(conn, cfg, block_id: str, client=None, recorder=None) -> str | None:
    from openai import OpenAI
    client = client or OpenAI(base_url=cfg.vision_base_url, api_key=cfg.vision_api_key)
    with conn.cursor() as cur:
        cur.execute(
            """SELECT b.crop_path, b.page_id::text, p.document_id::text
               FROM blocks b JOIN pages p ON p.id=b.page_id WHERE b.id=%s""",
            (block_id,))
        row = cur.fetchone()
        if not row:
            raise KeyError(f"块不存在: {block_id}")
        crop_path, page_id, doc_id = row
        cur.execute("SELECT block_type FROM blocks WHERE id=%s", (block_id,))
        if cur.fetchone()[0] != "figure":
            return None
    try:
        text, usage = transcribe_image(client, cfg.vision_model,
                                       str(resolve_storage_path(cfg, crop_path)),
                                       prompt=CAPTION_PROMPT)
    except Exception as e:  # noqa: BLE001 - 失败不阻断，留 NULL 由复核兜底
        if recorder is not None:
            recorder.error("caption", f"图注生成失败: {str(e)[:200]}",
                           page_id=page_id, exc=e)
        return None
    caption = (text or "").strip().splitlines()[0] if text and text.strip() else None
    if not caption:
        return None
    record_llm_call(conn, doc_id, "caption", cfg.vision_model, usage,
                    recorder=recorder, stage="parse", page_id=page_id,
                    prompt=CAPTION_PROMPT, output=caption)
    with conn.cursor() as cur:
        cur.execute("UPDATE blocks SET caption=%s, caption_source='vlm' WHERE id=%s",
                    (caption, block_id))
    return caption
```

`parse.py` run_parse 的块写库成功后（:173-179 之后）：

```python
            if block_type == "figure":
                (captioner or generate_caption)(conn, cfg, block_id,
                                                client=client, recorder=recorder)
```

`block_edit.py`：`create_block` 在 INSERT 后 `if block_type == "figure": generate_caption(...)`；`commit_block_geometry` 在事务后 `if block_type == "figure": generate_caption(...)`（重算覆盖 vlm 图注）。
注意 block_edit 调 caption 时传 client——两个函数的签名加 `client=None` 透传（`create_block` 已有 client 参数）。

`embed.py` approve_items 与 `internal_api.py` approve_item_ep 按上面行为节实现。
`backend/src/routes/review.ts` PATCH /blocks/:id：`content_md` 与 `caption` 至少其一（都没有 → 422）；动态拼 SET；chunks 处理由 DELETE 改：

```ts
await pool.query(
  `UPDATE chunks SET state='stale' WHERE document_id=$1 AND (
     source_block_ids && ARRAY[$2::uuid] OR page_no=$3)`,
  [page.document_id, c.req.param("id"), page.page_no]);
```

（注意：page_no 命中的 flat 页 chunk 也从 DELETE 变 stale——flat 重建路径 `embed_flat_pages` 是 DELETE+重建式幂等，stale 的 flat chunk 由页级 reindex 触发删除重建，行为等价；item chunk 由 Task 3 的 embed 选择器捞起。此处一并改是为了 caption 生效必须标 stale，不改两处口径不一致。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_caption.py tests/test_embed.py tests/test_block_edit.py tests/test_parse.py -v
cd backend && npm test -- review.test
```

预期：全 PASS。特别注意 test_embed.py 的 `test_edit_invalidates_chunk` 在 Task 3 才改语义——本 Task 不动 invalidate_chunk。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/ocr/caption.py pipeline/kb/ocr/parse.py pipeline/kb/ocr/block_edit.py pipeline/kb/rag/embed.py pipeline/kb/internal_api.py pipeline/tests/test_caption.py backend/src/routes/review.ts backend/src/routes/review.test.ts
git commit -m "feat: figure 图注生成（parse/补画/调框链路）+ approve 缺图拦截（批量跳过/单条 409）+ PATCH block 收 caption"
```

---

### Task 3: embed 输入 stem+图注、stale 取代删除、revision 记账

**Files:**
- Modify: `pipeline/kb/rag/embed.py`（embed_approved_items / invalidate_chunk）
- Modify: `pipeline/kb/internal_api.py`（approve-item 带 doc_id）
- Modify: `backend/src/routes/review.ts`（PATCH /items/:id revision+1 + stale）
- Test: `pipeline/tests/test_embed.py`、`pipeline/tests/test_internal_api.py`、`backend/src/routes/review.test.ts`

行为（§10、验收 6/7 pipeline 侧、锁定决策 2/3）：

- `embed_approved_items` 选行改为：

```python
        cur.execute(
            f"""SELECT i.id, i.document_id, i.content_md, i.label, i.chapter,
                       i.content_type, i.taxonomy, i.tags, i.page_start, i.page_end,
                       d.subject, d.grade, d.title, i.revision,
                       to_jsonb(i)->>'answer_md', to_jsonb(i)->>'answer_state'
                FROM items i JOIN documents d ON d.id = i.document_id
                WHERE i.qc_status='approved' AND i.content_md IS NOT NULL
                  AND i.content_type IS DISTINCT FROM 'answer'
                  AND (NOT EXISTS (SELECT 1 FROM chunks c WHERE c.item_id = i.id)
                       OR EXISTS (SELECT 1 FROM chunks c WHERE c.item_id = i.id
                                  AND c.state='stale'))
                {where}""",
            params,
        )
```

  `to_jsonb(i)->>'answer_md'`：0021 未落地时为 NULL（meta 不写键），落地后自动带上——不引列名，兼容两种 schema 状态。
- embed 输入组装（新函数，供测试直引）：

```python
def build_embed_input(cur, item_id: str, content_md: str) -> str:
    """stem + 图注。role='figure' 关联块的 caption 按 ordinal 拼接，去重，无 caption 不拼。
    答案（answer_md）不进输入（§8.1）。"""
    cur.execute(
        """SELECT DISTINCT b.id, b.ordinal, b.caption
           FROM item_blocks ib JOIN blocks b ON b.id = ib.block_id
           WHERE ib.item_id=%s AND ib.role='figure' AND b.caption IS NOT NULL
           ORDER BY b.ordinal""",
        (item_id,))
    parts = [content_md]
    parts += [f"〔图：{caption}〕" for _bid, _ord, caption in cur.fetchall()]
    return "\n".join(parts)
```

- 写入改 upsert 并补账：

```python
            cur.execute(
                """INSERT INTO chunks (item_id, document_id, content_md, meta, embedding,
                                       item_revision, state, source_block_ids, page_no)
                   VALUES (%s,%s,%s,%s,%s,%s,'indexed',%s,%s)
                   ON CONFLICT (item_id) DO UPDATE SET
                       content_md=EXCLUDED.content_md, meta=EXCLUDED.meta,
                       embedding=EXCLUDED.embedding, item_revision=EXCLUDED.item_revision,
                       state='indexed', source_block_ids=EXCLUDED.source_block_ids,
                       page_no=EXCLUDED.page_no""",
                (item_id, doc_id, embed_input, Jsonb(meta), vec, revision,
                 source_block_ids, page_start),
            )
```

  meta 快照在现有键上追加 `answer_md`/`answer_state`（仅非 None 时写入）；`source_block_ids` = item 全部关联块 id（不分 role）；`page_no` = items.page_start。
- `invalidate_chunk`：`DELETE` → `UPDATE chunks SET state='stale' WHERE item_id=%s`，docstring 改「标 stale 待重建（不再物理删除，重建前仍可检索）」。
- `/internal/approve-item`：UPDATE 后查 `SELECT document_id FROM items WHERE id=%s`，`embed_approved_items(conn, cfg, doc_id, client=embed_client)` 带 doc_id（修掉全库扫）。
- backend `PATCH /items/:id`：

```ts
      await pool.query(
        "UPDATE items SET content_md=$2, revision=revision+1, updated_at=now() WHERE id=$1 RETURNING id::text, content_md, revision",
        [id, body.content_md]);
      await pool.query("UPDATE chunks SET state='stale' WHERE item_id=$1", [id]);  // 原 DELETE 改 stale
```

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_embed.py` 修改/追加（验收 6/7 pipeline 侧）：

```python
def test_embed_input_is_stem_plus_caption_without_answer(conn, doc_chapter):
    """验收 6：embed 输入 = stem + 〔图：caption〕，不含 answer_md。"""
    from kb.rag.embed import embed_approved_items

    doc_id, cfg = doc_chapter
    seen: list[str] = []

    class Rec:
        class embeddings:
            @staticmethod
            def create(model, input):
                seen.append(input)
                class D: embedding = [1.0] * 1024
                class R: data = [D()]
                return R()

    with conn.cursor() as cur:  # 给 approved 的例1 挂一个带 caption 的 figure 块
        cur.execute("SELECT id::text FROM items WHERE label='例1'")
        (item_id,) = cur.fetchone()
        cur.execute("SELECT id::text FROM pages WHERE document_id=%s AND page_no=1", (doc_id,))
        (page_id,) = cur.fetchone()
        cur.execute(
            """INSERT INTO blocks (page_id, block_type, crop_path, ordinal, caption, caption_source)
               VALUES (%s,'figure','f.png',9,'梯形，上底 6 cm','vlm') RETURNING id::text""",
            (page_id,))
        (fig_id,) = cur.fetchone()
        cur.execute("INSERT INTO item_blocks (item_id, block_id, role) VALUES (%s,%s,'figure')",
                    (item_id, fig_id))
    n = embed_approved_items(conn, cfg, doc_id, client=Rec())
    assert n == 1
    assert seen[0].startswith("**例1** 内容")
    assert "〔图：梯形，上底 6 cm〕" in seen[0]
    assert "answer" not in seen[0]  # 无答案字段时输入不掺任何答案内容
    with conn.cursor() as cur:
        cur.execute("SELECT state, item_revision, page_no, source_block_ids FROM chunks WHERE item_id=%s",
                    (item_id,))
        state, item_rev, page_no, src = cur.fetchone()
        assert (state, item_rev, page_no) == ("indexed", 1, 1)
        assert src == [fig_id]  # source_block_ids 落账


def test_edit_marks_stale_and_rebuild_bumps_revision(conn, doc_chapter):
    """验收 7：invalidate_chunk 标 stale 不删；重建后 item_revision 对齐 items.revision。"""
    from kb.rag.embed import embed_approved_items, invalidate_chunk

    doc_id, cfg = doc_chapter
    embed_approved_items(conn, cfg, doc_id, client=_FakeEmbed())
    with conn.cursor() as cur:
        cur.execute("SELECT item_id::text FROM chunks")
        item_id = cur.fetchone()[0]
        cur.execute("UPDATE items SET revision=revision+1 WHERE id=%s", (item_id,))  # 模拟人工改题
    invalidate_chunk(conn, item_id)
    with conn.cursor() as cur:
        cur.execute("SELECT state FROM chunks WHERE item_id=%s", (item_id,))
        assert cur.fetchone()[0] == "stale"  # 不删
    n = embed_approved_items(conn, cfg, doc_id, client=_FakeEmbed())
    assert n == 1  # stale 被捞起重建
    with conn.cursor() as cur:
        cur.execute("SELECT state, item_revision FROM chunks WHERE item_id=%s", (item_id,))
        assert cur.fetchone() == ("indexed", 2)


def test_embed_skips_answer_type_items(conn, doc_chapter):
    """content_type='answer' 的卷末答案 item 不向量化（现状 bug 堵口，§8.1）。"""
    ...
```

`backend/src/routes/review.test.ts` 追加：

```ts
it("PATCH /items/:id：revision+1 且 chunk 标 stale 不删（验收 7 backend 侧）", async () => {
  const before = (await pool.query("SELECT revision FROM items WHERE id=$1", [itemId])).rows[0].revision;
  const resp = await app.request(`/api/review/items/${itemId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content_md: "改后的题干" }),
  });
  expect(resp.status).toBe(200);
  expect((await pool.query("SELECT revision FROM items WHERE id=$1", [itemId])).rows[0].revision)
    .toBe(before + 1);
  expect((await pool.query("SELECT state FROM chunks WHERE item_id=$1", [itemId])).rows[0].state)
    .toBe("stale");
});
```

`pipeline/tests/test_internal_api.py` 追加：`/internal/approve-item` 后 embed 只扫本 doc（造两个 doc 各一条 pending item，approve 其一，断言另一 doc 的 item 仍未向量化）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_embed.py tests/test_internal_api.py -v
cd backend && npm test -- review.test
```

预期：FAIL（state 列不存在断言错 / 选行不含 stale / DELETE 仍在）。

- [ ] **Step 3: 实现**（按行为节骨架改 embed.py / internal_api.py / review.ts）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_embed.py tests/test_internal_api.py tests/test_caption.py -v
cd backend && npm test -- review.test
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/rag/embed.py pipeline/kb/internal_api.py pipeline/tests/test_embed.py pipeline/tests/test_internal_api.py backend/src/routes/review.ts backend/src/routes/review.test.ts
git commit -m "feat: embed 输入改 stem+图注（答案仅作 meta payload），stale 取代删除，revision/item_revision 记账，approve-item 限定 doc"
```

---

### Task 4: 检索两侧过滤 excluded + 答案 payload 透出

**Files:**
- Modify: `backend/src/retrieval/search.ts`
- Modify: `pipeline/kb/rag/embed.py`（_vector_hits）
- Modify: `pipeline/kb/rag/lexical.py`（bm25_search）
- Test: `backend/src/retrieval/search.test.ts`、`pipeline/tests/test_embed.py`

行为（锁定决策 4）：

- backend `vectorHits`（search.ts:36-48）：conds 无条件加 `"c.state <> 'excluded'"`；BM25 全量查（:81-85）同样加 `state <> 'excluded'`（无参数条件，直接进 conds 数组）。
- pipeline `_vector_hits`（embed.py:181-194）：SQL 加 `WHERE c.state <> 'excluded'`；`bm25_search`（lexical.py:31）：`SELECT ... FROM chunks WHERE state <> 'excluded'`。
- `SearchHit`（search.ts:7-17）加显式字段（值来自 meta 摊平，toHit 不用改）：

```ts
  /** 答案快照（chunks.meta.answer_md，子系统 4 字段）；不参与 embedding，仅作 payload。 */
  answer_md?: string | null;
  answer_state?: string;
```

- stale 不过滤：重建前仍可搜到（内容近似），这是刻意语义，测试里钉死。

- [ ] **Step 1: 写失败测试**

`backend/src/retrieval/search.test.ts` 追加：

```ts
it("excluded chunk 两路召回都不命中；stale 仍可命中；meta 答案透出", async () => {
  // 三条同内容 chunk：indexed / stale / excluded（state 手工 UPDATE）
  const hits = await hybridSearch(pool, deps, "梯形面积", {});
  const states = hits.map((h) => h._state);  // 测试里从 meta 塞入标记位或按 item_id 回查
  expect(states).not.toContain("excluded");
  expect(states).toContain("stale");  // stale 在重建前仍可搜到
  const withAnswer = hits.find((h) => h.answer_md);
  expect(withAnswer?.answer_state).toBeDefined();
});
```

（断言写法按现有 fixture 调整：可在插入 chunk 时把 state 名写进 meta 便于断言，或按 item_id 回查 DB。）
`pipeline/tests/test_embed.py` 追加同语义用例（search(mode="vector") 与 mode="bm25" 都不返回 excluded）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && npm test -- search.test
cd pipeline && uv run pytest tests/test_embed.py -v
```

预期：FAIL（excluded 仍被命中）。

- [ ] **Step 3: 实现**（三处加过滤 + SearchHit 字段）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && npm test -- search.test
cd pipeline && uv run pytest tests/test_embed.py -v
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/retrieval/search.ts backend/src/retrieval/search.test.ts pipeline/kb/rag/embed.py pipeline/kb/rag/lexical.py pipeline/tests/test_embed.py
git commit -m "feat: 检索两栈过滤 state=excluded（stale 重建前仍可搜），SearchHit 透出答案 payload"
```

---

### Task 5: md 三处统一——图片 + 图注 + 答案折叠段 + 共图去重

**Files:**
- Create: `pipeline/kb/rag/mdtool.py`
- Modify: `pipeline/kb/rag/assemble.py`（:35-41 块拼接换 blocks_to_md）
- Modify: `pipeline/kb/rag/export_md.py`（:15-26 `_adopted_page_md` 同口径）
- Modify: `backend/src/routes/library.ts`（/content SQL :333-339 同口径，图片用 crop URL）
- Create: `frontend/src/lib/itemMarkdown.ts`（item 级文本：stem + 图 + `<!-- answer -->` 段）
- Test: `pipeline/tests/test_export_md.py`（追加）、`pipeline/tests/test_assemble_md.py`（新建或并入 test_export_md）、`backend/src/routes/library.test.ts`、`frontend/src/lib/itemMarkdown.test.ts`

行为（§7.3、锁定决策 6）：

- `mdtool.py`：

```python
"""markdown 组装共享规则：figure 渲染与共图去重（spec §7.3）。
三处消费同口径：assemble_chapter / export_md（落盘镜像，相对路径）；
backend /content 在 SQL 里实现同结构（图片换 crop URL）。"""


def figure_md(crop_path: str | None, caption: str | None, *, doc_id: str) -> str:
    """figure 块 -> 图片 + 图注行。落盘路径去掉 <doc_id>/ 前缀（从 storage/<doc_id>/ 起算，§7.1）。
    caption 为空时只出图片（复核页负责拦截，md 不拦）。"""
    rel = (crop_path or "").removeprefix(f"{doc_id}/")
    img = f"![{caption or ''}]({rel})"
    return f"{img}\n*图注：{caption}*" if caption else img


def blocks_to_md(rows, doc_id: str) -> str:
    """[(block_id, block_type, content_md, crop_path, caption)] -> 页/章正文。
    figure 渲染图片+图注，按 block_id 去重（题组共图只引一次）；其余块取 content_md；
    跳过 header/footer，与现口径一致。"""
    seen: set[str] = set()
    parts = []
    for block_id, block_type, content, crop_path, caption in rows:
        if block_type in ("header", "footer") or block_id in seen:
            continue
        seen.add(block_id)
        parts.append(figure_md(crop_path, caption, doc_id=doc_id)
                     if block_type == "figure" else (content or ""))
    return "\n\n".join(p for p in parts if p.strip())
```

- `assemble.py` / `export_md.py` 的块查询 SELECT 加 `id, block_type, crop_path, caption`，拼接换 `blocks_to_md`。
- backend `library.ts` /content 的 blocks_md 子查询改：

```sql
(SELECT string_agg(
   CASE WHEN b.block_type = 'figure'
        THEN concat('![', coalesce(b.caption, ''), '](/api/review/blocks/', b.id::text, '/crop)',
                    E'\n', '*图注：', coalesce(b.caption, ''), '*')
        ELSE b.content_md END,
   E'\n\n' ORDER BY b.ordinal)
 FROM blocks b
 WHERE b.page_id = p.id AND b.content_md IS NOT NULL
   AND b.block_type NOT IN ('header','footer')) AS blocks_md
```

  figure 块 content_md 恒非空（VLM 转录），CASE 不再依赖 content_md；WHERE 的 `content_md IS NOT NULL` 条件改为 `(b.content_md IS NOT NULL OR b.block_type = 'figure')`。
  注释注明与 pipeline mdtool.blocks_to_md 同口径、仅图片地址不同（URL vs 落盘相对路径）。
- `frontend/src/lib/itemMarkdown.ts`：

```ts
/** item 级文本（题卡/chunk 卡「复制」内容）：stem + 图 + 图注 + 答案折叠段（§7.3）。
    答案段用 <!-- answer --> 包裹，不进 embedding，仅作呈现/导出文本。 */
export function itemMarkdown(item: {
  label?: string | null; content_md: string;
  figures?: { block_id: string; caption: string | null; crop_url: string }[];
  answer_md?: string | null;
}): string {
  const parts: string[] = [];
  if (item.label) parts.push(`#### ${item.label}`);
  parts.push(item.content_md);
  const seen = new Set<string>();
  for (const f of item.figures ?? []) {
    if (seen.has(f.block_id)) continue;  // 题组共图只引一次
    seen.add(f.block_id);
    parts.push(`![${f.caption ?? ""}](${f.crop_url})` + (f.caption ? `\n*图注：${f.caption}*` : ""));
  }
  if (item.answer_md) {
    parts.push(`<!-- answer -->\n${item.answer_md}\n<!-- /answer -->`);
  }
  return parts.join("\n\n");
}
```

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_export_md.py` 追加：

```python
def test_page_md_renders_figure_with_caption(conn, doc_chapter):
    """figure 块 -> ![caption](相对路径) + 图注行；路径去掉 <doc_id>/ 前缀（§7.1/§7.3）。"""
    from kb.rag.export_md import export_page_md

    doc_id, cfg = doc_chapter
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM pages WHERE document_id=%s AND page_no=1", (doc_id,))
        (page_id,) = cur.fetchone()
        cur.execute(
            """INSERT INTO blocks (page_id, block_type, content_md, crop_path, ordinal,
                                   caption, caption_source)
               VALUES (%s,'figure','〔图〕',%s,9,'梯形，上底 6 cm','vlm')""",
            (page_id, f"{doc_id}/blocks/{page_id}/b009.png"))
    assert export_page_md(conn, cfg, doc_id, 1)
    text = (cfg.storage_dir / doc_id / "pages" / "p0001.md").read_text(encoding="utf-8")
    assert f"![梯形，上底 6 cm](blocks/{page_id}/b009.png)" in text
    assert "*图注：梯形，上底 6 cm*" in text
    assert f"{doc_id}/blocks" not in text  # 相对路径不含 doc_id 前缀


def test_blocks_to_md_dedupes_shared_figure(conn, doc_chapter):
    """题组共图：同一 block 出现两次只渲染一次（§7.3 去重）。"""
```

backend `library.test.ts` 追加：`GET /:id/content` 含 figure 块的页，断言 content_md 含 `![梯形](/api/review/blocks/<id>/crop)` 与 `*图注：…*`。
frontend `itemMarkdown.test.ts`：答案折叠段包裹、共图去重、无答案不出段。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_export_md.py -v
cd backend && npm test -- library.test
cd frontend && npm test -- itemMarkdown
```

预期：FAIL（figure 块现在只输出转录文本，无图片语法）。

- [ ] **Step 3: 实现**（mdtool.py + 三处接入 + itemMarkdown.ts）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_export_md.py tests/test_embed.py -v
cd backend && npm test -- library.test
cd frontend && npm test -- itemMarkdown
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/rag/mdtool.py pipeline/kb/rag/assemble.py pipeline/kb/rag/export_md.py pipeline/tests/test_export_md.py backend/src/routes/library.ts backend/src/routes/library.test.ts frontend/src/lib/itemMarkdown.ts frontend/src/lib/itemMarkdown.test.ts
git commit -m "feat: md 三处统一渲染 figure 图片+图注（落盘相对路径/API crop URL），item 级文本带答案折叠段与共图去重"
```

---

### Task 6: backend 入库查看支撑 + frontend 屏 5（chunk 账页升级）

**Files:**
- Modify: `backend/src/routes/library.ts`（GET /:id/chunks 加 state/meta/全文；reindex 支持 item）
- Modify: `pipeline/kb/internal_api.py`（/internal/reindex 加 type='item'）
- Modify: `frontend/src/api/library.ts`（LibraryChunk 类型扩展）
- Modify: `frontend/src/components/LibraryDetail.tsx`（IndexLedger 升级为 chunk 卡）
- Test: `backend/src/routes/library.test.ts`、`pipeline/tests/test_internal_api.py`、`frontend/src/components/LibraryDetail.test.tsx`

行为（§11.5，设计稿屏 5）：

- `GET /:id/chunks` SELECT 加：`c.state`、`c.item_revision`、`c.content_md`（全文，替换或并存 content_preview——替换，前端展示全文）、`c.meta`、`(SELECT b.page_id::text FROM blocks b WHERE b.id = c.source_block_ids[1]) AS first_page_id`（「在原文定位」用）。
- `/internal/reindex` 加 `type='item'`：`UPDATE chunks SET state='stale' WHERE item_id=%s AND document_id=%s` → `embed_approved_items(conn, cfg, body.doc_id, client=embed_client)` → 返回 `{"chunks": n}`；item 不存在 → 404。
  library.ts 的 `POST /:id/reindex` 不用改（type/id 已透传），只需前端传 `type:"item"`。
- frontend `LibraryChunk` 类型加 `state`、`item_revision`、`content_md`、`meta`、`first_page_id`。
- `IndexLedger` 升级为 chunk 卡列表（对齐 renderChunks :1286-1316）：序号 + 来源（meta.label/chapter 或页码）+ state 徽标（indexed→「已索引」ok / stale→「索引过期」bad / excluded→「已排除」灰）+ 「▸ embedding 输入（stem + 图注）」全文 + figure 图注行（meta 无图时不显示）+ 答案折叠条（meta.answer_md 存在时，默认收起，点击展开，标签「不参与 embedding」）+ 操作行：复制（`itemMarkdown` 或 content_md 写剪贴板）/ 在原文中定位（`first_page_id` → LibraryDetail 传 `onLocate(pageId)` 回调跳 PageDetail）/ 重建向量（`reindexLibraryUnit(docId, "item", item_id)` 后 reload；item_id 为空的 chapter chunk 走现有 chapter 重建）。
  底部统计行：`已索引 X · 失效待重建 Y · 排除 Z`（从 chunks 的 state 聚合；分页时统计走 `count(*) OVER()` 之外的独立聚合——加一列 `count(*) FILTER (WHERE state='indexed') OVER()` 等三个窗口计数，随首页返回）。
  「全文」tab（FullContent）经 Task 5 的 /content 改动自动渲染图片；答案折叠不在全文（锁定决策 6）。

- [ ] **Step 1: 写失败测试**

`backend/src/routes/library.test.ts` 追加：

```ts
it("GET /:id/chunks 带 state/item_revision/meta/first_page_id；底部聚合计数", async () => {
  // 造 item chunk（state='stale'，meta 含 answer_md，source_block_ids 指向块）
  const resp = await app.request(`/api/library/${docId}/chunks`);
  const { chunks } = await resp.json();
  expect(chunks[0].state).toBe("stale");
  expect(chunks[0].meta.answer_md).toBeDefined();
  expect(chunks[0].first_page_id).toBe(pageId);
});

it("POST /:id/reindex type=item 转发 pipeline 并标 stale 重建", async () => {
  // fetch stub 断言 /internal/reindex body {type:"item", id:<itemId>}
});
```

`pipeline/tests/test_internal_api.py` 追加：reindex type=item——stale 标定 + embed_approved_items 被调（FakeEmbed 计数）+ 404。
`frontend/src/components/LibraryDetail.test.tsx` 追加：stale 徽标渲染「索引过期」、答案默认折叠点击展开、点「重建向量」调用 `reindexLibraryUnit(docId,"item",itemId)`、点「在原文中定位」触发 onLocate(first_page_id)。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && npm test -- library.test
cd pipeline && uv run pytest tests/test_internal_api.py -v
cd frontend && npm test -- LibraryDetail
```

预期：FAIL（字段缺失 / reindex item 422 / 组件无此 UI）。

- [ ] **Step 3: 实现**（按行为节）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && npm test -- library.test
cd pipeline && uv run pytest tests/test_internal_api.py -v
cd frontend && npm test -- LibraryDetail
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/library.ts backend/src/routes/library.test.ts pipeline/kb/internal_api.py pipeline/tests/test_internal_api.py frontend/src/api/library.ts frontend/src/components/LibraryDetail.tsx frontend/src/components/LibraryDetail.test.tsx
git commit -m "feat: 入库查看屏——chunks 端点带 state/meta/全文，item 粒度重建，chunk 卡徽标/折叠答案/定位/重建"
```

---

### Task 7: frontend 屏 2 拆题复核（MaterialsView 条目 tab 升级题卡）

**Files:**
- Modify: `backend/src/routes/review.ts`（GET /items 扩展字段；新增 DELETE /items/:id；新增 GET /docs/:id/items-summary）
- Modify: `pipeline/kb/internal_api.py`（ApproveDocRequest 加 embed 开关）+ `pipeline/kb/rag/embed.py`（approve_items 加 embed=True 参数）
- Modify: `backend/src/routes/library.ts`（POST /:id/approve 透传 embed）
- Modify: `frontend/src/views/MaterialsView.tsx`（items tab → 题卡列表 + 右栏）
- Create: `frontend/src/components/ItemReviewCard.tsx`
- Modify: `frontend/src/api/review.ts`、`frontend/src/api/library.ts`（approve 加 embed 参数）
- Test: `backend/src/routes/review.test.ts`、`pipeline/tests/test_embed.py`（embed=False 不向量）、`frontend/src/components/ItemReviewCard.test.tsx`、`frontend/src/views/MaterialsView.test.tsx`

行为（§11.2，设计稿屏 2 :402-554；锁定决策 8/9/10）：

- backend `GET /api/review/items` SELECT 加：

```sql
       i.revision,
       to_jsonb(i)->>'answer_md' AS answer_md,
       to_jsonb(i)->>'answer_state' AS answer_state,
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'block_id', b.id::text, 'caption', b.caption) ORDER BY b.ordinal), '[]'::jsonb)
        FROM item_blocks ib JOIN blocks b ON b.id=ib.block_id
        WHERE ib.item_id=i.id AND ib.role='figure') AS figures
```

  `answer_*` 用 to_jsonb 兼容写法（0021 未落地时为 NULL）；figures 供题卡渲染裁图（`/api/review/blocks/<id>/crop`）与缺图判定（任一 caption 为 null）。
- 新增 `GET /api/review/docs/:id/items-summary`：

```sql
SELECT count(*) FILTER (WHERE i.content_type IS DISTINCT FROM 'answer')::int AS total,
       count(*) FILTER (WHERE i.qc_status='approved'
                        AND i.content_type IS DISTINCT FROM 'answer')::int AS confirmed,
       count(*) FILTER (WHERE i.qc_status IN ('pending','needs_review','auto_passed')
                        AND i.content_type IS DISTINCT FROM 'answer')::int AS pending,
       count(*) FILTER (WHERE to_jsonb(i)->>'answer_md' IS NOT NULL)::int AS with_answer,
       count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM item_blocks ib JOIN blocks b ON b.id=ib.block_id
           WHERE ib.item_id=i.id AND ib.role='figure' AND b.caption IS NULL))::int AS missing_caption
FROM items i WHERE i.document_id=$1
```

  题组数无数据源（题组判定逻辑不新写，锁定决策 8），响应不含该字段，UI 概览卡不显示此行。
- 新增 `DELETE /api/review/items/:id`：存在校验（404）→ `UPDATE items SET qc_status='rejected', updated_at=now()` + `UPDATE chunks SET state='excluded' WHERE item_id=$1` + pipeline_events（stage='user_edit', event_type='item_delete'）→ `{ok:true}`。
- pipeline：`ApproveDocRequest` 加 `embed: bool = True`；`approve_items(conn, cfg, doc_id, chapter_no=None, client=None, embed=True)`——`embed=False` 时跳过 embed_approved_items/embed_chapters，返回值 `embedded=0`；approve_doc_ep 透传。
  backend `POST /api/library/:id/approve` 读 body `embed`（缺省 true）透传。
- frontend `ItemReviewCard.tsx`（对齐屏 2 题卡）：头部 chip（章/label）+ 来源（页/块）+ 状态徽标（已确认 ok/待确认 warn）+ 缺图时红 chip「缺图注」；题干 md 渲染；figure 裁图 + 图注行（fig-cap）；答案折叠条（answer_md 存在时，默认收起，标「不参与 embedding」）；操作：采纳（缺图时禁用 + title 提示「先补图注」）/ ✎ 修改（textarea 就地编辑 → PATCH /items/:id）/ 重跑本页解析（POST /pages/:id/page-vlm，pageId 由首个块定位）/ 删除（DELETE，二次确认）。
  「关联题组」不实现（锁定决策 8，范围外）。
- MaterialsView items tab：左列题卡列表 + 右栏「本卷抽题概览」统计卡（识别题数/已确认/待确认/答案配对 with_answer/total/缺图题数 + 进度条 confirmed/total）+ 入库卡（「确认全部并生成向量」→ `approveLibraryDoc(id)`；「仅确认，稍后批量入库」→ `approveLibraryDoc(id, {embed:false})`）+ 入库粒度下拉（纯呈现，默认「按题组（材料 + 子题）· 推荐」）+ 注意卡（未配对答案不阻塞入库）。
  采纳 409 响应（缺图）→ 题卡顶部红提示条显示缺图 block 清单。
  快捷键（设计稿 :538-542）：`1` 采纳当前聚焦卡 / `2` 进入修改 / `Enter` 下一张；输入框聚焦时不响应（`e.target` 是 textarea/input 则跳过）。

- [ ] **Step 1: 写失败测试**

`backend/src/routes/review.test.ts` 追加：GET /items 带 figures/answer_md/revision；DELETE /items/:id → rejected + chunk excluded + 事件；GET /docs/:id/items-summary 各计数正确（含缺图题数）。
`pipeline/tests/test_embed.py` 追加：`approve_items(..., embed=False)` → approved 计数正确且无 chunk 产生。
`ItemReviewCard.test.tsx`：缺图（figures 有 null caption）时「采纳」禁用且有「缺图注」chip；答案折叠点击展开；「修改」→ PATCH 调用；快捷键 1/2/Enter 行为（fireEvent.keyDown）。
`MaterialsView.test.tsx`：items tab 渲染概览统计（mock items-summary 响应）；两按钮分别带 embed true/false。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && npm test -- review.test
cd pipeline && uv run pytest tests/test_embed.py -v
cd frontend && npm test -- ItemReviewCard MaterialsView
```

预期：FAIL。

- [ ] **Step 3: 实现**（按行为节）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && npm test -- review.test library.test
cd pipeline && uv run pytest tests/test_embed.py tests/test_internal_api.py -v
cd frontend && npm test -- ItemReviewCard MaterialsView
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/library.ts backend/src/routes/review.test.ts pipeline/kb/internal_api.py pipeline/kb/rag/embed.py pipeline/tests/test_embed.py frontend/src/views/MaterialsView.tsx frontend/src/components/ItemReviewCard.tsx frontend/src/components/ItemReviewCard.test.tsx frontend/src/views/MaterialsView.test.tsx frontend/src/api/review.ts frontend/src/api/library.ts
git commit -m "feat: 拆题复核屏——题卡（采纳/修改/删除/重跑）、缺图拦阻提示、概览统计卡、入库两动作、快捷键 1/2/Enter"
```

---

### Task 8: qc 规则配置化 + 乱码率/密度/抽样 + 屏 6 只读规则页

**Files:**
- Modify: `pipeline/kb/core/config.py`（KB_QC_* 阈值）
- Modify: `pipeline/kb/ocr/qc.py`（check_page_text + 抽样编排）
- Modify: `pipeline/.env.example`
- Modify: `pipeline/kb/internal_api.py`（GET /internal/qc-rules）
- Modify: `backend/src/routes/review.ts`（GET /api/review/qc-rules 转发）
- Modify: `frontend/src/views/MaterialsView.tsx`（BLOCKS 加「规则」tab）
- Create: `frontend/src/components/QcRulesPanel.tsx`
- Test: `pipeline/tests/test_qc.py`、`pipeline/tests/test_config.py`、`pipeline/tests/test_internal_api.py`、`backend/src/routes/review.test.ts`、`frontend/src/components/QcRulesPanel.test.tsx`

行为（§9、§11.6，设计稿屏 6 :1103-1146；锁定决策 7）：

- `Config` 加字段（load_config 同步，env 覆盖）：

```python
    qc_garbled_ratio: float = 0.03    # KB_QC_GARBLED_RATIO：乱码率上限
    qc_density_min: int = 30          # KB_QC_DENSITY_MIN：页字数下限
    qc_density_max: int = 3000        # KB_QC_DENSITY_MAX：页字数上限
    qc_sample_ratio: float = 0.10     # KB_QC_SAMPLE_RATIO：随机抽样比例
```

- `qc.py` 新增：

```python
_GARBLED_CATEGORIES = ("Cc", "Cf", "Cs", "Co", "Cn")


def check_page_text(text: str, cfg) -> list[str]:
    """页级文本规则：乱码率 > 阈值 -> 'garbled'；去空白字数越界 -> 'text_density'。"""
    import unicodedata
    compact = "".join(text.split())
    if not compact:
        return []
    reasons = []
    garbled = sum(1 for ch in compact
                  if unicodedata.category(ch) in _GARBLED_CATEGORIES or ch == "")
    if garbled / len(compact) > cfg.qc_garbled_ratio:
        reasons.append("garbled")
    if len(compact) < cfg.qc_density_min or len(compact) > cfg.qc_density_max:
        reasons.append("text_density")
    return reasons
```

  `CHECKABLE_REASONS` 加 `garbled`、`text_density`（可复算，修复后自动关闭）。
  `run_qc` 页级循环：页全部块 content_md 拼接 → check_page_text → 命中建页面级 review_queue 行（与 layout_gap 同机制，reason in existing 防重）。
  抽样编排（run_qc 末尾）：未排除、无 pending 页面级行的页，按 `int(md5(page_id).hexdigest()[:8], 16) / 0xFFFFFFFF < cfg.qc_sample_ratio` 确定性抽样，建 `review_queue(page_id, reason='random_sample')`；插入前 `SELECT 1 FROM review_queue WHERE page_id=%s AND reason='random_sample'`（不限 status）——一次抽样终身留痕，复跑幂等。
- `GET /internal/qc-rules`：返回 `[{key, name, threshold, source, enabled, note}]`——七行规则（块置信/VLM 评分 enabled=false、note='数据未采集'；乱码率/密度/题号断层/补解析/抽样 enabled=true，阈值读 cfg）；再带 `ingest_rules` 静态段（入库与重建规则文案：revision 语义、人工确认先于入库、可重跑发布）。
- backend `GET /api/review/qc-rules`：fetch GET 转发（forwardInternal 是 POST 专用，新写一个 GET 小函数）。
- frontend `QcRulesPanel.tsx`（对齐屏 6 双卡）：左卡「什么页进人工队列」规则表（信号/阈值/来源，未启用行灰显 + note）；右卡「入库与重建」规则列表（静态文案：chunk 带 source+revision、改动 → revision+1 → 标过期、入库可重跑、顺序原则）。MaterialsView BLOCKS 加 `["rules", "规则"]`。

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_qc.py` 追加：

```python
def test_garbled_ratio_rule(conn, cfg):
    """乱码率 > 3% 的页建 'garbled' 复核行；修复（内容更新）后复跑自动关闭。"""
    ...


def test_text_density_rule(conn, cfg):
    """页字数 <30 或 >3000 建 'text_density' 行。"""
    ...


def test_random_sample_deterministic_and_idempotent(conn, cfg):
    """抽样按 page_id 哈希确定（同库两次跑结果一致），已抽过的页不重复建行。"""
    ...


def test_qc_thresholds_from_config(conn, tmp_path):
    """KB_QC_* env 覆盖阈值进 Config。"""
```

`test_internal_api.py` 追加：GET /internal/qc-rules 返回七行 + 当前阈值。
backend/frontend 各加转发与渲染测试（未启用行显示「数据未采集」）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_qc.py tests/test_config.py tests/test_internal_api.py -v
cd backend && npm test -- review.test
cd frontend && npm test -- QcRulesPanel
```

预期：FAIL。

- [ ] **Step 3: 实现**（按行为节）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/ -v
cd backend && npm test -- review.test
cd frontend && npm test -- QcRulesPanel MaterialsView
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/core/config.py pipeline/kb/ocr/qc.py pipeline/.env.example pipeline/kb/internal_api.py pipeline/tests/test_qc.py pipeline/tests/test_config.py pipeline/tests/test_internal_api.py backend/src/routes/review.ts backend/src/routes/review.test.ts frontend/src/views/MaterialsView.tsx frontend/src/components/QcRulesPanel.tsx frontend/src/components/QcRulesPanel.test.tsx
git commit -m "feat: 质检规则配置化（KB_QC_*）+ 乱码率/文本密度规则 + 10% 确定性抽样 + 只读规则屏"
```

---

### Task 9: e2e 用例 + 三栈全量回归 + spec 收尾

**Files:**
- Create: `e2e/specs/vector-revision.spec.ts`
- Modify: `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md`（§14 状态表）
- Test:（本 Task 即测试）

e2e 用例（验收 6/7 的端到端面，断言到 UI / API / DB 字段；fixture 用 SQL 直插 documents/pages/blocks/items/chunks，不依赖子系统 4 落地）：

1. **答案折叠**：造带 meta.answer_md 的 chunk → 入库查看屏 chunk 卡答案默认不可见 → 点折叠条 → 答案可见；DB 断言 `chunks.content_md` 不含答案串、`meta->>'answer_md'` 含（验收 6 前半）。
2. **embed 输入不含答案**：触发 item 重建（reindex type=item）→ 查 `chunks.content_md` 含 `〔图：` 图注、不含 answer_md（验收 6 后半）。
3. **stale → 重建 revision+1**：UI 题卡「✎ 修改」改题干保存 → DB 断言 `items.revision=2`、`chunks.state='stale'` → 入库查看点「重建向量」→ `state='indexed'`、`item_revision=2`（验收 7）。
4. **缺图拦截**：造含无 caption figure 块的 pending item → 题卡「采纳」禁用且显示「缺图注」；直接调 `POST /api/review/items/:id/approve` → 409，UI 提示条出现。
5. **chunk 列表 state 徽标**：indexed/stale/excluded 三种 chunk 各一 → 入库查看屏三个徽标文案正确；检索 API 不含 excluded 的内容。

- [ ] **Step 1: 写 e2e 用例**

新建 `e2e/specs/vector-revision.spec.ts`（fixture/服务编排照抄 exam-structure.spec.ts 的模式：Playwright 自动拉三服务；DB 直插用现有 e2e 的 pg 工具——先读 exam-structure.spec.ts 对齐写法）。

- [ ] **Step 2: 跑 e2e 确认失败**

```bash
cd e2e && npm test -- vector-revision
```

预期：FAIL（UI/端点在 Task 1–8 前不存在）。若 Task 1–8 已完成则直接应 PASS——本步骤在实现完前序 Task 后执行，作用是验证而非驱动。

- [ ] **Step 3: 三栈全量回归**

```bash
cd pipeline && uv run pytest tests/
cd backend && npm test
cd frontend && npm test
cd e2e && npm test
```

预期：全 PASS。任何既有用例变红都必须修平（含 Task 2 改动 DELETE→stale 波及的旧断言），不允许跳过。

- [ ] **Step 4: spec §14 收尾**

状态表子系统 5 行改为「**已完成**：`docs/superpowers/plans/2026-09-10-vector-revision-captions.md`」；如五个子系统全部完成，把 §14 头部「本 spec 规模超出单一实现计划」一句保留、表格即为终态。

- [ ] **Step 5: Commit**

```bash
git add e2e/specs/vector-revision.spec.ts docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md
git commit -m "test(e2e): 向量化 revision/图注/缺图拦截/折叠答案全链路用例；spec §14 子系统 5 收尾"
```

---

## 完成判定

全部满足才算完成：

- spec §12 用例 6：答案默认折叠、点击展开可见（e2e UI 断言）；embed 输入不含 answer_md（pipeline 单测断言 embed 输入 + e2e 断言 chunks.content_md）。
- spec §12 用例 7：题目改动 → `items.revision+1` 且 chunk 标 stale；重建后 `state='indexed'`、`item_revision=items.revision`（pipeline + backend 单测 + e2e）。
- spec §10：入库/重建幂等可重跑（embed 连续两次调用第二次新增 0，沿用现有幂等断言口径扩展 stale 情形）。
- spec §7.2：figure 块 parse/补画/调框后生成 caption（vlm）；无 caption 的 figure item 单条 approve 409、批量 approve 跳过并进 blocked；PATCH block 可手工补 caption（manual）。
- spec §7.3：页/章 md 镜像与 /content 三处渲染 `![caption](…)` + `*图注：…*`；题组共图按 block_id 去重；item 级文本含 `<!-- answer -->` 折叠段。
- spec §9 + §11.6：阈值全走 Config（KB_QC_*），乱码率/密度/抽样规则命中建复核行，屏 6 只读呈现（含「数据未采集」行的诚实标注）。
- spec §13：迁移后存量 item chunk 全 stale；重建前检索不断档（stale 可搜），重建后为新口径（stem+图注）。
- 检索两栈（backend search.ts、pipeline embed.py/lexical.py）均不返回 excluded chunk。
- 三栈单测 + e2e 全量绿。

## 范围外

- **屏 6 阈值编辑 UI**：配置只走 .env（KB_QC_*），UI 永远只读。
- **「关联题组」操作与题组判定新逻辑**：需 items.parent_id schema 与 chunk 合并重定向规则，另立子系统；题组数统计因无数据源暂不出现在概览卡。
- **入库粒度下拉的实际行为切换**：本期纯 UI 呈现，chunk 粒度恒为 item。
- **块置信 <0.60 / VLM 评分 <0.80 两条规则的实现**：blocks 无置信列、无页评分流程，屏 6 标注「数据未采集」。
- **卷末答案区整页 chunk 标 excluded 的识别动作**：答案区定位是子系统 4 的职责，其落地后一行 `UPDATE chunks SET state='excluded'` 即接入本系统的过滤语义。
- **flat 页链路的 stale 化**：PATCH /pages/:id、page-exclusion、embed_flat_pages 维持 DELETE+重建原语义（与 item 链路正交，chunks.state 对 flat chunk 恒为 indexed）。
- **item 级 md 落盘镜像**：itemMarkdown 仅供 API/复制文本，不新增 storage 落盘产物。
- **chunk 单条的「加入索引/排除」操作**：沿用现有页级排除（/pages/:pageId/exclusion）。
- **检索命中卡的 UI 改版**（屏 4 右栏）：answer_md 已随 SearchHit 透出，命中卡折叠条渲染归子系统 4 的 UI 范围。
