# 试卷入库全链路优化设计（含 UI）

日期：2026-09-08
修订：2026-09-09（版面模型可配置 + 默认 PP-DocLayoutV3；§11 与 review-workbench.html 六屏对齐；crosscheck 并入质检；answer_state 补 suggested 档）
范围：PDF 试卷从 OCR 解析到按题向量入库的完整链路，含人工复核 UI
相关：`docs/superpowers/specs/2026-09-08-pipeline-overhaul-design.md`（流水线总体）、DESIGN.md（视觉令牌）

---

## 1. 背景与问题

现在 PDF 入库走的是"整页转录 → 按页/按章切 chunk"，对**试卷**这种文档类型不成立：

- 一道题跨页、一页多道题、答案在卷末，按页切出来的 chunk 语义是碎的。
- 家长/学生的检索意图是"这道题怎么做"，不是"第 3 页有什么"。
- 图形题的关键数字只印在图上，文本 chunk 里根本没有，检索不到。

目标是把试卷加工成**题目级**的可检索单元，同时保留：题面/答案分离、图形随题、全文可回溯。

非目标：本次不改检索主链路（向量/BM25 仍在 backend TS），不改 `paper_questions` 之外的历史表语义，不处理手写体答案识别。

---

## 2. 现状核实（事实清单）

落笔前逐条核过代码，以下是当前真实状态，不是待办清单：

| 事实 | 位置 | 说明 |
|---|---|---|
| 块裁图能力**已有** | `pipeline/kb/ocr/layout.py` 的 `crop_image` | `blocks` 表有 `bbox JSONB` + `crop_path`，每块都裁了图存盘 |
| 块类型**已有** `figure` | `pipeline/kb/ocr/layout.py` 的 `_LABEL_MAP` | PaddleOCR-VL 标签映射到 `text/figure/table/…` |
| 题面/图/答案角色**已分离** | `item_blocks.role ∈ (stem, figure, solution)` | 数据模型层面已分开 |
| **向量没分开** | `pipeline/kb/rag/embed.py` 的 `embed_approved_items`（内部 `embed_texts(cfg, [r[2] for r in rows])`） | 喂进去的是整条 `items.content_md`，题面和答案混在一起 |
| 一个题目只有一个向量 | `chunks.item_id UNIQUE` + `item_embeddings.item_id PRIMARY KEY` | 约束层面锁死 |
| 答案现在**正在被 embedding** | `embed_approved_items` 的 SQL 没过滤 `content_type` | `items.content_type='answer'` 是独立 item，也在被向量化，属现状 bug |
| 卷末答案配对按 label 精确相等 | `pipeline/kb/rag/structure.py` 的 `pair_items` | 连排"9. 160 10. 0.75，75% 11. 40"不会被切成 3 条，静默漏配 |
| 裁图**零 padding** | `pipeline/kb/ocr/layout.py` 的 `crop_image` / `pipeline/kb/paper_pipeline.py` 的 `_crop_question` | rect 直接用 bbox，紧贴裁 |
| `_crop_question` **没做越界 clamp** | `pipeline/kb/paper_pipeline.py` 的 `_crop_question` | `crop_image` 有 `& page.rect`，VLM 这条路径没有。VLM 输出超出 [0,1000] 时 rect 越界 |
| 两套 bbox 坐标系并存 | `pipeline/kb/ocr/layout.py`（页图像素）vs `pipeline/kb/paper_pipeline.py`（0-1000 归一化） | 同一个"bbox"字段两种语义 |
| 图片路径**两套不一致** | `pipeline/kb/ocr/layout.py` 存相对；`pipeline/kb/paper_pipeline.py` 存 `str(rel.resolve())` 绝对 | 同一库里两种存法 |
| 后端路径解析基准是 pipeline 目录 | `backend/src/routes/review.ts` 的 `join(dirname(storageRoot), p)` | 用的是 `dirname(storageRoot)`，不是 storageRoot 本身 |
| `paperQuestions.ts` **绕过**解析函数 | `backend/src/routes/paperQuestions.ts` 的 `readFile(q.image_path)` | 全库唯一一处直接读原始路径，也是唯一依赖绝对路径的地方 |
| DPI 默认 200 | `pipeline/kb/core/config.py` 的 `Config.dpi`（`dpi: int = 200`） | 页图与题图共用 |

结论：**缺的不是"切图"和"分角色"，而是"图进 md / 进呈现""向量按题面""卷末答案切分对齐""路径与 padding 规范化"这四件事。**

另：版面检测模型本身改为可配置（V2/V3，默认 PP-DocLayoutV3），版面切块从 opt-in 变为默认启用，见 3.1。

---

