# 家庭学习知识库 · 整体系统设计

日期：2026-09-02
状态：待评审
前置：Pre-phase 前端视觉原型已完成并经用户确认方向（`frontend/prototype/index.html`）。
关联：docx 入库的详细设计见 `2026-09-02-docx-ingest-design.md`，本文件将其并入"资料入库"一节。

## 背景与目标

项目服务一个多孩子家庭的学习管理场景，两条主线：

1. **资料入库**：家长上传学习资料（扫描版 PDF / docx），系统解析成结构化的题库（区分例题讲解、练习、答案），可检索。
2. **学习记录**：上传孩子的试卷，识别每题对错（VLM 预识别 + 人工确认），关联题库，支撑针对性复习与学习进展统计。

辅助要求：远端 LLM 调用记录 token 消耗（区分文本/图像）；长期支持奖励机制。

## 总体架构

前后端分离，后端按技术现实拆成两个服务，共享一个 PostgreSQL：

```
┌──────────────┐        ┌────────────────────────┐        ┌───────────────────────┐
│  frontend/   │ HTTP   │  backend/ (TS, Node)   │ 内部HTTP│  pipeline/ (Python)   │
│  React+Vite  ├───────>│  pi-agent + 产品API     ├───────>│  解析管线 + rerank     │
└──────────────┘        │  + 双路召回(向量+BM25)  │        │  + migrations         │
                        └────────┬───────────────┘        └─────────┬─────────────┘
                                 │                                  │
                                 └────────────► PostgreSQL ◄────────┘
                                             （+ pgvector）
```

- **pipeline/（Python，现有 backend/ 整体搬家）**：资料解析管线（渲染/版面/转录/切分/拆条）、文档向量化、schema migrations 的唯一主人、rerank 内部服务（本地 FlagEmbedding 权重）。
  对 TS 侧只暴露内部接口：`/internal/ingest`、`/internal/rerank`、管线状态。
  注意：DB 里页图/裁图路径是相对路径，搬家后 `storage/` 随代码挪到 `pipeline/storage/`，Python 进程一律从 `pipeline/` 启动。
- **backend/（TS，新建）**：pi-agent 支撑的聊天 agent、产品 API（孩子/做题记录/统计/资料管理）、**检索主链路**——
  embed query 直连 ollama HTTP，向量与 BM25 两路直接查 PostgreSQL（pgvector / 全文索引），合并排序。
  reranker 抽象为 provider：`local`（调 pipeline 服务的 `/internal/rerank`）或云 API（jina/cohere 等），配置切换。
- **frontend/（React+Vite+TS，新建）**：聊天、复核、统计、资料库、用量五个视图。
  开发用 Vite proxy 转发 `/api`，生产由 backend 服务托管 `frontend/dist`。

三条边界纪律：

1. schema 只由 pipeline/（Python）侧 migration 变更；枚举（错因词表、qc_status 等）以 SQL CHECK 为事实来源，TS 侧镜像类型。
2. 双路召回在 TS 内完成；只有需要重排时才调 Python 的 rerank 服务（或切云重排 API）。
   agent 工具经由 backend 的检索模块，不直连数据库之外的内部细节。
3. 上传链路：前端 → TS API 收文件 → 调 pipeline 服务 `/internal/ingest` → 前端轮询文档状态出进度。
   不引入消息队列。

## 领域模型

现有：`documents` / `pages` / `blocks` / `chapters` / `items` / `item_blocks` / `chunks` / `review_queue` / `llm_calls`。

新增：

- `children(id, name, grade, created_at)`：孩子档案，所有学习记录挂在孩子上。
- `attempts(id, child_id, item_id NULL, paper_question_id NULL, result, error_cause, note, created_at)`：
  孩子做题记录的**唯一事实表**，追加式历史。
  `result` ∈ 对/错/半对；`error_cause` ∈ 粗心/概念不清/方法不会/计算错（中文受控词表）。
  两个来源汇入：题库条目上手动标记（带 item_id）；试卷题确认后自动生成（带 paper_question_id，匹配到题库的带上 item_id）。
- `papers(id, child_id, title, subject, source_path, status, created_at)`：孩子的试卷。
- `paper_questions(id, paper_id, seq, content_md, image_path, recognized_result, confirmed_result, matched_item_id, match_score, created_at)`：
  试卷逐题。`recognized_result` 是 VLM 预识别，`confirmed_result` 是人工确认后的终值。

变更：

