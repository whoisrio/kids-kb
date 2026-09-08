# 资料入库流水线打通设计

日期：2026-09-08
状态：已确认

## 背景与目标

当前 pipeline 实现偏离原始期望，本文档覆盖四块修正工作：

1. docx/md 切分粒度：现状 `segment_chapter`（`pipeline/kb/embed.py:65`）按空行分段落聚合成 ≤1600 字符的 chunk，期望是 ~500 字符且可配置。
2. 试卷（exam）题目提取：现状 `--type exam` 只是元数据，不驱动任何处理分支；无目录页的试卷走 `structure` 直接回退 flat 整卷按页，不做题目提取。
3. PDF 版面切块未生效：`KB_LAYOUT_ENGINE` 未配置时默认 `whole_page`，每页只有一个整页 block，PaddleOCR 切块 + rapidocr/VLM 分级识别流程没有跑。
4. 资料库 UI 看不到 OCR 分块：块数据接口（`/api/review/pages/:id`）和展示组件（`frontend/src/components/PageDetail.tsx`）都在，但资料库详情页（`LibraryDetail`）只有页表数字和索引 chunk 列表，没有入口。

非目标：不改动 `papers`/`paper_questions` 批改试卷域（`pipeline/kb/paper_pipeline.py`）；不改动向量/BM25 检索主链路；schema 不变更（复用现有 documents/pages/blocks/items/chapters/chunks 表）。

## 关键决策

- 试卷拆题用方案 A：直接读已转录的 markdown（PDF 的 `page_md`、docx/md 的 `chapters.content_md`）喂文本 LLM 拆题。
  不采用逐页 VLM 带 bbox 拆题（方案 B），因为阶段一 OCR 转录质量已由 QC/crosscheck 把关，文本拆题足够，且一条链路统一覆盖三种格式。
  后续若复杂版面拆题质量不足，可为 PDF 试卷增加逐页 VLM 增强模式，与本设计不冲突。
- chunk 是检索单位，同时资料库 UI 支持按 chunk 查看；存储层仍按章节，不改为段级存储。
- PaddleOCR 切块只改本机 `pipeline/.env` 配置，代码默认值不动。

## 设计

### 1. docx/md 切分（可配 chunk）

修改 `pipeline/kb/embed.py` 的 `segment_chapter`：

- 按空行分段落，按序聚合段落，累计到 `max_chars` 切出一个 chunk。
- 单个段落超过 `max_chars` 时按 `max_chars` 硬切（保持现有简单策略）。
- 重叠：切点时把上一个 chunk 尾部 `max_chars × overlap_ratio`（默认 50）字符带入下一个 chunk 开头，保证跨 chunk 语义连续。
- 配置从环境变量读：`KB_CHUNK_MAX_CHARS`（默认 500）、`KB_CHUNK_OVERLAP_RATIO`（默认 0.1），写入 `pipeline/.env.example`。
- 作用范围：仅章节向量化（docx/md）使用这套配置；PDF flat 页向量化（`flat.embed_flat_pages` 复用同一函数）维持 1600、无重叠，不受影响。
- 已入库文档需走现有 `/internal/reindex` 重索引后按新粒度生效。

### 2. 试卷题目提取（structure exam 分支）

新模块 `pipeline/kb/structure_exam.py`。

`structure <doc_id>` 的模式判定顺序改为：显式 `--exam` > `documents.doc_type='exam'` > 原有 toc/flat 逻辑。

exam 模式对三种格式统一处理：

- 输入文本：PDF 按页序拼接各页 `page_md`（adopted 转录文本）；docx/md 拼接 `chapters.content_md`。
- 试卷文本按大题（题型 section）分批喂文本 LLM，走现有 `doc_ognize` 渠道。
- 新增 `EXAM_PROMPT`：输出结构化题目列表，字段含题号、题干 md、选项、答案 md（卷面自带答案区时）、页码区间。
- 写库：
  - 每个大题 section 写一个 `chapter`；LLM 拿不到 section 结构时合成单章。
  - 每道题写一个 `item`（`content_type='exercise'`）。
  - 卷面答案区提取出的答案写 answer item，复用现有 `pair_items` 按题号配对。
  - item 记 `page_start/page_end` 溯源；不写 bbox、不裁题图。
- approve、即时向量化、复核 UI 全部复用现有 items 链路，零新增。
- 处理日志走现有 `kb.traj.Recorder`，与其它 run 一致。

配置变更：`pipeline/.env` 加 `KB_LAYOUT_ENGINE=paddleocr`，`pipeline/.env.example` 同步补全该变量，使 PaddleOCR 切块 → rapidocr/VLM 分级识别流程实际生效。

### 3. 前端：资料库详情页三视图

`frontend/src/components/LibraryDetail.tsx` 增加视图切换：

- **完整 markdown**（默认视图）：按页/章渲染完整转录 markdown。
- **按 chunk 查看**：展示 ~500 字符检索段及其内容，基于现有 chunk 列表。
- **OCR 分块视图**：页图 + bbox 覆层 + 块列表，复用现有 `PageDetail` 组件，从页面表/缩略图点入。

后端补一个接口：`GET /api/library/:id/content` 返回整文档 markdown（PDF 拼 `page_md`，docx/md 拼 `chapters.content_md`），供全文视图使用。
chunk 数据走现有 `/api/library/:id/chunks`，block 数据走现有 `/api/review/pages/:id`，无需新增。

### 4. 错误处理

- exam 提取中某 section LLM 调用失败：该 section 标记失败、记 `pipeline_events`，可重跑，不阻塞其它 section。
- LLM 输出解析失败（JSON 不合法等）：重试一次，再失败按上一条处理。
- 整卷提取出 0 道题：structure 判失败并写明原因。
- 未配对的答案不阻塞入库，在复核页可见，由人工处理。

### 5. 测试

遵循 TDD，先写测试再实现。

- pipeline pytest（需 `KB_TEST_DATABASE_URL`）：
  - `segment_chapter` 单测：段落聚合 ~500、超长段落硬切、overlap 10%、环境变量配置覆盖。
  - `structure_exam` 测试（mock LLM）：PDF 试卷提取、docx 试卷提取、答案配对、多 section 分批、单 section 失败不影响其它 section。
- backend `npm test`：`GET /api/library/:id/content` 接口测试。
- e2e Playwright 补 spec：
  - exam 文档 ingest → structure → 题目条目出现在复核页、approve 后可检索。
  - 资料库三视图渲染：完整 markdown、按 chunk、OCR 分块。

## 涉及文件清单

- `pipeline/kb/embed.py`：segment_chapter 改造。
- `pipeline/kb/structure.py`、`pipeline/kb/cli.py`：模式判定接入 exam 分支与 `--exam` 参数。
- `pipeline/kb/structure_exam.py`：新增。
- `pipeline/.env`、`pipeline/.env.example`：`KB_LAYOUT_ENGINE`、chunk 配置。
- `backend/src/routes/library.ts`：新增 content 接口。
- `frontend/src/components/LibraryDetail.tsx`：三视图。
- `frontend/src/components/PageDetail.tsx`：如需小幅改造以支持在资料库内复用。
- `pipeline/tests/`、`backend` 测试、`e2e/specs/`：对应测试。
