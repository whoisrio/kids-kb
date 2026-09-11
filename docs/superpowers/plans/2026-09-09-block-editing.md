# 块编辑四操作 + 引用重定向 + 分块修正 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status:** implementation and all stack-level regression checks are complete; `Commit` checkboxes remain open because no commit was requested.

**Goal:** 复核页支持分块修正四操作——改文字（已有）/ 合并 / 按行拆分（即时生效）+ 调框 / 补画（重裁+重跑 OCR，diff 确认后落库），含 item_blocks/chunks 引用重定向与块血缘记账。

**Architecture:** migration `0020_block_editing.sql` 加 `blocks.origin/parent_block_ids/geometry_revision` 与 `chunks.state`；合并/拆分/删除是纯后端 DB 操作（即时生效，不调模型）；调框/补画必须裁图+OCR，走 pipeline 新增 internal 端点（preview 不落库 → diff 确认 → commit 落库），backend 用现有 `forwardInternal` 模式转发；前端在 `PageDetail.tsx` 的 bbox 覆层上加多选/拖拽/键盘微调/补画模式与 diff 弹窗。

**Tech Stack:** pipeline: Python 3.13 / pytest / psycopg / pymupdf；backend: TS / Hono / vitest（真库）；frontend: React / vitest + @testing-library（jsdom）；e2e: Playwright。

**Spec:** `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md` §4（血缘/几何部分）、§6、§11.1、§11.3、§12 用例 9–13。视觉/交互细节以 `docs/design/review-workbench.html` 屏 1（`#scr-review`）与屏 3（`#scr-blockfix`）为唯一事实源。

**前置：** 子系统 1/2 已完成（ordinal、crop_pad、路径基准 KB_STORAGE_DIR）。可复用零件已核实：`padded_px_bbox`（kb/ocr/pad.py:21）、`crop_image`（kb/ocr/layout.py:66）、`ocr_image`/`transcribe_image`/`starred_math`（kb/ocr/parse.py:109/37/92）、`resolve_storage_path`/`storage_rel`（kb/core/paths.py）、`record_llm_call`（kb/telemetry/metering.py）、`forwardInternal`（backend/src/routes/review.ts:428-444）。

**migration 编号偏差（已发生，照此执行）：** spec §14 原约定「§4 顺延为 0019」，但 0019 已被计划二的 `0019_crop_pad_paths.sql` 占用；本子系统的 schema 变更用 **`0020_block_editing.sql`**。§4 里 `items.revision` / `chunks.item_revision` 仍归子系统 5，本计划只取 `chunks.state`（§6.4 标 stale 所需）。

**锁定决策（执行者不要改动，有异议先回报）：**

1. **拆分按行比例近似切 bbox**：`y_split = y0 + (y1-y0) * line_index / total_lines`。UI 不知道每行的真实 y 坐标（OCR 行数据没存），这是 spec「按该行 y 坐标切」的可用近似，写进代码注释。
2. **合并/拆分生成新块、删旧块**：合并 C 的 `ordinal = min(A,B).ordinal`（空隙无害，排序不变）；拆分 B/C 分别取 `A.ordinal` 与 `A.ordinal+1`，后续块 `ordinal+1` 移位。旧块的 review_queue 行随 `ON DELETE CASCADE` 消失——合并/拆分本身是人工操作，事件已写 pipeline_events，接受。
3. **chunks 不删只标 `state='stale'`**（§6.4）；检索主链路本次不动（stale chunk 在重建前仍可被搜到，内容近似，子系统 5 处理重建与过滤）。
4. **新块裁图命名**：调框覆盖原 crop 文件（crop_path 不变）；补画新块用 `b-<block_id>.png` 避免与 bNNN.png 序号碰撞。
5. **合并/拆分后的裁图滞后刷新**：backend 完成 DB 操作后 best-effort 调 pipeline `/internal/block-recrop` 重裁（纯裁图不调模型，毫秒级）；失败不致命（UI 块卡裁图暂时是旧的，页图框是对的），警告落 pipeline_events。
6. **删块的「item 标 no_source」**：items 表没有该枚举，用 `qc_status='needs_review'` 代替并写事件说明（与 spec 的偏差，此处记录即生效）。
7. **拆分时 item 重定向规则**：item 归一化文本只含于前半 → B；只含于后半 → C；两半都沾或都不沾 → 两半都挂（保守不丢）。

---

### Task 1: migration 0020——块血缘/几何列 + chunks.state

**Files:**
- Create: `pipeline/kb/migrations/0020_block_editing.sql`
- Modify: `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md`（§14 编号约定行）
- Test: `pipeline/tests/test_migration_0020.py`

- [ ] **Step 1: 写失败测试**

新建 `pipeline/tests/test_migration_0020.py`：

```python
"""0020：blocks 血缘/几何列 + chunks.state。"""
from kb.core.db import MIGRATIONS_DIR


def test_0020_columns_exist_with_defaults(conn):
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
            " VALUES (%s, 'text', 'c.png', 1) RETURNING id::text",
            (page_id,),
        )
        block_id = cur.fetchone()[0]
        cur.execute(
            "SELECT origin, parent_block_ids, geometry_revision FROM blocks WHERE id=%s",
            (block_id,),
        )
        assert cur.fetchone() == ("layout", [], 1)  # 存量默认：原生块、无血缘、几何未动过
        cur.execute(
            "INSERT INTO items (document_id, content_type, content_md) VALUES (%s, 'exercise', '题') RETURNING id::text",
            (doc_id,),
        )
        item_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO chunks (item_id, content_md, embedding) VALUES (%s, '题', %s) RETURNING id::text",
            (item_id, [1.0] * 1024),
        )
        chunk_id = cur.fetchone()[0]
        cur.execute("SELECT state FROM chunks WHERE id=%s", (chunk_id,))
        assert cur.fetchone()[0] == "indexed"
        cur.execute("SELECT 1 FROM pg_attribute WHERE attrelid='chunks'::regclass AND attname='item_revision'")
        assert cur.fetchone() is None  # item_revision 归子系统 5，本 migration 不加
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_migration_0020.py -v
```

预期：FAIL，`column "origin" does not exist`。

- [ ] **Step 3: 写 migration**

新建 `pipeline/kb/migrations/0020_block_editing.sql`：

```sql
-- 0020：块编辑血缘/几何记账（spec §4/§6）+ chunks 失效状态（§6.4）
ALTER TABLE blocks ADD COLUMN origin TEXT NOT NULL DEFAULT 'layout';
  -- layout 版面检测 | manual 人工补画 | merged 合并生成 | split 拆分生成
ALTER TABLE blocks ADD COLUMN parent_block_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE blocks ADD COLUMN geometry_revision INTEGER NOT NULL DEFAULT 1;
  -- bbox 每次变更 +1；>1 表示几何被人动过，内容与版面检测输出不再等价

ALTER TABLE chunks ADD COLUMN state TEXT NOT NULL DEFAULT 'indexed';
  -- indexed | stale（源块变动待重建） | excluded（子系统 5 用）
```

- [ ] **Step 4: 更新 spec §14 编号约定**

§14 末尾「migration 编号约定」一段改为：「`0018_block_ordinal.sql` 已被子计划 1 占用；`0019_crop_pad_paths.sql` 已被子计划 2 占用；§4 的血缘/几何列与 `chunks.state` 由子计划 3 的 `0020_block_editing.sql` 落地；`items.revision` / `chunks.item_revision` 与 `items.answer_*` 留后续子系统。」

同时 §14 状态表子系统 3 行改为「**已出计划**：`docs/superpowers/plans/2026-09-09-block-editing.md`，未执行」。

- [ ] **Step 5: 跑测试 + 应用 dev 库**

```bash
cd pipeline && uv run pytest tests/test_migration_0020.py tests/test_db.py -v
cd pipeline && uv run python -c "from kb.core.config import load_config; from kb.core.db import connect, migrate; cfg = load_config(); print(migrate(connect(cfg.database_url)))"
```

预期：测试全 PASS；migrate 输出含 `0020_block_editing.sql`。

- [ ] **Step 6: Commit**

```bash
git add pipeline/kb/migrations/0020_block_editing.sql pipeline/tests/test_migration_0020.py docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md
git commit -m "feat(pipeline): migration 0020——blocks 血缘/几何列 + chunks.state（块编辑前置）"
```

---

### Task 2: 合并块 `POST /api/review/blocks/merge`

**Files:**
- Modify: `backend/src/routes/review.ts`
- Test: `backend/src/routes/review.test.ts`

行为（对应 §6.4 合并行 + 验收 9）：校验全部块存在且同页（否则 422）→ 事务内：建合并块 C（bbox=外接矩形、content_md=按 ordinal 序 `"\n\n"` 拼接、ordinal=min、origin='merged'、parent_block_ids=旧块 ids、crop_path 先沿用第一块的）→ item_blocks 去重后重定向到 C → chunks 的 source_block_ids 把旧 id 换成 C 并标 stale → 删旧块 → pages.index_status='stale' → pipeline_events（stage='user_edit', event_type='block_merge', actor='user'，payload 带 old/new）→ 提交后 best-effort 调 `/internal/block-recrop` 刷新 C 的裁图（失败仅日志，见锁定决策 5）。

