# kids-knowledge-base

小孩学习资料知识库：扫描版习题 PDF -> 结构化条目 -> 混合检索。

后端代码与依赖统一在 `pipeline/` 下（`kb/` 包、`tests/`、pyproject 与 .venv）；
根目录仅保留探索期脚本与 `resources/` 素材。

## 流水线（骨架期）

在 `pipeline/` 目录下执行：

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
- `pair_items` 按 label 精确配对 answer ↔ exercise/example；题号连续性检查（`missing_item`，支持纯数字与 "3-1" 式分组题号）进复核队列（不自动关闭）。

## 检索期：向量化与语义查询

```bash
uv run python -m kb.cli embed            # approved 条目 -> bge-m3 -> pgvector（幂等）
uv run python -m kb.cli search "除法竖式 倒推法"                    # 混合检索（默认 hybrid）
uv run python -m kb.cli search "..." --mode vector --rerank        # 单向量 / 加 cross-encoder 重排
```

- 混合检索：向量（bge-m3）+ BM25（纯 Python，CJK 字符二元分词）按 RRF(k=60) 融合；
  `--rerank` 用本地 FlagEmbedding 加载 bge-reranker-v2-m3 重排候选（ollama 无 rerank 接口，
  依赖 `uv sync --extra rerank`；注意多个 extra 要一起 sync：`--extra layout --extra rerank`）

- 向量化单元 = 条目（chunk 挂 `item_id`），只有人工确认（`qc_status='approved'`）的条目进库；
  条目被编辑后旧向量自动失效，下次 `embed` 重建
- meta 带 subject/grade/chapter/taxonomy/tags/label/页码，`search()` 支持 filters 精确过滤 + 语义混排
- embedding 默认本地 ollama bge-m3（1024 维），`KB_EMBED_BASE_URL`/`KB_EMBED_MODEL` 可配置；
  pgvector HNSW 索引，余弦距离
- 复核页「检索」tab 可直接查询，命中卡片点进条目详情（含溯源裁图）
- `assemble_chapter` 把采用版本的页内容拼成章节 markdown（完整文档产物，adopted=page_md 用整页稿）

## 版面质量返工：PaddleOCR-VL 整管线重处理

PP-DocLayoutV2 对密集数学页切块过碎（20-30 块/页、阅读顺序断）时，整管线（PP-DocLayoutV3 + PaddleOCR-VL-1.5）重处理指定页：

```bash
KB_LAYOUT_ENGINE=paddleocr uv run --extra layout python -m kb.cli reprocess <doc_id> --pages 9-15
# 然后对空内容块（竖式图等）补转录：run_parse 会自动拾取 content_md IS NULL 的块
```

破坏性操作：删指定页旧块（级联复核行）与页码相交章节的 items，需重跑 `structure` 重建。实测 ~1-3 分钟/页。

设计文档：`docs/superpowers/specs/2026-08-31-pdf-parsing-pipeline-design.md`
实施计划：`docs/superpowers/plans/2026-08-31-pdf-pipeline-phase1.md`（骨架期）、
`2026-08-31-pdf-pipeline-phase2a-layout.md`（版面+分级解析）、
`2026-08-31-pdf-pipeline-phase2b-structure.md`（结构化拆分）

## 人工复核（页级 web 页）

```bash
cd pipeline && uv run python -m kb.cli review   # http://127.0.0.1:8765
```

以页为单位：待复核 = 有 pending 复核行的页；已通过 = 干净的 parsed 页（自动归入，无需逐页点）。
点进页详情看整页扫描图 + 区块 bbox 高亮（红框=有问题），点击块在右侧查看/编辑转录
（Markdown + KaTeX 渲染）；「✓ 整页通过」关掉该页全部 pending 行，「✗ 打回本页」建页级
自定义行。已通过的页仍可编辑（改坏了会自动新建可检测行）和打回。
版面类问题（layout_gap/layout_overlap）重跑版面后机器复算自动关闭。