## 3. 总体流程

```
PDF
 └─① 渲染页图 (dpi=200) + 版面检测切块（可配置，默认 PP-DocLayoutV3）──> blocks(bbox, crop_path, block_type)
 └─② 分级解析: rapidocr ─失败─> VLM 补解析
 └─③ VLM 质检（评分 + 命中规则；含可选双模型比对，配了 KB_VISION_COMPARE_MODEL 才跑，未配置自动跳过，分歧块建 llm_disagree 复核行进人工队列）
       └─ 达标 ────────────────┐
       └─ 未达标 / 被补解析过 ─> ④ 人工复核
 └─④ 人工复核（规则命中页必审 + 10% 抽样，其余自动通过）
 └─⑤ LLM 拆题（整卷转录文本按大题分批；内含卷末答案关联子步骤：答案区切分 → 题号对齐 → 低置信进人工，见 §8）
 └─⑥ 人工确认题目 → 按题向量入库（可重跑）→ 呈现：chunk 列表 / 题目级检索（答案折叠）/ 全文 markdown
```

**人工确认（④⑤的确认环节）必须先于入库（⑥），顺序不能颠倒。** 人工确认之前就入库，人工改动无法回灌，向量变无主脏数据。入库是一次可重跑的"发布"动作。

**凡是 OCR 失败被 VLM 补过的页，强制进人工队列**，不让 VLM 给自己补的内容打分放行——自评一致性偏差。

### 3.1 版面模型可配置

- 新增环境变量 `KB_LAYOUT_MODEL`，合法值 `PP-DocLayoutV2 | PP-DocLayoutV3`，默认 `PP-DocLayoutV3`；非法值时 `load_config` 直接报错退出，错误信息含合法值列表。
  `Config` 增加 `layout_model` 字段，`.env.example` 同步。
- `KB_LAYOUT_ENGINE` 默认值从 `whole_page` 改为 `paddleocr`（合法值不变）；没装 paddle 依赖的环境 ingest 直接失败，import 报错要带出安装指引，不做静默降级 whole_page（避免"以为在切块其实在整页"重演）。
- `PaddleOCRLayout` 构造函数增加 `model_name` 参数，懒加载处 `LayoutDetection(model_name=self._model_name)`；`make_layout_analyzer` 透传 `cfg.layout_model`。
- blocks 的阅读顺序：PP-DocLayoutV2/V3 都带指针网络，返回 boxes 的顺序即阅读顺序，`analyze()` 删掉现有 y/x 排序，按模型输出顺序写 `blocks.ordinal`（1..N）；模型输出为空时不产生块（与 y/x 兜底行为等价，不保留死代码）。
- `_LABEL_MAP` 需按 V3 实际标签集核对补齐；未知标签仍回落 text 不丢内容（现状行为保留）。
- 依赖：paddlepaddle/paddleocr 已在 pyproject 声明，本次起需实际安装；首次运行自动下载模型到 ~/.paddlex（V3 约 125MB）。
- 影响：整页 VLM 不再是默认路径，workbook/exam 入库默认切块，文字块走 rapidocr 才真正生效；需要旧行为可显式 `KB_LAYOUT_ENGINE=whole_page` 回退。

---

## 4. 数据模型变更

新增 migration `0018_exam_ingest.sql`（当前最新是 `0017_pipeline_events.sql`；schema 只由 pipeline/kb/migrations 变更）：

```sql
-- 题目级答案字段：只作为题目 chunk 的独立字段，不单独拥有向量
ALTER TABLE items ADD COLUMN answer_md TEXT;
ALTER TABLE items ADD COLUMN answer_conf REAL;
ALTER TABLE items ADD COLUMN answer_state TEXT NOT NULL DEFAULT 'none';
  -- none 无答案 | suggested 机器配对待确认（置信 0.60–0.85） | paired 高置信自动配对（≥0.85） | confirmed 人工确认/手工指定 | pending 未配对待补 | rejected 人工标记无答案

-- 图注描述：进向量的是这句文本，不是图像本身
ALTER TABLE blocks ADD COLUMN caption TEXT;
ALTER TABLE blocks ADD COLUMN caption_source TEXT;  -- vlm | manual | null

-- 裁图 padding 记账：存的是原始 bbox，padding 只在裁图时加
ALTER TABLE blocks ADD COLUMN crop_pad JSONB;       -- [dx, dy] 实际生效的外扩量（页图像素）

-- 阅读顺序显式化（现状靠 created_at + uuid 兜底，见 6.1）
ALTER TABLE blocks ADD COLUMN ordinal INTEGER;
UPDATE blocks SET ordinal = sub.rn FROM (
  SELECT id, row_number() OVER (PARTITION BY page_id
         ORDER BY created_at, id) AS rn FROM blocks) sub
  WHERE blocks.id = sub.id;
ALTER TABLE blocks ALTER COLUMN ordinal SET NOT NULL;

-- 块的血缘：人工修正后要知道这个框是哪来的
ALTER TABLE blocks ADD COLUMN origin TEXT NOT NULL DEFAULT 'layout';
  -- layout 版面检测 | manual 人工补画 | merged 合并生成 | split 拆分生成
ALTER TABLE blocks ADD COLUMN parent_block_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE blocks ADD COLUMN geometry_revision INTEGER NOT NULL DEFAULT 1;
  -- bbox 每次变更 +1；>1 表示几何被人动过，内容与版面检测的输出不再等价

-- revision：题目改动后旧向量失效待重建
ALTER TABLE items ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chunks ADD COLUMN item_revision INTEGER;
ALTER TABLE chunks ADD COLUMN state TEXT NOT NULL DEFAULT 'indexed';  -- indexed | stale | excluded
```

