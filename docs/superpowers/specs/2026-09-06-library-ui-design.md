# 资料库 UI 重设计

日期：2026-09-06

状态：待评审

上游：`2026-09-05-phase3-c-design.md`

## 背景

当前系统把「复核」和「资料库」拆成两个概念，入口只有一个文档下拉框，PDF 页状态和 DOCX/MD 章节混在同一组 tab 里。用户需要先选文档再看内容，不能按科目浏览，也不能看到完整的解析状态。

本设计用统一的「资料库」替代这两个入口，提供独立的列表页和按资料类型自适应的详情页。

## 目标

- 独立资料库列表页，支持上传、删除、按科目浏览。
- 进入单篇资料后按资料类型切换内容模型：PDF 用页视图，DOCX/MD 用章节视图。
- PDF 保留原始页与解析块的对应关系，块框标注关联条目。
- 所有解析内容可编辑，编辑后标记索引过期，由用户手动重新向量化。
- 审核状态分两层：文档级 + 页级/章节级。
- 索引状态也分两层：页级/章节级，跟随内容变更自动更新。
- 搜索支持单篇文档内搜索和全局搜索。

## 非目标

- 不改聊天功能。
- 不改检索算法本身。
- 不改条目拆分逻辑，只改呈现和状态管理。

## 页面结构

侧边栏导航调整为：聊天、资料库、统计、用量。删除「复核」入口，资料库成为唯一入口。

### 列表页

按科目分组展示所有资料，不使用下拉框。

每份资料显示：

- 标题（原文件名）。
- 文件类型（PDF/DOCX/MD）。
- 添加时间。
- 添加人。
- 文档级解析状态（待解析 / 解析中 / 待复核 / 已通过 / 已打回）。

交互：

- 右上角「上传资料」按钮，支持 PDF/DOCX/MD，上传时选择科目和类型。
- 每份资料卡片带删除按钮，点击后弹出确认。
- 点击资料卡片进入详情页。
- 顶部有全局搜索框。

### PDF 资料详情页

布局分左右两栏。

左栏：

- 原始 PDF 页图 + bbox 块框覆盖层。
- 块框根据关联条目显示角标（如 `#12 题干`、`#12 图`）。
- 点击块框高亮右侧对应块或条目。

右栏两种视图切换：

- **块视图**：列出本页所有解析块，每块可编辑。
- **条目视图**：列出聚合后的条目（例题/练习题/答案），并标注由哪些块组成。

点击右侧条目高亮左侧相关块。

顶部：

- 页码导航 + 页状态过滤（全部 / 待复核 / 已通过）。
- 文档级审核状态徽标。

「原始 PDF vs 解析文本」对比视图作为可选开关。

### DOCX / Markdown 资料详情页

不展示页状态，改为章节视图。

布局：

- 左侧章节目录。
- 右侧选中章节的 Markdown 渲染。

可切换到「Chunk 拆分视图」，显示每个 chunk 的内容。

同样支持编辑和索引过期标记。

## 状态模型

审核状态分两层。

### 文档级（documents.review_status）

| 值 | 含义 |
|---|---|
| `pending` | 有待复核的页或章节，整体还没完全通过 |
| `approved` | 所有页/章节都已通过 |
| `rejected` | 有页或章节被打回 |

### 页级/章节级（pages.review_status / chapters.review_status）

| 值 | 含义 |
|---|---|
| `pending` | 解析完成，等待人工复核 |
| `auto_passed` | pipeline 判断没问题，自动通过并完成索引 |
| `approved` | 人工确认通过 |
| `rejected` | 人工打回 |

### 索引状态（页级/章节级）

| 值 | 含义 |
|---|---|
| `not_indexed` | 内容还没有生成向量 |
| `indexed` | pipeline 或人工通过后已完成索引 |
| `stale` | 内容被编辑过，需要重新拆分/向量化 |

## 索引完成条件

- PDF 页：pipeline 解析完成后自动打分，分数达到阈值 → `review_status = auto_passed` + `index_status = indexed`。
- PDF 页：pipeline 判断需要人工复核 → `review_status = pending`，人工通过后 → `review_status = approved` + `index_status = indexed`。
- DOCX/MD 章节：入库后自动切 chunk + 向量化 → `auto_passed` + `indexed`。
- 用户编辑某页/某章节内容 → 该页/章节的 `index_status` 变 `stale`。
- 重新向量化完成 → `index_status` 恢复 `indexed`。
- 文档级状态随页/章节状态变化自动计算。

## 编辑与向量化

无论审核状态如何，所有解析内容均可编辑。

编辑保存时只更新内容，不自动重新拆分或向量化。

如果该页/章节已有 chunk 或 embedding，编辑后在编辑区域旁显示黄色徽标「索引已过期」。