- [ ] **Step 1: 写失败测试**

`backend/src/routes/review.test.ts` 追加（fixture 模式照抄现有 beforeAll：裸 INSERT + `PNG_1PX`；items/chunks 手工插，chunks embedding 用 1024 维全 1）：

```ts
  it("POST /blocks/merge：合并两块——item_blocks 重定向不重复、chunks 标 stale、origin/ordinal 正确（验收 9）", async () => {
    // 在 page1 上再造两个块（block11 已有，沿用 fixture 风格）
    const mk = async (ord: number, content: string, bbox: number[]) =>
      (await pool.query(
        `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md, ordinal)
         VALUES ($1,'text',$2,$3,$4,$5) RETURNING id::text`,
        [page1, JSON.stringify(bbox), join(docId, "blocks", `m${ord}.png`), content, ord],
      )).rows[0].id as string;
    const bA = await mk(10, "上半", [10, 100, 200, 150]);
    const bB = await mk(11, "下半", [20, 160, 220, 200]);
    // item 同时挂 A、B（同角色）——验证去重；另一条 chunk 只引 B
    const item = (await pool.query(
      `INSERT INTO items (document_id, content_type, content_md) VALUES ($1,'exercise','题') RETURNING id::text`,
      [docId])).rows[0].id as string;
    await pool.query(
      `INSERT INTO item_blocks (item_id, block_id, role) VALUES ($1,$2,'stem'),($1,$3,'stem')`,
      [item, bA, bB]);
    const vec = `[${"1,".repeat(1023)}1]`;
    await pool.query(
      `INSERT INTO chunks (item_id, content_md, embedding, source_block_ids)
       VALUES ($1,'题',$2::vector, ARRAY[$3::uuid,$4::uuid])`,
      [item, vec, bA, bB]);

    const resp = await app.request("/api/review/blocks/merge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ block_ids: [bB, bA] }),  // 乱序传，验证内部按 ordinal 排
    });
    expect(resp.status).toBe(200);
    const { id: newId } = await resp.json();

    const blk = (await pool.query(
      "SELECT bbox, content_md, ordinal, origin, parent_block_ids FROM blocks WHERE id=$1",
      [newId])).rows[0];
    expect(blk.bbox).toEqual([10, 100, 220, 200]);       // 外接矩形
    expect(blk.content_md).toBe("上半\n\n下半");           // 按 ordinal 序拼接
    expect(blk.ordinal).toBe(10);                          // 原位，不是页末尾
    expect(blk.origin).toBe("merged");
    expect(blk.parent_block_ids).toEqual([bA, bB]);

    const ib = await pool.query("SELECT count(*) FROM item_blocks WHERE item_id=$1", [item]);
    expect(Number(ib.rows[0].count)).toBe(1);              // 重定向且去重
    const ck = (await pool.query(
      "SELECT source_block_ids, state FROM chunks WHERE item_id=$1", [item])).rows[0];
    expect(ck.source_block_ids).toEqual([newId]);
    expect(ck.state).toBe("stale");
    const gone = await pool.query(
      "SELECT count(*) FROM blocks WHERE id = ANY($1::uuid[])", [[bA, bB]]);
    expect(Number(gone.rows[0].count)).toBe(0);
    const ev = await pool.query(
      "SELECT 1 FROM pipeline_events WHERE stage='user_edit' AND event_type='block_merge'");
    expect(ev.rowCount).toBeGreaterThan(0);
  });

  it("POST /blocks/merge：跨页 → 422；不足两块 → 422", async () => {
    const otherPageBlock = (await pool.query(
      `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md, ordinal)
       VALUES ($1,'text','[0,0,1,1]',$2,'异页',1) RETURNING id::text`,
      [page2, join(docId, "blocks", "cross.png")])).rows[0].id as string;
    const cross = await app.request("/api/review/blocks/merge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ block_ids: [block11, otherPageBlock] }),
    });
    expect(cross.status).toBe(422);
    const single = await app.request("/api/review/blocks/merge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ block_ids: [block11] }),
    });
    expect(single.status).toBe(422);
  });
```

注意：第二条用例写的是占位断言，实现时改成真正的跨页构造（block12 在 page1；从 page2 建一个块来凑跨页 → 422；单块 → 422）。写完即改紧，不许留 `[200,422]` 这种断言。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && npm test -- review.test
```

预期：FAIL，404（路由不存在）。

- [ ] **Step 3: 实现**

`backend/src/routes/review.ts` 在 PATCH /blocks/:id 之后加（事务用 `pool.connect()` 客户端，参照 paperQuestions.ts:12-25 的 `withTx` 模式，在本文件内联等价的）：

```ts
  app.post("/blocks/merge", async (c) => {
    let body: { block_ids?: string[] };
    try { body = await c.req.json(); } catch { return c.json({ error: "请求体不是合法 JSON" }, 400); }
    const ids = body.block_ids ?? [];
    if (ids.length < 2) return c.json({ error: "至少两块才能合并" }, 422);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: blocks } = await client.query(
        `SELECT id::text, page_id::text, bbox, content_md, ordinal FROM blocks
         WHERE id = ANY($1::uuid[]) ORDER BY ordinal`, [ids]);
      if (blocks.length !== ids.length) { await client.query("ROLLBACK"); return c.json({ error: "块不存在" }, 404); }
      if (new Set(blocks.map(b => b.page_id)).size !== 1) {
        await client.query("ROLLBACK"); return c.json({ error: "只能合并同页的块" }, 422);
      }
      const newId = crypto.randomUUID();
      const bbox = [
        Math.min(...blocks.map(b => b.bbox[0])), Math.min(...blocks.map(b => b.bbox[1])),
        Math.max(...blocks.map(b => b.bbox[2])), Math.max(...blocks.map(b => b.bbox[3])),
      ];
      const content = blocks.map(b => b.content_md ?? "").filter(Boolean).join("\n\n");
      await client.query(
        `INSERT INTO blocks (id, page_id, block_type, bbox, crop_path, content_md, ordinal, origin, parent_block_ids)
         VALUES ($1,$2,'text',$3,$4,$5,$6,'merged',$7::uuid[])`,
        [newId, blocks[0].page_id, JSON.stringify(bbox),
         (await client.query("SELECT crop_path FROM blocks WHERE id=$1", [blocks[0].id])).rows[0].crop_path,
         content, blocks[0].ordinal, ids]);
      // item_blocks：先去重（同事项同角色多条），再重定向
      await client.query(
        `DELETE FROM item_blocks a USING item_blocks b
         WHERE a.block_id = ANY($1::uuid[]) AND b.block_id = ANY($1::uuid[])
           AND a.item_id=b.item_id AND a.role=b.role AND a.ctid < b.ctid`, [ids]);
      await client.query(
        "UPDATE item_blocks SET block_id=$2 WHERE block_id = ANY($1::uuid[])", [ids, newId]);
      // chunks：换引用 + 标 stale（不删，§6.4）
      await client.query(
        `UPDATE chunks SET source_block_ids = (
           SELECT array_agg(DISTINCT x) FROM unnest(
             (SELECT array_agg(y) FROM unnest(source_block_ids) y WHERE y <> ALL($1::uuid[]))
             || $2::uuid) x), state='stale'
         WHERE source_block_ids && $1::uuid[]`, [ids, newId]);
      await client.query("DELETE FROM blocks WHERE id = ANY($1::uuid[])", [ids]);
      await client.query(
        "UPDATE pages SET index_status='stale', index_error=NULL WHERE id=$1", [blocks[0].page_id]);
      await client.query(
        `INSERT INTO pipeline_events (document_id, page_id, stage, event_type, actor, summary, payload, status)
         SELECT p.document_id, p.id, 'user_edit', 'block_merge', 'user', $2, $3, 'ok'
         FROM pages p WHERE p.id=$1`,
        [blocks[0].page_id, `合并 ${ids.length} 块 → ${newId.slice(0, 8)}`,
         JSON.stringify({ merged: ids, into: newId, content })]);
      await client.query("COMMIT");
      // best-effort 重裁合并块（不调模型；pipeline 不在线不致命）
      fetch(`${deps.pipelineUrl}/internal/block-recrop`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ block_id: newId }),
      }).catch(err => console.warn("合并块重裁失败（可忽略，裁图滞后）", err));
      return c.json({ id: newId });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return invalidId(c, err) ?? (() => { throw err; })();
    } finally {
      client.release();
    }
  });