- `llm_calls` 加 `modality`（text/image）与 `paper_id`（nullable）：区分文本与图像调用，试卷管线的调用挂到试卷。
- `chapters` 加 `content_md`（nullable）：docx 章节原文（PDF 章为 NULL）。

## 资料入库

PDF 扫描件走现有管线（渲染→版面→转录→质检→章节拆条），不变。

docx 走新路径（详见 docx spec）：pandoc 转 markdown → 按标题切章存 `chapters.content_md` → `structure_chapter` 加分支直接拆章稿 → items。
docx 文档不写 pages/blocks；grounding 对无溯源块的条目改为对照章原文。
CLI `ingest` 按扩展名自动分流。

资料库页承担管理职能：上传、解析进度、状态（解析中/待复核/已完成）、章节查看、导出 md、重跑。

## 试卷管线

```
上传试卷(PDF/图片) → 页图渲染（复用现有组件） → VLM 整页拆题 + 识别对错痕迹（✓✗/红笔/扣分）
→ paper_questions(recognized_result) → 复核页逐题人工确认（confirmed_result）
→ 确认后：写 attempts + bge-m3 向量匹配题库（超阈值自动关联 matched_item_id，低于阈值人工选）
```

页图与题图裁切存 `storage/papers/<paper_id>/`。

## 聊天与 agent

- 前端聊天页 ↔ TS 服务 `POST /api/chat`（SSE 流式）。
- agent 用 pi-agent（pi-mono：`pi-ai` 统一 LLM 接口 + `pi-agent-core` agent 循环），库式集成进我们自己的 Node 服务。
  备选 dsh（DeepSeek Harness）是独立插件运行时，对本场景偏重，不选。
- 工具集（检索类，不写库）：`search_items`（hybrid 语义检索+过滤）、`get_item`（条目详情含讲解/答案）、`list_children`、`get_child_progress`（做题记录与统计）。
- 对话模型单独配 `CHAT_BASE_URL / CHAT_API_KEY / CHAT_MODEL`，留空回落 `DOC_OGNIZE_*`；调用照常记 `llm_calls`（purpose=chat，modality=text）。

## 统计与用量

两个页面严格分离：

- **统计**（学习向）：按孩子看正确率趋势（按周）、错因分布、薄弱知识点（taxonomy/tags）、待重练清单。
- **用量**（系统向）：token 总消耗、文本/图像分列、按用途/按模型汇总、最近调用流水。

## 前端信息架构与视觉

五视图：聊天（首页）/ 复核 / 统计 / 资料库 / 用量，原型已确认方向。
视觉语言：作业本 + 红笔批改——纸白底、思源宋体标题、红笔朱 `#E03C28` 签名色、订正青表正确与进步、题目卡为横格线+红边距的作业本纸、红笔圈/下划线批注关键数据。
token 统计不进统计页；复核页支持键盘流转（1/2/3 标记对错，Enter 下一条）。

## AGENTS.md（仓库根，新建）

写 ingest 工作流约定：用户提供文档时先从文件名/内容推断科目与类型；判断不了科目时必须先提问让用户选择（语文/数学/英语/其他），确认后再执行 ingest。

## 分期

- **Pre-phase（已完成）**：前端视觉原型，五视图 + 视觉语言，用户已确认方向。
- **Phase 1（本轮）**：
  - 目录搬家：现有 Python `backend/` 整体迁到 `pipeline/`（含 storage/，保持相对路径可解析）
  - `children` / `attempts` 表 + `llm_calls` 加 modality/paper_id
  - `backend/` TS 服务骨架 + pi-agent + `/api/chat`（SSE）+ 检索工具（题库部分）
  - 双路召回在 TS 实现（ollama embed + pgvector/BM25 SQL + 合并）；pipeline 侧加 `/internal/rerank`，TS 侧 reranker provider 抽象
  - frontend/ React 骨架 + 聊天页（按原型视觉）
  - 资料条目手动标记 API（写 attempts）
  - docx 入库（按 docx spec）
  - 根目录 AGENTS.md
- **Phase 2**：试卷上传管线 + VLM 对错预识别 + 复核页确认流 + 题库匹配。
- **Phase 3**：复核页迁移 React + 统计页 + 用量页；现有静态复核页退役。
- **Phase 4（长期）**：奖励机制（积分/徽章，如攻克曾经的错题加分）。

## 范围外

- docx 图片进 `item_blocks` 溯源；条目 content_md 只留图片相对路径。
- LibreOffice 转 PDF 的统一管线方案。
- 多家长账号、权限体系、云端部署。
- agent 的出题/执行动作能力（本轮只检索）。