不改动 `chunks.item_id UNIQUE`——答案不独立成 chunk，这个约束保留。

`blocks.crop_path` 与 `paper_questions.image_path` **统一改为相对路径**，基准见第 7 节。

---

## 5. 裁图与 padding 规范

### 5.1 为什么要有 padding，以及为什么不能无差别加

配置的版面模型（默认 PP-DocLayoutV3）的框紧贴文字墨迹，误差 2–3px（在页图尺度）。数学图形更糟：尺寸标注、箭头、图注常在框外沿，紧贴裁会把"上底 6 cm"这个数字切掉一半——而它恰恰是解题关键。

但 padding 不能无差别加。填空题连排时行距在 200 DPI 下只有 8–16px，外扩 6px 会把上一题的尾巴和下一题的题号一起切进来，人工复核时看到的是"这题怎么带了邻题的字"。

### 5.2 取值（按物理长度定义，两个坐标系各自换算）

padding 按**物理长度**定义，不按固定像素，这样改 DPI 不用改配置：

| 块类型 | 水平外扩 | 垂直外扩 |
|---|---|---|
| `text` 文本块 | 0.8 mm | 0.5 mm |
| `figure` 图形块 | 1.5 mm | 1.0 mm |

纵向比横向保守，就是因为块间距在纵向更小。

**换算公式：**

- layout 路径（bbox 是页图像素，DPI = D）：
  `px = round(mm / 25.4 * D)`
- paper_pipeline 路径（bbox 是 0-1000 归一化，x 按页宽、y 按页高各自归一）：
  `unit_x = round(mm / page_width_mm * 1000)`
  `unit_y = round(mm / page_height_mm * 1000)`

**A4（210×297mm）、DPI=200 下的实际值：**

| 块类型 | layout 像素 | 0-1000 归一化 (x, y) |
|---|---|---|
| `text` | 6 px 横向 / 4 px 纵向 | x: 4，y: 2 |
| `figure` | 12 px 横向 / 8 px 纵向 | x: 7，y: 3 |

非 A4 页面按实际 `page.rect` 换算，代码里本来就是比例换算，自动适配。

### 5.3 三条 clamp 规则（缺一不可）

1. **clamp 到页面边界。** `rect & page.rect`。`paper_pipeline._crop_question` 现在缺这条，必须补——VLM 输出超出 [0,1000] 是常态不是异常。
2. **clamp 到不与相邻块重叠。** 按 y 排序取同页相邻块：
   `pad_top = min(pad_v, gap_to_prev / 2)`
   `pad_bottom = min(pad_v, gap_to_next / 2)`
3. **bbox 存原始值，padding 只在裁图时加。** 存库里的 bbox 保持检测模型/人工调框的原始坐标，实际生效的 padding 记到 `blocks.crop_pad`。否则人工在 UI 上调完框、再用 bbox 反查页图位置，坐标对不上。

---

## 6. 块的编辑与修正

### 6.1 现状：块是只读的，分块错了目前无解

核过代码，事实是：

- `PATCH /blocks/:id`（`backend/src/routes/review.ts`）**只接受 `content_md`**，硬校验 `typeof body.content_md !== "string"` 就返回 422。改不了 bbox，改不了 block_type。
- 没有任何合并 / 拆分 / 新建 / 删除块的接口。
- 前端 `PageDetail.tsx` 里零个 textarea、contentEditable、拖拽或 resize 事件，纯只读展示 + 审核状态切换。

所以"分块识别错了"这件事**当前没有任何处理手段**。只能把错的文本改对，但框还是错的——页图上的红框和文本内容对不上，复核就失去意义了。