```

`/internal/block-recrop` 在 Task 5 才实现——本 Task 的 fetch 是 best-effort catch 掉的，测试里 stub fetch 或直接让它 ECONNREFUSED 进 catch（`console.warn` 可 mock 静默）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && npm test -- review.test
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/review.test.ts
git commit -m "feat(backend): 合并块接口——item_blocks 去重重定向、chunks 标 stale、origin=merged 血缘记账"
```

---

### Task 3: 按行拆分块 `POST /api/review/blocks/:id/split`

**Files:**
- Modify: `backend/src/routes/review.ts`
- Test: `backend/src/routes/review.test.ts`

行为（验收 10）：body `{line_index}`（1-based，切在第 line_index 行之后；合法范围 1..行数-1，否则 422）。事务内：内容按行切两半 → bbox 按行比例切（锁定决策 1）→ 后续块 ordinal+1 移位 → 插 B（A.ordinal，前半）C（A.ordinal+1，后半），均 origin='split'、parent_block_ids=[A] → item_blocks 按锁定决策 7 重定向 → chunks 把 A 换成 B,C 标 stale → 删 A → 页标 stale → 事件 → best-effort 对 B、C 各调一次 `/internal/block-recrop`。**全程不调 OCR**。

- [ ] **Step 1: 写失败测试**

```ts
  it("POST /blocks/:id/split：两半各自继承文本与比例 bbox，ordinal 原位，不触发 OCR（验收 10）", async () => {
    const bX = (await pool.query(
      `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md, ordinal)
       VALUES ($1,'text',$2,$3,$4,5) RETURNING id::text`,
      [page1, JSON.stringify([0, 100, 200, 300]), join(docId, "blocks", "x.png"),
       "第一行\n第二行\n第三行\n第四行"])).rows[0].id as string;
    // 挂一条 item（文本落在后半）和一条 chunk
    const item = (await pool.query(
      `INSERT INTO items (document_id, content_type, content_md) VALUES ($1,'exercise','第三行 第四行') RETURNING id::text`,
      [docId])).rows[0].id as string;
    await pool.query("INSERT INTO item_blocks (item_id, block_id, role) VALUES ($1,$2,'stem')", [item, bX]);
    const vec = `[${"1,".repeat(1023)}1]`;
    await pool.query(
      `INSERT INTO chunks (item_id, content_md, embedding, source_block_ids)
       VALUES ($1,'题',$2::vector, ARRAY[$3::uuid])`, [item, vec, bX]);

    const llmBefore = (await pool.query("SELECT count(*) FROM llm_calls")).rows[0].count;
    const resp = await app.request(`/api/review/blocks/${bX}/split`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line_index: 2 }),
    });
    expect(resp.status).toBe(200);
    const { ids } = await resp.json() as { ids: string[] };
    expect(ids).toHaveLength(2);

    const halves = (await pool.query(
      "SELECT content_md, bbox, ordinal, origin, parent_block_ids FROM blocks WHERE id = ANY($1::uuid[]) ORDER BY ordinal",
      [ids])).rows;
    expect(halves[0].content_md).toBe("第一行\n第二行");
    expect(halves[0].bbox).toEqual([0, 100, 200, 200]);   // 行比例：100 + 200*2/4
    expect(halves[1].content_md).toBe("第三行\n第四行");
    expect(halves[1].bbox).toEqual([0, 200, 200, 300]);
    expect([halves[0].ordinal, halves[1].ordinal]).toEqual([5, 6]);  // 原位
    expect(halves[0].origin).toBe("split");
    expect(halves[0].parent_block_ids).toEqual([bX]);
    // item 文本只沾后半 → 重定向到 C
    const ib = await pool.query("SELECT block_id::text FROM item_blocks WHERE item_id=$1", [item]);
    expect(ib.rows[0].block_id).toBe(ids[1]);
    const ck = (await pool.query("SELECT state, source_block_ids FROM chunks WHERE item_id=$1", [item])).rows[0];
    expect(ck.state).toBe("stale");
    expect(ck.source_block_ids.sort()).toEqual([...ids].sort());
    const llmAfter = (await pool.query("SELECT count(*) FROM llm_calls")).rows[0].count;
    expect(llmAfter).toBe(llmBefore);  // 不触发 OCR/VLM
  });

  it("POST /blocks/:id/split：line_index 越界 → 422", async () => {
    const resp = await app.request(`/api/review/blocks/${block11}/split`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line_index: 99 }),
    });
    expect(resp.status).toBe(422);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && npm test -- review.test
```

预期：FAIL，404。

- [ ] **Step 3: 实现**

`backend/src/routes/review.ts` 加（事务模式同 Task 2）：

```ts
  app.post("/blocks/:id/split", async (c) => {
    let body: { line_index?: number };
    try { body = await c.req.json(); } catch { return c.json({ error: "请求体不是合法 JSON" }, 400); }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [blk] } = await client.query(
        "SELECT id::text, page_id::text, bbox, content_md, ordinal, block_type FROM blocks WHERE id=$1",
        [c.req.param("id")]);
      if (!blk) { await client.query("ROLLBACK"); return c.json({ error: "块不存在" }, 404); }
      const lines = (blk.content_md ?? "").split("\n");
      const k = body.line_index ?? 0;
      if (k < 1 || k > lines.length - 1) {
        await client.query("ROLLBACK");
        return c.json({ error: `line_index 须在 1..${lines.length - 1}` }, 422);
      }
      const [x0, y0, x1, y1] = blk.bbox;
      // 行比例近似切 bbox：UI 不掌握行级 y 坐标（spec §6.2 的可用近似）
      const ySplit = Math.round(y0 + (y1 - y0) * k / lines.length);
      const idB = crypto.randomUUID(), idC = crypto.randomUUID();
      await client.query(
        "UPDATE blocks SET ordinal=ordinal+1 WHERE page_id=$1 AND ordinal>$2",
        [blk.page_id, blk.ordinal]);
      const insertHalf = (id: string, content: string, bbox: number[], ordinal: number) =>
        client.query(
          `INSERT INTO blocks (id, page_id, block_type, bbox, crop_path, content_md, ordinal, origin, parent_block_ids)
           SELECT $1, page_id, block_type, $2, crop_path, $3, $4, 'split', ARRAY[$5::uuid]
           FROM blocks WHERE id=$5`,
          [id, JSON.stringify(bbox), content, ordinal, blk.id]);
      await insertHalf(idB, lines.slice(0, k).join("\n"), [x0, y0, x1, ySplit], blk.ordinal);
      await insertHalf(idC, lines.slice(k).join("\n"), [x0, ySplit, x1, y1], blk.ordinal + 1);
      // item_blocks：按 item 文本落在哪一半重定向（锁定决策 7）
      const { rows: links } = await client.query(
        `SELECT ib.item_id::text, ib.role, i.content_md FROM item_blocks ib
         JOIN items i ON i.id=ib.item_id WHERE ib.block_id=$1`, [blk.id]);
      const norm = (s: string) => s.replace(/\s+/g, "");
      const halfB = norm(lines.slice(0, k).join("")), halfC = norm(lines.slice(k).join(""));
      for (const l of links) {
        const t = norm(l.content_md ?? "");
        const inB = t.length > 0 && halfB.includes(t);
        const inC = t.length > 0 && halfC.includes(t);
        const targets = inB && !inC ? [idB] : inC && !inB ? [idC] : [idB, idC];  // 都沾/都不沾→两半都挂
        await client.query("DELETE FROM item_blocks WHERE item_id=$1 AND block_id=$2 AND role=$3",
          [l.item_id, blk.id, l.role]);
        for (const t2 of targets) {
          await client.query(
            "INSERT INTO item_blocks (item_id, block_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
            [l.item_id, t2, l.role]);
        }
      }
      await client.query(
        `UPDATE chunks SET source_block_ids = (
           SELECT array_agg(DISTINCT x) FROM unnest(
             array_remove(source_block_ids, $1::uuid) || $2::uuid || $3::uuid) x),
           state='stale'
         WHERE source_block_ids && ARRAY[$1::uuid]`, [blk.id, idB, idC]);
      await client.query("DELETE FROM blocks WHERE id=$1", [blk.id]);
      await client.query(
        "UPDATE pages SET index_status='stale', index_error=NULL WHERE id=$1", [blk.page_id]);
      await client.query(
        `INSERT INTO pipeline_events (document_id, page_id, stage, event_type, actor, summary, payload, status)
         SELECT p.document_id, p.id, 'user_edit', 'block_split', 'user', $2, $3, 'ok'
         FROM pages p WHERE p.id=$1`,
        [blk.page_id, `拆分块 ${blk.id.slice(0, 8)} 于第 ${k} 行后`,
         JSON.stringify({ from: blk.id, into: [idB, idC], line_index: k })]);
      await client.query("COMMIT");
      for (const id of [idB, idC]) {
        fetch(`${deps.pipelineUrl}/internal/block-recrop`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ block_id: id }),
        }).catch(err => console.warn("拆分批重裁失败（可忽略，裁图滞后）", err));
      }
      return c.json({ ids: [idB, idC] });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return invalidId(c, err) ?? (() => { throw err; })();
    } finally {
      client.release();
    }
  });
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && npm test -- review.test
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/review.test.ts
git commit -m "feat(backend): 按行拆分块——两半继承文本与比例 bbox，item/chunk 重定向，不触发 OCR"
```

