# 家庭学习知识库

双栈：`frontend/`（React+Vite）、`backend/`（TS：pi-agent + 产品 API + 双路召回）、`pipeline/`（Python：解析管线 + migrations + rerank 服务）。

## 资料入库工作流

入库入口有两条，殊途同归（都走同三个 ingest 函数，source_path 为幂等键）：

- **UI**：资料库页「上传新教辅 / 试卷」→ `POST /api/library/docs`（multipart，标题缺省取文件名）→ backend 预插 documents（`parse_status='pending'`）并后台驱动 pipeline `POST /internal/ingest-doc`（同步 parse，30 分钟超时）。
  doc 级 `parse_status` 口径：`pending` 待检测 → `parsing` 检测中 → `parsed` / `failed`；书架卡片按此显示「待检测/检测中 x/y 页/检测失败」，检测态下每 4s 轮询。
  backend 重启时 `redriveStuckDocs` 重驱动滞留在 pending/parsing 的文档（pipeline 幂等）。
  上传只到 parse（layout + OCR + VLM 公式识别）为止；structure/approve 仍走下述 CLI/复核页。
- **CLI**（用户直接给文件要求入库时）：按下述 1-7 步。

用户提供文档（PDF/docx/md）要求入库时：

1. 先从文件名和内容推断 `--subject`（语文/数学/英语/…）与 `--type`（workbook 练习册 / exam 试卷）。
2. **科目判断不了就先提问让用户选**，确认后再执行，不要猜。
3. 入库命令（在 pipeline/ 下）：
   `uv run python -m kb.cli ingest <文件> --title <书名> --subject <科目> --type <类型>`
   pdf / docx / md 同一条命令，按扩展名自动分流。
   docx/md 入库即完成**章节向量化**——不拆条也能被聊天检索到。
   分段粒度由 `KB_CHUNK_MAX_CHARS`（默认 500）控制——章节向量化和 flat 页级切分/「预览切分」都吃它（章节另有 `KB_CHUNK_OVERLAP_RATIO`（默认 0.1）的相邻段重叠，flat 页无重叠）；已入库文档改配置后需重索引生效。
   pdf 入库的 parse 阶段：text/title 块 OCR 疑似公式升级 VLM 转录时，VLM 判 [FORMULA]（或转录整体就是一个 $$…$$ 块的确定性兜底）会把 block_type 改判为 formula 并记 `block_type_origin='vlm'`（默认 'layout'），复核页块头显示「VLM改判」徽标；figure 块转录整体是 $$…$$ 时同样改判（竖式常被版面误判成图）；header/footer 永不改判。
   qc 后自动判定页类型（`pages.page_type`，0023）：`content` 正文 / `toc` 目录 / `ad` 广告 / `cover` 封面。
   非内容页默认置 `excluded_from_index=true`——页图与块原文保留，但 structure 拆题窗口、assemble 章稿、flat 页向量化、条目向量化（经 item_blocks 关联）一律跳过。
   判定保守（广告页需命中广告关键词且无题目特征，正文页的「扫码看视频」不会误判），且只降级不升级：人工经 `/internal/page-exclusion` 恢复的页不会被重判覆盖。
   页类型判定后跑 heading 阶段（0024）：本地小模型给标题块判层级 1/2/3 写 `blocks.title_level`（NULL=未判定），候选为 title 块 + 带「第N讲/章/节/课/单元」编号线索的 text 块，excluded 页不入选；幂等只补未判定块（坏批留 NULL 断点续跑），模型渠道 `HEADING_*` 留空逐项回落 `DOC_OGNIZE_*` → `KB_VISION_*`。
4. `structure <doc_id>` 拆条成题目级条目：`--type exam` 的文档（或显式 `--exam`）走试卷拆题——整卷转录文本按大题分批喂 LLM，提取成题目级 items + 答案配对；练习册走目录页→章节拆条；无目录页且非试卷的文档，若有 ≥2 个一级标题（blocks.title_level=1，0024）走 heading 模式——一级标题确定性合成章节后与目录路径同路逐章拆条（`documents.struct_mode='heading'`，approve 分流同 toc），否则回退「整卷按页」模式（`--flat` 显式强制）。
5. 批量复核通过：`approve <doc_id>`（可 `--chapter N` 限章）。
   通过即自动向量化，之后聊天可检索到条目级内容；
   也可在复核页逐条 approve（条目 tab 详情页或页详情题目视图的「✓ 确认」，同样即时向量化）。
6. 处理日志：每次 ingest/structure/approve/编辑/向量化都会写 `pipeline_events`（级别由 `KB_TRAJECTORY_LEVEL=verbose|simple|off` 控制，默认 simple）。
   复核页「处理日志」tab 按文档查 run 时间线，页详情「本页日志」按页查；JSONL 镜像在 `pipeline/storage/<doc_id>/trajectory/<run_id>.jsonl`。
