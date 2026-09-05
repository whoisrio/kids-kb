# Phase 3-C 设计：聊天增强 + 复核迁移 + 统计用量 + flat 入库

日期：2026-09-05
状态：待评审
上游：`2026-09-02-overall-system-design.md`（Phase 3 分期）、`2026-09-03-chat-session-design.md`（会话基线）、`2026-09-03-phase3-backlog.md`（3-B 清账）
关联阻塞：3-A Task 13 真实资料验收（记录见 `.workbuddy/memory/2026-09-04.md`）

## 背景与目标

Phase 3 收尾。
按整体设计交付 Phase 3 剩余范围：复核页迁移 React + 统计页 + 用量页 + 旧静态复核页退役。
同时把聊天补全为完整产品：分支编辑/rewind/regenerate、thinking 呈现、markdown 渲染、复制、删除。
并解锁 3-A Task 13 的无目录试卷集合入库。

## 总体

一份 spec、四个 workstream，实施拆四个计划依序执行：

- 3-C1 聊天增强
- 3-C2 文档复核迁移 + 静态页退役
- 3-C3 统计 + 用量页
- 3-C4 无目录试卷集合 flat 入库（独立可先行，直接解锁 Task 13 验收）

依赖关系：3-C2 的「flat 文档页级通过即向量化」依赖 3-C4 的 chunk 结构，其余互不依赖。

## Workstream A：聊天增强（3-C1）

### A1 会话分支

存储模型：pi-agent-core `Session` 原生 session tree（entry `parentId` 树 + lanes），不自创机制。

- 分支 = lane。会话首个分支为 `main`，编辑/rewind/regenerate 产生的新分支为 `br-<uuid>`。
- 读写分支：`session.view(lane)`——`appendMessage` 追加到该分支叶，`findEntriesOnBranch` 沿叶→根读该分支路径。

统一原语：**fork at entry**。

- 编辑用户消息 e：在其父 entry 处开叉，新分支上发送编辑后的内容。
- rewind：前端把「续写点」移到某条消息，视觉截断尾部并提示「后续内容保留在原分支」，下一次发送时在该消息处开叉；不发送不产生空分支。
- regenerate：在最后一条 assistant 的父 entry 处开叉，重发同一条用户消息原文。

API：

- `POST /api/chat` 请求新增可选 `lane_id` 与 `branch_at`（entryId）。
  `lane_id` = 写入目标分支，缺省为最新分支（与 GET 详情无 lane 参数时同口径）。
  `branch_at` 给定时在该 entry 处开新分支：指定的 entry 成为新消息的父节点，本轮及后续消息落新分支；编辑（父 entry）、rewind（目标消息 entry）、regenerate（末条 assistant 的父 entry）统一为此语义。
- SSE `session` 事件 data 由裸 id 改为 `{ "session_id": ..., "lane_id": ... }`。
  新会话与开叉都经此事件回传 lane，前端据此切换当前分支。
- `GET /api/sessions/:id?lane=` 返回 `{ title, currentModel, currentLane, lanes: [{ id, forkEntryId }], messages: [{ entryId, role, content, thinking? }] }`。
  无 `lane` 参数时返回最新分支（叶 entry `seq` 最大者）。
- 前端 ‹i/n› 切换器：同一父 entry 下的兄弟消息组挂切换器；切换 = 以对应 lane 重新加载路径。

隐患修复（本 workstream 先行）：`JsonlSessionHandle.messages()`/`currentModel()` 现用 `findEntries`（全树扫描），有分支后会把所有分支的消息混读。
改为指定 lane 的 `findEntriesOnBranch`。

历史重建（喂回模型）：只回放 text 内容，不回放 thinking（`toAgentMessages` 现行为不变）。

### A2 thinking