---

### Task 4: 删除块 `DELETE /api/review/blocks/:id`（带复核保护）

**Files:**
- Modify: `backend/src/routes/review.ts`
- Test: `backend/src/routes/review.test.ts`

行为（§6.4 删除行 + 验收 13）：有 review_queue 记录的块 → 409 不删（沿用 layout.py:172-179 的保护口径）；否则事务内：item_blocks 解绑并把受影响 items 置 `qc_status='needs_review'`（锁定决策 6）→ chunks 摘掉该 block id 标 stale → 删块 → 页标 stale → 事件。

- [ ] **Step 1: 写失败测试**

```ts
  it("DELETE /blocks/:id：有 review_queue 记录的块 → 409 不删（验收 13）", async () => {
    // block12 在 beforeAll 已挂 review_queue 行
    const resp = await app.request(`/api/review/blocks/${block12}`, { method: "DELETE" });
    expect(resp.status).toBe(409);
    const still = await pool.query("SELECT count(*) FROM blocks WHERE id=$1", [block12]);
    expect(Number(still.rows[0].count)).toBe(1);
  });

  it("DELETE /blocks/:id：无保护块——item 解绑置 needs_review，chunk 摘引用标 stale", async () => {
    const bD = (await pool.query(
      `INSERT INTO blocks (page_id, block_type, bbox, crop_path, content_md, ordinal)
       VALUES ($1,'text','[0,0,1,1]',$2,'待删',20) RETURNING id::text`,
      [page1, join(docId, "blocks", "d.png")])).rows[0].id as string;
    const item = (await pool.query(
      `INSERT INTO items (document_id, content_type, content_md, qc_status)
       VALUES ($1,'exercise','题','approved') RETURNING id::text`, [docId])).rows[0].id as string;
    await pool.query("INSERT INTO item_blocks (item_id, block_id, role) VALUES ($1,$2,'stem')", [item, bD]);
    const vec = `[${"1,".repeat(1023)}1]`;
    await pool.query(
      `INSERT INTO chunks (item_id, content_md, embedding, source_block_ids)
       VALUES ($1,'题',$2::vector, ARRAY[$3::uuid])`, [item, vec, bD]);

    const resp = await app.request(`/api/review/blocks/${bD}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    expect(Number((await pool.query("SELECT count(*) FROM blocks WHERE id=$1", [bD])).rows[0].count)).toBe(0);
    expect(Number((await pool.query("SELECT count(*) FROM item_blocks WHERE block_id=$1", [bD])).rows[0].count)).toBe(0);
    expect((await pool.query("SELECT qc_status FROM items WHERE id=$1", [item])).rows[0].qc_status)
      .toBe("needs_review");
    const ck = (await pool.query("SELECT source_block_ids, state FROM chunks WHERE item_id=$1", [item])).rows[0];
    expect(ck.source_block_ids).toEqual([]);
    expect(ck.state).toBe("stale");
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && npm test -- review.test
```

预期：FAIL，404。

- [ ] **Step 3: 实现**

```ts
  app.delete("/blocks/:id", async (c) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [blk] } = await client.query(
        "SELECT id::text, page_id::text FROM blocks WHERE id=$1", [c.req.param("id")]);
      if (!blk) { await client.query("ROLLBACK"); return c.json({ error: "块不存在" }, 404); }
      // 与 layout.py force 删除同口径：有复核记录的块不清（人工痕迹不丢）
      const { rows: [guard] } = await client.query(
        "SELECT count(*)::int AS n FROM review_queue WHERE block_id=$1", [blk.id]);
      if (guard.n > 0) {
        await client.query("ROLLBACK");
        return c.json({ error: "该块有复核记录，先处理复核行再删" }, 409);
      }
      await client.query(
        `UPDATE items SET qc_status='needs_review', updated_at=now()
         WHERE id IN (SELECT item_id FROM item_blocks WHERE block_id=$1)`, [blk.id]);
      await client.query("DELETE FROM item_blocks WHERE block_id=$1", [blk.id]);
      await client.query(
        `UPDATE chunks SET source_block_ids=array_remove(source_block_ids, $1::uuid), state='stale'
         WHERE source_block_ids && ARRAY[$1::uuid]`, [blk.id]);
      await client.query("DELETE FROM blocks WHERE id=$1", [blk.id]);
      await client.query(
        "UPDATE pages SET index_status='stale', index_error=NULL WHERE id=$1", [blk.page_id]);
      await client.query(
        `INSERT INTO pipeline_events (document_id, page_id, stage, event_type, actor, summary, payload, status)
         SELECT p.document_id, p.id, 'user_edit', 'block_delete', 'user', $2, $3, 'ok'
         FROM pages p WHERE p.id=$1`,
        [blk.page_id, `删除块 ${blk.id.slice(0, 8)}`, JSON.stringify({ block_id: blk.id })]);
      await client.query("COMMIT");
      return c.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      return invalidId(c, err) ?? (() => { throw err; })();
    } finally {
      client.release();
    }
  });
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && npm test -- review.test
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/review.test.ts
git commit -m "feat(backend): 删除块接口——review_queue 保护 409，item 置 needs_review，chunk 摘引用标 stale"
```

---

### Task 5: pipeline 调框端点——preview（重裁+重识别，不落库）+ commit + recrop

**Files:**
- Create: `pipeline/kb/ocr/block_edit.py`
- Modify: `pipeline/kb/internal_api.py`
- Test: `pipeline/tests/test_block_edit.py`

三个函数一个模块：

- `recrop_block(conn, cfg, block_id) -> dict`：按当前 bbox + 邻居（同页 ordinal 相邻）重裁覆盖原 crop 文件，更新 `crop_pad`。供合并/拆分后刷新裁图（Task 2/3 的 best-effort 调用）。
- `preview_block_geometry(conn, cfg, block_id, bbox, client=None, ocr=None) -> dict`：页图像素 bbox → 邻居 clamp + padding → 裁到 staging（`blocks/<page_id>/staging_<uuid>.png`）→ 按块类型识别（`_OCRABLE_TYPES` 走 rapidocr，`starred_math` 命中升级 VLM；其余 VLM——与 parse.py 同规则）→ 返回 `{text, source_model, crop_pad, staging}`，**不写 blocks 表**。
- `commit_block_geometry(conn, cfg, block_id, bbox, staging, adopted_text, source_model) -> dict`：staging 覆盖原 crop → `UPDATE blocks SET bbox, crop_pad, content_md, source_model, geometry_revision=geometry_revision+1`（bbox 存**用户调的原始值**，padding 只作用于裁图）→ chunks 标 stale → 页标 stale → pipeline_events（stage='user_edit', event_type='block_geometry'）。

internal_api 三个端点：`POST /internal/block-recrop {block_id}`、`POST /internal/block-geometry-preview {block_id, bbox}`、`POST /internal/block-geometry-commit {block_id, bbox, staging, adopted_text, source_model}`。

- [ ] **Step 1: 写失败测试**

新建 `pipeline/tests/test_block_edit.py`（fixture 参照 test_reprocess.py 的 `doc3`：A4@200dpi 页；页图用 render_document 真渲染）：

```python
"""调框 preview/commit 与 recrop（验收 11 的 pipeline 侧）。"""
import uuid

import pymupdf as fitz
import pytest

from kb.core.config import Config


@pytest.fixture()
def doc1(conn, tmp_path):
    cfg = Config(
        database_url="postgresql://localhost/kb_test",
        storage_dir=tmp_path / "storage",
        vision_base_url="http://localhost:11434/v1",
        vision_api_key="ollama",
        vision_model="qwen3:4b",
    )
    p = tmp_path / "a.pdf"
    d = fitz.open()
    d.new_page()  # A4
    d.save(p)
    from kb.ocr.render import render_document
    doc_id = render_document(conn, cfg, p, title="t")
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM pages WHERE document_id=%s", (doc_id,))
        page_id = cur.fetchone()[0]
        out_dir = cfg.storage_dir / doc_id / "blocks" / page_id
        out_dir.mkdir(parents=True, exist_ok=True)
        for i, (bbox, text) in enumerate(
                [([100, 100, 500, 200], "上文"), ([100, 300, 500, 400], "中文")], start=1):
            crop = out_dir / f"b{i - 1:03d}.png"
            crop.write_bytes(b"png")
            cur.execute(
                """INSERT INTO blocks (id, page_id, block_type, bbox, crop_path, content_md, ordinal)
                   VALUES (%s,%s,'text',%s,%s,%s,%s)""",
                (str(uuid.uuid4()), page_id, str(bbox), f"{doc_id}/blocks/{page_id}/b{i - 1:03d}.png",
                 text, i),
            )
    return doc_id, cfg


