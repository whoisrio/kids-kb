# Pipeline Trajectory 日志设计

日期：2026-09-07
状态：已确认（用户逐节批准）

## 背景与目标

pipeline 解析对用户是黑盒，质量难以定位。
需要把每一步 OCR / VLM 调用（初始解析、质检、双模型比对、整页 VLM）、用户主动修改、structure 拆条、向量化等操作像 trajectory 一样完整记录。
目标有二：方便用户查阅（by 文档 / by 页），方便后续问题定位。
记录级别支持 verbose（完整输入输出）/ simple（摘要）/ off（不记录）配置。

## 总体方案

新增 `pipeline_events` 事件表（PostgreSQL，事实来源）+ `storage/` 下 JSONL 只写镜像。
pipeline 侧封装统一的 `Recorder` 埋点层；用户编辑由 backend `review.ts` 直写。
查询走 backend 新 API 直读 DB，前端在文档与页面两个维度展示。

## 事件模型

核心抽象是 run + event。

- 每次操作（一次 ingest、一次 structure、一次 approve、一次用户编辑、一次 reindex）是一个 run，用 `run_id`（UUID）标识。
- run 内发生的每件事是一条 event，按 `created_at` 排序即为 trajectory。
- 不建 runs 表；run 的元信息（命令、参数、触发来源 cli/api/backend）放在该 run 第一条 `stage_start` 事件的 payload 里，run 列表查询用 `DISTINCT run_id` + 首条事件。

### 表结构（`pipeline/kb/migrations/0017_pipeline_events.sql`）

```
pipeline_events
  id                BIGSERIAL PK
  run_id            UUID NOT NULL
  document_id       UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE
  page_id           UUID NULL REFERENCES pages(id) ON DELETE CASCADE
  item_id           UUID NULL REFERENCES items(id) ON DELETE SET NULL
  stage             TEXT NOT NULL   -- render|layout|parse|qc|crosscheck|page_vlm
                                    -- |structure|approve|user_edit|embed|export|reindex
  event_type        TEXT NOT NULL   -- stage_start|stage_end|llm_call|decision|edit|error
  summary           TEXT NOT NULL   -- 一行人读摘要，simple 模式也只写这个
  payload           JSONB NULL      -- verbose 才写：完整 prompt、原始输出、编辑 diff 等
  model             TEXT NULL
  prompt_tokens     INT NULL
  completion_tokens INT NULL
  duration_ms       INT NULL
  status            TEXT NOT NULL DEFAULT 'ok'  -- ok|error|skipped
  actor             TEXT NOT NULL DEFAULT 'pipeline'  -- pipeline|user
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
```

索引：`(document_id, created_at)`、`(document_id, page_id, created_at)`、`(run_id)`。

取舍：

- `page_id` 冗余于 `document_id`，by 页查看直接过滤，删页/删文档级联清。
- 图片不落库，payload 只存 `crop_path`/`image_path` 引用，不存 base64。
- `summary` 永远写、`payload` 仅 verbose 写，这是 simple/verbose 分级的落点。
- 生命周期随文档：删文档级联删事件，不做额外保留/清理策略。

## 埋点与配置

### Recorder（`pipeline/kb/traj.py`）

- `Recorder(run_id, document_id, config)`，方法：`start(stage, …)` / `llm_call(stage, page_id, …)` / `decision(...)` / `error(...)` / `end(...)`。
- 所有记录统一走 Recorder：按级别裁剪 → 写 `pipeline_events` → 追加 JSONL。
- 记录失败只打印警告，绝不阻塞主链路。

埋点位置：

- `metering.record_llm_call()` 扩展为可选接收 recorder；所有 LLM/VLM 调用（parse、qc、crosscheck、page_vlm、structure 的 LLM 拼条）自动产生 `llm_call` 事件，token 数从 metering 复用。
- 编排函数（`pipeline.py:ingest`、`structure.py:run_structure`、`embed.py:approve_items/embed_*`、`flat.py`）在阶段边界埋 `stage_start/stage_end`。
- CLI 与 internal API 共用核心函数，两条入口自动覆盖。
- 用户编辑在 backend `review.ts` 的 `PATCH /items|blocks|pages/:id` 处理里写 `user_edit` 事件（actor=user，payload 存 `{field, old, new}` diff），每次编辑自成一 run；backend 直写 DB。

### 分级配置

`config.py` 加 `KB_TRAJECTORY_LEVEL=verbose|simple|off`，默认 `simple`，`pipeline/.env.example` 同步。

- `verbose`：summary + 完整 payload（prompt 全文、模型原始输出、耗时、token、编辑 diff）。
- `simple`：只写 summary + 元信息（stage、model、tokens、duration、status），payload 留空。
- `off`：pipeline 侧完全不写。
- backend 的 `user_edit` 不受此开关影响（用户修改是审计，永远记，量很小）；backend 不需要自己的开关。

### JSONL 镜像

`storage/<doc_id>/trajectory/<run_id>.jsonl`（与现有 `storage/<doc_id>/{pages,chapters,media}` 镜像布局一致），每条事件一行。
与项目「DB 事实来源、storage 只写镜像」约定一致：查询只读 DB，JSONL 仅作原始归档。
写文件失败同样只警告不阻塞。
JSONL 镜像只覆盖 pipeline 侧事件；backend 的 `user_edit` 只写 DB（量小，不镜像）。

## 查询 API（backend，`backend/src/routes/trajectory.ts`）

直读 DB，不走 pipeline（读路径不依赖 Python）。

- `GET /documents/:id/trajectory` — by 文档查看，默认返回 run 列表（run_id、stage、actor、起止时间、事件数、error 数）。
- `GET /documents/:id/trajectory?level=event&run_id=X&page_id=Y` — 展开某 run 的事件流，可按页过滤。
- `GET /pages/:id/trajectory` — by 页查看（复核页直接用）。
- 列表响应不含 payload；`GET /trajectory/events/:id` 按需取单条事件的 payload 详情。

## 前端展示

- 文档详情/复核页加「处理日志」tab：左侧 run 时间线（阶段 + 状态色），右侧选中 run 的事件流；事件可展开看 payload（prompt/输出/diff 等宽折叠块）。
- 页面级复核视图加「本页日志」面板：调 `GET /pages/:id/trajectory`，只显示该页事件。

## 错误处理

- 事件写库/写文件失败：catch 后 print 警告，主链路继续。
- DB 行与 JSONL 行允许短暂不一致（JSONL 是纯归档，DB 是事实来源）。
- `off` 级别下 Recorder 是 no-op，埋点开销可忽略。

## 测试

- pipeline（pytest）：各级别下事件写入/裁剪行为；记录失败不阻塞主链路；删文档级联删事件。
- backend（vitest）：三个查询端点的过滤与分页；`PATCH /items/:id` 产生 `user_edit` 事件且 diff 正确。
- e2e（Playwright）：走 ingest → structure → approve → 编辑 → embed 全链路，断言 UI 日志 tab 展示完整 trajectory、by 页过滤正确、JSONL 文件存在；新增 spec 进 e2e/。