7. 落盘镜像：`export <doc_id>`。

## 开发启动

一键起三服务（pipeline :8766 + backend :8787 + frontend :5200）：在**仓库根目录**执行 `node scripts/start.mjs`（Ctrl+C 停掉本次拉起的，跨平台）。
幂等：已在运行的服务（健康检查可达）自动跳过不重复启动；`--force` 先杀占端口进程再全部重启（改了 pipeline 代码后用它让 8766 吃到新代码——pipeline 无热更新，backend tsx watch / frontend vite 会自动热载）。

- pipeline：`cd pipeline && uv run pytest tests/`（测试需 KB_TEST_DATABASE_URL）
  版面切块默认启用（PP-DocLayoutV3），需 paddlepaddle/paddleocr 依赖（pyproject 已声明），首次运行自动下载模型约 125MB 到 ~/.paddlex；`KB_LAYOUT_MODEL=PP-DocLayoutV2` 可切回 V2。
  小图标/装饰图块在 layout 层直接丢弃（连裁图都不生成）：figure 块面积占页比 < `KB_LAYOUT_MIN_FIGURE_RATIO`（默认 0.005）即丢弃，设 0 关闭；纯二维码图块无条件丢弃。
- backend：`cd backend && npm test`（真库测试需 KB_TEST_DATABASE_URL）/ `npm run dev`（8787）
- frontend：`cd frontend && npm run dev`（5200，proxy 到 8787）
- e2e：`cd e2e && npm test`（全栈 Playwright，见下）

## 实际效果验证（E2E 纪律）

验证产品实际效果时，**必须用 e2e/ 下的 Playwright 用例**（真实三服务 + ollama + PostgreSQL，断言到 UI、API、JSONL、DB 字段），不允许用 ego-browser 之类的临时浏览器驱动代替——一次性验证不可回归，用例才是资产。新增页面/链路时同步补 spec。

- 运行：`cd e2e && npm test`。Playwright 自动拉起缺失的服务（在跑的复用），需本机 ollama 与 PostgreSQL 就绪。
- 前置：模型切换用例需 ≥2 个注册模型（config 里 CHAT_MODELS，e2e 默认 `qwen3.5:4b-32k,qwen3.5:2b`）。

## 出题（薄弱点强化练习）

统计页「针对薄弱点出题」→ LLM 按弱知识点（stats 同口径 top5 tag + 题库 approved 例题做参考）出题 → 练习页（?view=quiz）作答 → 判分（选择题本地集合相等判分；简答 AI 判分，解析失败半分兜底）→ 逐题写 attempts（quiz_question_id 来源，result ≥80% correct / >0 partial / 否则 wrong，实得分存 note）→ 统计/待重练自动更新。

- 出题/判分 prompt 与判分逻辑移植自 openMAIC（MIT）：出题模板 `backend/src/quiz/prompts.ts`、判分 `backend/src/quiz/grading.ts`、归一化 `backend/src/quiz/normalize.ts`（兼容 LLM 输出的 string options / correctAnswer 写法）。
- 生成的题落 quizzes/quiz_questions（0021），**不回写 items**（不污染精校题库、不向量化）。
- backend 一次性非流式 LLM 调用走 `src/llm.ts` makeCallText（chatBaseUrl + chatModels[0]），计量 purpose='quiz'。
- 练习页样式 scoped 在 `.qz-root`（`frontend/src/quiz.css`，openMAIC 风 token：品牌紫 #722ed1），不碰 theme.css。

## 呈现口径：原文档图像为主，解析文本为辅

解析文本用于检索/比对/判分，呈现优先用原文档的图（页图看原书上下文，题目级裁图做刷题/比对）。
题库条目块混合渲染走 `frontend/src/components/ItemBlocksPreview.tsx`：text/title 渲染 Markdown，formula/figure/table 用裁图（原比例只缩不放，裁图 404 回退块文本）。
试卷比对已按此落地：`GET /api/paper-questions/:id/candidates` 的候选带 `blocks[].crop_url`，QuestionCard 已匹配题显示「题库原题对照」裁图区，MatchPicker 候选卡带裁图。

## 边界纪律

- schema 只能由 pipeline/kb/migrations/ 变更。
- 检索主链路的向量/BM25 在 backend（TS）；只有 rerank 调 pipeline 的 /internal/rerank。
- DB 图片路径（pages.image_path / blocks.crop_path / paper_questions.image_path）一律相对 KB_STORAGE_DIR；读取走 `kb/core/paths.py` resolve_storage_path（pipeline）/ `src/storagePath.ts`（backend）。md 是只写镜像，搬目录必须 storage/<doc_id>/ 整目录搬。
- DB 内容的事实来源是 PostgreSQL；storage/ 下的 md 是只写镜像。