def test_preview_crops_staging_and_recognizes_without_writing(doc1, conn):
    """preview：staging 裁图 + OCR 文本返回，blocks 表不动。"""
    from kb.ocr.block_edit import preview_block_geometry

    doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text, content_md FROM blocks ORDER BY ordinal LIMIT 1")
        block_id, old_text = cur.fetchone()
    out = preview_block_geometry(conn, cfg, block_id, [90, 95, 510, 210],
                                 ocr=lambda _p: "新识别文本")
    assert out["text"] == "新识别文本"
    assert out["source_model"] == "rapidocr"
    assert out["crop_pad"] == [6, 4]  # text 档，A4@200dpi
    staging = cfg.storage_dir / out["staging"]
    assert staging.exists() and "staging_" in staging.name
    pix = fitz.Pixmap(str(staging))
    assert (pix.width, pix.height) == (432, 123)  # 420+2*6, 115+4+4
    with conn.cursor() as cur:
        cur.execute("SELECT content_md, geometry_revision FROM blocks WHERE id=%s", (block_id,))
        assert cur.fetchone() == (old_text, 1)  # 未落库


def test_commit_applies_geometry_and_marks_stale(doc1, conn):
    """commit：bbox/crop_pad/内容落库，geometry_revision+1，chunks 标 stale（验收 11）。"""
    from kb.ocr.block_edit import commit_block_geometry, preview_block_geometry

    doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM blocks ORDER BY ordinal LIMIT 1")
        (block_id,) = cur.fetchone()
        cur.execute(
            "INSERT INTO items (document_id, content_type, content_md) VALUES (%s,'exercise','题') RETURNING id::text",
            (doc_id,),
        )
        (item_id,) = cur.fetchone()
        cur.execute(
            "INSERT INTO chunks (item_id, content_md, embedding, source_block_ids)"
            " VALUES (%s,'题',%s,ARRAY[%s::uuid])",
            (item_id, [1.0] * 1024, block_id),
        )
    prev = preview_block_geometry(conn, cfg, block_id, [90, 95, 510, 210],
                                  ocr=lambda _p: "新识别文本")
    out = commit_block_geometry(conn, cfg, block_id, [90, 95, 510, 210],
                                prev["staging"], "新识别文本", "rapidocr")
    assert out["ok"] is True
    with conn.cursor() as cur:
        cur.execute(
            "SELECT bbox, crop_pad, content_md, geometry_revision FROM blocks WHERE id=%s",
            (block_id,))
        bbox, crop_pad, content_md, rev = cur.fetchone()
        assert bbox == [90, 95, 510, 210]  # 存用户调的原始值
        assert crop_pad == [6, 4]
        assert content_md == "新识别文本"
        assert rev == 2
        cur.execute("SELECT state FROM chunks WHERE item_id=%s", (item_id,))
        assert cur.fetchone()[0] == "stale"
        cur.execute(
            "SELECT 1 FROM pipeline_events WHERE stage='user_edit' AND event_type='block_geometry'")
        assert cur.fetchone() is not None
    assert not (cfg.storage_dir / prev["staging"]).exists()  # staging 已消费


def test_recrop_uses_neighbor_clamp(doc1, conn):
    """recrop：邻居 gap=100 → 不夹；gap 小的情形在 pad.py 单测已覆盖，这里验证落库 crop_pad。"""
    from kb.ocr.block_edit import recrop_block

    doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM blocks ORDER BY ordinal LIMIT 1")
        (block_id,) = cur.fetchone()
    out = recrop_block(conn, cfg, block_id)
    assert out["crop_pad"] == [6, 4]  # 下邻 gap=100 → bottom=min(4,50)=4
    with conn.cursor() as cur:
        cur.execute("SELECT crop_pad FROM blocks WHERE id=%s", (block_id,))
        assert cur.fetchone()[0] == [6, 4]
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_block_edit.py -v
```

预期：FAIL，`ModuleNotFoundError: kb.ocr.block_edit`。

- [ ] **Step 3: 实现 `block_edit.py`**

新建 `pipeline/kb/ocr/block_edit.py`：

```python
"""块几何编辑：调框 preview/commit 与合并/拆分后重裁（spec §6.3）。

preview 不落库（新旧文本 diff 由用户确认）；commit 才写 blocks 并标 stale。
bbox 一律页图像素、存用户/检测原始值；padding 只在裁图时加（pad.py）。
"""
from __future__ import annotations

import uuid
from pathlib import Path

from psycopg.types.json import Jsonb

from kb.core.paths import resolve_storage_path, storage_rel
from kb.ocr.layout import crop_image
from kb.ocr.pad import padded_px_bbox
from kb.ocr.parse import ocr_image, starred_math, transcribe_image

_OCRABLE_TYPES = {"text", "title", "header", "footer"}  # 与 parse.run_parse 同口径


def _page_and_neighbors(cur, block_id: str):
    """取块所在页图（绝对路径）与同页全部块（ordinal 序）。"""
    cur.execute(
        """SELECT b.page_id::text, p.image_path, p.document_id::text
           FROM blocks b JOIN pages p ON p.id=b.page_id WHERE b.id=%s""",
        (block_id,))
    row = cur.fetchone()
    if not row:
        raise KeyError(f"块不存在: {block_id}")
    page_id, image_path, doc_id = row
    cur.execute(
        "SELECT id::text, bbox, ordinal, block_type FROM blocks WHERE page_id=%s ORDER BY ordinal",
        (page_id,))
    return page_id, image_path, doc_id, cur.fetchall()


def _neighbors_of(blocks, block_id: str | None, ordinal_hint: int | None):
    """同页 ordinal 序中与目标相邻的前/后块 bbox（目标自身排除）。"""
    boxes = [(b[0], b[1], b[2]) for b in blocks if b[0] != block_id]
    prev = next_ = None
    for i, (_id, bbox, _ord) in enumerate(boxes):
        if ordinal_hint is not None and _ord < ordinal_hint:
            prev = bbox
        elif ordinal_hint is not None and _ord > ordinal_hint and next_ is None:
            next_ = bbox
    return prev, next_


def _recognize(cfg, block_type: str, crop_path: Path, client, ocr):
    """与 parse.run_parse 同规则：文本类 rapidocr（竖式星号升级 VLM），其余 VLM。"""
    ocr = ocr or ocr_image
    if block_type in _OCRABLE_TYPES:
        text = ocr(str(crop_path))
        if starred_math(text):
            text, _usage = transcribe_image(client, cfg.vision_model, str(crop_path))
            return text, cfg.vision_model
        return text, "rapidocr"
    text, _usage = transcribe_image(client, cfg.vision_model, str(crop_path))
    return text, cfg.vision_model


def preview_block_geometry(conn, cfg, block_id: str, bbox: list[float],
                           client=None, ocr=None) -> dict:
    """重裁 + 重识别到 staging，不写 blocks 表。返回 {text, source_model, crop_pad, staging}。"""
    import pymupdf as fitz

    with conn.cursor() as cur:
        page_id, image_path, doc_id, blocks = _page_and_neighbors(cur, block_id)
        cur.execute("SELECT block_type, ordinal FROM blocks WHERE id=%s", (block_id,))
        block_type, ordinal = cur.fetchone()
    abs_img = resolve_storage_path(cfg, image_path)
    pix = fitz.Pixmap(str(abs_img))
    page_size = (pix.width, pix.height)
    del pix
    prev_bbox, next_bbox = _neighbors_of(blocks, block_id, ordinal)
    padded, pad = padded_px_bbox(tuple(bbox), block_type, cfg.dpi, page_size,
                                 prev_bbox=prev_bbox, next_bbox=next_bbox)
    staging = Path(cfg.storage_dir) / doc_id / "blocks" / page_id / f"staging_{uuid.uuid4().hex[:8]}.png"
    staging.parent.mkdir(parents=True, exist_ok=True)
    crop_image(str(abs_img), padded, staging)
    text, source = _recognize(cfg, block_type, staging, client, ocr)
    return {"text": text, "source_model": source, "crop_pad": pad,
            "staging": storage_rel(cfg, staging)}


