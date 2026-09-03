# Phase 1.5 聊天会话补全 设计

2026-09-03。上游：`2026-09-02-overall-system-design.md`（分期表）。

## 目标

聊天从"无状态单次问答"补全为完整会话产品：会话持久化、历史会话列表与回看、运行时模型切换。

## 关键架构决定：不迁 AgentHarness（上游未就绪）

`@earendil-works/pi-agent-core@0.84.4`（当前 registry 最新版）的 `AgentHarness` 是 stub：所有运行时方法（prompt/events.on/create.restore 等）抛 `HarnessNotImplemented`（`dist/harness/agent-harness.js:44-165`），无法用于对话执行。
session 持久化层（`JsonlSessionRepo`/`Session`）是完整实现，可独立使用。
因此本期：保留裸 `Agent`，手工接 `JsonlSessionRepo`；`AgentHarness` 迁移列为上游就绪后的后续项（届时事件模型会变：harness 只有 run_start/run_end + watch 快照，无 text_delta 事件，SSE 桥接需重写）。

## 设计

### 会话存储

- `JsonlSessionRepo`，`sessionsRoot = backend/storage/sessions/`（gitignored；属产品数据，不进 pipeline 的 storage 镜像纪律）。
- `fs` 用包内 `NodeExecutionEnv`（`new NodeExecutionEnv({ cwd })`，结构上是 `JsonlSessionRepoFileSystem` 超集）。
- `repo.create({ cwd, metadata })`：metadata 塞 `{ title, model }`（list 直接带出；title 取首条用户消息前 20 字）。
- 消息在裸 Agent 的 `message_end` 时 `session.appendMessage(event.message)`（user/assistant 都记）。
- `session_id` 由前端持有并随 `/api/chat` 请求回传；缺省即新会话。

### API

- `POST /api/chat`：请求体加可选 `session_id`、`model`（`provider/id` 或裸 id）。
  有 session_id → `repo.open()` 恢复历史进 initialState.messages；无 → `repo.create()`。
  SSE 事件流不变（delta/done/error），首帧前发 `event: session`，data 为 session_id（前端据此记下新会话 id）。
- `GET /api/sessions`：`repo.list()`（modifiedAt 倒序）→ `[{ id, title, model, createdAt, modifiedAt }]`（title/model 从 metadata）。
- `GET /api/sessions/:id`：`repo.open()` + `findEntries({ type: "message", order: "oldestFirst" })` → `{ messages: [{ role, content }] }`。
- `GET /api/models`：从 Models 注册表读 `getAvailable()`/静态注册列表 → `[{ provider, id, name }]`。

### 模型注册与切换

- `backend/src/config.ts` 加 `chatModels`：`CHAT_MODELS` 环境变量逗号分隔，缺省 `[CHAT_MODEL]`。
  同一 ollama provider 下注册多个 model。
- 切换粒度 = 会话级：请求带 `model` 时该会话后续用新模型，并 `session.appendEntry({ type: "model_change", provider, modelId }, "main")` 留痕；会话 metadata.model 同步更新（若 repo 不支持改 metadata，则以 model_change entry 为准，list 展示创建时模型即可）。
- 默认模型 = 会话创建时的模型；请求不带 model 时沿用。

### 前端

- 聊天页加历史侧栏（会话列表，`GET /api/sessions`；点击进入回看：加载 `GET /api/sessions/:id` 的 messages 进消息流；当前会话标记）。
- 「新对话」按钮：清空消息流、清 session_id。
- 顶栏加模型下拉（`GET /api/models`），切换后随下一条消息请求带 `model`。
- 视觉沿用原型令牌；侧栏用 rail 与消息流之间的窄栏（240px 左右），不引入新色。

### 明确不做（本期）

- 会话重命名/删除 UI、分支（fork/lane）、compaction（harness 未用，裸 Agent 无此需求，上下文窗口内直传）。
- 会话内容进 PostgreSQL——session 是 JSONL 日志，不是 DB 事实；DB 里的聊天痕迹仍只有 `llm_calls` 计量。

### 风险与待验证点

- `repo.open()` 的单写者 claim 行为不明（类型注释提到 writer claim，jsonl 实现未见锁文件）——单进程 backend 内重复 open 同一会话需小试验证；如遇问题，backend 内做 session_id → Session 的进程内缓存。
- `appendEntry` 的 lane 参数：先用 `getLanes()` 探测，缺则 `createLane("main", null)`。
- pi-agent-core 是 0.x，升级需过 changelog。

## 验收

- 发一条消息后 `backend/storage/sessions/` 出现 JSONL，含 user+assistant 消息。
- 刷新页面，历史侧栏可见该会话，点击完整回看。
- 切换模型后发消息，`llm_calls` 记录的 model 为新模型，会话 JSONL 有 model_change entry。
- backend/frontend 测试全绿（新增：session 创建/恢复/列表/回看、模型切换、前端会话列表交互）。