**顺带核出一个更严重的隐患**：块的阅读顺序现在靠 `ORDER BY created_at, id`（`pipeline/kb/rag/flat.py`、`pipeline/kb/rag/assemble.py`、`pipeline/kb/rag/export_md.py`、`pipeline/kb/ocr/golden.py` 都是这个写法）。`created_at` 默认 `now()`，在 autocommit 下靠微秒递增勉强等于插入顺序；一旦同事务批量插入，多行 `created_at` 完全相同，就退化到按 `id` 排——而 id 是 `uuid4()` 随机数。更要命的是**合并/拆分/补画产生的新块，created_at 是"现在"，会排到该页末尾而不是原位**，阅读顺序直接乱掉，题目顺序错，答案配对跟着错。这是第 4 节加显式 `ordinal` 的原因。

### 6.2 分块错误的四种类型

不是所有"分块错"都该用同一种手段修，成本和后果差别很大：

| 类型 | 表现 | 处置 | 要不要重跑 OCR |
|---|---|---|---|
| **切多了** | 一个语义块被切成两块（题干被拦腰截断） | 合并 | **不需要**，纯元数据操作 |
| **切少了** | 两个语义块黏成一块（两道题挤一块） | 拆分 | 按文本行切**不需要**；按几何切需要 |
| **切歪了** | 框边界不对，带进邻块内容或漏掉自己的 | 调框 | **需要** |
| **漏检** | 版面模型根本没检出这块 | 补画新框 | **需要** |

关键区分在 `bbox → crop_image → OCR → content_md` 这条链：**动了 bbox，content_md 就失效了**。

- **合并**：新 bbox 是两框外接矩形，新 content_md 是两段文本拼接。内容本身没变，只是归属变了 → 不用调模型，即时生效。
- **按行拆分**：用户在文本里点一个切分位置，按该行 y 坐标切 bbox，两半各自继承对应文本 → 也不用调模型，而且比在图上画线准得多。
- **调框 / 补画**：必须重裁 + 重跑 OCR。

所以 UI 上要把这两类分开：合并和按行拆分**即时生效**，调框和补画**要等模型跑**。不能都塞进一个"保存"按钮里。

### 6.3 改框后必须重跑 OCR，并把新旧文本摆在一起对比

改了框却把 content_md 留着不动，是最糟的结果——页图和文字对不上，人工复核就白做了。

流程：调框 / 补画 → 自动重裁（按 5.2 的 padding 规则）→ 自动重跑 OCR → **新旧文本并排 diff 给用户确认**。用户确认后才落库，同时 `geometry_revision += 1`、`origin` 记为 `manual`（补画）或沿用原值（调框）、`parent_block_ids` 记血缘。

### 6.4 引用重定向（改块会牵动 item 和 chunk）

`item_blocks.block_id` 和 `chunks.source_block_ids` 都指向 block，块变了这些引用不能悬空。

现有 `PATCH /blocks/:id` 是直接 `DELETE FROM chunks WHERE source_block_ids && ARRAY[block_id]`（review.ts）。改文字这么干没问题，**改分块时不能照抄**：

| 操作 | item_blocks | chunks |
|---|---|---|
| 合并 A+B→C | 指向 A 或 B 的重定向到 C，去重 | 合并 source_block_ids，标 stale 待重建 |
| 拆分 A→B+C | 按 item 文本落在新块的哪一半，重定向到对应块 | 标 stale 待重建 |
| 调框 / 补画 | 保持不变（内容变了，归属没变） | 标 stale 待重建 |
| 删除块 | 解除绑定，item 标 `no_source` | 标 stale |

删除块要沿用 `pipeline/kb/ocr/layout.py` 已有的保护：`NOT EXISTS (SELECT 1 FROM review_queue r WHERE r.block_id=b.id)`——**有复核记录的块不会被清掉**，人工痕迹不丢。新增的删除接口必须套同一条规则。

### 6.5 交互要求

- 拖拽 8 个控制点（4 角 + 4 边中点）；拖到接近相邻块边界时吸附（gap < 4px）。
- 键盘微调：方向键 1px，Shift + 方向键 10px。
- 补画：页图上拖拽拉框，松手触发裁图 + OCR。
- 拆分**优先做"在文本里点位置"**，图上画线只作兜底——前者不用重跑 OCR 且更准。
- 每次几何变更写 `pipeline_events`（`stage='user_edit'`），与现有块编辑日志保持一致。

---

## 7. 图片入库与 md 呈现

### 7.1 路径基准（用户决定：物理相对路径）

相对路径，但**基准必须钉死**，否则半年后搬目录全断：

