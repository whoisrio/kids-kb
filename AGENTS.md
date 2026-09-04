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
4. PDF（docx/md 可选）跑 `structure <doc_id>` 拆条成题目级条目。
5. 批量复核通过：`approve <doc_id>`（可 `--chapter N` 限章）。
   通过即自动向量化，之后聊天可检索到条目级内容；
   也可在复核页逐条 approve（同样即时向量化）。
6. 落盘镜像：`export <doc_id>`。

## 开发启动

一键起三服务（pipeline :8766 + backend :8787 + frontend :5200）：在**仓库根目录**执行 `node scripts/start.mjs`（Ctrl+C 全停，跨平台）。

- pipeline：`cd pipeline && uv run pytest tests/`（测试需 KB_TEST_DATABASE_URL）
- backend：`cd backend && npm test`（真库测试需 KB_TEST_DATABASE_URL）/ `npm run dev`（8787）
- frontend：`cd frontend && npm run dev`（5200，proxy 到 8787）
- e2e：`cd e2e && npm test`（全栈 Playwright，见下）

## 实际效果验证（E2E 纪律）

验证产品实际效果时，**必须用 e2e/ 下的 Playwright 用例**（真实三服务 + ollama + PostgreSQL，断言到 UI、API、JSONL、DB 字段），不允许用 ego-browser 之类的临时浏览器驱动代替——一次性验证不可回归，用例才是资产。新增页面/链路时同步补 spec。

- 运行：`cd e2e && npm test`。Playwright 自动拉起缺失的服务（在跑的复用），需本机 ollama 与 PostgreSQL 就绪。
- 前置：模型切换用例需 ≥2 个注册模型（config 里 CHAT_MODELS，e2e 默认 `qwen3.5:4b,qwen3.5:2b`）。

## 边界纪律

- schema 只能由 pipeline/kb/migrations/ 变更。
- 检索主链路的向量/BM25 在 backend（TS）；只有 rerank 调 pipeline 的 /internal/rerank。
- DB 内容的事实来源是 PostgreSQL；storage/ 下的 md 是只写镜像。
