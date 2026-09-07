# 资料库管理界面设计

## 设计结论

这版方向叫「索引账页」。

资料库的本质是批量核对学习资料、确认哪些内容能进入知识库，而不是一个普通文件列表。

界面沿用现有作业纸视觉体系：米白纸面、细网格、红笔强调、墨色表格。

签名元素是连续的「chunk 线」：每个已索引片段像缝在纸边上的分段标签，让向量化结果从抽象状态变成可指认的实物。

这版刻意不做通用管理后台的灰蓝数据面板，也不把所有信息塞进卡片阴影里。

## 设计令牌

| 角色 | 取值 | 用法 |
| --- | --- | --- |
| Paper | `#FCFBF7` | 主画布，保持现有学习知识库底色 |
| Ink | `#2B2B26` | 表格主体、标题、正文 |
| Pencil | `#8A867C` | 次级元数据、空状态、分页说明 |
| Red Pen | `#E03C28` | 选中页、待处理行动、排除开关的危险态 |
| Verified Green | `#2E7D5B` | 已通过、已索引、可检索 |
| Stale Amber | `#B07C1F` | 内容已改动但索引过期 |
| Excluded Slate | `#68707A` | 被排除页与空 chunk 占位 |
| Hairline | `#E8E5DD` | 账本分隔线、表格横线 |

字体继续使用 Noto Serif SC 做资料标题和页码，Noto Sans SC 做界面文本，IBM Plex Mono 做状态计数、chunk 序号、时间与行号。

标题层级保持克制：页面主标题用衬线体，统计和过滤行用小号无衬线体，让资料名成为第一层信息。

## 信息架构

### 1. 资料库列表

默认进入表格视图，因为用户需要比较审核进度、索引进度和资料类型。

表格上方是一行过滤账目：搜索、科目、文件类型、自动审核、人工复核、索引状态、视图切换。

每个筛选控件都是即时过滤，不放在折叠面板里。

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 资料库                    124 份 · 8 份待处理 · 31% 已索引                    │
├──────────────────────────────────────────────────────────────────────────────┤
│ [搜索书名] [科目▾] [类型▾] [自动审核▾] [人工复核▾] [索引▾]      表格 | 卡片    │
├──────────────────────────────────────────────────────────────────────────────┤
│ 资料                 科目/类型    自动审核    人工复核    索引        操作       │
├──────────────────────────────────────────────────────────────────────────────┤
│ 三年级数学练习册     数学/PDF     18/20 通过  待复核 3    12/20 已索引 查看     │
│                      8 页需复核   3 页打回    2 页过期    1 页排除             │
├──────────────────────────────────────────────────────────────────────────────┤
│ 语文阅读试卷         语文/PDF     6/6 通过    未复核      6/6 已索引  查看     │
├──────────────────────────────────────────────────────────────────────────────┤
│ 英语讲解稿           英语/MD      不适用      已通过      8 段已索引  查看     │
└──────────────────────────────────────────────────────────────────────────────┘
│ ← 上一页   第 1 / 7 页 · 每页 20 份   下一页 →                                 │
```

表格列的含义固定：

- 「资料」显示书名、页数/章节数、创建时间。
- 「自动审核」显示解析流水线通过数、需复核数和打回数。
- 「人工复核」显示用户自己的处理结果。
- 「索引」显示已向量化单元数、过期数、排除数。
- 「操作」只保留「查看」，删除放在资料详情页，避免批量误删。

卡片视图是次要模式，用于浏览书名和封面感觉。

卡片仍必须保留索引比例，避免切换视图后丢失最重要的状态。

```text
┌───────────────┐
│ PDF · 数学    │
│ 三年级练习册  │
│ ───────────── │
│ 自动 18/20    │
│ 复核 待处理   │
│ ▓▓▓▓▓░░ 12/20 │
│ 已索引        │
└───────────────┘
```

空状态写「没有匹配的资料，试试清除索引或科目筛选。」，不显示营销文案。

## 2. 资料详情

进入资料后先看到资料摘要和一个紧凑状态账页，再分页浏览内容。

摘要不展开成仪表盘，只保留书名、类型、结构模式、总体审核和索引进度。

PDF 的默认内容视图是「页面表」，docx/md 的默认内容视图是「章节表」。

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← 资料库    三年级数学练习册                                                  │
│ PDF · 20 页 · 目录拆条     自动 18/20 · 人工待复核 3 · 索引 12/20 · 1 页排除   │
├──────────────────────────────────────────────────────────────────────────────┤
│ 页面表 | 缩略图 | 索引账页                                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ 页   缩略图   自动审核    人工复核    OCR 块    索引       排除   操作         │
│ 17   ▢       通过        待复核      6 块      已索引 3    [ ]   查看/重建    │
│ 18   ▢       通过        通过        7 块      过期       [ ]   查看/重建    │
│ 19   ▢       需复核      未处理      8 块      未索引     [ ]   查看          │
│ 20   ▢       不参与      不参与      0 块      已排除     [x]   恢复          │
├──────────────────────────────────────────────────────────────────────────────┤
│ ← 上一页   第 1 / 4 页 · 每页 5 页   下一页 →                                 │
```