用户点击「重新向量化」按钮，重新生成 chunk 和 embedding。

如果该页/章节尚未向量化，不显示此提示。

## 块与条目的关系

块（block）是 PDF 页面上解析出来的物理内容单元，如一段文字、一个图、一个公式、一个表格。

条目（item）是学习内容单元，如一道例题、一道练习题、一个答案。

一个条目可能由多个块组成；一个块也可能被多个条目引用。

页面上把块框出来，并标注这些块聚合成了哪些条目。

现有数据模型已支持：`blocks.bbox` 保存坐标，`item_blocks` 保存条目-块映射。本设计不需要改变这个模型。

## 搜索

两种搜索模式：

- **单篇文档搜索**：在详情页内搜索该文档的内容。
- **全局搜索**：在资料库列表页顶部搜索所有文档的内容。

搜索结果点击后跳转到对应资料详情页的对应位置（页或章节）。

## 数据变更

### schema 变更

`documents` 表新增：

- `uploaded_by` TEXT：添加人。
- `review_status` TEXT CHECK IN (`pending`, `approved`, `rejected`)，默认 `pending`。

`pages` 表新增：

- `review_status` TEXT CHECK IN (`pending`, `auto_passed`, `approved`, `rejected`)，默认 `pending`。
- `index_status` TEXT CHECK IN (`not_indexed`, `indexed`, `stale`)，默认 `not_indexed`。

`chapters` 表新增：

- `review_status` TEXT CHECK IN (`pending`, `auto_passed`, `approved`, `rejected`)，默认 `pending`。
- `index_status` TEXT CHECK IN (`not_indexed`, `indexed`, `stale`)，默认 `not_indexed`。

现有 `pages.status` 改名为 `pages.parse_status`，`documents.status` 改名为 `documents.parse_status`，统一使用 `parse_status` 表示 pipeline 解析状态。三个状态维度语义如下：

| 列名 | 语义 |
|---|---|
| `parse_status` | pipeline 解析状态：`pending / rendered / parsed / failed` |
| `review_status` | 审核状态：`pending / auto_passed / approved / rejected` |
| `index_status` | 索引状态：`not_indexed / indexed / stale` |

### API 变更

新增或改造：

- `GET /api/library`：列表页数据（含科目分组、上传人、状态、索引统计）。
- `POST /api/library`：上传资料（PDF/DOCX/MD）。
- `DELETE /api/library/:id`：删除资料。
- `GET /api/library/:id`：详情页元数据（文档状态 + 页/章节状态摘要）。
- `POST /api/library/:id/reindex`：手动重新向量化指定页或章节。

现有 `/api/review/*` 逐步迁移到 `/api/library/*`，旧路由在迁移完成后退役。

## 交互流程

### 上传流程

1. 用户点击「上传资料」。
2. 选择文件（PDF/DOCX/MD），选择科目和类型。
3. 上传成功后，文档出现在列表中，pipeline 状态为 `pending`，审核状态为 `pending`。
4. pipeline 完成解析后，文档状态更新。
5. PDF：所有页解析完成，自动通过的标为 `auto_passed`，需要复核的标为 `pending`。
6. DOCX/MD：章节切 chunk + 向量化完成，状态标为 `auto_passed`。

### 编辑流程

1. 用户在详情页编辑某页或某章节的内容。
2. 保存后，该页/章节的索引状态变为 `stale`。
3. 编辑区域旁显示「索引已过期」徽标和「重新向量化」按钮。
4. 用户点击「重新向量化」，该页/章节重新生成 chunk 和 embedding。
5. 索引状态恢复 `indexed`。

### 审核流程

PDF 页：

1. 页状态为 `pending` 时，用户在详情页查看原始页和解析结果。
2. 用户可以逐块编辑，然后点击「通过本页」→ 页状态 `approved`。
3. 用户也可以点击「打回本页」→ 页状态 `rejected`。
4. 打回后用户可以重新解析或编辑，再通过。

DOCX/MD 章节：

1. 章节入库后自动通过并完成索引。
2. 用户编辑后索引过期，重新向量化后索引恢复。
3. 用户也可以手动将章节标为 `rejected`。

## 方案选择

选择了方案 A（完整重设计），而不是方案 B（渐进改造）或方案 C（最小改动）。理由：现有 combo box 入口不适合作为资料库，两个入口造成概念混乱，数据模型已支持所需交互，一次性重设计可以避免后续返工。

## 实施建议

按以下顺序实施：

1. Schema 迁移 + 状态计算。
2. Library 列表 API + 前端列表页。
3. PDF 详情页（复用 PageDetail，扩展条目标注）。
4. DOCX/MD 详情页（章节 + chunk 视图）。
5. 编辑 + 索引过期 + 手动向量化。
6. 搜索。
7. 旧路由退役。

每步都应先写 E2E 测试再实现。