- **基准目录 = `KB_STORAGE_DIR`（即 `pipeline/storage/`）**，不是 pipeline 目录，不是仓库根。
- md 里写 `![](blocks/<page_id>/b007.png)`，从 `storage/<doc_id>/` 起算。
- 需要同时修两处后端代码，否则新路径读不出来：
  - `backend/src/routes/review.ts` 的 `join(dirname(storageRoot), p)` 改成 `join(storageRoot, p)`——现在基准差了一层。
  - `backend/src/routes/paperQuestions.ts` 的 `readFile(q.image_path)` 改走 `resolveStoragePath`——它是全库唯一绕过解析的地方，也是唯一依赖绝对路径的地方。
- `pipeline/kb/paper_pipeline.py` 的 `str(rel.resolve())` 改成相对，与 `pipeline/kb/ocr/layout.py` 一致。

**已知代价（接受）**：md 是只写镜像，`export` 或迁移时必须**整目录搬**（`storage/<doc_id>/` 连同 `blocks/`、`pages/`、md 一起走），单独拷 md 文件出去图片链接会断。这一点要写进 export 的说明里。

### 7.2 图要进 md，也要进向量——但进的是图注文本

图像本身不参与 embedding（embedding 模型是文本的）。所以：

1. 块类型标成 `figure` 的块，裁图后调 VLM 生成一句描述，写进 `blocks.caption`。
2. 拼题面 embedding 输入时，caption 作为题干的一部分拼进去：
   `embed_input = stem_md + "\n" + "〔图：{caption}〕"`
3. 没有 caption 的 figure 块，在人工复核页拦一道：不给描述不许通过。

不做这一步，"看图填空"这类题存了图也检索不到——数字只印在图上，题干里没有。

### 7.3 md 与 UI 中的呈现

题目 md 模板：

```markdown
#### 二、填空 11
如图，梯形上底 6 cm，下底 10 cm，高 5 cm，面积是 ______ cm²。

![梯形示意图](blocks/e3f1…/b007.png)
*图注：梯形，上底 6 cm，下底 10 cm，高 5 cm*

<!-- answer -->
答案：40 cm²
<!-- /answer -->
```

- 图片用标准 markdown 图片语法，相对路径指向 `storage/<doc_id>/` 下。
- 答案段用 `<!-- answer -->` 注释包裹，方便渲染层折叠，也方便导出时选择是否带答案。
- 题组内多个子题共用一张图时**只存一份、只引用一次**，按 `block_id` 去重，不重复裁图。

---

## 8. 答案字段化与卷末答案关联

### 8.1 答案不是独立 chunk（已定）

答案**不单独拥有向量**，只作为题目 chunk 里的独立字段 `items.answer_md`。理由：学生搜"长方体体积怎么算"，答案文本是"160 cm³"，向量距离极远，独立成向量基本检索不到；就算命中，拿到孤零零一个"160 cm³"看不到题面等于废数据。

embedding 输入只喂 `stem + 图注`，答案当 payload 跟着返回。副作用：改答案不必重建题面向量。

顺带把现状 bug 堵了：`embed_approved_items` 的 SQL 加 `content_type` 过滤，卷末答案整页 chunk 标 `excluded`。

### 8.2 卷末答案区要在解析阶段做关联

`pair_items`（`pipeline/kb/rag/structure.py`）现在按 label 精确相等配对，卷末答案两种常见排版都会漏：

- **连排**：「9. 160　10. 0.75，75%　11. 40」→ 现在切成 1 个块挂「9」，10 和 11 静默漏配。
- **子题嵌套**：「15.（1）6 cm（2）432 cm³」→ 现在挂「15」或「15（1）」，子题 2、3 拿不到答案。

需要新增的处理链（4 步）：

1. **版面定位**：识别「参考答案」「答案」标题块，锁定答案区页范围（通常在卷末连续 1–2 页）。
2. **连排切分**：在答案区内按题号正则（大题号 + 可选「（n）」子题号）切成 N 段。
3. **子题再切**：大题号 + 「（n）」两级，切出 `15(1) / 15(2) / 15(3)`。
4. **题号对齐**：切出的题号与题目 label 匹配，匹配不上进人工。

**对齐置信度分档**（进 UI 的对齐表，与 `answer_state` 枚举一一对应）：

| 置信 | `answer_state` | 处理 |
|---|---|---|
| ≥ 0.85 | `paired` | 高置信自动配对 |
| 0.60 – 0.85 | `suggested` | 标「待确认」，人工一键采纳后转 `confirmed` |
| < 0.60 或找不到题号 | `pending` | 标「未配对」，答案字段留空 |

与 UI 配对表状态文案的映射：已配对 = `paired`/`confirmed`，待确认 = `suggested`，未配对 = `pending`，标记无答案 = `rejected`。