def commit_block_geometry(conn, cfg, block_id: str, bbox: list[float], staging: str,
                          adopted_text: str, source_model: str) -> dict:
    """staging 覆盖原 crop，bbox/crop_pad/内容落库，geometry_revision+1，chunks 标 stale。"""
    import shutil

    import pymupdf as fitz

    staging_abs = resolve_storage_path(cfg, staging)
    with conn.cursor() as cur:
        page_id, image_path, doc_id, blocks = _page_and_neighbors(cur, block_id)
        cur.execute("SELECT block_type, ordinal, crop_path FROM blocks WHERE id=%s", (block_id,))
        block_type, ordinal, crop_path = cur.fetchone()
    # crop_pad 重算（不信 preview 传入，保持确定性）
    pix = fitz.Pixmap(str(resolve_storage_path(cfg, image_path)))
    page_size = (pix.width, pix.height)
    del pix
    prev_bbox, next_bbox = _neighbors_of(blocks, block_id, ordinal)
    _padded, pad = padded_px_bbox(tuple(bbox), block_type, cfg.dpi, page_size,
                                  prev_bbox=prev_bbox, next_bbox=next_bbox)
    shutil.move(str(staging_abs), str(resolve_storage_path(cfg, crop_path)))
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            """UPDATE blocks SET bbox=%s, crop_pad=%s, content_md=%s, source_model=%s,
                   geometry_revision=geometry_revision+1
               WHERE id=%s""",
            (Jsonb([float(v) for v in bbox]), Jsonb(pad), adopted_text, source_model, block_id))
        cur.execute(
            "UPDATE chunks SET state='stale' WHERE source_block_ids && ARRAY[%s::uuid]",
            (block_id,))
        cur.execute(
            "UPDATE pages SET index_status='stale', index_error=NULL WHERE id=%s", (page_id,))
        cur.execute(
            """INSERT INTO pipeline_events (document_id, page_id, stage, event_type, actor,
                                            summary, payload, status)
               VALUES (%s,%s,'user_edit','block_geometry','user',%s,%s,'ok')""",
            (doc_id, page_id, f"调框 {block_id[:8]} → rev+1",
             Jsonb({"block_id": block_id, "bbox": bbox, "crop_pad": pad})))
    return {"ok": True, "crop_pad": pad}


def recrop_block(conn, cfg, block_id: str) -> dict:
    """按当前 bbox + 邻居 clamp 重裁覆盖原 crop，更新 crop_pad。不调模型。"""
    with conn.cursor() as cur:
        page_id, image_path, _doc_id, blocks = _page_and_neighbors(cur, block_id)
        cur.execute("SELECT bbox, block_type, ordinal, crop_path FROM blocks WHERE id=%s",
                    (block_id,))
        bbox, block_type, ordinal, crop_path = cur.fetchone()
    abs_img = resolve_storage_path(cfg, image_path)
    import pymupdf as fitz
    pix = fitz.Pixmap(str(abs_img))
    page_size = (pix.width, pix.height)
    del pix
    prev_bbox, next_bbox = _neighbors_of(blocks, block_id, ordinal)
    padded, pad = padded_px_bbox(tuple(bbox), block_type, cfg.dpi, page_size,
                                 prev_bbox=prev_bbox, next_bbox=next_bbox)
    crop_image(str(abs_img), padded, str(resolve_storage_path(cfg, crop_path)))
    with conn.cursor() as cur:
        cur.execute("UPDATE blocks SET crop_pad=%s WHERE id=%s", (Jsonb(pad), block_id))
    return {"ok": True, "crop_pad": pad}
```

`pipeline/kb/internal_api.py` 加三个端点（照现有端点的注入/错误处理模式）：

```python
    @app.post("/internal/block-recrop")
    def block_recrop():
        body = request.get_json(force=True)  # 按本文件实际的框架写法对齐
        with get_conn() as conn:
            return jsonify(recrop_block(conn, cfg, body["block_id"]))

    @app.post("/internal/block-geometry-preview")
    def block_geometry_preview():
        body = request.get_json(force=True)
        with get_conn() as conn:
            return jsonify(preview_block_geometry(
                conn, cfg, body["block_id"], body["bbox"], client=vlm_client))

    @app.post("/internal/block-geometry-commit")
    def block_geometry_commit():
        body = request.get_json(force=True)
        with get_conn() as conn:
            return jsonify(commit_block_geometry(
                conn, cfg, body["block_id"], body["bbox"], body["staging"],
                body["adopted_text"], body["source_model"]))
```

注意：internal_api.py 的实际框架/参数注入以该文件现状为准（先读再写，上面是语义骨架）；`KeyError`（块不存在）→ 404。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_block_edit.py tests/test_internal_api.py -v
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/ocr/block_edit.py pipeline/kb/internal_api.py pipeline/tests/test_block_edit.py
git commit -m "feat(pipeline): 块几何编辑端点——调框 preview/commit + recrop（padding 重裁 + 分级识别）"
```

---

### Task 6: pipeline 补画端点 + backend 三个转发

**Files:**
- Modify: `pipeline/kb/ocr/block_edit.py`（加 `create_block`）
- Modify: `pipeline/kb/internal_api.py`
- Modify: `backend/src/routes/review.ts`
- Test: `pipeline/tests/test_block_edit.py`、`backend/src/routes/review.test.ts`

`create_block(conn, cfg, page_id, bbox, block_type, client=None, ocr=None)`（验收 12）：bbox clamp 到页内 → 邻居按「插入位置」定（新块 y0 落在的 ordinal 位置）→ padding 裁图到 `blocks/<page_id>/b-<new_id>.png` → 识别 → ordinal 插入移位（`UPDATE blocks SET ordinal=ordinal+1 WHERE page_id AND ordinal>=k`）→ INSERT origin='manual' → 事件（event_type='block_create'）→ 返回新块。

backend 用现有 `forwardInternal` 加三条转发：`POST /api/review/blocks/:id/geometry-preview`、`POST /api/review/blocks/:id/geometry-commit`、`POST /api/review/pages/:id/blocks`（补画）。

- [ ] **Step 1: 写失败测试**

`pipeline/tests/test_block_edit.py` 追加：

```python
def test_create_block_manual_origin_and_ordinal(doc1, conn):
    """补画：origin='manual'，ordinal 按 y 落位并移位，OCR 结果入库（验收 12 pipeline 侧）。"""
    from kb.ocr.block_edit import create_block

    doc_id, cfg = doc1
    with conn.cursor() as cur:
        cur.execute("SELECT id::text FROM pages WHERE document_id=%s", (doc_id,))
        (page_id,) = cur.fetchone()
    out = create_block(conn, cfg, page_id, [100, 220, 500, 280], "text",
                       ocr=lambda _p: "补画内容")
    assert out["block"]["origin"] == "manual"
    assert out["block"]["content_md"] == "补画内容"
    assert out["block"]["ordinal"] == 2  # 落在 b000(ordinal=1, y1=200) 之后、b001(ordinal=2, y0=300) 之前
    with conn.cursor() as cur:
        cur.execute("SELECT id::text, ordinal FROM blocks WHERE page_id=%s ORDER BY ordinal", (page_id,))
        rows = cur.fetchall()
    assert [r[1] for r in rows] == [1, 2, 3]  # 原 b001 被移位到 3
    cur_path = out["block"]["crop_path"]
    assert (cfg.storage_dir / cur_path).exists()
    assert f"/blocks/{page_id}/b-" in cur_path
```

`backend/src/routes/review.test.ts` 追加（fetch stub 模式照抄现有 :368-414 按 URL 分流）：

```ts
  it("POST /pages/:id/blocks：转发 pipeline 补画端点（验收 12 backend 侧）", async () => {
    const { vi } = await import("vitest");
    const fakeBlock = { id: "new-b", origin: "manual", content_md: "补画内容", ordinal: 2 };
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "http://pipeline.test/internal/block-create") {
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({ page_id: page1, bbox: [1, 2, 3, 4], block_type: "text" });
        return new Response(JSON.stringify({ block: fakeBlock }),
          { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("no route", { status: 404 });
    });
    try {
      const resp = await app.request(`/api/review/pages/${page1}/blocks`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox: [1, 2, 3, 4], block_type: "text" }),
      });
      expect(resp.status).toBe(200);
      expect((await resp.json()).block.origin).toBe("manual");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("geometry preview/commit 转发：pipeline 不可达 → 502", async () => {
    const { vi } = await import("vitest");
    vi.stubGlobal("fetch", async () => { throw new Error("ECONNREFUSED"); });
    try {
      const resp = await app.request(`/api/review/blocks/${block11}/geometry-preview`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox: [0, 0, 10, 10] }),
      });
      expect(resp.status).toBe(502);
    } finally {
      vi.unstubAllGlobals();
    }
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd pipeline && uv run pytest tests/test_block_edit.py -v
cd backend && npm test -- review.test
```

预期：FAIL（`create_block` 不存在；backend 404）。

- [ ] **Step 3: 实现**

`pipeline/kb/ocr/block_edit.py` 追加：

