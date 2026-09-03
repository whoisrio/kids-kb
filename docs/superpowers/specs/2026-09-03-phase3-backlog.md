# Phase 3 待办清单（backlog）

> 来源：Phase 2 试卷管线上线后的实际使用反馈与 code review（2026-09-03）。
> Phase 3（复核页迁移 React + 统计页 + 用量页，见 `2026-09-02-overall-system-design.md` 分期表）开工时，从此清单拣选并入 spec/plan，逐项消化后从本文件划掉。

## P0：解析失败时看不到原始文件

**现象**：试卷加工失败（status=failed）后，复核视图只显示「处理失败 + 重试」，原始上传件无处可看。
家长无法判断是照片拍糊了/传错文件，还是系统识别挂了；重试也不知道在重试什么。

**现状约束**：

- `frontend/src/views/ReviewView.tsx` 的 failed 分支只渲染 fail-box，不加载任何页图。
- backend 只有页图回传 `GET /api/papers/:id/pages/:n/image`，没有 source.pdf 原件回传 API。
- 页图由 pipeline 渲染（逐页、先渲染后 VLM）；失败发生在渲染之前（如 PDF 打不开）时页图一张都没有，即使前端想展示也无图可用。
- VLM 中途失败时已渲染的页图在 storage 里存在，但 failed 视图同样不展示。

**修复方向**：

- backend 加 `GET /api/papers/:id/source.pdf`：读 pipeline storage 的 `papers/<id>/source.pdf` 回传（`application/pdf`）。
  source.pdf 是 pipeline 加工的第一步就落盘的，只要上传到达过 pipeline 就一定有，比页图更可靠。
- failed 详情页嵌入原件预览：有页图展示页图，没页图给 source.pdf 链接/内嵌。
- 成功卷也补「查看整卷原件」入口：现在只有当前题的裁图（缺失才回退整页），拆题拆错时家长只能逐题看，没有整卷视角。

## P0 关联：坏上传件的死循环

pipeline 先写 `source.pdf` 再 `fitz.open` 验证（`pipeline/kb/paper_pipeline.py` ingest_paper）：

- 坏 PDF 会留下 0 字节残留文件；
- 该卷 status=failed 后点重试，drivePaper 不带 bytes 复用坏文件，永远以同一错误失败，只能重新上传一张新卷（没有删除/重传入口）。

修复方向：pipeline 先验证再落盘；或 retry 支持带新文件重传。可与 P0 一并处理。

## P1：Phase 2 code review 遗留 Minor（2026-09-03，均已确认未处理）

| # | 问题 | 位置 |
|---|---|---|
| 1 | 非 UUID id 在 retry / re-recognize / candidates / image 返回 500，confirm / match / 详情返回 422，同族错误语义不一致 | `backend/src/routes/papers.ts`、`paperQuestions.ts` |
| 2 | matchQuestion topK=5（spec 写 10）；subject 过滤在 RRF 融合后做，两路召回是全局 top-20，同学科真命中可能被其他学科挤出窗口，应下推进 SQL | `backend/src/retrieval/match.ts`、`search.ts` |
| 3 | re-recognize 后整卷重跑自动匹配（`matched_item_id IS NULL` 不限页），家长人工清除过的匹配会被自动匹配重新挂上 | `backend/src/papers/jobs.ts` |
| 4 | 坏 PDF（损坏/加密）在 assemblePdf 抛 pdf-lib 解析错误 → 500 而非 422；前端 `json()` 只抛「请求失败: 422」，丢服务端 `{error}` 文案 | `backend/src/papers/assemble.ts`、`frontend/src/api/papers.ts` |
| 5 | internal_api 每请求 `connect()` 新连接，靠 GC 关闭；建议 try/finally close 或池化 | `pipeline/kb/internal_api.py` |
| 6 | 试卷队列无孩子维度：`fetchPapers()` 不传 childId，多孩家庭队列混排且队列项不显示孩子名 | `frontend/src/views/ReviewView.tsx` |
| 7 | 匹配浮层打开时键盘 1/2/3 仍可能确认底层题（焦点守卫只覆盖大多数场景）；确认失败只有 console.error 无 UI 反馈 | `frontend/src/views/ReviewView.tsx` |
| 8 | `storageRoot` 相对 cwd 解析（`../pipeline/storage`），从仓库根直接 `node backend/dist/index.js` 会指向仓库外；建议相对 `import.meta.url` 解析 | `backend/src/config.ts` |
| 9 | migration 0012 去重用 `created_at <`，若历史重复行时间戳完全相同会双双保留导致建索引失败（概率极低；可用 `ctid` 排序兜底） | `pipeline/kb/migrations/0012_papers_attempts_unique.sql` |
| 10 | 队列里 failed 卷的「重试」是不可点的 span，看着像按钮；实际入口在详情页 | `frontend/src/components/PaperQueue.tsx` |

## 备注

- pipeline 与 backend 的测试共用 `kb_test` 且各自 DROP SCHEMA，**绝不能并行跑**（互相污染出假失败）。
- pipeline 服务（`serve-internal`）改代码必须重启进程；backend（tsx watch）与 frontend（Vite）会自动热载。