页面表是主视图，因为它能同时比较状态和识别块数。

缩略图模式帮助人工找到版式异常页，但仍保留状态徽标和排除开关。

「索引账页」展示这本书当前有哪些 chunk、每个 chunk 来自哪些页或块、文本预览和检索状态。

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 索引账页                             20 chunks · 2 过期 · 1 页已排除          │
├──────────────────────────────────────────────────────────────────────────────┤
│ 01 ────────────── P17 / B02-B04 ─────────────── 已索引                        │
│    例 1：先算乘法，再算加法……                                                 │
│ 02 ────────────── P17 / B05 ─────────────────── 过期                          │
│    3. 一根绳子长 24 米……                                                      │
│ 03 ────────────── P18 / B01-B03 ─────────────── 已索引                        │
│    竖式计算：25 × 14 = …                                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

状态用文字徽标而不是只靠颜色：

- 自动审核：`通过`、`需复核`、`打回`、`未解析`、`不参与`。
- 人工复核：`未处理`、`通过`、`打回`。
- 索引：`未索引`、`已索引`、`过期`、`已排除`。

## 3. 页面复核与 chunk 视图

页详情采用三栏工作台，不再只看整页图。

左侧是原页，中间是 OCR 块账目，右侧是可切换的整页稿、条目和索引预览。

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← 资料详情    第 17 页    通过 · 已索引 3 · 过期 0                            │
├──────────────────────┬───────────────────────┬───────────────────────────────┤
│ 原页                 │ OCR 块                │ 整页稿 | 条目 | chunk          │
│                      │                       │                               │
│  ┌──────────────┐    │ B01 页眉  已排除       │ 01 ▸ B02-B04                 │
│  │ 页图         │    │ B02 题干  已选中       │    先算乘法，再算加法……       │
│  │ bbox B02 高亮│    │ B03 公式  通过         │ 02 ▸ B05                     │
│  │              │    │ B04 图注  有批注       │    一根绳子长 24 米……         │
│  │              │    │ B05 页脚  待复核       │    ─────────────────────      │
│  └──────────────┘    │ [编辑] [批注] [选中]   │ 生成方式：整页稿按语义切分      │
│ [查看大图] [排除页]  │                       │ [重建本页索引]                │
└──────────────────────┴──────────────────────┴───────────────────────────────┘
```

OCR 块必须逐块可见：

- 页图上的 bbox 与块账目双向联动，悬停或选中一边时另一边高亮。
- 每块显示类型、OCR 来源、转录状态和批注数。
- 编辑块时先显示原文本，再显示输入框，保存后写回该块并让本页索引标记过期。
- 每块可新增或修改批注，批注保留作者、时间和文本，不覆盖 OCR 内容。

整页稿视图支持直接编辑复合页内容。

编辑器分成「原始 Markdown」和「渲染预览」两段，保存后不再静默重建索引。

保存整页稿后页面显示「索引已过期，需要重建才能进入检索」，由用户决定是否重建。

## 4. PDF 排除与重建

页表、缩略图和页详情都提供同一个排除开关。

开关文案使用「排除此页」和「恢复此页」，不用「忽略」或「禁用」。

排除前弹出一句确认：说明该页现有 chunk 会被删除，且不会进入后续知识库。

排除成功后：

- 页状态显示「已排除」。
- 该页全部 chunk 被删除。
- 自动审核和人工复核状态保留，但改为弱化显示「不参与」。
- 后续批量审核、approve、embed 都跳过该页。

「重建本页索引」只处理未排除页。

重建前界面显示预计 chunk 数和来源页，重建后显示成功写入数量并刷新 chunk 线。

如果旧索引有但重建失败，状态保持「过期」，错误写明可再次重建，不误报为已索引。

## 5. 视觉规则

表格用纸面横向细线，不用每行卡片阴影。

资料名和页码使用衬线体，形成「账本页码」的阅读锚点。

状态徽标圆角小、颜色低饱和，可读性优先。

chunk 线左侧是连续红色细线，每个 chunk 是一条短账签；过期 chunk 有缺口，排除 chunk 用灰色断口。

所有主操作有 2px 红色焦点环；弹窗、下拉和 bbox 都支持键盘访问。

≥900px 使用三栏；768–899px 页图与块账目上下排列；<768px 只保留当前块，左右切换。

`prefers-reduced-motion` 下关闭浮层进入和 chunk 载入动效，只保留状态变化。

## 备选方向

1. 「审核流水线」：把每份资料画成解析、复核、向量化三段管道。优点是状态语义强，缺点是占用太多横向空间，不适合一屏比较多本书。
2. 「文件箱」：继续卡片网格，强化缩略图。优点是视觉轻松，缺点是难以比较 20 页中哪几页有问题，与本次目标相反。
3. 「索引账页」：表格管列表，账签管 chunk，三栏管复核。优点是数据密度和操作路径最匹配，推荐采用。

## 交互摘要

列表请求带 `page / page_size / q / subject / file_type / auto_review / review_status / index_status`。

详情请求返回分页的页或章节，以及聚合计数。

索引请求返回 chunk 列表、序号、来源页/块、内容预览和状态。

排除请求是页级显式操作，返回被删除的 chunk 数。

OCR 块编辑和批注使用独立接口，编辑后立即使本页索引失效。

## 前后端逻辑设计

### 数据模型

新增 `0016_library_index_controls.sql`，不把 UI 需要的状态继续挤进现有含义不清的字段。

`pages` 新增：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `auto_review_status` | `pending / passed / needs_review / failed` | 解析流水线自动审核结果 |
| `manual_review_status` | `unreviewed / approved / rejected` | 用户对整页或条目的复核结果 |
| `excluded_from_index` | `boolean` | 是否被人工排除，排除页不进入知识库 |
| `index_error` | `text` | 最近一次重建失败的错误信息 |

`chapters` 同样新增 `auto_review_status` 和 `manual_review_status`。

现有 `pages.review_status` 只保留为兼容字段；新读写路径使用两个字段的组合，回填规则如下：

| 旧 `review_status` | 新自动审核 | 新人工复核 |
| --- | --- | --- |
| `pending` | `pending` | `unreviewed` |
| `auto_passed` | `passed` | `unreviewed` |
| `approved` | `passed` | `approved` |
| `rejected` | `failed` | `rejected` |

`blocks` 不直接保存批注文本，新增 `block_annotations` 表，保证一个 OCR 块可以有多条历史批注。

```sql
CREATE TABLE block_annotations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    block_id uuid NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    author text NOT NULL DEFAULT 'admin',
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
```

`chunks` 新增 `source_block_ids uuid[]` 和 `page_no integer`。

这样索引账页能回答两个关键问题：chunk 从哪些块来，chunk 属于哪一页。

flat 页级 chunk 写入真实页号和页内来源块；item chunk 写入溯源块；chapter chunk 在无法定位块时允许数组为空。

### 状态机

自动审核由 pipeline 写入，人工复核和排除由 backend 写入。

```text
解析中   parse_status=pending|rendered|failed
自动审核 pending -> passed | needs_review | failed
人工复核 unreviewed -> approved | rejected；approved/rejected 只能由下一次内容重建重开
索引     not_indexed -> indexed；内容变更 -> stale；排除恢复 -> not_indexed
排除     excluded_from_index=false -> true；true -> false
```

状态变更是原子的：

- 整页通过：写 `manual_review_status=approved`，关闭本页 pending review queue。
- 页内容或 OCR 块变更：设置 `index_status=stale`，删除属于该页或该溯源链的旧 chunk。
- 批注变更：不改变索引状态，因为批注不进入检索内容。
- 排除页：pipeline 删除相关 chunk，重建受影响的结构单元；页显示 `excluded_from_index=true`。
- 恢复页：pipeline 重新组装受影响单元，但单元保持 `not_indexed`，等待用户触发向量化。
- 重建失败：保留 `index_status=stale`，写入 `index_error`，不伪装成 `indexed`。

### API 设计

#### 资料列表

```http
GET /api/library
  ?page=1
  &pageSize=20
  &q=数学
  &subject=数学
  &file_type=pdf
  &auto_review=pending
  &review_status=unreviewed
  &index_status=stale