- 配置：`KB_CHAT_THINKING`（`off|minimal|low|medium|high|xhigh|max`，缺省 `medium`）写入 `makeModel` 的 `reasoning` 字段（现为 `false`）。
- 流式：`chat.ts` 订阅 `thinking_delta`，新增 SSE 事件 `thinking`（data 为 JSON 字符串，编码同 `delta`）。
- 持久化：`appendMessage` 本就落完整 AgentMessage（含 thinking 内容块），无额外写入成本。
  读端 `messages()` 把 assistant 消息的 thinking 块拼为 `thinking?` 字段带出。
- 前端行为：当前轮 thinking 面板在 thinking 输出期间展开，收到首个 `delta`（正式内容）自动折叠；历史轮与回看一律默认折叠；模型未输出 thinking 则无面板。
- 模型兼容：pi-ai 对 reasoning 参数的支持度按 provider URL 自动探测，不支持的模型不传该参数、不报错。

### A3 markdown 渲染

- assistant 消息：react-markdown + remark-gfm + remark-math + rehype-katex，替换手写 `renderRichText`。
  不启用 rehype-raw（无原始 HTML 注入面），组件化渲染默认转义。
- user 消息：保持纯文本转义。
- 流式：delta 累积后整体重渲染（memo 优化），未闭合语法按 markdown 容错渲染。

### A4 复制

- 单条：消息 hover 工具条「复制」→ 剪贴板写原始 markdown（assistant）/原文（user）。
- 整会话：会话工具条「复制全文」→ 拼接 Markdown 对话稿（`## 我` / `## 学习助手` 交替）写剪贴板。
- 均不含 thinking。
- 剪贴板失败（权限/环境）→ toast「复制失败」，不中断。

### A5 删除

- `DELETE /api/sessions/:id` → `repo.delete(metadata)` + 清进程内缓存；会话不存在返回 404。
- 前端：侧栏项 hover 出「删除」+ 确认弹窗；删除当前会话 → 回到新会话态；流式进行中先 abort 再删。

## Workstream B：文档复核迁移 + 静态页退役（3-C2）

### B1 前端结构

ReviewView 顶部加 tab：「试卷」（现有功能不动）/「资料」（新）。
资料 tab 四块，对应旧静态页：待复核页 / 已通过页 / 条目 / 检索试搜。
文档选择：资料 tab 顶部文档下拉（含待复核数徽标）。

### B2 API（backend TS）

读路径直连 PostgreSQL（papers 路由同款风格），图片从 `storageRoot` 读盘回传：

- `GET /api/review/docs` → `[{ id, title, subject, doc_type, status, pending_pages }]`
- `GET /api/review/pages?doc_id=&status=pending|approved`
- `GET /api/review/pages/:id` → 页详情（页图 URL、块列表含 bbox/类型/转录/有无 pending 行、pending 行明细）
- `GET /api/review/pages/:id/image`、`GET /api/review/blocks/:id/crop`
- `GET /api/review/items?doc_id=&status=`、`GET /api/review/items/:id`（详情 + grounding 块与裁图）
- `GET /api/review/search?q=&subject=` → 复用 TS `hybridSearch`（旧页绕道 pipeline，新页走自家检索主链路）

写路径：

- 纯 DB 写在 TS 做：`PATCH /api/review/blocks/:id`（编辑块转录）、`PATCH /api/review/items/:id`（编辑条目）、`POST /api/review/pages/:id/reject`（页打回）、`POST /api/review/items/:id/reject`。
- approve 走 pipeline internal，保持「approve = 向量化」单一事实来源：
  - `POST /api/review/pages/:id/approve`：TS 关闭该页全部 pending 复核行（DB 写）；若 `documents.struct_mode='flat'`，同时调 `POST /internal/embed-flat-page` 向量化该页。
  - `POST /api/review/items/:id/approve`：转发 `POST /internal/approve-item`。
    现有 `review_api.approve_item` 的 approve+向量化逻辑迁入 internal_api，CLI 与 UI 共用同一实现。
  - `POST /api/review/pages/:id/page-vlm`：转发 internal（页级 VLM 重跑，逻辑同旧端点）。