```python
def create_block(conn, cfg, page_id: str, bbox: list[float], block_type: str = "text",
                 client=None, ocr=None) -> dict:
    """人工补画块：clamp 页内 → padding 裁图 → 识别 → ordinal 按 y 落位 → origin='manual'。"""
    import pymupdf as fitz

    if block_type not in ("text", "title", "formula", "figure", "table", "header", "footer"):
        raise ValueError(f"非法 block_type: {block_type}")
    with conn.cursor() as cur:
        cur.execute(
            "SELECT image_path, document_id::text FROM pages WHERE id=%s", (page_id,))
        row = cur.fetchone()
        if not row:
            raise KeyError(f"页不存在: {page_id}")
        image_path, doc_id = row
        cur.execute(
            "SELECT id::text, bbox, ordinal FROM blocks WHERE page_id=%s ORDER BY ordinal",
            (page_id,))
        blocks = cur.fetchall()
    abs_img = resolve_storage_path(cfg, image_path)
    pix = fitz.Pixmap(str(abs_img))
    page_size = (pix.width, pix.height)
    del pix
    x0 = max(0.0, min(float(bbox[0]), page_size[0]))
    y0 = max(0.0, min(float(bbox[1]), page_size[1]))
    x1 = max(0.0, min(float(bbox[2]), page_size[0]))
    y1 = max(0.0, min(float(bbox[3]), page_size[1]))
    if x1 - x0 < 2 or y1 - y0 < 2:
        raise ValueError("框太小（<2px），不是有效块")
    # 落位：按 y0 插入到 ordinal 序列；新块的邻居用于 padding clamp
    k = 1 + sum(1 for _id, bb, _o in blocks if bb and float(bb[1]) < y0)
    prev_bbox = next((bb for _id, bb, o in reversed(blocks) if o < k and bb), None)
    next_bbox = next((bb for _id, bb, o in blocks if o >= k and bb), None)
    padded, pad = padded_px_bbox((x0, y0, x1, y1), block_type, cfg.dpi, page_size,
                                 prev_bbox=prev_bbox, next_bbox=next_bbox)
    new_id = str(uuid.uuid4())
    crop = Path(cfg.storage_dir) / doc_id / "blocks" / page_id / f"b-{new_id}.png"
    crop.parent.mkdir(parents=True, exist_ok=True)
    crop_image(str(abs_img), padded, crop)
    text, source = _recognize(cfg, block_type, crop, client, ocr)
    with conn.transaction(), conn.cursor() as cur:
        cur.execute(
            "UPDATE blocks SET ordinal=ordinal+1 WHERE page_id=%s AND ordinal>=%s",
            (page_id, k))
        cur.execute(
            """INSERT INTO blocks (id, page_id, block_type, bbox, crop_path, content_md,
                                   source_model, ordinal, origin)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'manual')""",
            (new_id, page_id, block_type, Jsonb([x0, y0, x1, y1]),
             storage_rel(cfg, crop), text, source, k))
        cur.execute(
            "UPDATE pages SET index_status='stale', index_error=NULL WHERE id=%s", (page_id,))
        cur.execute(
            """INSERT INTO pipeline_events (document_id, page_id, stage, event_type, actor,
                                            summary, payload, status)
               VALUES (%s,%s,'user_edit','block_create','user',%s,%s,'ok')""",
            (doc_id, page_id, f"补画块 {new_id[:8]}",
             Jsonb({"block_id": new_id, "bbox": [x0, y0, x1, y1], "block_type": block_type})))
    return {"block": {"id": new_id, "origin": "manual", "content_md": text,
                      "ordinal": k, "crop_path": storage_rel(cfg, crop), "crop_pad": pad}}
```

internal_api 加 `POST /internal/block-create`（body `{page_id, bbox, block_type?}`）。

backend `review.ts` 加三条转发（用现有 `forwardInternal(deps, c, path, body)` 模式，先读该函数签名再写）：

```ts
  app.post("/blocks/:id/geometry-preview", (c) =>
    forwardInternal(deps, c, "/internal/block-geometry-preview",
      { block_id: c.req.param("id"), ...(await c.req.json()) }));
```

`forwardInternal` 若不是 async 透传形态，按现状适配；pages 补画：

```ts
  app.post("/pages/:id/blocks", (c) =>
    forwardInternal(deps, c, "/internal/block-create",
      { page_id: c.req.param("id"), ...(await c.req.json()) }));
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd pipeline && uv run pytest tests/test_block_edit.py tests/test_internal_api.py -v
cd backend && npm test
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add pipeline/kb/ocr/block_edit.py pipeline/kb/internal_api.py pipeline/tests/test_block_edit.py backend/src/routes/review.ts backend/src/routes/review.test.ts
git commit -m "feat: 补画块端点（origin=manual + ordinal 落位）与 backend 三条几何转发"
```

---

### Task 7: backend 页详情暴露血缘字段 + 前端 API 客户端

**Files:**
- Modify: `backend/src/routes/review.ts`（GET /pages/:id 的 blocks 查询，约 :66-130）
- Modify: `frontend/src/api/review.ts`
- Test: `backend/src/routes/review.test.ts`

- [ ] **Step 1: 写失败测试**

review.test.ts 的页详情用例里补断言（找到现有 `GET /pages/:id` 用例）：

```ts
    expect(blocks[0].origin).toBe("layout");
    expect(blocks[0]).toHaveProperty("geometry_revision");
    expect(blocks[0]).toHaveProperty("crop_pad");
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd backend && npm test -- review.test
```

预期：FAIL（`origin` undefined）。

- [ ] **Step 3: 实现**

GET /pages/:id 的 blocks SELECT 列表加 `origin, geometry_revision, crop_pad`（原样透传 JSONB）。

`frontend/src/api/review.ts` 加（类型与 fetch 风格照现有函数，如 `updateReviewBlock` :121）：

```ts
export interface BlockGeometryPreview {
  text: string;
  source_model: string;
  crop_pad: [number, number];
  staging: string;
}

export async function mergeBlocks(ids: string[]): Promise<{ id: string }> { /* POST /blocks/merge */ }
export async function splitBlock(id: string, lineIndex: number): Promise<{ ids: string[] }> { /* POST /blocks/:id/split */ }
export async function deleteBlock(id: string): Promise<void> { /* DELETE /blocks/:id，409 抛错带 message */ }
export async function previewBlockGeometry(id: string, bbox: number[]): Promise<BlockGeometryPreview> { /* POST geometry-preview */ }
export async function commitBlockGeometry(id: string, bbox: number[], staging: string, adoptedText: string, sourceModel: string): Promise<void> { /* POST geometry-commit */ }
export async function createBlock(pageId: string, bbox: number[], blockType: string): Promise<{ block: ReviewBlock }> { /* POST /pages/:id/blocks */ }
```

（每个函数体照文件内现有模式写全，错误统一 `throw new Error(await resp.text())` 或该文件既有约定；`ReviewBlock` 类型加 `origin / geometry_revision / crop_pad` 可选字段。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd backend && npm test -- review.test
cd frontend && npx tsc --noEmit
```

预期：PASS / 无类型错误。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/review.ts backend/src/routes/review.test.ts frontend/src/api/review.ts
git commit -m "feat: 页详情暴露块血缘字段 + 前端块编辑 API 客户端"
```

---

### Task 8: 前端——框色语义 + 多选合并 + 文本点拆

**Files:**
- Modify: `frontend/src/components/PageDetail.tsx`
- Modify: `frontend/src/theme.css`
- Modify: `frontend/src/api/review.ts`（类型，Task 7 已含）
- Test: `frontend/src/components/PageDetail.test.tsx`

视觉/交互以 review-workbench.html `#scr-review` 为准：

- 框色（theme.css 现有 `.pd-image .bbox` / `.has-issue` / `.selected` 上扩展）：当前聚焦=主色蓝实框（`.bbox.focus`）；问题块=红框（`.bbox.has-issue`，已有）；人工已修改=琥珀（`.bbox.edited`，判定 `geometry_revision>1 || origin!=='layout'`）；补画块=紫色虚线（`.bbox.manual`，`border:2px dashed #7c3aed`，角标「补画」）；正常=细灰。页图下方加图例（照 HTML :329-335）。
- 多选：⌘/Ctrl+点击块卡或 bbox 切换选中（`.selected` 已有样式）；选中 ≥2 块时底部操作条「合并选中块」可用 → `mergeBlocks` → 刷新页数据。
- 文本点拆：块卡文本编辑态下，「拆分」按钮 → 取 textarea `selectionStart` 算行号（`content.slice(0, selectionStart).split("\n").length`）→ `splitBlock(id, lineIndex)` → 刷新。行号即光标所在行（切在该行之后）。UI 上提示「在文本里点选切分位置」。
- 快捷键（照 ReviewView.tsx:109-124 的守卫模式）：↑↓ 切换聚焦块；⌘↵ 通过本页（已有 approve 按钮逻辑复用）。

- [ ] **Step 1: 写失败测试**

`frontend/src/components/PageDetail.test.tsx` 追加（fetch 桩用 `src/test/support.ts` 的 `fetchRouter`）：

