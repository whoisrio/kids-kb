# kids-knowledge-base

小孩学习资料知识库：扫描版习题 PDF -> 结构化条目 -> 混合检索。

后端代码与依赖统一在 `backend/` 下（`kb/` 包、`tests/`、pyproject 与 .venv）；
根目录仅保留探索期脚本与 `resources/` 素材。

## 流水线（骨架期）

在 `backend/` 目录下执行：

```bash
uv sync
createdb kb && cp .env.example .env   # 按需改成真实视觉模型端点
uv run python -m kb.cli migrate
uv run python -m kb.cli ingest <pdf> --title 书名 --subject 数学 --grade 四年级 [--start 1 --end 8]
uv run python -m kb.cli status
uv run pytest                          # 测试需 KB_TEST_DATABASE_URL（如 postgresql://localhost/kb_test）
```

五阶段骨架：渲染 -> 整页版面 -> 视觉解析 -> 质检 lite -> 复核队列；
各阶段幂等、可断点重跑，输入输出落 PostgreSQL（含 pgvector 扩展，本期只建表）。

## 黄金集基线（骨架期，qwen3.8-27b 整页转录）

《7星学霸题中题数学4年级第7辑》第 5~8 页，人工校对后 `golden-check` 实测：

| 页 | 内容 | CER |
|---|---|---|
| p5 | 目录（转录会幻觉出无关公式前缀） | 0.337 |
| p6 | 第 1 讲正文 | 0.190 |
| p7 | 第 1 讲解析 | 0.112 |
| p8 | 第 1 讲思维导图/例题 | 0.248 |
| 平均 | | 0.222 |

结论：整页 VLM 转录无法满足“文本必须准确”的目标，
精度期需按设计切换 PaddleOCR-VL 版面分析 + 分区块解析。

设计文档：`docs/superpowers/specs/2026-08-31-pdf-parsing-pipeline-design.md`
实施计划：`docs/superpowers/plans/2026-08-31-pdf-pipeline-phase1.md`

## 人工复核（最简 web 页）

```bash
cd backend && uv run python -m kb.cli review   # http://127.0.0.1:8765
```

待复核/已通过/已打回三个页签；每条记录左侧裁图、右侧转录文本并排；
转录渲染为可读 Markdown + LaTeX（KaTeX，本地静态资产，DOMPurify 消毒）；「✓ 通过 / ✗ 打回」直接回写 `review_queue.status`。
打回后的重解析走既有断点重跑（`ingest` 重跑即可）。
