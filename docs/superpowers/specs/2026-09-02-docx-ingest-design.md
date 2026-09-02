# docx 解析路径设计

日期：2026-09-02
状态：待评审

## 背景

现有管线只支持扫描版 PDF：渲染成页图 → 版面切块 → OCR/VLM 转录 → 章节拆条。
用户手里的另一类资料是 word 文档（如公众号下载的《语法一阶 期末测试》），自带文字层，不需要渲染与 OCR。
目标：docx 也能进同一条"章节拆条 → items → 复核 → 向量化"的下游，改动最小化。

## 方案总览

pandoc 把 docx 转成 gfm markdown，按标题切章存进 `chapters.content_md`，复用现有 `structure_chapter` 的 LLM 拆条。
docx 文档没有页概念：不写 `pages`/`blocks`，条目不溯源块。

## 数据流

```
docx ──pandoc──> markdown（+media 图片落盘）
                   │
                   ├─ 按 markdown 标题切章 ──> chapters 行（content_md=该章原文）
                   │
                   └─ structure_chapter：章有 content_md 则直接作章节窗口喂 LLM
                                              │
                                              └─> items（无 item_blocks）
```

## schema 变更

`0009_chapters_content_md.sql`：

```sql
ALTER TABLE chapters ADD COLUMN content_md TEXT;
```

PDF 章节该列为 NULL；docx 章节存该章 markdown 原文。
第一个标题之前的卷首内容并入第一章的 content_md，不单独存整份文档。

## 各模块改动

### `kb/docx_ingest.py`（新）

`ingest_docx(conn, cfg, path, title, subject, grade, doc_type) -> doc_id`：

1. 插 `documents` 行（`page_count=0`，`has_text_layer=true`）。
2. `pandoc -f docx -t gfm --extract-media=storage/<doc_id>` 转 markdown，图片落 `storage/<doc_id>/media/`，markdown 里保留相对引用。
3. 按一级/二级标题切章，写 `chapters`（chapter_no 按顺序编号，title 取标题文本，content_md 存原文，page_start/page_end 留 NULL）。
   无任何标题时整份文档作为单章（title 取文档标题）。
4. 末尾调用 `export_chapter_mds` 落章稿镜像。

### `kb/structure.py`

`structure_chapter` 开头分支：章有 `content_md` 则窗口就是这份文本（单个伪块，无 block_ids 可溯源，`item_blocks` 为空）；否则走现有 `_chapter_blocks`。
`page_start IS NULL` 且 `content_md IS NULL` 才跳过。
items 的 `page_start/page_end` 对 docx 章为 NULL。

### `kb/assemble.py` / `kb/export_md.py`

`assemble_chapter`：章有 `content_md` 直接返回它（带 `<!-- cNN -->` 注释头），不再查 pages。
docx 文档无页，`export_page_mds` 自然不写任何文件；章稿镜像照常出 `storage/<doc_id>/chapters/cNN.md`。

### `kb/grounding.py`

`sync_item_grounding` 的源文本获取加回落：item 无 `item_blocks` 时，用该 item 所在章的 `chapters.content_md` 作接地面（按 document_id + chapter 标签关联），避免 docx 条目全部被误报 `no_source:`。

### `kb/cli.py`

`ingest` 命令按扩展名自动分流：`.docx` 走 `ingest_docx`，其余走现有 PDF 管线。
`structure` 命令无需改：`extract_toc` 见已有章节直接返回 0，`calibrate_pages` 对无块文档是 no-op，`structure_chapter` 走新分支。

### 不动的部分

- QC（run_qc / crosscheck）是页/块级机制，docx 路径不经过。
- 复核 web 页：条目级复核直接可用（溯源块列表为空）；页级复核对 docx 文档为空列表，属预期。
- embed / search：从 items 出向量，无感知。

## AGENTS.md（仓库根，新建）

写 ingest 工作流约定：

- 用户提供文档时，先从文件名和内容推断 `--subject` 与 `--type`。
- 判断不了科目时，必须先提问让用户选择（语文/数学/英语/其他），确认后再执行 ingest。
- PDF 与 docx 用同一条 `ingest` 命令。

## 测试策略

- 测试 fixture 用 pandoc 现场把 markdown 合成 docx（环境已有 pandoc），不依赖真实样本。
- 覆盖：ingest_docx 切章入库、structure 走 content_md 分支出 items、grounding 不误报 no_source、assemble/export 出章稿。
- 真实样本《语法一阶 期末测试》到位后跑一次真实 ingest 人工验收。

## 后续方向（本轮不实现）

孩子学习进展记录是项目级目标：每题记 对/错/半对 + 错因（粗心/概念不清/方法不会/计算错，中文受控词表）+ 备注，追加式历史表 `attempts`。
录入走复核 web 页条目上的"标记"按钮，出进展报告走 CLI `report`。
本轮只把题目拆成可稳定引用的 items（题号 label），为记录打基础。

## 范围外

- docx 图片不进 `item_blocks` 溯源，条目 content_md 里只留图片相对路径。
- 不做 LibreOffice 转 PDF 的统一管线方案。
- 页级/块级复核 UI 对 docx 的适配。