**未配对不阻塞入库。** 题目照常向量化，`answer_state='pending'`，人工补上后只重建该 chunk（revision+1）。

### 8.3 跨页答案

答案区跨页时，按页序拼接后再走切分，不按页分别切——否则一道大题的答案被页边界劈成两半。

---

## 9. 质检规则与人工抽样

质检判定要可计算、可配置，不能藏在视图里。UI 只负责呈现"命中了哪几条"。

| 规则 | 默认阈值 | 说明 |
|---|---|---|
| 块置信过低 | < 0.60 | OCR 低置信块占比 |
| VLM 评分 | < 0.80 | 整页评分 |
| 乱码率 | > 3% | 非常用字符占比 |
| 题号序列断层 | 有 | 题号不连续或重复 |
| 文本密度异常 | < 30 或 > 3000 字/页 | 固定阈值替代 ±2σ：±2σ 依赖整批页分布、单页入队判定不稳定；过密=漏切，过疏=多切 |
| OCR 失败触发 VLM 补解析 | 无条件 | 编排；自评一致性偏差，补解析页强制进人工 |
| 随机抽样 | 10% | 命中之外的页随机抽 |

策略：**规则命中页必审 + 10% 随机抽样 + 其余整本通过**。不逐页全审——50 页 PDF 看一晚上不可接受。

阶段③质检内含可选双模型比对（crosscheck）：formula/figure/table 块必查、text 块按 block_id 哈希抽 5%，与第二渠道模型（`KB_VISION_COMPARE_MODEL`，未配置则跳过）重转录比对，CER>0.2 建 llm_disagree 复核行进人工。

阈值放配置文件，验收时能改，不硬编码在视图。

---

## 10. 向量化与 revision

入库粒度分情况，不一律"一题一向量"：

- **题组（材料 + 子题）**：一个 chunk。子题做子块并保留父引用——一道大题的子题共用材料，拆开后各自失去上下文。
- **纯单题**（计算题、填空）：一题一向量。

revision 机制：

- 题目改动 → `items.revision += 1`，对应 chunk 标 `stale`，旧向量待重建。
- 重建是可重跑的发布动作，不是一次性写入。
- chunk 带 `source_id + item_revision`，可追溯"这条向量是哪一版题目生成的"。

存量影响：embedding 输入从"整条 content_md"改成"stem + 图注"，**存量向量全部作废需重建**。`invalidate_chunk` 机制已有，可直接复用。

---

## 11. UI 规格

视觉令牌沿用 DESIGN.md 的经典学院蓝（Oxford Royal Blue 主色 + Slate 层级 + 6/8px 圆角），术语与 `PageDetail` / `LibraryDetail` 对齐。

设计稿 `docs/design/review-workbench.html` 是资料库审核 UI 的目标能力与唯一视觉事实源，共 6 屏：复核工作台 → 拆题复核 → 分块修正 → 答案关联 → 入库查看 → 质检规则。
本节只规定语义与规则，视觉/交互细节以 HTML 为准。

### 11.1 屏 1 · 人工复核工作台

三栏：左待复核页队列（按严重度排序，含筛选"仅未处理/全部/已通过"）｜中页图 + bbox 覆层｜右 OCR 块列表 + VLM 质检结论。

块 ⇄ 页图双向联动：点击/悬浮/↑↓ 键切换块，页图自动框出并滚动定位。

**框色语义（关键，不许混用）：**

| 颜色 | 含义 |
|---|---|
| 主色蓝框 | 当前聚焦（跟随列表操作） |
| 红色框 | 问题块：OCR 低置信 / 命中质检规则 |
| 琥珀框 | 人工已修改 |
| 细灰框 | 正常块，悬浮高亮 |

红框只表示"这页有问题"，**不**表示"我点了一下"。用红色表达聚焦会让两个语义打架。页图下方固定放图例。

底部操作：本页通过并下一页 / 打回本页 / 重跑 VLM 解析本页 / 合并选中块 / 拆分块。快捷键：↑↓ 切块、E 编辑、⌘↵ 通过本页。

分块修正的四种操作（改文字 / 合并 / 拆分 / 调框补画，对应 6.2）在本屏可直接发起：前三个即时生效，第四个要等模型，这个差异必须在 UI 上说清楚——否则用户点完"调框"没反应，会以为坏了。操作细则与引用重定向规则详见 11.3。

调框 / 补画的 diff 弹窗：左"原文本"、右"新识别"，差异高亮，底部「采用新文本 / 保留原文本 / 手动改」。确认后 `geometry_revision += 1`，页图上该块加一个"人工调过"的角标。