### B3 镜像偏差

旧页每次编辑块即刷新 `storage/` md 镜像。
TS 编辑只写 DB，镜像改为 `export` 时重算。
镜像本就是只写产物，AGENTS.md「DB 是事实来源」纪律不变。

### B4 退役

删除 `pipeline/kb/review_api.py`、`pipeline/kb/static/`（review.html / render.js / render_selftest.js）、CLI `review` 子命令。
:8765 服务消失。
`pipeline/tests/test_review_api.py` 中 approve 相关断言迁移为 internal_api 测试。
README 复核章节改指 React 复核页。

## Workstream C：统计 + 用量页（3-C3）

按已确认原型视觉实现，Rail 占位转正，App.tsx 顶栏孩子切换接真数据。

### C1 StatsView

- 数据源：`attempts`（join `items` / `paper_questions` / `children`）。
- 孩子选择器：`GET /api/children`（现有路由），替换 App 里写死的「小宝/朵朵」。
- Hero：本周错题数（wrong+partial）、本周正确率与环比（vs 上周）、已订正数、待重练数。
  正确率 = correct 次数 / 总次数，partial 计入分母不计入分子；环比为百分点差。
- 错因分布：近 30 天按 `error_cause` 计数（条形图）。
- 薄弱知识点：错题经 `item_id`（或 `paper_questions.matched_item_id`）join `items` 的 taxonomy/tags 计数（标签云）。
- 正确率趋势：近 8 周周正确率（柱状图）。
- 待重练清单：每题最新一次 attempt 为 wrong/partial 的题目卡（内容、来源、错因），「已订正」按钮 → `POST /api/attempts`（现有路由）记一条 correct。
- 口径：
  - 已订正 = 该题（item 或 paper_question 维度）最新一次 attempt 为 correct。
  - 待重练 = 最新一次 attempt 为 wrong/partial。
  - 本周 = 本周一起至今；趋势近 8 周含当周。
  - 未挂题库的试卷题（仅 paper_question_id）计入统计，内容显示试卷题干。
- API：`GET /api/stats/overview?child_id=` 一次返回全部聚合块。

### C2 UsageView

- 数据源：`llm_calls`。
- Hero：本月 token 总量（prompt+completion）、文本/图像分列、调用次数。
- 按用途（purpose）、按模型（model）聚合。
- 最近调用流水：最新 50 条（时间/用途/模型/模态/输入/输出）。
- 口径：本月 = 自然月；`modality` 为空的历史行计入文本。
- API：`GET /api/usage/overview`。
- 纪律：token 统计不进统计页，两页分离沿用原型。

## Workstream D：无目录试卷集合 flat 入库（3-C4）

### D1 触发

`kb.cli structure <doc_id>`：

- 目录页探测（SQL `LIKE '%目录%'`）失败 → 不再 `SystemExit`，自动回退 flat，日志明示「未找到目录页，回退整卷按页模式」。
- `--flat` 显式强制（防探测误命中假目录页）。
- `--toc-pages` 仍可指定，走 TOC 路径。

### D2 结构

- 建 1 条合成章：`chapter_no=1`、`title=文档名`、`content_md=全页采用内容以 \n\n 拼接`、taxonomy/tags 为 NULL。
- `documents.struct_mode` 置 `flat`（migration 0014：`ALTER TABLE documents ADD COLUMN struct_mode text CHECK (struct_mode IN ('toc','flat'))`，TOC 路径置 `toc`）——复核页、approve 分流、统计展示事都以此为准，不做启发式判定。
- 采用内容取法与 `structure._chapter_blocks` 一致：`adopted='page_md'` 的页用整页转录，其余页用块文本（跳过 header/footer）。
- 不建 items、不跑拆条。
  题目级拆条的价值在挂孩子做题记录，那是试卷管线（已实现）的事。

### D3 向量化