```

响应：

```json
{
  "documents": [{
    "id": "doc_1",
    "title": "三年级数学练习册",
    "subject": "数学",
    "file_type": "pdf",
    "page_count": 20,
    "auto_review": { "passed": 18, "needs_review": 1, "failed": 1 },
    "manual_review": { "unreviewed": 3, "approved": 15, "rejected": 2 },
    "index": { "indexed": 12, "stale": 2, "excluded": 1 }
  }],
  "pagination": { "page": 1, "pageSize": 20, "total": 124, "totalPages": 7 }
}
```

过滤语义：

- `q` 匹配资料标题，不搜索 chunk 内容，避免列表页变成检索页。
- `auto_review` 是文档内是否存在该状态的页。
- `review_status` 是文档内是否存在该人工状态。
- `index_status` 支持 `indexed / partial / stale / not_indexed / excluded`。

#### 资料详情

```http
GET /api/library/:docId
  ?unit=pages|chapters
  &page=1
  &pageSize=20
```

PDF 返回分页后的 `pages`，docx/md 返回分页后的 `chapters`。

每个 page 条目包含：

```json
{
  "id": "page_17",
  "page_no": 17,
  "parse_status": "parsed",
  "auto_review_status": "passed",
  "manual_review_status": "unreviewed",
  "index_status": "indexed",
  "excluded_from_index": false,
  "block_count": 6,
  "chunk_count": 3,
  "thumbnail_url": "/api/review/pages/page_17/image"
}
```

每个 chapter 条目包含章节号、标题、内容预览、自动审核、人工复核、chunk 数和索引状态。

详情响应同时返回文档级聚合，供标题栏一次渲染。

#### 索引账页

```http
GET /api/library/:docId/chunks?page=1&pageSize=20
GET /api/review/pages/:pageId/index-preview
```

chunk 列表条目：

```json
{
  "id": "chunk_1",
  "seq": 1,
  "page_no": 17,
  "source_block_ids": ["block_2", "block_3"],
  "content_preview": "例 1：先算乘法，再算加法……",
  "status": "indexed",
  "created_at": "2026-09-06T10:00:00Z"
}
```

`index-preview` 在真正写向量前调用，返回将要切分出的段、来源和字符数。

这满足「触发索引后 chunk 怎么切分能直观看到」，并避免用户只能在 embedding 完成后猜结果。

#### 排除与恢复

```http
POST /api/library/pages/:pageId/exclusion
{ "excluded": true }
```

backend 校验页存在后调用 pipeline `/internal/page-exclusion`。

pipeline 在一个数据库事务里：

1. 更新 `pages.excluded_from_index`。
2. 删除直接属于该页的 chunk。
3. 删除 source block 全部或部分落在该页的 item/chapter chunk。
4. 重建 flat 合成章或 TOC 受影响条目的内容。
5. 返回 `{ page_id, excluded, deleted_chunks, affected_units }`。

恢复页用同一个接口传 `false`；恢复只重建内容，不自动 embedding。

#### 页面、块和批注

```http
PATCH /api/review/pages/:id
{ "page_md": "新的整页稿" }