补画的框用**紫色虚线边框 + `origin=manual` 角标**跟原生块区分开，让人一眼看出"这块是人补的"。

### 11.2 屏 2 · 拆题复核

题卡操作：采纳 / ✎ 修改题干 / 关联题组 / 重跑本页解析 / 删除。

「入库粒度」下拉：按题组·推荐 / 按单题 / 按页。

右栏抽题概览统计卡：识别题数 / 题组数 / 已确认 / 待确认 / 答案配对率 / 缺图题数 + 进度条。

入库卡：「确认全部并生成向量」「仅确认，稍后批量入库」两个动作（入库 = 生成 chunk + 向量，是可重跑的发布动作）。

快捷键：1 采纳 / 2 修改 / Enter 下一条。

提示卡：未配对答案不阻塞入库（`answer_state='pending'`，见 8.2）。

缺图题（无 caption 的 figure 块）拦一道不给通过。

### 11.3 屏 3 · 分块修正

对应 §6 的四种操作（改文字 / 合并 / 拆分 / 调框补画）：前三即时生效，第四要等模型。

| 操作 | 入口 | 反馈 |
|---|---|---|
| **改文字** | 右侧块卡直接编辑（E 键） | 即时生效，块转琥珀框 |
| **合并** | 多选块（⌘/Ctrl+点击）→ 合并选中块 | **即时生效**，页图框变外接矩形，文本拼接 |
| **拆分** | 在块文本里点切分位置 → 拆分块 | **即时生效**，按该行 y 坐标切框，两半各自继承文本 |
| **调框 / 补画** | 页图上拖控制点 / 拉新框 | **要等模型**：显示"重裁 + 重识别中"，完成后弹新旧文本 diff 供确认 |

引用重定向规则表（§6.4）在此屏呈现：

| 操作 | item_blocks | chunks |
|---|---|---|
| 合并 A+B→C | 指向 A 或 B 的重定向到 C，去重 | 合并 source_block_ids，标 stale 待重建 |
| 拆分 A→B+C | 按 item 文本落在新块的哪一半，重定向到对应块 | 标 stale 待重建 |
| 调框 / 补画 | 保持不变（内容变了，归属没变） | 标 stale 待重建 |
| 删除块 | 解除绑定，item 标 `no_source` | 标 stale |

底部注明框色与 origin 角标语义：框色语义见 11.1；补画块带紫色虚线边框 + `origin=manual` 角标，合并/拆分生成块分别记 `origin=merged/split`。

### 11.4 屏 4 · 答案关联与检索呈现

三栏：左卷末答案区页图（叠 bbox，演示"连排"蓝框、"子题嵌套"红框）+ 四步说明｜中题号对齐表（已配对/待确认/未配对分色，底部操作：采纳选中配对 / 手工指定答案块 / 在卷末页图中定位 / 标记无答案）｜右检索命中预览 + 三条硬规则卡。

检索命中卡：题干 + 裁切图 + 图注 + **折叠的答案条**（默认隐藏，标签"默认隐藏"）。

### 11.5 屏 5 · 入库查看

左 chunk 列表（题组/题/页，带 state：indexed / stale / excluded）｜右完整 markdown 全文（含图片渲染、答案折叠）。每个 chunk 可复制 / 在原文中定位 / 重建向量。

### 11.6 屏 6 · 质检与入库规则

可配规则表（第 9 节）+ 顺序原则（人工确认必须先于入库）。

---

## 12. 验收

按 AGENTS.md 的 E2E 纪律，用 `e2e/` 下 Playwright 用例断言到 UI / API / DB 字段，不用临时浏览器驱动。

必补用例：

