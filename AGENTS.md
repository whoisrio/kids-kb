# 家庭学习知识库

双栈：`frontend/`（React+Vite）、`backend/`（TS：pi-agent + 产品 API + 双路召回）、`pipeline/`（Python：解析管线 + migrations + rerank 服务）。

## 资料入库工作流

用户提供文档（PDF/docx）要求入库时：

1. 先从文件名和内容推断 `--subject`（语文/数学/英语/…）与 `--type`（workbook 练习册 / exam 试卷）。
2. **科目判断不了就先提问让用户选**，确认后再执行，不要猜。
3. 入库命令（在 pipeline/ 下）：
   `uv run python -m kb.cli ingest <文件> --title <书名> --subject <科目> --type <类型>`
   pdf 与 docx 同一条命令，按扩展名自动分流。
4. 完成后跑 `structure <doc_id>` 拆条、`export <doc_id>` 落盘镜像。

## 开发启动

- pipeline：`cd pipeline && uv run pytest tests/`（测试需 KB_TEST_DATABASE_URL）
- backend：`cd backend && npm test`（真库测试需 KB_TEST_DATABASE_URL）/ `npm run dev`（8787）
- frontend：`cd frontend && npm run dev`（5173，proxy 到 8787）

## 边界纪律

- schema 只能由 pipeline/kb/migrations/ 变更。
- 检索主链路的向量/BM25 在 backend（TS）；只有 rerank 调 pipeline 的 /internal/rerank。
- DB 内容的事实来源是 PostgreSQL；storage/ 下的 md 是只写镜像。