- 按页对齐切段：每页一段，超长页用 `segment_chapter` 逻辑再细分。
- `chunks.seg_no = page_no * 1000 + 段内序号`。
  确定性编号保证页重建不与其他页冲突，排序语义以 `meta.page_no` 为准。
- chunk meta 沿用 `embed_chapters` 的章节 meta 字段（kind/chapter/doc_title/subject/grade 等）并新增 `page_no`。
- 向量化时点对齐 PDF 复核流：页级通过 → 该页 chunk 即时向量化（删该页旧 chunk 后重插，幂等）。
- `kb.cli approve <doc_id>` 对 flat 文档 = 全部待复核页通过 + 全页向量化。

### D4 Task 13 口径偏差

原验收期望「命中试卷条目（题目级）」。
flat 路径交付页级章节 chunk 可检索（meta 带 page_no 可定位到页）。
3-A 计划 Task 13 Step 2-5 按此口径修订后执行。

## 对既有计划/规范的偏差汇总

- SSE `session` 事件 data 从裸 id 改为 `{ session_id, lane_id }` 对象（A1）。
- `GET /api/sessions/:id` 响应结构扩展（messages 带 entryId/thinking，新增 lanes/currentLane）（A1）。
- storage md 镜像刷新时点从「编辑即刷」改为「export 重算」（B3）。
- 旧静态复核页整体退役，approve 逻辑迁入 internal_api（B2/B4）。
- 3-A Task 13 Step 2 验收口径从题目级改为页级（D4）。

## 测试策略

TDD 全程（RED → GREEN → commit），每 workstream 独立可回归：

- backend vitest（真库）：lane 分支 handle（fork/分支读/兄弟树）、`branch_at`+`lane_id` 请求语义、thinking SSE 事件、删除路由、复核读/写路由、stats/usage 聚合 SQL。
- pipeline pytest：flat 回退触发、合成章落库、按页切段与 seg_no、internal approve-item / embed-flat-page。
- frontend vitest：markdown 渲染、thinking 面板折叠时序、复制按钮、分支切换器、删除确认、StatsView/UsageView 数据绑定。
- e2e（Playwright，真三服务）新增 4 条 spec：
  - 聊天增强全链路（编辑/rewind/regenerate/分支切换/thinking/markdown/复制/删除）。
  - 资料复核全链路（页图 bbox/块编辑/页通过/条目 approve 即时可检索/试搜）。
  - 统计用量（断言到 SQL 直查字段级一致）。
  - flat 入库 → 聊天检索（命中带 page_no 定位）。

## 错误处理

- `branch_at`/`lane_id` 非法或不存在 → 400，校验先于任何持久化（沿用 Phase 2 防毒化纪律）。
- 删除不存在的会话 → 404。
- 剪贴板失败 → toast 提示，不中断。
- 模型无 thinking 输出 → 无面板、无事件，不算错误。
- 复核写失败 → 500 + UI 错误文案（papers 风格）。
- flat 页向量化失败 → 页保持已通过、chunk 缺失可重试（approve 幂等重入）。

## 范围外

- 资料库页 web 化（上传/进度/导出管理页；原型有、从未排期，另行立项）。
- 会话重命名。
- thinking 内容编辑。
- 统计页自定义时间窗与导出。
- 多家长账号与权限。

## 验收

- 3-C1：编辑/rewind/regenerate 后旧分支可经 ‹i/n› 切回；thinking 当轮展开-自动折叠、回看可见且默认折叠；assistant 消息 markdown+LaTeX 正常渲染；单条/整会话复制内容正确；删除会话后列表与文件系统均无残留。
- 3-C2：React 复核页覆盖旧静态页全部高频操作（页复核/块编辑/条目 approve 即时可检索/试搜）；:8765 下线；三侧测试全绿。
- 3-C3：统计页数字与 SQL 直查一致（e2e 断言到字段）；用量页聚合与 `llm_calls` 对账。
- 3-C4：无目录 PDF `structure` 自动 flat 入库，聊天检索命中且定位到页；3-A Task 13 Step 2-5 按修订口径过验。