PATCH /api/review/blocks/:id
{ "content_md": "修正后的 OCR 文本" }

POST /api/review/blocks/:id/annotations
{ "body": "页眉不进入题目" }

PATCH /api/review/block-annotations/:id
DELETE /api/review/block-annotations/:id
```

内容写入后返回最新页面聚合。

批注接口只写 `block_annotations`，不使索引失效。

页面和块编辑接口在同一事务里更新内容、设置索引过期并清理旧 chunk。

#### 重建索引

```http
POST /api/review/pages/:pageId/reindex
POST /api/library/:docId/reindex
{ "type": "page|chapter", "id": "unitId" }
```

backend 先检查 `excluded_from_index=false`，否则返回 409。

然后调用 pipeline `/internal/reindex`，成功后返回：

```json
{ "page_id": "page_17", "chunks": 3, "status": "indexed" }
```

单页重建保持同步执行，因为一次只处理一页且前端按钮已经进入 busy 态。

批量重建先不加入本版；等列表操作出现真实需要时，再引入 job 表，避免第一版就做半成品后台任务。

### Pipeline 职责

pipeline 是向量化切分和排除重建的唯一实现。

`flat.page_contents` 查询页时过滤 `excluded_from_index=true`。

`structure` 组装 TOC 条目时同样跳过排除页。

`embed_flat_pages` 删除旧页 chunk 后重新切段，并把 `page_no` 和 `source_block_ids` 写入 `chunks`。

`embed_approved_items` 继续只写 approved 条目，但 source block 来自排除页的条目不会重新进入向量。

`embed_chapters` 只索引没有被排除页影响且 `manual_review_status=approved` 的章节。

新增 `/internal/page-exclusion`，专门处理排除页引发的内容重建和 chunk 清理。

新增 `/internal/index-preview`，复用 `segment_chapter`，不调用 embedding 服务。

### 前端状态设计

`LibraryView` 拆成三层：

1. `LibraryToolbar` 保存过滤条件、视图模式和分页。
2. `LibraryTable` 或 `LibraryCards` 只负责渲染行数据。
3. `LibraryDetail` 负责文档摘要、页面表、缩略图和索引账页。

过滤条件同步到 URL query，刷新后不丢失。

搜索输入 300ms 防抖；其他筛选立即触发。

每次过滤变化重置到第 1 页；请求带 AbortController，慢响应不能覆盖新响应。

`PageDetail` 的状态分区：

- 左侧页图保存自然尺寸、bbox 选中块。
- 中间块账目保存每块的编辑草稿、批注展开态和保存中状态。
- 右侧 `page_md / items / chunks` 是懒加载标签页。

排除和重建不使用乐观更新。

排除涉及删除向量，重建涉及写入向量，都等服务端返回后刷新状态和 chunk 线。

所有失败保留在当前视图的显式错误条中，不清空已加载的数据。

### 测试设计

Backend 使用真实 PostgreSQL 测试：

- 分页总数、`pageSize` 边界和过滤组合。
- 文档详情的分页页/章节数据。
- 排除页后 `chunks` 里不再有该页 source block。
- 页面和块编辑后 `index_status=stale`。
- 重建成功和失败后的状态分别正确。

Pipeline 使用真实 PostgreSQL 测试：

- `page_contents` 跳过排除页。
- `index-preview` 的切段结果和实际 `embed_flat_pages` 一致。
- `page-exclusion` 在 flat 与 TOC 两种模式下都清理正确。

Frontend Vitest 覆盖：

- 默认表格渲染、卡片切换和分页控件。
- 状态徽标文案、索引比例和排除开关。
- 页图 bbox 与 OCR 块联动。
- chunk 线、过期态和重建按钮。

Playwright E2E 覆盖完整链路：

1. 入库一本测试 PDF。
2. 在资料库列表按索引状态过滤并分页。
3. 打开详情，切换页面表/缩略图/索引账页。
4. 编辑 OCR 块和整页稿，断言 API 与 DB 的 `stale` 状态。
5. 给块添加批注，断言刷新后仍在。
6. 排除页，断言 UI、API 和 DB 中相关 chunk 均消失。
7. 触发重建，断言 UI 的 chunk 数和 DB 的新 chunk 一致。
8. 用聊天检索确认排除页内容不再命中，已索引页内容可命中。

## 验收清单

- 列表默认表格，支持分页和全部过滤条件。
- 可切换卡片，卡片仍显示索引比例。
- 详情页按页或章节分页，每个单元显示自动审核、人工复核和索引状态。
- 被排除页不产生 chunk，原有 chunk 被删除。
- 索引账页能看到 chunk 序号、来源、文本、状态和重建结果。
- OCR 每块可定位、编辑、加批注。
- 整页稿可编辑，保存后索引状态变为过期。
- 全链路测试覆盖 UI、API、chunk 数据和排除字段。