```tsx
it("⌘点击多选两块后合并：调 merge API 并刷新", async () => {
  // 桩 GET 页详情（两块）+ POST /blocks/merge 记录调用
  // 渲染 → 对两个块卡 fireEvent.click(..., { metaKey: true })
  // 点「合并选中块」→ 断言 merge 请求体 block_ids 含两块 id
});

it("文本框内光标在第 2 行点拆分：split API 收到 line_index=2", async () => {
  // 进入块编辑态 → textarea 设置 selectionStart 到第二行行尾 → 点「拆分块」
  // 断言 split 请求体 { line_index: 2 }
});

it("origin=manual 的块渲染紫色虚线框与「补画」角标；geometry_revision>1 的块带琥珀 edited 样式", async () => {
  // 桩数据给两个块分别 origin:'manual' 和 geometry_revision:2
  // 断言 .bbox.manual 与 .bbox.edited 存在
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd frontend && npx vitest run src/components/PageDetail.test.tsx
```

预期：FAIL。

- [ ] **Step 3: 实现**

按上述语义改 PageDetail.tsx + theme.css；结构/文案/样式值照 review-workbench.html `#scr-review`（框色 CSS :100-127、图例 :329-335、操作条 :340-352）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd frontend && npx vitest run src/components/PageDetail.test.tsx
```

预期：全 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PageDetail.tsx frontend/src/theme.css frontend/src/components/PageDetail.test.tsx
git commit -m "feat(frontend): 复核页框色语义（蓝/红/琥珀/紫虚线）+ 多选合并 + 文本点拆"
```

---

### Task 9: 前端——调框拖拽/键盘微调 + diff 弹窗 + 补画模式

**Files:**
- Modify: `frontend/src/components/PageDetail.tsx`
- Create: `frontend/src/components/BlockGeometryDiff.tsx`（diff 确认弹窗）
- Modify: `frontend/src/theme.css`
- Test: `frontend/src/components/PageDetail.test.tsx`、`frontend/src/components/BlockGeometryDiff.test.tsx`

交互（照 `#scr-blockfix` :772-828）：

- 调框：聚焦块的 bbox 进入编辑态后显示 8 控制点（4 角 + 4 边中点，6×6 白底蓝边方块）。拖拽换算回页图像素坐标（显示 px × `imgSize.w / 显示宽`）；拖到相邻块边界 4 显示 px 内吸附到该边界。键盘：方向键 ±1px（页图坐标）、Shift+方向键 ±10px（聚焦 bbox 编辑态时拦截，守卫同快捷键模式）。
- 松手/退出编辑态 → `previewBlockGeometry` → 显示「重裁 + 重识别中」→ 完成后弹 `BlockGeometryDiff`：左「原文本」右「新识别」（差异高亮：旧 `bg-danger-bg text-danger`、新 `#f0fdf4/#15803d`；行级 diff 用最简 LCS 或按行对比即可，不引依赖），按钮「采用新文本 / 保留原文本 / 手动改」（手动改 → 右侧变 textarea）。确认 → `commitBlockGeometry` → 刷新；取消 → staging 不管（临时文件，pipeline 侧定期清理即可，本期不做清理）。
- 补画：工具条「补画新框」进入模式（页图十字光标）→ 拖拽拉框 → 松手 → `createBlock` → 新块出现（紫虚线 + 角标）。Esc 退出模式。

- [ ] **Step 1: 写失败测试**

```tsx
// BlockGeometryDiff.test.tsx
it("差异高亮 + 三个操作按钮回调", async () => {
  // render old="上底 6 cm" new="上底 8 cm"
  // 断言两处差异节点存在；点「采用新文本」→ onConfirm(new)
  // 点「保留原文本」→ onConfirm(old)；「手动改」→ 出现 textarea
});

// PageDetail.test.tsx
it("键盘微调：方向键把聚焦 bbox 左移 1px，Shift+右移 10px", async () => {
  // 进入调框编辑态 → fireEvent.keyDown ArrowLeft / Shift+ArrowRight
  // 断言预览请求 bbox 的变化量
});

it("拖拽松手后调 preview，确认后调 commit 并刷新", async () => {
  // jsdom 无真实布局：直接 fireEvent.mouseDown/mouseUp 走流程
  // 桩 preview 返回 { text:'新', staging:'staging_x.png', ... }
  // diff 弹窗点「采用新文本」→ 断言 commit 请求体含 staging 与 adopted_text='新'
});

it("补画模式拖拽拉框 → createBlock 请求，Esc 退出模式", async () => { /* 同上模式 */ });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd frontend && npx vitest run src/components/PageDetail.test.tsx src/components/BlockGeometryDiff.test.tsx
```

预期：FAIL。

- [ ] **Step 3: 实现**

按上述语义实现；弹窗结构照 `MatchPicker.tsx:35-36` 的 `.dialog-mask` + `.dialog` 模式，样式入 theme.css（`:857-878` 附近扩展）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd frontend && npx vitest run
```

预期：全 PASS（含既有组件测试无回归）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PageDetail.tsx frontend/src/components/BlockGeometryDiff.tsx frontend/src/theme.css frontend/src/components/PageDetail.test.tsx frontend/src/components/BlockGeometryDiff.test.tsx
git commit -m "feat(frontend): 调框 8 控制点拖拽/键盘微调 + 新旧文本 diff 弹窗 + 补画模式"
```

---

### Task 10: e2e `block-editing.spec.ts` + 全量回归 + spec 收尾

**Files:**
- Create: `e2e/specs/block-editing.spec.ts`
- Modify: `docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md` §14

页图生成技巧：jsdom/fixture 的 1px PNG 不够用（要真裁图真 OCR）。用 Playwright 自己造：测试内 `page.set_content('<div style="font-size:48px">第一行文字<br>第二行文字<br>第三行文字</div>')` → `page.screenshot()` 存为页图 PNG（真实像素、rapidocr 可读），DB fixture 的 image_path 指过去，bbox 按截图实际尺寸给。

- [ ] **Step 1: 写 e2e 用例**

`e2e/specs/block-editing.spec.ts`（serial，种子/清理模式照 `materials-review.spec.ts`）：

1. **合并（验收 9 e2e 侧）**：UI 上 ⌘多选两块 → 合并 → 断言页图框变外接矩形（新 bbox）+ DB `origin='merged'`、`ordinal` 原位、item_blocks 重定向、chunks `state='stale'`。
2. **拆分（验收 10）**：块文本第 1 行后点拆分 → 断言两块的 content_md 与比例 bbox + `llm_calls` 计数不变（不触发 OCR）。
3. **删除保护（验收 13）**：给块挂 review_queue 行 → UI 删除 → 409 提示可见；取消保护后删除成功、item 置 needs_review。
4. **调框（验收 11）**：键盘微调 bbox → diff 弹窗出现（pipeline 真跑 rapidocr）→ 采用新文本 → DB `geometry_revision=2`、`crop_pad=[6,4]`（A4 比例页图按实际 DPI 换算断言，别硬编码）、chunks stale。
5. **补画（验收 12）**：补画模式拉框 → 新块出现，紫虚线 +「补画」角标可见，DB `origin='manual'`、内容非空。

- [ ] **Step 2: 跑 e2e**

```bash
cd e2e && npx playwright test specs/block-editing.spec.ts
```

预期：全 PASS。rapidocr 对 Playwright 截图的识别若不稳，把字体调大/留白调宽，不许用 `test.fixme` 糊过去。

- [ ] **Step 3: 三栈全量回归**

```bash
cd pipeline && uv run pytest tests/ -q
cd backend && npm test
cd frontend && npx vitest run
cd e2e && npm test
```

预期：全绿。

- [ ] **Step 4: spec §14 收尾**

子系统 3 行状态改「已完成」。

- [ ] **Step 5: Commit**

```bash
git add e2e/specs/block-editing.spec.ts docs/superpowers/specs/2026-09-08-exam-ingest-optimization-design.md
git commit -m "test(e2e): 分块修正四操作全链路用例（合并/拆分/调框/补画/删除保护）"
```

---

## 完成判定

- 三栈单测 + e2e 全绿
- 合并：item_blocks 重定向去重、chunks 标 stale、`origin='merged'`、ordinal 原位（验收 9）
- 拆分：两半继承文本与比例 bbox、不触发 OCR（`llm_calls` 无新增）（验收 10）
- 调框：preview 不落库 → diff 确认 → commit 后 `geometry_revision+1`、`crop_pad` 符合 §5.2（验收 11）
- 补画：`origin='manual'`、紫虚线 + 角标、OCR 入库（验收 12）
- 删除：有 review_queue 记录 → 409（验收 13）
- 所有几何/结构变更写 `pipeline_events`（stage='user_edit'）

## 范围外（明确不做）

- `items.revision` / `chunks.item_revision` / stale chunk 的重建触发与检索过滤（子系统 5）。
- 答案关联 UI（子系统 4）；staging 临时文件定期清理（记入 §13 风险，后续再说）。
- review_queue 行在合并/拆分时随 CASCADE 消失——已在锁定决策 2 记录接受。
