# 家庭学习知识库

双栈：`frontend/`（React+Vite）、`backend/`（TS：pi-agent + 产品 API + 双路召回）、`pipeline/`（Python：解析管线 + migrations + rerank 服务）。

## 资料入库工作流

用户提供文档（PDF/docx/md）要求入库时：

1. 先从文件名和内容推断 `--subject`（语文/数学/英语/…）与 `--type`（workbook 练习册 / exam 试卷）。
2. **科目判断不了就先提问让用户选**，确认后再执行，不要猜。
3. 入库命令（在 pipeline/ 下）：
   `uv run python -m kb.cli ingest <文件> --title <书名> --subject <科目> --type <类型>`
   pdf / docx / md 同一条命令，按扩展名自动分流。
   docx/md 入库即完成**章节向量化**——不拆条也能被聊天检索到。
   章节向量化分段粒度由 `KB_CHUNK_MAX_CHARS`（默认 500）与 `KB_CHUNK_OVERLAP_RATIO`（默认 0.1）控制；已入库文档改配置后需重索引生效。
4. `structure <doc_id>` 拆条成题目级条目：`--type exam` 的文档（或显式 `--exam`）走试卷拆题——整卷转录文本按大题分批喂 LLM，提取成题目级 items + 答案配对；练习册走目录页→章节拆条；无目录页且非试卷的文档回退「整卷按页」模式（`--flat` 显式强制）。
5. 批量复核通过：`approve <doc_id>`（可 `--chapter N` 限章）。
   通过即自动向量化，之后聊天可检索到条目级内容；
   也可在复核页逐条 approve（同样即时向量化）。
6. 处理日志：每次 ingest/structure/approve/编辑/向量化都会写 `pipeline_events`（级别由 `KB_TRAJECTORY_LEVEL=verbose|simple|off` 控制，默认 simple）。
   复核页「处理日志」tab 按文档查 run 时间线，页详情「本页日志」按页查；JSONL 镜像在 `pipeline/storage/<doc_id>/trajectory/<run_id>.jsonl`。
7. 落盘镜像：`export <doc_id>`。

## 开发启动

一键起三服务（pipeline :8766 + backend :8787 + frontend :5200）：在**仓库根目录**执行 `node scripts/start.mjs`（Ctrl+C 全停，跨平台）。

- pipeline：`cd pipeline && uv run pytest tests/`（测试需 KB_TEST_DATABASE_URL）
  版面切块默认启用（PP-DocLayoutV3），需 paddlepaddle/paddleocr 依赖（pyproject 已声明），首次运行自动下载模型约 125MB 到 ~/.paddlex；`KB_LAYOUT_MODEL=PP-DocLayoutV2` 可切回 V2。
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

## 边界纪律

- schema 只能由 pipeline/kb/migrations/ 变更。
- 检索主链路的向量/BM25 在 backend（TS）；只有 rerank 调 pipeline 的 /internal/rerank。
- DB 图片路径（pages.image_path / blocks.crop_path / paper_questions.image_path）一律相对 KB_STORAGE_DIR；读取走 `kb/core/paths.py` resolve_storage_path（pipeline）/ `src/storagePath.ts`（backend）。md 是只写镜像，搬目录必须 storage/<doc_id>/ 整目录搬。
- DB 内容的事实来源是 PostgreSQL；storage/ 下的 md 是只写镜像。
