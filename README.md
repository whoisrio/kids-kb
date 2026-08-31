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

五阶段骨架：渲染 -> 版面分析 -> 分级解析 -> 质检 -> 复核队列；
各阶段幂等、可断点重跑，输入输出落 PostgreSQL（含 pgvector 扩展，本期只建表）。

## 精度期 2a：版面引擎与质检升级

- 版面引擎开关：`KB_LAYOUT_ENGINE=paddleocr`（需 `uv sync --extra layout`）。
  选型实测：完整 PaddleOCR-VL 质量 SOTA 但 Mac CPU 353s/页（逐块 VLM 识别我们用不上）；
  改用版面专用模型 PP-DocLayoutV2，实测 ~5s/页，识别仍走③分级路由（文本→rapidocr，公式/图/表→视觉模型）。
- 质检三层：L1 规则（empty/maybe_truncated，自动关闭）；
  L2 公式 KaTeX 校验（bad_latex，可自动关闭，需本机 node）；
  L3 双模型比对（`KB_VISION_COMPARE_MODEL` 配置第二渠道，llm_disagree 只进不出、人工裁决）。
- 黄金集区块级：`golden-annotate <doc_id>` 导出区块标注底稿（人工校对），
  `golden-check <doc_id> --level block` 报区块匹配率/类型准确率/内容 CER。

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

## 精度期 2b：结构化拆分

```bash
uv run python -m kb.cli structure <doc_id> [--toc-pages 5]   # 目录页不给则自动探测
```

- 目录页经视觉模型解析进 `chapters` 表：章节/印刷页码/分类(taxonomy)/思想方法(tags)，是该书词表的唯一事实来源；
- `calibrate_pages` 用章节标题在块文本中的首次出现定位物理页范围（印刷页码≠物理页码；目录页含所有标题，搜索时排除）；
- 按章节窗口（非单页）喂文本模型拆条，跨页题目天然合并；taxonomy/tags 从该章词表注入，模型不自由发挥；
- `pair_items` 按 label 精确配对 answer ↔ exercise/example；题号连续性检查（`missing_item`）进复核队列（不自动关闭）。

设计文档：`docs/superpowers/specs/2026-08-31-pdf-parsing-pipeline-design.md`
实施计划：`docs/superpowers/plans/2026-08-31-pdf-pipeline-phase1.md`（骨架期）、
`2026-08-31-pdf-pipeline-phase2a-layout.md`（版面+分级解析）、
`2026-08-31-pdf-pipeline-phase2b-structure.md`（结构化拆分）

## 人工复核（最简 web 页）

```bash
cd backend && uv run python -m kb.cli review   # http://127.0.0.1:8765
```

待复核/已通过/已打回三个页签；每条记录左侧裁图、右侧转录文本并排；
转录渲染为可读 Markdown + LaTeX（KaTeX，本地静态资产，DOMPurify 消毒）；「✓ 通过 / ✗ 打回」直接回写 `review_queue.status`。
打回后的重解析走既有断点重跑（`ingest` 重跑即可）。