1. 卷末连排答案「9. 160　10. 0.75，75%　11. 40」切成 3 条并正确挂到 3 道题（现状会漏配）。
2. 子题嵌套「15.（1）…（2）…」按子题对齐。
3. `figure` 块裁图带 padding，且不与相邻块重叠（断言 `blocks.crop_pad` 与裁图尺寸）。
4. VLM 输出 bbox 超出 [0,1000] 时不崩、裁图 clamp 在页内。
5. md 里的相对图片路径能被后端正确解析（覆盖 `paperQuestions` 那条绕过路径）。
6. 答案默认折叠，展开后可见；答案不进 embedding（断言 embed 输入不含 `answer_md`）。
7. 题目改动后 chunk 标 stale，重建后 revision+1。
8. 未配对答案不阻塞入库，`answer_state='pending'`。
9. 合并两块：`item_blocks` 引用重定向到新块且不重复，`chunks` 标 stale，新块 `origin='merged'`、`ordinal` 落在原位（**不是页末尾**）。
10. 在文本中间拆分块：两半各自继承对应文本，**不触发 OCR 调用**（断言 `llm_calls` 表无新增）。
11. 调框：触发重裁 + 重跑 OCR，弹出新旧 diff；确认后 `geometry_revision` 递增，`crop_pad` 符合 5.2 取值。
12. 补画新框：`origin='manual'`，页图紫色虚线显示，OCR 结果入库。
13. 有 `review_queue` 记录的块不被删除接口清掉（沿用 `pipeline/kb/ocr/layout.py` 中 `NOT EXISTS (SELECT 1 FROM review_queue ...)` 的保护）。
14. 块顺序按 `ordinal` 而非 `created_at`：人为把新块的 created_at 设成最新，阅读顺序仍正确。
15. 默认配置（不设 `KB_LAYOUT_MODEL`）下 `make_layout_analyzer` 加载 PP-DocLayoutV3（断言传给 `LayoutDetection` 的 `model_name`）。
16. `KB_LAYOUT_MODEL=PP-DocLayoutV2` 时加载 V2。
17. `KB_LAYOUT_MODEL` 非法值时 `load_config` 报错退出，错误信息含合法值列表。
18. `blocks.ordinal` 采用模型输出顺序：构造返回乱序坐标的假 pipeline，断言 ordinal 不再按 y/x 排；模型输出为空时不产生块。
19. `_LABEL_MAP` 覆盖 V3 实际标签集：一页真图跑 V3，输出 label 全部有映射；未知标签回落 text 行为不变。
20. 黄金集回归：V3 下切块结果不劣于现状基线（沿用现有 golden 机制）。

---

## 13. 风险与遗留

| 项 | 风险 | 处置 |
|---|---|---|
| 存量向量作废 | embedding 输入改了，全部要重建 | `invalidate_chunk` 已有，可重跑；成本是重新调 embedding 模型 |
| 相对路径迁移 | md 单独拷出去链接断 | export 整目录导出，写进说明 |
| VLM caption 质量 | 图注描述错，会把错误信息带进向量 | caption 在人工复核页可见可改，改后 revision+1 |
| 题组粒度判断 | LLM 判哪些题是题组可能不准 | 拆题复核页可人工调整粒度 |
| paddle 依赖实际安装 | 1~2GB 磁盘，arm64 安装失败阻断所有入库 | pyproject 已声明；import 报错带安装指引；e2e 环境前置就绪 |
| V3 本机 CPU 未实测 | 按官方 1.6× 推算约 7~8s/页，若远超预期影响批处理 | 实现期先跑一页实测，超 15s/页回报再决策 |
| V3 标签集漂移 | V3 输出 label 与 V2 不同，映射漏了会静默归 text | 验收用例 19 兜底；映射表注释来源 |
| 默认引擎变更行为跳变 | whole_page 不再默认，老环境升级后行为变 | 文档写明；KB_LAYOUT_ENGINE=whole_page 可显式回退 |
| 两套 bbox 坐标系 | 同一个字段两种语义，长期是坑 | 本次不统一（改动面太大），但 migration 里给 `blocks` 加注释标明单位是页图像素 |

---

## 14. 实施拆分与进度

本 spec 规模超出单一实现计划，拆为 5 个子系统，各自独立 brainstorm → plan → 实现，每块都可单独交付。开新子计划 / 完成时更新本表。

| # | 子系统 | 覆盖章节 | 状态 |
|---|---|---|---|
| 1 | 版面模型可配置（V2/V3 默认 V3 + ordinal 阅读顺序） | §3.1、§12 用例 14–20 | 已完成 |
| 2 | 裁图 padding / clamp / 路径统一 | §5、§7.1、§12 用例 3–5 | 已完成 |
| 3 | 块编辑四操作 + 引用重定向 + 复核/分块修正 UI | §4（血缘/几何部分）、§6、§11.1、§11.3、§12 用例 9–13 | 未开始 |
| 4 | 答案字段化 + 卷末关联 + 答案关联 UI | §8、§11.4、§12 用例 1–2、8 | 未开始 |
| 5 | 向量化 revision + caption + 拆题复核/入库/规则屏 | §7.2–7.3、§10、§11.2、§11.5、§11.6、§12 用例 6–7 | 未开始 |

顺序说明：1 是其余各块的地基（ordinal、切块默认启用）；2→3→4→5 大体按依赖递增排布，但 3/4 之间可并行。

migration 编号约定：`0018_block_ordinal.sql` 已被子计划 1 占用（见计划一偏差说明）；原 §4 的 `0018_exam_ingest.sql` 顺延为 `0019`，并去掉其中的 ordinal 段（已随 0018 落地）。
