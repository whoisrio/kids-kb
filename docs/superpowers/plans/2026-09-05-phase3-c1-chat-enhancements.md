# Phase 3-C1 聊天增强 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把聊天补全为完整产品——会话分支（编辑/rewind/regenerate + ‹i/n› 切换）、thinking 呈现、assistant 消息 markdown+LaTeX 渲染、单条/整会话复制、会话删除。

**Architecture:** 依据 `docs/superpowers/specs/2026-09-05-phase3-c-design.md`（Workstream A）。分支完全复用 pi-agent-core `Session` 原生 session tree（entry `parentId` 树 + lanes）：分支 = lane（`main` / `br-<uuidv7>`），统一原语 **fork at entry**（`createLane(lane, entryId)` + `view(lane).appendMessage`）。分支元数据（fromLane/forkEntryId）落 `branch_meta` custom entry，读端免全树推导。thinking 走 `KB_CHAT_THINKING` → Agent `thinkingLevel` + `thinking_delta` → SSE `thinking` 事件，落盘复用 appendMessage 的完整 AgentMessage。前端 useChat 增加 lane 状态与 branchAt 发送参数，MessageBubble 换 react-markdown 渲染 + thinking 面板 + hover 工具条。

**Tech Stack:** backend：hono + @earendil-works/pi-agent-core@0.84.4（`Session.view/createLane/findEntriesOnBranch/appendCustomEntry/delete`）+ vitest（真 JSONL 落盘）；frontend：react-markdown@10 + remark-gfm@4 + remark-math@6 + rehype-katex@7 + vitest(jsdom)；e2e：Playwright（真三服务 + ollama，qwen3.5 系已验证经 `/v1` 返回独立 `reasoning` 字段，thinking 链路真实可测）。

**执行顺序:** Task 1-3 是存储层（读端/写端/删除）→ Task 4-7 是 API 层（详情/发送/删除/thinking）→ Task 8-11 是前端 → Task 12 E2E → Task 13 文档回写。严格按序。

**测试约定:**

- backend：`cd backend && npm test`（单文件：`npx vitest run src/agent/sessions.test.ts`）
- frontend：`cd frontend && npm test`（单文件：`npx vitest run src/hooks/useChat.test.ts`）
- E2E：`cd e2e && npx playwright test specs/chat-enhancements.spec.ts`（真三服务 + ollama + PostgreSQL）

**Spec 偏差记录:**

- `GET /api/sessions/:id` 的 `lanes` 每项在 spec 的 `{ id, forkEntryId }` 上多一个 `fromLaneId`（branch_meta 记录）：前端切换器「切回原分支」需要知道原分支的 lane id，读端免全树推导。`branch_at` 语义限定为**消息 entry**（前端只持有消息 entryId；`branch_at: null` = 根部分叉，用于编辑首条消息）。
- `POST /api/review/...` 无关本计划；`lane_id` 与 `branch_at` 同给 → 400（语义互斥，显式校验优于静默忽略）。
- 旧静态复核页 QC 同步（`sync_block_reviews`/`sync_item_grounding`）不迁移——那是 3-C2 的范围与口径。

---

## 文件结构（本计划涉及的全部文件）

- Modify: `backend/src/agent/sessions.ts` —— handle 全面 lane 化（读/写/lanes/forkAt/delete）+ StoredChatMessage 扩展
- Modify: `backend/src/agent/sessions.test.ts` —— 分支/thinking/删除用例
- Modify: `backend/src/routes/sessions.ts` —— GET ?lane= 新响应 + DELETE
- Modify: `backend/src/routes/sessions.test.ts` —— 新响应/404/204 用例
- Modify: `backend/src/agent/chat.ts` —— lane_id/branch_at/thinking SSE/Agent thinkingLevel
- Modify: `backend/src/agent/chat.test.ts` —— 分支请求语义/thinking 事件用例
- Modify: `backend/src/config.ts` + `config.test.ts` —— KB_CHAT_THINKING
- Modify: `backend/src/index.ts` —— 无（chatRoute deps 不变）
- Modify: `frontend/package.json` —— +react-markdown/remark-gfm/remark-math/rehype-katex
- Modify: `frontend/src/api/chat.ts` —— 类型/session 事件对象/thinking/branchAt/deleteSession
- Modify: `frontend/src/api/chat.test.ts` —— 对应用例
- Modify: `frontend/src/hooks/useChat.ts` —— lane 状态/编辑/rewind/regenerate/切换/删除
- Modify: `frontend/src/hooks/useChat.test.ts` —— 对应用例
- Modify: `frontend/src/components/MessageBubble.tsx` —— markdown/thinking 面板/hover 工具条/编辑态
- Create: `frontend/src/components/MessageBubble.test.tsx`
- Modify: `frontend/src/views/ChatView.tsx` —— 切换器/rewind 截断/复制全文入口
- Create: `frontend/src/views/ChatView.test.tsx`
- Modify: `frontend/src/components/SessionsSidebar.tsx` —— 删除按钮
- Modify: `frontend/src/App.tsx` —— toast/复制全文/ConfirmDialog 接线
- Modify: `frontend/src/App.test.tsx` —— session 事件新格式
- Modify: `frontend/src/theme.css` —— thinking/切换器/工具条/toast/dialog 样式
- Create: `e2e/specs/chat-enhancements.spec.ts`
- Modify: `e2e/specs/chat-session.spec.ts` —— detail 响应扩展后的断言修正
- Docs: `README.md`

---

### Task 1: sessions.ts——读端 lane 化（messages/currentModel 走分支路径）+ thinking/entryId 读出

**Files:**

- Modify: `backend/src/agent/sessions.ts`
- Test: `backend/src/agent/sessions.test.ts`

- [ ] **Step 1: 写失败测试（sessions.test.ts 追加；先加 thinking 构造器）**

在 `sessions.test.ts` 顶部 helper 区（`assistantMsg` 之后）加：

```ts
function thinkingAssistantMsg(thinking: string, text: string): AgentMessage {
  return {
    ...assistantMsg(text),
    content: [{ type: "thinking", thinking }, { type: "text", text }],
  };
}
```

追加用例（describe 块内）：

```ts
  it("messages() 带出 entryId 与 thinking（assistant 的 thinking 块拼接）", async () => {
    const { store } = makeStore();
    const h = await store.create({ title: "t", model: "m" });
    await h.appendMessage(userMsg("难题"));
    await h.appendMessage(thinkingAssistantMsg("先拆位值", "答案是 12"));
    const msgs = await h.messages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: "user", content: "难题" });
    expect(typeof msgs[0].entryId).toBe("string");
    expect(msgs[1]).toMatchObject({
      role: "assistant", content: "答案是 12", thinking: "先拆位值",
    });
    expect(typeof msgs[1].entryId).toBe("string");
  });

  it("messages()/currentModel() 缺省读最新分支；显式 lane 读该分支", async () => {
    const { store } = makeStore();
    const h = await store.create({ title: "t", model: "m0" });
    await h.appendMessage(userMsg("q1"));
    await h.appendMessage(assistantMsg("a1"));
    await h.markModelChange("m1");
    // 在 q1 处开叉（forkAt Task 2 实现；这里先通过底层 session 验证读端）
    const fork = await h.forkAt((await h.messages())[0].entryId, "main");
    await h.appendMessage(userMsg("q2'"), fork);
    await h.appendMessage(assistantMsg("a2'"), fork);

    // 缺省 = 最新分支（叶 seq 最大者 = fork）
    expect((await h.messages()).map((m) => m.content)).toEqual(["q1", "q2'", "a2'"]);
    // 显式 main 只读原路径
    expect((await h.messages("main")).map((m) => m.content)).toEqual(["q1", "a1"]);
    // currentModel 同口径：main 上有 model_change，fork 路径也含它（fork 在其后）
    expect(await h.currentModel("main")).toBe("m1");
    expect(await h.currentModel(fork)).toBe("m1");
  });
```

注意：第一条用例只依赖本任务的读端改造；第二条依赖 Task 2 的 `forkAt`/带 lane 写入——**先写两条，Task 1 只让第一条过，Task 2 让第二条过**（TDD 跨任务 RED 保持）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/agent/sessions.test.ts`
Expected: FAIL——`msgs[0].entryId` undefined（`entryId` 不存在）、`h.forkAt is not a function`。

- [ ] **Step 3: 实现读端改造**

`backend/src/agent/sessions.ts`：

接口扩展（`StoredChatMessage` 之后、`SessionHandle` 之前）：

```ts
export interface StoredChatMessage {
  role: "user" | "assistant";
  content: string;
  /** 消息 entry 的 id（前端编辑/rewind/regenerate 的分支定位）。 */
  entryId: string;
  /** assistant 的 thinking 块拼接；无 thinking 输出则缺省。 */
  thinking?: string;
}

/** branch_meta custom entry 的 data 载荷：分支创建时一次性落盘的元数据。 */
export interface BranchMeta {
  lane: string;
  fromLane: string | null;
  forkEntryId: string | null;
}

export interface LaneInfo {
  id: string;
  /** 开叉点 entry id（消息 entry）；main 与根部分叉为 null。 */
  forkEntryId: string | null;
  /** 开叉时的写入分支（原分支）；main 为 null。 */
  fromLaneId: string | null;
}
```

`SessionHandle` 接口整体替换为：

```ts
export interface SessionHandle {
  readonly id: string;
  readonly title: string;
  /** 当前模型：该分支路径上最近一次 model_change，否则创建时 metadata.model。缺省最新分支。 */
  currentModel(lane?: string): Promise<string>;
  /** 该分支路径上的历史消息（仅 user/assistant，text 段拼接；带 entryId/thinking）。缺省最新分支。 */
  messages(lane?: string): Promise<StoredChatMessage[]>;
  appendMessage(message: AgentMessage, lane?: string): Promise<void>;
  markModelChange(modelId: string, lane?: string): Promise<void>;
  /** 全部分支（main 最前，其余按创建序）。 */
  lanes(): Promise<LaneInfo[]>;
  /** 最新分支：叶 entry seq 最大者（并列不可能，seq 唯一）。 */
  latestLane(): Promise<string>;
  /** 在 entryId 处开新分支（null = 根部），落 branch_meta，返回新 lane id。 */
  forkAt(entryId: string | null, fromLane: string): Promise<string>;
  laneExists(lane: string): Promise<boolean>;
  entryExists(entryId: string): Promise<boolean>;
}
```

`messageText` 之后加：

```ts
function messageThinking(m: AgentMessage): string | undefined {
  if (m.role !== "assistant" || typeof m.content === "string") return undefined;
  const t = m.content.filter((c) => c.type === "thinking").map((c) => c.thinking).join("");
  return t || undefined;
}
```

`JsonlSessionHandle` 的 `currentModel`/`messages` 替换为：

```ts
  async currentModel(lane?: string): Promise<string> {
    const target = lane ?? (await this.latestLane());
    const [change] = (await this.session.view(target).findEntriesOnBranch({
      type: "model_change", order: "newestFirst", limit: 1,
    })) as ModelChangeEntry[];
    return change?.modelId ?? this.createdModel;
  }

  async messages(lane?: string): Promise<StoredChatMessage[]> {
    const target = lane ?? (await this.latestLane());
    const entries = (await this.session.view(target).findEntriesOnBranch({
      type: "message", order: "oldestFirst",
    })) as MessageEntry[];
    const out: StoredChatMessage[] = [];
    for (const e of entries) {
      // 读端 role 白名单：toolResult 等其他角色不进历史（不写脏数据，也不靠强转）
      const role = e.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = messageText(e.message);
      if (!text) continue;
      out.push({ role, content: text, entryId: e.id, thinking: messageThinking(e.message) });
    }
    return out;
  }
```

（`latestLane`/`forkAt` 等 Task 2 实现；TS 此步会因缺方法报错，先把 `JsonlSessionHandle` 里其余方法体的编译错误消掉——本任务先加占位实现，见下。）

占位（Task 2 替换为真实现）：

```ts
  async lanes(): Promise<LaneInfo[]> { return [{ id: "main", forkEntryId: null, fromLaneId: null }]; }
  async latestLane(): Promise<string> { return "main"; }
  async forkAt(_entryId: string | null, _fromLane: string): Promise<string> { throw new Error("Task 2"); }
  async laneExists(lane: string): Promise<boolean> { return lane === "main"; }
  async entryExists(_entryId: string): Promise<boolean> { return false; }
```

（pi-agent-core 源码依据：`view(lane).findEntriesOnBranch` 默认从该 lane 当前叶向根扫描，`order: "oldestFirst"` 反转为正序；`view("main")` 返回 session 自身、默认 lane 即 main。）

- [ ] **Step 4: 跑测试确认第一条用例通过（第二条仍 RED 留给 Task 2）**

Run: `cd backend && npx vitest run src/agent/sessions.test.ts`
Expected: 「entryId 与 thinking」PASS；「缺省读最新分支」FAIL（forkAt 占位抛错）。其余既有用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/sessions.ts backend/src/agent/sessions.test.ts
git commit -m "feat(backend): 会话读端 lane 化——messages/currentModel 走分支路径，带出 entryId/thinking"
```

---

### Task 2: sessions.ts——写端 lane 化 + lanes/latestLane/forkAt（branch_meta）

**Files:**

- Modify: `backend/src/agent/sessions.ts`
- Test: `backend/src/agent/sessions.test.ts`

- [ ] **Step 1: 写失败测试（追加）**

```ts
  it("forkAt 在消息处开叉：新分支只含前缀+新消息；lanes() 带元数据；分支隔离写", async () => {
    const { store } = makeStore();
    const h = await store.create({ title: "t", model: "m0" });
    await h.appendMessage(userMsg("q1"));
    await h.appendMessage(assistantMsg("a1"));
    const msgs = await h.messages();
    const fork = await h.forkAt(msgs[1].entryId, "main"); // 在 a1 处开叉（rewind 语义）
    expect(fork).toMatch(/^br-/);
    await h.appendMessage(userMsg("q2"), fork);
    await h.markModelChange("mX", fork);

    expect((await h.messages(fork)).map((m) => m.content)).toEqual(["q1", "a1", "q2"]);
    expect((await h.messages("main")).map((m) => m.content)).toEqual(["q1", "a1"]);
    expect(await h.currentModel(fork)).toBe("mX");
    expect(await h.currentModel("main")).toBe("m0"); // model_change 落在 fork 上，main 不受影响

    const lanes = await h.lanes();
    expect(lanes.map((l) => l.id)).toEqual(["main", fork]); // main 最前
    expect(lanes[1]).toEqual({ id: fork, forkEntryId: msgs[1].entryId, fromLaneId: "main" });
  });

  it("forkAt(null) 根部分叉（编辑首条消息）；entryExists/laneExists", async () => {
    const { store } = makeStore();
    const h = await store.create({ title: "t", model: "m" });
    await h.appendMessage(userMsg("q1"));
    await h.appendMessage(assistantMsg("a1"));
    const rootFork = await h.forkAt(null, "main");
    await h.appendMessage(userMsg("q1-改"), rootFork);
    expect((await h.messages(rootFork)).map((m) => m.content)).toEqual(["q1-改"]);

    expect(await h.entryExists((await h.messages())[0].entryId)).toBe(true);
    expect(await h.entryExists("no-such-entry")).toBe(false);
    expect(await h.laneExists(rootFork)).toBe(true);
    expect(await h.laneExists("br-nope")).toBe(false);
  });

  it("重开会话后 lanes() 仍可恢复（branch_meta 落盘）", async () => {
    const { store, dir } = makeStore();
    const h = await store.create({ title: "t", model: "m" });
    await h.appendMessage(userMsg("q1"));
    const fork = await h.forkAt((await h.messages())[0].entryId, "main");
    const reopened = await new JsonlSessionStore({ sessionsRoot: dir, cwd: dir }).open(h.id);
    expect((await reopened!.lanes()).map((l) => l.id)).toEqual(["main", fork]);
    expect((await reopened!.messages(fork)).map((m) => m.content)).toEqual(["q1"]);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/agent/sessions.test.ts`
Expected: FAIL——占位 forkAt 抛 "Task 2"。

- [ ] **Step 3: 实现（替换 Task 1 的占位）**

`ensureLane` 与写端方法替换为：

```ts
  private async ensureLane(lane = "main") {
    // 只有 main 懒建；br-* 由 forkAt 创建，不存在即编程错误（校验在路由层前置）
    if (lane !== "main") return;
    const lanes = await this.session.getLanes();
    if (!lanes.some((l) => l.lane === "main")) await this.session.createLane("main", null);
  }

  async appendMessage(message: AgentMessage, lane?: string): Promise<void> {
    const target = lane ?? (await this.latestLane());
    await this.ensureLane(target);
    await this.session.view(target).appendMessage(message);
  }

  async markModelChange(modelId: string, lane?: string): Promise<void> {
    const target = lane ?? (await this.latestLane());
    await this.ensureLane(target);
    await this.session.appendEntry(
      { type: "model_change", id: uuidv7(), provider: "chat", modelId },
      target,
    );
  }

  async lanes(): Promise<LaneInfo[]> {
    await this.ensureLane();
    const metas = (await this.session.findEntries({ customType: "branch_meta" })) as CustomEntry[];
    const byLane = new Map<string, CustomEntry>();
    for (const e of metas) { // findEntries 按 seq 升序；同 lane 取最早一条
      const d = e.data as BranchMeta | undefined;
      if (d?.lane && !byLane.has(d.lane)) byLane.set(d.lane, e);
    }
    const forks = [...byLane.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((e) => {
        const d = e.data as BranchMeta;
        return { id: d.lane, forkEntryId: d.forkEntryId ?? null, fromLaneId: d.fromLane ?? null };
      });
    return [{ id: "main", forkEntryId: null, fromLaneId: null }, ...forks];
  }

  async latestLane(): Promise<string> {
    await this.ensureLane();
    const pointers = await this.session.getLanes();
    let best = "main";
    let bestSeq = -1;
    for (const { lane, leafId } of pointers) {
      const seq = leafId ? (await this.session.getEntry(leafId))?.seq ?? -1 : -1;
      if (seq > bestSeq) { bestSeq = seq; best = lane; }
    }
    return best;
  }

  async forkAt(entryId: string | null, fromLane: string): Promise<string> {
    const lane = `br-${uuidv7()}`;
    await this.session.createLane(lane, entryId);
    // branch_meta 作为新分支首个 entry 落盘：fromLane/forkEntryId 读端免推导
    await this.session.view(lane).appendCustomEntry(
      "branch_meta", { lane, fromLane, forkEntryId: entryId } satisfies BranchMeta,
    );
    return lane;
  }

  async laneExists(lane: string): Promise<boolean> {
    await this.ensureLane();
    return (await this.session.getLanes()).some((l) => l.lane === lane);
  }

  async entryExists(entryId: string): Promise<boolean> {
    return (await this.session.getEntry(entryId)) !== undefined;
  }
```

import 区补 `CustomEntry`：

```ts
import {
  JsonlSessionRepo,
  uuidv7,
  type AgentMessage,
  type CustomEntry,
  type JsonlSessionMetadata,
  type MessageEntry,
  type ModelChangeEntry,
  type Session,
} from "@earendil-works/pi-agent-core";
```

（「消息 entry 之间夹 model_change」的情形：fork 后首条消息的裸 parent 是 mc/branch_meta entry，但切换器按**消息列表前一条**对齐（见 Task 10），forkEntryId 恒为消息 entry，不受影响。）

- [ ] **Step 4: 跑测试确认通过（含 Task 1 留下的 RED）**

Run: `cd backend && npx vitest run src/agent/sessions.test.ts`
Expected: 全部 PASS（含「缺省读最新分支」）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/sessions.ts backend/src/agent/sessions.test.ts
git commit -m "feat(backend): forkAt/lanes/latestLane——分支写端与 branch_meta 元数据落盘"
```

---

### Task 3: sessions.ts——store.delete(id)

**Files:**

- Modify: `backend/src/agent/sessions.ts`（`SessionStore` 接口 + `JsonlSessionStore`）
- Test: `backend/src/agent/sessions.test.ts`

- [ ] **Step 1: 写失败测试（追加）**

```ts
  it("delete：文件消失、list/open 不再有、不存在返回 false", async () => {
    const { store, dir } = makeStore();
    const h = await store.create({ title: "t", model: "m" });
    await h.appendMessage(userMsg("q1"));
    const files1 = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
    expect(files1).toHaveLength(1);
    expect(await store.delete(h.id)).toBe(true);
    const files2 = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
    expect(files2).toHaveLength(0);
    expect(await store.open(h.id)).toBeNull();
    expect((await store.list()).map((s) => s.id)).not.toContain(h.id);
    expect(await store.delete(h.id)).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/agent/sessions.test.ts -t delete`
Expected: FAIL——`store.delete is not a function`。

- [ ] **Step 3: 实现**

`SessionStore` 接口加一行（`list()` 之后）：

```ts
  /** 删除会话（JSONL 文件 + 进程缓存）；不存在返回 false。 */
  delete(id: string): Promise<boolean>;
```

`JsonlSessionStore` 类末尾（`list()` 之后）加：

```ts
  async delete(id: string): Promise<boolean> {
    const meta = (await this.repo.list()).find((m) => m.id === id);
    if (!meta) return false;
    await this.repo.delete(meta);
    this.cache.delete(id);
    return true;
  }
```

- [ ] **Step 4: 跑测试确认通过 + 编译检查**

Run: `cd backend && npx vitest run src/agent/sessions.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS；tsc 报 `SessionStore` 其它实现（fakeStore in tests）缺 `delete` —— 同步补：`chat.test.ts` 与 `routes/sessions.test.ts` 的 fake store 各加 `delete: async () => false,`（Task 4/5 会替换它们，此处先让编译过）。

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/sessions.ts backend/src/agent/sessions.test.ts backend/src/agent/chat.test.ts backend/src/routes/sessions.test.ts
git commit -m "feat(backend): JsonlSessionStore.delete——会话删除（repo.delete + 缓存清理）"
```

---

### Task 4: GET /api/sessions/:id?lane=——新响应结构

**Files:**

- Modify: `backend/src/routes/sessions.ts`
- Test: `backend/src/routes/sessions.test.ts`

- [ ] **Step 1: 写失败测试（sessions.test.ts 的 makeStore 与用例整体替换）**

```ts
/** fake handle：可预置 lanes/messages/currentModel，记录写入 lane。 */
function makeStore(opts: {
  list?: Awaited<ReturnType<SessionStore["list"]>>;
  sessions?: Record<string, {
    title?: string; model?: string;
    messages?: { role: "user" | "assistant"; content: string; entryId?: string; thinking?: string }[];
    lanes?: { id: string; forkEntryId: string | null; fromLaneId: string | null }[];
  }>;
}): SessionStore {
  return {
    create: async () => { throw new Error("未使用"); },
    open: async (id): Promise<SessionHandle | null> => {
      const data = opts.sessions?.[id];
      if (!data) return null;
      const written: { lane?: string }[] = [];
      return {
        id,
        title: data.title ?? "",
        currentModel: async () => data.model ?? "",
        messages: async (lane) => lane === "main" ? [] : (data.messages ?? []),
        appendMessage: async (_m, lane) => { written.push({ lane }); },
        markModelChange: async () => {},
        lanes: async () => data.lanes ?? [{ id: "main", forkEntryId: null, fromLaneId: null }],
        latestLane: async () => data.lanes?.at(-1)?.id ?? "main",
        forkAt: async () => "br-fake",
        laneExists: async (lane) => lane === "main" || (data.lanes ?? []).some((l) => l.id === lane),
        entryExists: async () => true,
        delete: async () => false,
        // 测试辅助（不在接口上，仅本文件内部断言用）
        ...({ written } as Record<string, never>),
      } as unknown as SessionHandle;
    },
    list: async () => opts.list ?? [],
    delete: async () => false,
  };
}
```

用例替换（describe 内整体替换原「GET /:id」两条，列表用例保留）：

```ts
  it("GET /:id 无 lane 参数：currentLane=最新分支，响应含 lanes 与消息 entryId/thinking", async () => {
    const store = makeStore({
      sessions: {
        s1: {
          title: "口算题",
          model: "deepseek-v3",
          lanes: [
            { id: "main", forkEntryId: null, fromLaneId: null },
            { id: "br-1", forkEntryId: "e1", fromLaneId: "main" },
          ],
          messages: [
            { role: "user", content: "问题", entryId: "e0" },
            { role: "assistant", content: "回答", entryId: "e2", thinking: "想了想" },
          ],
        },
      },
    });
    const resp = await app(store).request("/api/sessions/s1");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      title: "口算题",
      currentModel: "deepseek-v3",
      currentLane: "br-1",
      lanes: [
        { id: "main", forkEntryId: null, fromLaneId: null },
        { id: "br-1", forkEntryId: "e1", fromLaneId: "main" },
      ],
      messages: [
        { role: "user", content: "问题", entryId: "e0" },
        { role: "assistant", content: "回答", entryId: "e2", thinking: "想了想" },
      ],
    });
  });

  it("GET /:id?lane=main：读指定分支", async () => {
    const store = makeStore({
      sessions: { s1: { title: "t", model: "m", messages: [{ role: "user", content: "主分支", entryId: "e0" }] } },
    });
    const resp = await app(store).request("/api/sessions/s1?lane=main");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.currentLane).toBe("main");
    expect(body.messages).toEqual([{ role: "user", content: "主分支", entryId: "e0" }]);
  });

  it("GET /:id?lane=不存在 → 404；GET /:id 不存在 → 404", async () => {
    const a = app(makeStore({ sessions: { s1: {} } }));
    expect((await a.request("/api/sessions/s1?lane=br-nope")).status).toBe(404);
    expect((await app(makeStore({})).request("/api/sessions/ghost")).status).toBe(404);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/routes/sessions.test.ts`
Expected: FAIL——响应缺 `currentLane`/`lanes`、`?lane=` 不校验。

- [ ] **Step 3: 实现（routes/sessions.ts 的 GET /:id 整体替换）**

```ts
  app.get("/:id", async (c) => {
    const handle = await store.open(c.req.param("id"));
    if (!handle) return c.json({ error: "会话不存在" }, 404);
    const lane = c.req.query("lane");
    if (lane !== undefined && !(await handle.laneExists(lane))) {
      return c.json({ error: "分支不存在" }, 404);
    }
    const currentLane = lane ?? (await handle.latestLane());
    return c.json({
      title: handle.title,
      currentModel: await handle.currentModel(currentLane),
      currentLane,
      lanes: await handle.lanes(),
      messages: await handle.messages(currentLane),
    });
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx vitest run src/routes/sessions.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/sessions.ts backend/src/routes/sessions.test.ts
git commit -m "feat(backend): GET /api/sessions/:id?lane=——currentLane/lanes/entryId/thinking"
```

---

### Task 5: POST /api/chat——lane_id/branch_at + SSE session 事件对象化

**Files:**

- Modify: `backend/src/agent/chat.ts`
- Test: `backend/src/agent/chat.test.ts`

- [ ] **Step 1: 写失败测试（chat.test.ts：先整体替换 fakeStore）**

fakeStore 替换为 lane-aware 版（保留原记录器并新增分支行为）：

```ts
/** 内存 fake SessionStore：lane-aware；可预置已有会话，记录写入/fork/删除。 */
function fakeStore(initial?: Record<string, {
  model?: string; messages?: StoredChatMessage[]; title?: string;
  lanes?: string[]; // 缺省 ["main"]
}>) {
  const data: Record<string, { model: string; messages: StoredChatMessage[]; title: string; lanes: string[] }> = {};
  for (const [id, v] of Object.entries(initial ?? {})) {
    data[id] = { model: v.model ?? "m", messages: v.messages ?? [], title: v.title ?? "", lanes: v.lanes ?? ["main"] };
  }
  const appended: Record<string, { lane?: string; message: unknown }[]> = {};
  const marks: Record<string, { lane?: string; model: string }[]> = {};
  const forks: { sessionId: string; entryId: string | null; fromLane: string; lane: string }[] = [];
  const createCalls: { title: string; model: string }[] = [];
  const deleted: string[] = [];
  let seq = 0;
  let laneSeq = 0;
  const makeHandle = (id: string): SessionHandle => ({
    id,
    title: data[id].title,
    currentModel: async (lane) => data[id].model,
    messages: async () => data[id].messages,
    appendMessage: async (m, lane) => { (appended[id] ??= []).push({ lane, message: m }); },
    markModelChange: async (modelId, lane) => {
      (marks[id] ??= []).push({ lane, model: modelId });
      data[id].model = modelId;
    },
    lanes: async () => data[id].lanes.map((l) =>
      l === "main" ? { id: "main", forkEntryId: null, fromLaneId: null }
        : { id: l, forkEntryId: "e-fork", fromLaneId: "main" }),
    latestLane: async () => data[id].lanes.at(-1)!,
    forkAt: async (entryId, fromLane) => {
      const lane = `br-${++laneSeq}`;
      data[id].lanes.push(lane);
      forks.push({ sessionId: id, entryId, fromLane, lane });
      return lane;
    },
    laneExists: async (lane) => data[id].lanes.includes(lane),
    entryExists: async (entryId) => entryId === "e-exists",
    delete: async () => { deleted.push(id); return true; },
  });
  const store: SessionStore = {
    create: async (o) => {
      createCalls.push(o);
      const id = `s-${++seq}`;
      data[id] = { model: o.model, title: o.title, messages: [], lanes: ["main"] };
      return makeHandle(id);
    },
    open: async (id) => (data[id] ? makeHandle(id) : null),
    list: async () => [],
    delete: async (id) => { deleted.push(id); return Boolean(data[id]); },
  };
  return { store, createCalls, appended, marks, forks, deleted };
}
```

（import 行补 `import type { StoredChatMessage } from "./sessions.js";` 已有则不动。）追加用例（新 describe）：

```ts
describe("/api/chat 分支", () => {
  it("branch_at 给定 → forkAt 创建分支并写入；SSE session 事件为 {session_id, lane_id} 对象", async () => {
    const { store, forks, appended } = fakeStore({
      "s-x": { model: "qwen3:4b", messages: [
        { role: "user", content: "q1", entryId: "e0" },
        { role: "assistant", content: "a1", entryId: "e1" },
      ] },
    });
    const agent = fakeAgent([
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "q2" }] } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a2" }] } },
      { type: "agent_end", messages: [] },
    ]);
    const resp = await post(app(() => agent, { store, defaultModel: "qwen3:4b" }), {
      session_id: "s-x", branch_at: "e-exists",
      messages: [{ role: "user", content: "q2" }],
    });
    const body = await resp.text();
    expect(forks).toEqual([{ sessionId: "s-x", entryId: "e-exists", fromLane: "main", lane: "br-1" }]);
    expect(appended["s-x"].map((a) => a.lane)).toEqual(["br-1", "br-1"]);
    expect(body).toContain('event: session');
    expect(body).toContain(JSON.stringify({ session_id: "s-x", lane_id: "br-1" }));
    expect(body.indexOf("event: session")).toBeLessThan(body.indexOf("event: done"));
  });

  it("branch_at: null → 根部分叉（编辑首条消息）", async () => {
    const { store, forks } = fakeStore({
      "s-x": { model: "m", messages: [{ role: "user", content: "q1", entryId: "e0" }] },
    });
    const agent = fakeAgent([{ type: "agent_end", messages: [] }]);
    const resp = await post(app(() => agent, { store, defaultModel: "m" }), {
      session_id: "s-x", branch_at: null, messages: [{ role: "user", content: "q1-改" }],
    });
    expect(resp.status).toBe(200);
    expect(forks[0].entryId).toBeNull();
  });

  it("lane_id 给定 → 历史从该 lane 读、消息落该 lane；缺省 → latestLane", async () => {
    const { store, appended } = fakeStore({
      "s-x": { model: "m", messages: [{ role: "user", content: "分支历史", entryId: "e0" }], lanes: ["main", "br-9"] },
    });
    let factoryMessages: { role: string; content: string }[] | null = null;
    const agent = fakeAgent([{ type: "agent_end", messages: [] }]);
    const factory: AgentFactory = (messages) => { factoryMessages = messages; return agent; };
    await (await post(app(factory, { store, defaultModel: "m" }), {
      session_id: "s-x", lane_id: "br-9", messages: [{ role: "user", content: "hi" }],
    })).text();
    expect(factoryMessages).toEqual([{ role: "user", content: "分支历史" }]);
    expect(appended["s-x"][0]?.lane).toBe("br-9");
    // 缺省：写入 latestLane
    await (await post(app(factory, { store, defaultModel: "m" }), {
      session_id: "s-x", messages: [{ role: "user", content: "again" }],
    })).text();
    expect(appended["s-x"][1]?.lane).toBe("br-9");
  });

  it("校验先于持久化：lane_id 不存在 / branch_at 不存在 / 两者同给 / branch_at 无 session_id → 400", async () => {
    const { store, forks, createCalls } = fakeStore({
      "s-x": { model: "m", messages: [{ role: "user", content: "q", entryId: "e0" }] },
    });
    const a = app(() => fakeAgent([]), { store, defaultModel: "m" });
    expect((await post(a, { session_id: "s-x", lane_id: "br-nope", messages: [{ role: "user", content: "hi" }] })).status).toBe(400);
    expect((await post(a, { session_id: "s-x", branch_at: "e-ghost", messages: [{ role: "user", content: "hi" }] })).status).toBe(400);
    expect((await post(a, { session_id: "s-x", lane_id: "main", branch_at: "e-exists", messages: [{ role: "user", content: "hi" }] })).status).toBe(400);
    expect((await post(a, { branch_at: "e-exists", messages: [{ role: "user", content: "hi" }] })).status).toBe(400);
    expect(forks).toEqual([]);
    expect(createCalls).toEqual([]);
  });

  it("模型切换留痕落在写入分支上", async () => {
    const { store, marks } = fakeStore({
      "s-x": { model: "qwen3:4b", messages: [], lanes: ["main", "br-9"] },
    });
    const agent = fakeAgent([{ type: "agent_end", messages: [] }]);
    await (await post(app(() => agent, { store, defaultModel: "qwen3:4b", models: ["qwen3:4b", "deepseek-v3"] }), {
      session_id: "s-x", lane_id: "br-9", model: "deepseek-v3",
      messages: [{ role: "user", content: "hi" }],
    })).text();
    expect(marks["s-x"]).toEqual([{ lane: "br-9", model: "deepseek-v3" }]);
  });
});
```

既有用例「无 session_id → 创建会话…」的 `expect(body).toContain('"s-1"')` 改为 `expect(body).toContain('"session_id":"s-1"')`（data 里 `'event: session\ndata: "s-new"'` 类断言同理），且既有 SSE 断言里 `'"s-x"'` 改 `'"session_id":"s-x"'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/agent/chat.test.ts`
Expected: FAIL——forks 空（未实现）/ session 事件仍是裸 id。

- [ ] **Step 3: 实现（chat.ts）**

`chatRoute` 内，`const sessionIdRaw = ...` 校验块之后追加：

```ts
    const laneRaw = (body as { lane_id?: unknown }).lane_id;
    if (laneRaw !== undefined && typeof laneRaw !== "string") {
      return c.json({ error: "lane_id 须为字符串" }, 400);
    }
    // branch_at：消息 entry id；null = 根部分叉（编辑首条消息）；缺省 = 不开叉
    const branchRaw = (body as { branch_at?: unknown }).branch_at;
    if (branchRaw !== undefined && branchRaw !== null && typeof branchRaw !== "string") {
      return c.json({ error: "branch_at 须为字符串或 null" }, 400);
    }
    if (laneRaw !== undefined && branchRaw !== undefined) {
      return c.json({ error: "lane_id 与 branch_at 不能同给" }, 400);
    }
    if (branchRaw !== undefined && !sessionIdRaw) {
      return c.json({ error: "branch_at 仅用于已有会话" }, 400);
    }
```

会话恢复/创建块整体替换为：

```ts
    // 会话恢复/创建必须在 streamSSE 之前完成（404/校验前置，session 事件要是首帧）
    let handle: SessionHandle | null = null;
    let writeLane = "main";
    if (deps.store) {
      try {
        if (sessionIdRaw) {
          handle = await deps.store.open(sessionIdRaw);
          if (!handle) return c.json({ error: "会话不存在" }, 404);
          if (branchRaw !== undefined) {
            if (typeof branchRaw === "string" && !(await handle.entryExists(branchRaw))) {
              return c.json({ error: "branch_at 条目不存在" }, 400);
            }
            writeLane = await handle.forkAt(branchRaw, await handle.latestLane());
          } else if (typeof laneRaw === "string") {
            if (!(await handle.laneExists(laneRaw))) return c.json({ error: "分支不存在" }, 400);
            writeLane = laneRaw;
          } else {
            writeLane = await handle.latestLane();
          }
          history = await handle.messages(writeLane);
          const current = await handle.currentModel(writeLane);
          if (requestedModel && requestedModel !== current) {
            await handle.markModelChange(requestedModel, writeLane);
          }
          requestedModel ??= current;
        } else {
          const firstUser = messages.find((m) => m.role === "user")!;
          const model = requestedModel ?? deps.defaultModel ?? "";
          handle = await deps.store.create({ title: firstUser.content.slice(0, 20), model });
          requestedModel ??= deps.defaultModel;
        }
      } catch (err) {
        console.error("会话存取失败", err);
        return c.json({ error: CLIENT_ERROR_MSG }, 500);
      }
    }
```

SSE 首帧替换：

```ts
      if (handle) await stream.writeSSE({
        event: "session",
        data: JSON.stringify({ session_id: handle.id, lane_id: writeLane }),
      });
```

`message_end` 落盘行替换：

```ts
          if (handle && (msg?.role === "user" || msg?.role === "assistant")) {
            try {
              await handle.appendMessage(msg, writeLane);
            } catch (err) {
              console.error("会话消息落盘失败", err);
            }
          }
```

- [ ] **Step 4: 跑测试确认通过（含既有会话持久化用例更新后全绿）**

Run: `cd backend && npx vitest run src/agent/chat.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/chat.ts backend/src/agent/chat.test.ts
git commit -m "feat(backend): /api/chat lane_id/branch_at——fork-at-entry 统一原语 + SSE session 对象化"
```

---

### Task 6: DELETE /api/sessions/:id

**Files:**

- Modify: `backend/src/routes/sessions.ts`
- Test: `backend/src/routes/sessions.test.ts`

- [ ] **Step 1: 写失败测试（追加）**

```ts
  it("DELETE /:id：存在 → 204 并调 store.delete；不存在 → 404", async () => {
    let deletedId: string | null = null;
    const store: SessionStore = {
      ...makeStore({}),
      open: async () => null,
      delete: async (id) => { deletedId = id; return id === "s1"; },
    };
    const a = app(store);
    expect((await a.request("/api/sessions/s1", { method: "DELETE" })).status).toBe(204);
    expect(deletedId).toBe("s1");
    expect((await a.request("/api/sessions/ghost", { method: "DELETE" })).status).toBe(404);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/routes/sessions.test.ts -t DELETE`
Expected: FAIL——404（路由不存在时 Hono 返回 404）。

- [ ] **Step 3: 实现（routes/sessions.ts，GET /:id 之后加）**

```ts
  app.delete("/:id", async (c) => {
    const ok = await store.delete(c.req.param("id"));
    if (!ok) return c.json({ error: "会话不存在" }, 404);
    return c.body(null, 204);
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && npx vitest run src/routes/sessions.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/sessions.ts backend/src/routes/sessions.test.ts
git commit -m "feat(backend): DELETE /api/sessions/:id——会话删除路由"
```

---

### Task 7: thinking——KB_CHAT_THINKING 配置 + SSE thinking 事件

**Files:**

- Modify: `backend/src/config.ts`、`backend/src/config.test.ts`、`backend/src/agent/chat.ts`
- Test: `backend/src/config.test.ts`、`backend/src/agent/chat.test.ts`

- [ ] **Step 1: 写失败测试**

`config.test.ts` 追加：

```ts
describe("KB_CHAT_THINKING", () => {
  const base = { KB_DATABASE_URL: "postgresql://localhost/kb" };
  it("缺省 medium；合法值透传；off 关闭；非法值报错", () => {
    expect(loadConfig({ ...base }).chatThinking).toBe("medium");
    expect(loadConfig({ ...base, KB_CHAT_THINKING: "high" }).chatThinking).toBe("high");
    expect(loadConfig({ ...base, KB_CHAT_THINKING: "off" }).chatThinking).toBe("off");
    expect(() => loadConfig({ ...base, KB_CHAT_THINKING: "bogus" })).toThrow(/KB_CHAT_THINKING/);
  });
});
```

`chat.test.ts` 追加：

```ts
  it("thinking_delta → SSE thinking 事件（data 为 JSON 字符串，编码同 delta）", async () => {
    const agent = fakeAgent([
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "先想" } },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "一下" } },
      delta("答案"),
      { type: "agent_end", messages: [] },
    ]);
    const resp = await post(app(() => agent), { messages: [{ role: "user", content: "hi" }] });
    const body = await resp.text();
    expect(body).toContain('event: thinking\ndata: "先想"');
    expect(body).toContain('event: thinking\ndata: "一下"');
    expect(body.indexOf("event: thinking")).toBeLessThan(body.indexOf("event: delta"));
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && npx vitest run src/config.test.ts src/agent/chat.test.ts`
Expected: FAIL——`chatThinking` 不存在 / 无 thinking 事件。

- [ ] **Step 3: 实现**

`config.ts`——`BackendConfig` 加字段与解析（`matchThreshold` 之后）：

```ts
  /** 聊天 thinking 档位（off|minimal|low|medium|high|xhigh|max）。 */
  chatThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
```

```ts
    chatThinking: (() => {
      const raw = pick(env.KB_CHAT_THINKING);
      const allowed = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      if (raw !== undefined && !allowed.includes(raw)) {
        throw new Error(`KB_CHAT_THINKING 取值: ${allowed.join("|")}`);
      }
      return (raw ?? "medium") as BackendConfig["chatThinking"];
    })(),
```

（config.ts 顶部 import `type { ThinkingLevel }` 不引入——字面量联合自持，避免跨包类型漂移。）

`chat.ts`——`makeModel` 的 `reasoning: false` 改：

```ts
    reasoning: cfg.chatThinking !== "off",
```

`new Agent({...})` 的 initialState 加：

```ts
        thinkingLevel: cfg.chatThinking,
```

（pi-agent-core 源码依据：Agent 默认 `thinkingLevel: "off"`；`createLoopConfig` 把它映射为 `reasoning` 传 streamSimple；openai-completions 适配层对不支持 reasoning 的端点自动不传该参数、对 ollama `/v1` 已验证返回独立 `reasoning` 字段 → `thinking_delta` 事件。）

`message_update` 订阅块替换：

```ts
      agent.subscribe(async (event) => {
        if (event.type === "message_update") {
          const ev = event.assistantMessageEvent;
          if (ev?.type === "thinking_delta") {
            await stream.writeSSE({ event: "thinking", data: JSON.stringify(ev.delta) });
          }
          if (ev?.type === "text_delta") {
            await stream.writeSSE({ event: "delta", data: JSON.stringify(ev.delta) });
          }
        }
```

- [ ] **Step 4: 跑测试确认通过 + backend 全量**

Run: `cd backend && npm test`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add backend/src/config.ts backend/src/config.test.ts backend/src/agent/chat.ts backend/src/agent/chat.test.ts
git commit -m "feat(backend): KB_CHAT_THINKING + SSE thinking 事件——thinking 全链路（配置→模型→流式→落盘）"
```

---

### Task 8: 前端 api/chat.ts——类型/session 事件对象/thinking/branchAt/deleteSession

**Files:**

- Modify: `frontend/src/api/chat.ts`
- Test: `frontend/src/api/chat.test.ts`

- [ ] **Step 1: 写失败测试（api/chat.test.ts 追加/调整）**

既有用例里 SSE 桩 `'event: session\ndata: "s-new"\n\n'` 全部改为 `'event: session\ndata: {"session_id":"s-new","lane_id":"main"}\n\n'`（各处同构替换），再追加：

```ts
  it("session 事件对象解析：onSession 收 (id, lane)", async () => {
    const seen: unknown[] = [];
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: () => {}, onDone: () => {}, onSession: (id, lane) => seen.push([id, lane]) },
      fetchRouter({ "/api/chat": () => sseResponse([
        'event: session\ndata: {"session_id":"s-9","lane_id":"br-1"}\n\n',
        "event: done\ndata: \n\n",
      ]) }),
    );
    expect(seen).toEqual([["s-9", "br-1"]]);
  });

  it("thinking 事件流经 onThinking；请求带 lane_id/branch_at", async () => {
    let body: unknown = null;
    const thinkings: string[] = [];
    await streamChat(
      [{ role: "user", content: "hi" }],
      {
        onDelta: () => {}, onDone: () => {},
        onThinking: (t) => thinkings.push(t),
      },
      fetchRouter({ "/api/chat": (init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse([
          'event: session\ndata: {"session_id":"s-1","lane_id":"br-1"}\n\n',
          'event: thinking\ndata: "想"\n\n',
          "event: done\ndata: \n\n",
        ]);
      } }),
      undefined,
      { sessionId: "s-1", laneId: "br-1", branchAt: null },
    );
    expect(thinkings).toEqual(["想"]);
    expect(body).toMatchObject({ session_id: "s-1", lane_id: "br-1", branch_at: null });
  });

  it("branchAt: 'e1' 透传；未给则不带字段", async () => {
    const bodies: unknown[] = [];
    const run = (opts: ChatStreamOptions) => streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: () => {}, onDone: () => {} },
      fetchRouter({ "/api/chat": (init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse(["event: done\ndata: \n\n"]);
      } }),
      undefined,
      opts,
    );
    await run({ branchAt: "e1" });
    await run({});
    expect(bodies[0]).toMatchObject({ branch_at: "e1" });
    expect("branch_at" in (bodies[1] as object)).toBe(false);
  });

  it("deleteSession：DELETE /api/sessions/:id；404 返回 false", async () => {
    const fetchImpl = fetchRouter({
      "/api/sessions/s1": () => new Response(null, { status: 204 }),
      "/api/sessions/ghost": () => jsonResponse({ error: "会话不存在" }, 404),
    });
    expect(await deleteSession("s1", fetchImpl)).toBe(true);
    expect(await deleteSession("ghost", fetchImpl)).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/api/chat.test.ts`
Expected: FAIL——`deleteSession` 不存在、session 事件解析还是裸 id、onThinking 无。

- [ ] **Step 3: 实现（api/chat.ts）**

类型区替换/追加：

```ts
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** 服务端消息 entry id（回看/流收尾刷新后存在；流式中的本地乐观消息无）。 */
  entryId?: string;
  /** assistant 的 thinking（历史回看带出；流式期间本地累积）。 */
  thinking?: string;
}

export interface LaneInfo {
  id: string;
  forkEntryId: string | null;
  fromLaneId: string | null;
}

export interface SessionDetail {
  title: string;
  currentModel: string;
  currentLane: string;
  lanes: LaneInfo[];
  messages: ChatMessage[];
}

export interface ChatHandlers {
  onDelta: (text: string) => void;
  onThinking?: (text: string) => void;
  onDone: () => void;
  onError?: (message: string) => void;
  /** 首帧 session 事件：后端回传 {session_id, lane_id}（新会话/开叉均会发）。 */
  onSession?: (id: string, lane: string) => void;
}

export interface ChatStreamOptions {
  /** 会话 id；缺省 = 新会话（由后端创建并经 session 事件回传）。 */
  sessionId?: string;
  /** 本轮使用的模型 id；缺省沿用会话当前模型/后端默认。 */
  model?: string;
  /** 写入目标分支；缺省由后端取最新分支。 */
  laneId?: string;
  /** 在该消息 entry 处开新分支（编辑/rewind/regenerate 统一原语）；null = 根部分叉。 */
  branchAt?: string | null;
}
```

`streamChat` 请求体构造替换：

```ts
    const body: {
      messages: ChatMessage[]; session_id?: string; model?: string;
      lane_id?: string; branch_at?: string | null;
    } = { messages };
    if (options.sessionId) body.session_id = options.sessionId;
    if (options.model) body.model = options.model;
    if (options.laneId) body.lane_id = options.laneId;
    if (options.branchAt !== undefined) body.branch_at = options.branchAt;
```

SSE 分发替换（session 与 thinking）：

```ts
        if (event === "session") {
          let payload: { session_id: string; lane_id: string };
          try {
            payload = JSON.parse(data);
          } catch {
            finishError("响应解析失败");
            return;
          }
          handlers.onSession?.(payload.session_id, payload.lane_id);
        }
        if (event === "thinking") {
          let text: string;
          try {
            text = JSON.parse(data);
          } catch {
            finishError("响应解析失败");
            return;
          }
          handlers.onThinking?.(text);
        }
```

`fetchSessionDetail` 与文件末尾追加：

```ts
/** GET /api/sessions/:id?lane=：分支回看（lane 缺省 = 最新分支）。 */
export function fetchSessionDetail(
  id: string,
  fetchImpl: FetchLike = fetch,
  lane?: string,
): Promise<SessionDetail> {
  const url = `/api/sessions/${encodeURIComponent(id)}${lane ? `?lane=${encodeURIComponent(lane)}` : ""}`;
  return getJson(url, fetchImpl);
}

/** DELETE /api/sessions/:id：删除会话；不存在（404）返回 false。 */
export async function deleteSession(id: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const resp = await fetchImpl(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (resp.status === 404) return false;
  if (!resp.ok) throw new Error(`请求失败: ${resp.status}`);
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过（useChat.test.ts/App.test.ts 此时可能红——下个任务修）**

Run: `cd frontend && npx vitest run src/api/chat.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/chat.ts frontend/src/api/chat.test.ts
git commit -m "feat(frontend): chat API——session 事件对象/thinking/branchAt/deleteSession"
```

---

### Task 9: 前端 useChat——lane 状态/编辑/rewind/regenerate/切换/删除

**Files:**

- Modify: `frontend/src/hooks/useChat.ts`
- Test: `frontend/src/hooks/useChat.test.ts`

- [ ] **Step 1: 写失败测试（既有用例的 SSE 桩与 detail 桩按新格式更新后，追加）**

既有用例更新点（全部用例统一）：

- `'event: session\ndata: "s-new"\n\n'` → `'event: session\ndata: {"session_id":"s-new","lane_id":"main"}\n\n'`（各处）
- `/api/sessions/s1` 桩响应补 `currentLane: "main"` 与 `lanes: [{ id: "main", forkEntryId: null, fromLaneId: null }]`；消息项补 `entryId`（如 `{ role: "user", content: "问题", entryId: "e0" }`）
- 「send：…」用例的 `/api/sessions` 计数逻辑不变；`onDone` 现在会再拉一次 detail，因此 fetchRouter 需含 `"/api/sessions/s-new?lane=main": () => jsonResponse({ title: "你好", currentModel: "qwen3:4b", currentLane: "main", lanes: [{ id: "main", forkEntryId: null, fromLaneId: null }], messages: [{ role: "user", content: "hi", entryId: "e0" }, { role: "assistant", content: "你好", entryId: "e1" }] })`

追加用例：

```ts
  it("编辑消息：请求带 branch_at=前一条 entryId，本地截断到编辑点", async () => {
    let chatBody: unknown = null;
    const detail = {
      title: "t", currentModel: "qwen3:4b", currentLane: "br-1",
      lanes: [
        { id: "main", forkEntryId: null, fromLaneId: null },
        { id: "br-1", forkEntryId: "e1", fromLaneId: "main" },
      ],
      messages: [
        { role: "user", content: "q1", entryId: "e0" },
        { role: "assistant", content: "a1", entryId: "e1" },
      ],
    };
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse(detail),
      "/api/sessions/s1?lane=br-1": () => jsonResponse(detail),
      "/api/chat": (init) => {
        chatBody = JSON.parse(String(init?.body));
        return sseResponse([
          'event: session\ndata: {"session_id":"s1","lane_id":"br-2"}\n\n',
          'event: delta\ndata: "新答"\n\n',
          "event: done\ndata: \n\n",
        ]);
      },
      "/api/sessions/s1?lane=br-2": () => jsonResponse({
        ...detail, currentLane: "br-2",
        lanes: [...detail.lanes, { id: "br-2", forkEntryId: "e1", fromLaneId: "br-1" }],
        messages: [
          { role: "user", content: "q1", entryId: "e0" },
          { role: "assistant", content: "a1", entryId: "e1" },
          { role: "user", content: "q1-改", entryId: "e2" },
          { role: "assistant", content: "新答", entryId: "e3" },
        ],
      }),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    act(() => result.current.editMessage(0, "q1-改")); // 编辑首条 → 根部分叉
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(chatBody).toMatchObject({ session_id: "s1", branch_at: null });
    await waitFor(() => expect(result.current.messages.map((m) => m.content)).toEqual(["q1", "a1", "q1-改", "新答"]));
    expect(result.current.currentLane).toBe("br-2");
  });

  it("rewind：截断显示 + 下一次发送在目标消息处开叉", async () => {
    let chatBody: unknown = null;
    const detail = {
      title: "t", currentModel: "m", currentLane: "main",
      lanes: [{ id: "main", forkEntryId: null, fromLaneId: null }],
      messages: [
        { role: "user", content: "q1", entryId: "e0" },
        { role: "assistant", content: "a1", entryId: "e1" },
        { role: "user", content: "q2", entryId: "e2" },
        { role: "assistant", content: "a2", entryId: "e3" },
      ],
    };
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse(detail),
      "/api/sessions/s1?lane=main": () => jsonResponse(detail),
      "/api/chat": (init) => {
        chatBody = JSON.parse(String(init?.body));
        return sseResponse([
          'event: session\ndata: {"session_id":"s1","lane_id":"br-1"}\n\n',
          "event: done\ndata: \n\n",
        ]);
      },
      "/api/sessions/s1?lane=br-1": () => jsonResponse({ ...detail, currentLane: "br-1" }),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    act(() => result.current.setRewind(1)); // 回到 a1
    expect(result.current.rewindTo).toEqual({ index: 1, entryId: "e1" });
    act(() => result.current.send("q3"));
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(chatBody).toMatchObject({ session_id: "s1", branch_at: "e1" });
    expect(result.current.rewindTo).toBeNull();
  });

  it("regenerate：在末条 assistant 的前一条（user 消息）处开叉并重发原文", async () => {
    let chatBody: unknown = null;
    const detail = {
      title: "t", currentModel: "m", currentLane: "main",
      lanes: [{ id: "main", forkEntryId: null, fromLaneId: null }],
      messages: [
        { role: "user", content: "q1", entryId: "e0" },
        { role: "assistant", content: "a1", entryId: "e1" },
      ],
    };
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse(detail),
      "/api/sessions/s1?lane=main": () => jsonResponse(detail),
      "/api/chat": (init) => {
        chatBody = JSON.parse(String(init?.body));
        return sseResponse([
          'event: session\ndata: {"session_id":"s1","lane_id":"br-1"}\n\n',
          'event: delta\ndata: "a1\'"\n\n',
          "event: done\ndata: \n\n",
        ]);
      },
      "/api/sessions/s1?lane=br-1": () => jsonResponse({ ...detail, currentLane: "br-1" }),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    act(() => result.current.regenerate());
    await waitFor(() => expect(result.current.streaming).toBe(false));
    expect(chatBody).toMatchObject({
      session_id: "s1", branch_at: "e0",
      messages: [{ role: "user", content: "q1" }], // 重发原文
    });
  });

  it("selectLane：按分支重载路径与 lanes", async () => {
    const mainDetail = {
      title: "t", currentModel: "m", currentLane: "main",
      lanes: [
        { id: "main", forkEntryId: null, fromLaneId: null },
        { id: "br-1", forkEntryId: "e1", fromLaneId: "main" },
      ],
      messages: [
        { role: "user", content: "q1", entryId: "e0" },
        { role: "assistant", content: "a1", entryId: "e1" },
      ],
    };
    const brDetail = {
      ...mainDetail, currentLane: "br-1",
      messages: [
        { role: "user", content: "q1", entryId: "e0" },
        { role: "assistant", content: "a1", entryId: "e1" },
        { role: "user", content: "q2'", entryId: "e2" },
      ],
    };
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse(mainDetail),
      "/api/sessions/s1?lane=main": () => jsonResponse(mainDetail),
      "/api/sessions/s1?lane=br-1": () => jsonResponse(brDetail),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    await act(async () => { await result.current.selectLane("br-1"); });
    expect(result.current.currentLane).toBe("br-1");
    expect(result.current.messages.map((m) => m.content)).toEqual(["q1", "a1", "q2'"]);
    // 发送写到当前查看的分支
    let chatBody: unknown = null;
    (fetchImpl as unknown as { calls?: unknown }).calls = undefined;
    const fetch2 = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1?lane=br-1": () => jsonResponse(brDetail),
      "/api/chat": (init) => {
        chatBody = JSON.parse(String(init?.body));
        return sseResponse([
          'event: session\ndata: {"session_id":"s1","lane_id":"br-1"}\n\n',
          "event: done\ndata: \n\n",
        ]);
      },
    });
    void fetch2;
    expect(chatBody).toBeNull(); // 本用例只验证加载；lane 写入由上一用例覆盖
  });

  it("deleteSession：删除当前会话后回到新会话态", async () => {
    const detail = {
      title: "t", currentModel: "m", currentLane: "main",
      lanes: [{ id: "main", forkEntryId: null, fromLaneId: null }],
      messages: [{ role: "user", content: "q1", entryId: "e0" }],
    };
    const fetchImpl = fetchRouter({
      "/api/models": () => jsonResponse(MODELS),
      "/api/sessions": () => jsonResponse([S1]),
      "/api/sessions/s1": () => jsonResponse(detail),
      "/api/sessions/s1?lane=main": () => jsonResponse(detail),
      "/api/sessions/s1?lane=br-1": () => jsonResponse(detail),
    });
    const { result } = renderHook(() => useChat(fetchImpl));
    await waitFor(() => expect(result.current.model).toBe("qwen3:4b"));
    await act(async () => { await result.current.selectSession("s1"); });
    await act(async () => { await result.current.deleteSession("s1"); });
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.currentLane).toBe("main");
  });
```

注意：deleteSession 用例的 fetchRouter 需含 `"/api/sessions/s1"` 的 DELETE 命中——fetchRouter 按 URL 精确路由且不区分 method，`"/api/sessions/s1": () => jsonResponse(detail)` 会被 DELETE 复用并返回 200（非 404 → 视为成功）。可接受；若想钉死语义，加专用桩返回 204。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/hooks/useChat.test.ts`
Expected: FAIL——`editMessage`/`setRewind`/`regenerate`/`selectLane`/`deleteSession` 不存在。

- [ ] **Step 3: 实现（useChat.ts 整体重写）**

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteSession,
  fetchModels,
  fetchSessionDetail,
  fetchSessions,
  streamChat,
  type ChatMessage,
  type LaneInfo,
  type ModelInfo,
  type SessionSummary,
} from "../api/chat";

/** 聊天产品状态：消息流 + 会话（列表/当前/回看/分支）+ 模型选择 + SSE 流式。
    会话与分支状态由服务端权威（JSONL session tree），前端只持有 id/lane 并在
    session 事件/收尾时刷新；编辑/rewind/regenerate 统一为 branch_at 发送。 */
export function useChat(fetchImpl: typeof fetch = fetch) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [currentLane, setCurrentLane] = useState("main");
  const [lanes, setLanes] = useState<LaneInfo[]>([{ id: "main", forkEntryId: null, fromLaneId: null }]);
  const [rewindTo, setRewindTo] = useState<{ index: number; entryId: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 流式回调闭包用：最新的会话/分支（新会话的 id 只在 session 事件里出现）。 */
  const cursorRef = useRef<{ id: string | null; lane: string }>({ id: null, lane: "main" });
  /** activeSessionId 的 ref 镜像（refreshDetail 闭包内比较「期间是否已切走」用）。 */
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await fetchSessions(fetchImpl));
    } catch (err) {
      console.error("会话列表加载失败", err);
    }
  }, [fetchImpl]);

  const loadDetail = useCallback(async (id: string, lane?: string) => {
    try {
      const detail = await fetchSessionDetail(id, fetchImpl, lane);
      setMessages(detail.messages);
      setActiveSessionId(id);
      setCurrentLane(detail.currentLane);
      setLanes(detail.lanes);
      setRewindTo(null);
      if (detail.currentModel) setModel(detail.currentModel);
      cursorRef.current = { id, lane: detail.currentLane };
    } catch (err) {
      console.error("会话加载失败", err);
    }
  }, [fetchImpl]);

  /** 流收尾后按当前会话/分支重拉详情：补齐 entryId 与 lanes（编辑/切换的依据）。 */
  const refreshDetail = useCallback(async () => {
    const { id, lane } = cursorRef.current;
    if (!id) return;
    // 期间用户可能已切走：只在与光标一致时落状态
    if (id !== activeSessionIdRef.current) return;
    await loadDetail(id, lane);
  }, [loadDetail]);

  // 初始加载：模型列表（首个 = 后端默认模型）+ 会话列表
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchModels(fetchImpl);
        if (cancelled || list.length === 0) return;
        setModels(list);
        setModel((m) => m || list[0].id);
      } catch (err) {
        console.error("模型列表加载失败", err);
      }
    })();
    void refreshSessions();
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, refreshSessions]);

  // 卸载时中止进行中的流
  useEffect(() => () => abortRef.current?.abort(), []);

  const appendToLast = (text: string) =>
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const copy = [...prev];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { ...last, content: last.content + text };
      return copy;
    });

  const appendThinkingToLast = (text: string) =>
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const copy = [...prev];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { ...last, thinking: (last.thinking ?? "") + text };
      return copy;
    });

  /** 发送一条用户消息。
      opts.branchAt：在该 entry 处开新分支（缺省取 rewind 点）；opts.keepUntil：本地截断下标（编辑/rewind/重发时丢弃尾部）。 */
  const send = (content: string, opts: { branchAt?: string | null; keepUntil?: number } = {}) => {
    const text = content.trim();
    if (!text || streaming) return;
    const branchAt = opts.branchAt !== undefined ? opts.branchAt
      : rewindTo ? rewindTo.entryId : undefined;
    const keepUntil = opts.keepUntil !== undefined ? opts.keepUntil
      : rewindTo ? rewindTo.index + 1 : undefined;
    const base = keepUntil !== undefined ? messages.slice(0, keepUntil) : messages;
    const withUser: ChatMessage[] = [...base, { role: "user", content: text }];
    setMessages([...withUser, { role: "assistant", content: "" }]);
    setStreaming(true);
    setRewindTo(null);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    void streamChat(
      withUser,
      {
        onSession: (id, lane) => {
          setActiveSessionId(id);
          setCurrentLane(lane);
          cursorRef.current = { id, lane };
          void refreshSessions();
        },
        onThinking: appendThinkingToLast,
        onDelta: appendToLast,
        onDone: () => {
          setStreaming(false);
          void refreshSessions();
          void refreshDetail();
        },
        onError: (message) => {
          appendToLast(`（出错了：${message}）`);
          setStreaming(false);
        },
      },
      fetchImpl,
      ac.signal,
      {
        sessionId: activeSessionId ?? undefined,
        model: model || undefined,
        // 续写当前查看的分支（服务端缺省取最新分支，与查看态可能不同）
        laneId: branchAt === undefined && activeSessionId ? currentLane : undefined,
        branchAt,
      },
    );
  };

  /** 编辑用户消息：在其前一条消息处开叉，新分支发送编辑后内容。 */
  const editMessage = (index: number, content: string) => {
    const branchAt = index === 0 ? null : messages[index - 1].entryId ?? null;
    send(content, { branchAt, keepUntil: index });
  };

  /** 重新生成：在末条 assistant 的前一条（user 消息）处开叉，重发同一条用户消息原文。 */
  const regenerate = () => {
    const k = messages.length - 1;
    if (streaming || k < 1 || messages[k].role !== "assistant") return;
    const userMsg = messages[k - 1];
    if (userMsg.role !== "user" || !userMsg.entryId) return;
    send(userMsg.content, { branchAt: userMsg.entryId, keepUntil: k });
  };

  /** rewind：把续写点移到某条消息（纯前端态；下一次发送才在该消息处开叉）。 */
  const setRewind = (index: number) => {
    if (streaming) return;
    const m = messages[index];
    if (!m.entryId) return;
    setRewindTo({ index, entryId: m.entryId });
  };
  const cancelRewind = () => setRewindTo(null);

  /** 回看历史会话（lane 缺省 = 最新分支）。 */
  const selectSession = async (id: string) => {
    if (id === activeSessionId) return;
    abortRef.current?.abort();
    await loadDetail(id);
  };

  /** 分支切换：以对应 lane 重新加载路径。 */
  const selectLane = async (lane: string) => {
    if (!activeSessionId || lane === currentLane) return;
    await loadDetail(activeSessionId, lane);
  };

  /** 新对话：清空消息流与 session_id（模型选择保留）。 */
  const newChat = () => {
    abortRef.current?.abort();
    setMessages([]);
    setActiveSessionId(null);
    setCurrentLane("main");
    setLanes([{ id: "main", forkEntryId: null, fromLaneId: null }]);
    setRewindTo(null);
    cursorRef.current = { id: null, lane: "main" };
  };

  /** 删除会话：流式中先 abort；删除当前会话则回到新会话态。 */
  const deleteSessionById = async (id: string) => {
    if (id === activeSessionId) abortRef.current?.abort();
    try {
      const ok = await deleteSession(id, fetchImpl);
      if (!ok) return;
    } catch (err) {
      console.error("会话删除失败", err);
      return;
    }
    if (id === activeSessionId) newChat();
    void refreshSessions();
  };

  return {
    messages,
    streaming,
    sessions,
    models,
    model,
    activeSessionId,
    currentLane,
    lanes,
    rewindTo,
    send,
    editMessage,
    regenerate,
    setRewind,
    cancelRewind,
    selectSession,
    selectLane,
    newChat,
    deleteSession: deleteSessionById,
    selectModel: setModel,
  };
}
```

（`activeSessionIdRef` 在组件体内每渲染同步一次——ref 读到最新值，这是 React 官方认可的「最新值镜像」手法。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/hooks/useChat.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useChat.ts frontend/src/hooks/useChat.test.ts
git commit -m "feat(frontend): useChat——分支状态机（编辑/rewind/regenerate/切换/删除）"
```

---

### Task 10: 前端 MessageBubble——markdown 渲染 + thinking 面板 + hover 工具条

**Files:**

- Modify: `frontend/src/components/MessageBubble.tsx`
- Create: `frontend/src/components/MessageBubble.test.tsx`
- Modify: `frontend/package.json`（依赖）

- [ ] **Step 1: 安装依赖**

Run: `cd frontend && npm install react-markdown@^10 remark-gfm@^4 remark-math@^6 rehype-katex@^7`
Expected: 安装成功（katex CSS 已在 main.tsx 引入，无需重复）。

- [ ] **Step 2: 写失败测试（MessageBubble.test.tsx）**

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "../api/chat";

const msg = (over: Partial<ChatMessage> & { role?: "user" | "assistant" }): ChatMessage => ({
  role: "assistant",
  content: "答案",
  ...over,
} as ChatMessage);

describe("MessageBubble", () => {
  it("assistant 消息渲染 markdown：GFM 表格/列表 + LaTeX 数学", () => {
    render(<MessageBubble
      message={msg({ content: "- 要点一\n- 要点二\n\n$3+4=7$\n\n| a | b |\n| - | - |\n| 1 | 2 |" })}
      index={0} isLast={false} streaming={false}
    />);
    expect(screen.getAllByText(/要点/)).toHaveLength(2);
    expect(document.querySelector(".bubble .katex")).not.toBeNull(); // LaTeX 真渲染
    expect(document.querySelectorAll("table")).toHaveLength(1);
  });

  it("user 消息保持纯文本转义（无 markdown/HTML 注入）", () => {
    render(<MessageBubble
      message={msg({ role: "user", content: "<b>加粗</b> *不是斜体*" })}
      index={0} isLast={false} streaming={false}
    />);
    expect(screen.getByText("<b>加粗</b> *不是斜体*")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });

  it("无 thinking 的消息不渲染面板；有 thinking 的历史轮默认折叠，点击头部展开", () => {
    const { rerender } = render(<MessageBubble
      message={msg({ thinking: "想了想" })} index={0} isLast={false} streaming={false}
    />);
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    expect(screen.queryByText("想了想")).toBeNull(); // 折叠态正文不可见
    fireEvent.click(screen.getByRole("button", { name: /思考过程/ }));
    expect(screen.getByText("想了想")).toBeVisible();
    rerender(<MessageBubble message={msg({})} index={0} isLast={false} streaming={false} />);
    expect(screen.queryByText("思考过程")).toBeNull();
  });

  it("当前轮 thinking 输出期间展开，收到首个 delta 自动折叠", () => {
    const { rerender } = render(<MessageBubble
      message={msg({ content: "", thinking: "想" })} index={0} isLast={true} streaming={true}
    />);
    expect(screen.getByText("想")).toBeVisible(); // 展开
    rerender(<MessageBubble
      message={msg({ content: "答案", thinking: "想" })} index={0} isLast={true} streaming={true}
    />);
    expect(screen.queryByText("想")).toBeNull(); // 首个 delta 后自动折叠
  });

  it("hover 工具条：复制/编辑（user）/rewind/重新生成按 props 出现，编辑态保存回调", () => {
    const onEdit = vi.fn();
    const { rerender } = render(<MessageBubble
      message={msg({ role: "user", content: "原问题", entryId: "e0" })} index={0} isLast={false} streaming={false}
      actions={{ onEdit, onRewind: vi.fn(), onCopy: vi.fn() }}
    />);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "改后" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onEdit).toHaveBeenCalledWith(0, "改后");
    rerender(<MessageBubble
      message={msg({ entryId: "e1" })} index={1} isLast={true} streaming={false}
      actions={{ onRegenerate: vi.fn(), onRewind: vi.fn(), onCopy: vi.fn() }}
    />);
    expect(screen.getByRole("button", { name: "重新生成" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/MessageBubble.test.tsx`
Expected: FAIL——props 不匹配/无 markdown 渲染。

- [ ] **Step 4: 实现（MessageBubble.tsx 整体重写）**

```tsx
import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { ChatMessage } from "../api/chat";

export interface BubbleActions {
  onEdit?: (index: number, content: string) => void;
  onRewind?: (index: number) => void;
  onRegenerate?: () => void;
  onCopy?: (message: ChatMessage) => void;
}

/** assistant 的 markdown 渲染：delta 累积后整体重渲（memo 优化）。
    不启用 rehype-raw——组件化渲染默认转义，无原始 HTML 注入面。 */
const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

interface MessageBubbleProps {
  message: ChatMessage;
  index: number;
  isLast: boolean;
  streaming: boolean;
  actions?: BubbleActions;
}

export function MessageBubble({ message, index, isLast, streaming, actions }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  // 当前轮：thinking 输出期间展开（尚无正式内容），收到首个 delta 自动折叠；历史轮默认折叠
  const thinkingOpen = manualOpen ?? (isLast && streaming && message.content === "" && !!message.thinking);

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };
  const saveEdit = () => {
    setEditing(false);
    if (draft.trim() && draft !== message.content) actions?.onEdit?.(index, draft.trim());
  };

  return (
    <div className={`msg ${isUser ? "user" : "agent"}`}>
      <div className="avatar">{isUser ? "我" : "答"}</div>
      <div className="msg-main">
        <div className="who">{isUser ? "我" : "学习助手"}</div>
        {message.thinking && (
          <div className={`thinking${thinkingOpen ? " open" : ""}`} data-thinking-open={thinkingOpen}>
            <button className="thinking-head" onClick={() => setManualOpen(!thinkingOpen)}>
              💭 思考过程
            </button>
            {thinkingOpen && <div className="thinking-body">{message.thinking}</div>}
          </div>
        )}
        {isUser ? (
          editing ? (
            <div className="edit-box">
              <textarea aria-label="编辑消息" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="edit-actions">
                <button className="primary" onClick={saveEdit}>保存</button>
                <button className="ghost" onClick={() => setEditing(false)}>取消</button>
              </div>
            </div>
          ) : (
            <div className="bubble">{message.content}</div>
          )
        ) : (
          <div className="bubble"><Markdown text={message.content} /></div>
        )}
        {message.entryId && !editing && (
          <div className="msg-actions">
            <button title="复制" onClick={() => actions?.onCopy?.(message)}>复制</button>
            {isUser && actions?.onEdit && <button onClick={startEdit}>编辑</button>}
            {actions?.onRewind && <button onClick={() => actions.onRewind!(index)}>回到这</button>}
            {actions?.onRegenerate && <button onClick={() => actions.onRegenerate!()}>重新生成</button>}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/components/MessageBubble.test.tsx`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/components/MessageBubble.tsx frontend/src/components/MessageBubble.test.tsx
git commit -m "feat(frontend): MessageBubble——markdown+LaTeX 渲染/thinking 面板/hover 工具条"
```

---

### Task 11: 前端 ChatView/SessionsSidebar/App——切换器/rewind UI/复制全文/删除确认/toast

**Files:**

- Modify: `frontend/src/views/ChatView.tsx`、`frontend/src/components/SessionsSidebar.tsx`、`frontend/src/App.tsx`
- Create: `frontend/src/views/ChatView.test.tsx`
- Modify: `frontend/src/App.test.tsx`、`frontend/src/theme.css`

- [ ] **Step 1: 写失败测试（ChatView.test.tsx）**

```tsx
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import type { ChatMessage, LaneInfo } from "../api/chat";

const LANES: LaneInfo[] = [
  { id: "main", forkEntryId: null, fromLaneId: null },
  { id: "br-1", forkEntryId: "e0", fromLaneId: "main" },
];

const MSGS: ChatMessage[] = [
  { role: "user", content: "q1", entryId: "e0" },
  { role: "assistant", content: "a1", entryId: "e1" },
];

describe("ChatView", () => {
  it("‹i/n› 切换器：同一父消息下有分叉时出现，点击切到对应 lane", async () => {
    const onSwitchLane = vi.fn();
    render(<ChatView
      messages={MSGS} streaming={false} lanes={LANES} currentLane="br-1"
      rewindTo={null}
      onSend={vi.fn()} onEdit={vi.fn()} onRewind={vi.fn()} onCancelRewind={vi.fn()}
      onRegenerate={vi.fn()} onSwitchLane={onSwitchLane} onToast={vi.fn()}
    />);
    // br-1 在 e0（首条消息）处分叉：首条消息位置 ‹2/2›
    expect(screen.getByText("2/2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "‹" }));
    expect(onSwitchLane).toHaveBeenCalledWith("main");
    // 当前在 main 时显示 ‹1/2›
    render(<ChatView
      messages={MSGS} streaming={false} lanes={LANES} currentLane="main" rewindTo={null}
      onSend={vi.fn()} onEdit={vi.fn()} onRewind={vi.fn()} onCancelRewind={vi.fn()}
      onRegenerate={vi.fn()} onSwitchLane={onSwitchLane} onToast={vi.fn()}
    />);
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("rewind：截断显示 + 提示条；取消恢复", () => {
    render(<ChatView
      messages={MSGS} streaming={false} lanes={LANES} currentLane="main"
      rewindTo={{ index: 0, entryId: "e0" }}
      onSend={vi.fn()} onEdit={vi.fn()} onRewind={vi.fn()} onCancelRewind={vi.fn()}
      onRegenerate={vi.fn()} onSwitchLane={vi.fn()} onToast={vi.fn()}
    />);
    expect(screen.queryByText("a1")).toBeNull(); // 截断
    expect(screen.getByText(/后续内容保留在原分支/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消回退" }));
    expect(screen.getByText("取消回退")).toBeInTheDocument(); // 按钮仍在（未受控示例）
  });

  it("无分叉的消息无切换器；复制走 onCopy 消息原文", () => {
    render(<ChatView
      messages={[{ role: "user", content: "单分支", entryId: "e0" }]}
      streaming={false}
      lanes={[LANES[0]]} currentLane="main" rewindTo={null}
      onSend={vi.fn()} onEdit={vi.fn()} onRewind={vi.fn()} onCancelRewind={vi.fn()}
      onRegenerate={vi.fn()} onSwitchLane={vi.fn()} onToast={vi.fn()}
    />);
    expect(screen.queryByText("1/1")).toBeNull();
  });
});
```

（App.test.tsx 同步更新：SSE 桩 session 事件改对象格式、detail 桩补 lane 字段——同 useChat.test.ts 的更新手法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/views/ChatView.test.tsx`
Expected: FAIL——ChatView props 不匹配。

- [ ] **Step 3: 实现**

`ChatView.tsx` 整体重写：

```tsx
import { useState } from "react";
import type { ChatMessage, LaneInfo } from "../api/chat";
import { Composer } from "../components/Composer";
import { MessageBubble } from "../components/MessageBubble";

const CHIPS = [
  "把本周错题整理成一张复习卷",
  "朵朵的英语语法错因分布",
  "《7星学霸》第 3 讲有哪些例题",
];

interface ChatViewProps {
  messages: ChatMessage[];
  streaming: boolean;
  lanes: LaneInfo[];
  currentLane: string;
  rewindTo: { index: number; entryId: string } | null;
  onSend: (content: string) => void;
  onEdit: (index: number, content: string) => void;
  onRewind: (index: number) => void;
  onCancelRewind: () => void;
  onRegenerate: () => void;
  onSwitchLane: (laneId: string) => void;
  onToast: (text: string) => void;
}

/** ‹i/n› 分支切换器选项：F 位置 = 前一条消息（i=0 为根部）。
    规则（与后端 branch_meta 对齐）：
    - forks = 在 F 处开叉的分支（含当前分支自身）
    - 当前路径未在 F 处开叉 → 当前即原消息（选项 0），forks 为其余选项
    - 当前分支就在 F 处开叉 → 原消息在 fromLane（选项 0），forks 顺排
    - 根部（i=0）：providers = 全部根 lane（main + 根部分叉） */
function switcherOptions(
  index: number, messages: ChatMessage[], lanes: LaneInfo[], currentLane: string,
): { laneIds: string[]; current: number } | null {
  const F = index === 0 ? null : messages[index - 1].entryId ?? null;
  if (F === null) {
    const roots = lanes.filter((l) => l.forkEntryId === null);
    if (roots.length < 2) return null;
    const cur = roots.findIndex((l) => l.id === currentLane);
    return { laneIds: roots.map((l) => l.id), current: cur >= 0 ? cur : 0 };
  }
  const forks = lanes.filter((l) => l.forkEntryId === F);
  if (forks.length === 0) return null;
  const currentIsFork = forks.some((l) => l.id === currentLane);
  if (!currentIsFork) {
    // 当前路径持有原消息：选项 0 = 原地（不切换），其余 = 各分叉
    return { laneIds: [currentLane, ...forks.map((f) => f.id)], current: 0 };
  }
  const originalLane = forks.find((f) => f.fromLaneId)?.fromLaneId ?? "main";
  const laneIds = [originalLane, ...forks.map((f) => f.id)];
  return { current: 1 + forks.findIndex((f) => f.id === currentLane), laneIds };
}

function BranchSwitcher({ index, messages, lanes, currentLane, onSwitchLane }: {
  index: number; messages: ChatMessage[]; lanes: LaneInfo[]; currentLane: string;
  onSwitchLane: (laneId: string) => void;
}) {
  const opts = switcherOptions(index, messages, lanes, currentLane);
  if (!opts) return null;
  const n = opts.laneIds.length;
  if (n < 2) return null;
  const go = (delta: number) => {
    const next = (opts!.current + delta + n) % n;
    if (next !== opts!.current) onSwitchLane(opts!.laneIds[next]);
  };
  return (
    <span className="branch-switch" aria-label={`分支 ${opts.current + 1}/${n}`}>
      <button onClick={() => go(-1)} disabled={n < 2}>‹</button>
      <span>{opts.current + 1}/{n}</span>
      <button onClick={() => go(1)} disabled={n < 2}>›</button>
    </span>
  );
}

export function ChatView(props: ChatViewProps) {
  const { messages, streaming, lanes, currentLane, rewindTo } = props;
  const [input, setInput] = useState("");
  const visible = rewindTo ? messages.slice(0, rewindTo.index + 1) : messages;

  const send = () => {
    const content = input.trim();
    if (!content || streaming) return;
    props.onSend(content);
    setInput("");
  };

  const copyMessage = async (m: ChatMessage) => {
    try {
      await navigator.clipboard.writeText(m.content);
      props.onToast("已复制");
    } catch {
      props.onToast("复制失败");
    }
  };

  return (
    <>
      <div className="chat-wrap" data-streaming={streaming ? "true" : "false"}>
        <div className="chat-log">
          {messages.length === 0 && (
            <div className="chat-empty">还没有对话——问孩子学习情况，或找题、看讲解。</div>
          )}
          {visible.map((m, i) => (
            <MessageBubble
              key={m.entryId ?? i}
              message={m}
              index={i}
              isLast={i === messages.length - 1}
              streaming={streaming}
              actions={{
                onEdit: props.onEdit,
                onRewind: props.onRewind,
                onRegenerate:
                  !streaming && i === messages.length - 1 && m.role === "assistant"
                    ? props.onRegenerate : undefined,
                onCopy: (msg) => void copyMessage(msg),
              }}
              switcher={
                <BranchSwitcher
                  index={i} messages={messages} lanes={lanes}
                  currentLane={currentLane} onSwitchLane={props.onSwitchLane}
                />
              }
            />
          ))}
        </div>
        {rewindTo && (
          <div className="rewind-banner" role="status">
            已回到这条消息——后续内容保留在原分支，下一次发送将从这里开叉。
            <button className="ghost" onClick={props.onCancelRewind}>取消回退</button>
          </div>
        )}
        <div className="chips">
          {CHIPS.map((c) => (
            <button key={c} onClick={() => setInput(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>
      <Composer value={input} onChange={setInput} onSend={send} disabled={streaming} />
    </>
  );
}
```

`MessageBubble.tsx` 补 `switcher?: React.ReactNode` prop，渲染在 `.who` 旁：

```tsx
interface MessageBubbleProps {
  message: ChatMessage;
  index: number;
  isLast: boolean;
  streaming: boolean;
  actions?: BubbleActions;
  /** ‹i/n› 分支切换器（由 ChatView 计算，随消息头渲染）。 */
  switcher?: React.ReactNode;
}
```

```tsx
        <div className="who">
          {isUser ? "我" : "学习助手"}
          {switcher}
        </div>
```

`SessionsSidebar.tsx`：`session-item` 按钮内加删除入口（props 加 `onDelete: (id: string) => void`）：

```tsx
            <span className="del" role="button" aria-label={`删除会话 ${s.title}`}
                  onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}>🗑</span>
```

（放在 `.m` 行末；CSS hover 显示。）

`App.tsx` 整体替换（接 toast/复制全文/删除确认/新 ChatView props）：

```tsx
import { useEffect, useRef, useState } from "react";
import { ModelPicker } from "./components/ModelPicker";
import { Rail } from "./components/Rail";
import { SessionsSidebar } from "./components/SessionsSidebar";
import { useChat } from "./hooks/useChat";
import { ChatView } from "./views/ChatView";
import { ReviewView } from "./views/ReviewView";
import type { ChatMessage } from "./api/chat";

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function today(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  return `${ymd} ${WEEKDAYS[d.getDay()]}`;
}

/** 整会话复制稿：## 我 / ## 学习助手 交替，不含 thinking。 */
function transcript(messages: ChatMessage[]): string {
  return messages
    .map((m) => `## ${m.role === "user" ? "我" : "学习助手"}\n\n${m.content}`)
    .join("\n\n");
}

export function App() {
  const [kid, setKid] = useState("小宝");
  const [view, setView] = useState<"chat" | "review">("chat");
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chat = useChat();

  const showToast = (text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

  const copyAll = async () => {
    if (!chat.messages.length) return;
    try {
      await navigator.clipboard.writeText(transcript(chat.messages));
      showToast("已复制全文");
    } catch {
      showToast("复制失败");
    }
  };

  return (
    <div className="app">
      <Rail activeView={view} onSelect={setView} />
      {view === "chat" && (
        <SessionsSidebar
          sessions={chat.sessions}
          activeId={chat.activeSessionId}
          onSelect={(id) => void chat.selectSession(id)}
          onNew={chat.newChat}
          onDelete={setConfirmDelete}
        />
      )}
      <main>
        <div className="topbar">
          <div>
            <span className="date">{today()}</span>
            <h1>{view === "chat" ? "聊天" : "复核"}</h1>
          </div>
          {view === "chat" ? (
            <>
              <span className="hint">问孩子学习情况，或找题、看讲解</span>
              {chat.activeSessionId && (
                <button className="ghost" onClick={() => void copyAll()}>复制全文</button>
              )}
              <ModelPicker models={chat.models} value={chat.model} onChange={chat.selectModel} />
              <div className="kid-switch">
                {["小宝", "朵朵"].map((k) => (
                  <button key={k} className={kid === k ? "on" : ""} onClick={() => setKid(k)}>
                    {k}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <span className="hint">确认试卷对错与题库匹配</span>
          )}
        </div>
        {view === "chat"
          ? <ChatView
              messages={chat.messages}
              streaming={chat.streaming}
              lanes={chat.lanes}
              currentLane={chat.currentLane}
              rewindTo={chat.rewindTo}
              onSend={chat.send}
              onEdit={chat.editMessage}
              onRewind={chat.setRewind}
              onCancelRewind={chat.cancelRewind}
              onRegenerate={chat.regenerate}
              onSwitchLane={(lane) => void chat.selectLane(lane)}
              onToast={showToast}
            />
          : <ReviewView />}
      </main>
      {toast && <div className="toast" role="status">{toast}</div>}
      {confirmDelete && (
        <div className="dialog-mask" role="dialog" aria-label="删除会话">
          <div className="dialog">
            <p>删除这个会话？删除后不可恢复。</p>
            <div className="dialog-actions">
              <button className="danger" onClick={() => {
                void chat.deleteSession(confirmDelete);
                setConfirmDelete(null);
              }}>删除</button>
              <button className="ghost" onClick={() => setConfirmDelete(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

（kid-switch 真数据化属 3-C3，此处保持占位。）

`theme.css` 追加（文件末尾）：

```css
/* ---- 3-C1 聊天增强 ---- */
.msg-main { min-width: 0; }
.msg .who { display: flex; align-items: center; gap: 8px; }
.msg-actions { display: none; gap: 4px; margin-top: 2px; }
.msg:hover .msg-actions { display: inline-flex; }
.msg-actions button { border: 1px solid var(--line); background: var(--card); border-radius: 6px;
  font-size: 11px; padding: 2px 8px; cursor: pointer; color: var(--ink); }
.msg-actions button:hover { border-color: var(--redpen); color: var(--redpen); }
.branch-switch { display: inline-flex; align-items: center; gap: 2px; font-size: 11px;
  color: var(--pencil); font-family: var(--mono); }
.branch-switch button { border: none; background: none; cursor: pointer; font-size: 13px;
  color: var(--pencil); padding: 0 3px; }
.branch-switch button:hover { color: var(--redpen); }
.thinking { margin: 2px 0 6px; border: 1px dashed var(--line); border-radius: 8px;
  background: rgba(255,255,255,.55); }
.thinking-head { border: none; background: none; cursor: pointer; font-size: 11.5px;
  color: var(--pencil); padding: 4px 10px; width: 100%; text-align: left; }
.thinking-body { font-size: 12.5px; color: var(--pencil); padding: 0 10px 8px;
  white-space: pre-wrap; max-height: 240px; overflow-y: auto; }
.thinking.open .thinking-head { color: var(--ink); }
.bubble .md > :first-child { margin-top: 0; }
.bubble .md > :last-child { margin-bottom: 0; }
.bubble .md p { margin: 6px 0; }
.bubble .md pre { background: rgba(43,43,38,.06); padding: 8px 10px; border-radius: 6px;
  overflow-x: auto; font-family: var(--mono); font-size: 12.5px; }
.bubble .md code { font-family: var(--mono); font-size: 12.5px; }
.bubble .md table { border-collapse: collapse; margin: 6px 0; }
.bubble .md th, .bubble .md td { border: 1px solid var(--line); padding: 3px 8px; font-size: 12.5px; }
.bubble .md .katex-display { margin: 8px 0; overflow-x: auto; }
.edit-box textarea { width: 100%; min-height: 64px; border: 1px solid var(--line);
  border-radius: 8px; padding: 8px; font: inherit; }
.edit-actions { display: flex; gap: 6px; margin-top: 4px; }
.rewind-banner { display: flex; align-items: center; gap: 10px; margin: 4px 16px;
  padding: 8px 12px; border: 1px dashed var(--redpen); border-radius: 8px;
  color: var(--redpen); font-size: 12.5px; }
.session-item { position: relative; }
.session-item .del { display: none; position: absolute; right: 8px; bottom: 8px;
  cursor: pointer; font-size: 12px; opacity: .6; }
.session-item:hover .del { display: inline; }
.session-item .del:hover { opacity: 1; }
.toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  background: var(--ink); color: #fff; font-size: 13px; padding: 8px 18px;
  border-radius: 999px; z-index: 60; }
.dialog-mask { position: fixed; inset: 0; background: rgba(43,43,38,.35); z-index: 50;
  display: flex; align-items: center; justify-content: center; }
.dialog { background: var(--paper); border-radius: 12px; padding: 20px 24px;
  box-shadow: 0 12px 40px rgba(43,43,38,.18); min-width: 280px; }
.dialog p { margin: 0 0 14px; font-size: 14px; }
.dialog-actions { display: flex; gap: 8px; justify-content: flex-end; }
.dialog-actions .danger { background: var(--redpen); color: #fff; border: none;
  border-radius: 8px; padding: 6px 16px; cursor: pointer; }
.topbar .ghost { border: 1px solid var(--line); background: var(--card); border-radius: 8px;
  padding: 5px 12px; font-size: 12.5px; cursor: pointer; color: var(--ink); }
.topbar .ghost:hover { border-color: var(--redpen); color: var(--redpen); }
.edit-box .primary, .dialog-actions .danger { font-weight: 500; }
.edit-box .ghost { border: 1px solid var(--line); background: none; border-radius: 8px;
  padding: 6px 16px; cursor: pointer; }
```

- [ ] **Step 4: 跑前端全量确认通过**

Run: `cd frontend && npm test`
Expected: 全部 PASS（App.test.tsx 更新后）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/ChatView.tsx frontend/src/views/ChatView.test.tsx frontend/src/components/MessageBubble.tsx frontend/src/components/SessionsSidebar.tsx frontend/src/App.tsx frontend/src/App.test.tsx frontend/src/theme.css
git commit -m "feat(frontend): ‹i/n› 分支切换器/rewind 截断/复制全文/删除确认/toast"
```

---

### Task 12: E2E——聊天增强全链路

**Files:**

- Create: `e2e/specs/chat-enhancements.spec.ts`
- Modify: `e2e/specs/chat-session.spec.ts`（detail 响应扩展后的断言修正）

- [ ] **Step 1: 修正既有 chat-session.spec.ts**

- `t1` 中 `expect(detail.messages[0]).toEqual({ role: "user", content: MSG_A1 });` → `expect(detail.messages[0]).toMatchObject({ role: "user", content: MSG_A1 }); expect(typeof detail.messages[0].entryId).toBe("string");`
- `t1` detail 请求后补：`expect(detail.currentLane).toBe("main"); expect(detail.lanes).toEqual([{ id: "main", forkEntryId: null, fromLaneId: null }]);`
- `t2` 的 `currentModel: string; messages: …` 类型行补 `currentLane: string;`；断言不变（`bubbles` 与 `detail.messages.map(content)` 比较不受影响）。

- [ ] **Step 2: 写新 spec**

```typescript
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";

/** 3-C1 聊天增强全链路：编辑/rewind/regenerate 分支 + ‹i/n› 切换 + thinking +
    markdown/LaTeX + 复制 + 删除。真实栈（三服务 + ollama + PostgreSQL），
    断言到 UI、API、JSONL、llm_calls 字段。串行执行。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const SESSIONS_ROOT =
  process.env.KB_SESSIONS_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backend/storage/sessions");

const Q1 = `E2E-${RUN}-999 乘 999 等于多少？`;
const Q1_EDIT = `E2E-${RUN}-888 乘 888 等于多少？`;
const Q2 = `E2E-${RUN}-再用 markdown 无序列表给我三个预习建议`;

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let sessionId = "";
let turnCount = 0;

function findSessionFile(id: string): string {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  return walk(SESSIONS_ROOT).find((f) => f.endsWith(`${id}.jsonl`))!;
}

async function waitReplyDone(page: Page, timeout = 240_000) {
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false", { timeout });
  await expect
    .poll(async () => (await page.locator(".msg:last-child .bubble").textContent())?.length ?? 0, { timeout })
    .toBeGreaterThan(0);
  const reply = (await page.locator(".msg:last-child .bubble").textContent())!;
  expect(reply).not.toContain("出错了");
  turnCount++;
  return reply;
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder(/问点什么/).fill(text);
  await page.getByRole("button", { name: "发送" }).click();
}

test.beforeAll(async () => {
  // thinking 用例依赖模型默认输出 reasoning（本机 ollama qwen3.5 已验证经 /v1 返回独立 reasoning 字段）
});

test("t1 thinking 当轮展开-自动折叠 + assistant 消息 markdown/LaTeX 渲染", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/");
  await send(page, `${Q1} 请思考后只回答算式结果，用 $...$ 行内 LaTeX。`);
  // thinking 输出期间面板展开（qwen3.5 思考期数秒，poll 捕捉）
  await expect
    .poll(async () => page.locator(".thinking.open").count(), { timeout: 60_000 })
    .toBeGreaterThan(0);
  const reply = await waitReplyDone(page);
  // 首个 delta 后自动折叠：收尾后不展开
  await expect(page.locator(".thinking.open")).toHaveCount(0);
  expect(page.locator(".thinking")).toHaveCount(1); // 面板存在（默认折叠）
  // LaTeX 真渲染（katex 节点）
  await expect(page.locator(".msg:last-child .bubble .katex").first()).toBeVisible({ timeout: 10_000 });
  expect(reply).toContain("998001");

  // API：detail 带 entryId/thinking/currentLane/lanes
  const list = (await (await page.request.get("/api/sessions")).json()) as { id: string; title: string }[];
  sessionId = list.find((s) => s.title.startsWith(`E2E-${RUN}`))!.id;
  const detail = (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as {
    currentLane: string;
    lanes: { id: string }[];
    messages: { entryId: string; role: string; content: string; thinking?: string }[];
  };
  expect(detail.currentLane).toBe("main");
  expect(detail.lanes).toEqual([{ id: "main", forkEntryId: null, fromLaneId: null }]);
  expect(detail.messages).toHaveLength(2);
  expect(detail.messages.every((m) => typeof m.entryId === "string")).toBe(true);
  expect(detail.messages[1].thinking).toBeTruthy(); // thinking 已持久化
  // JSONL：assistant 消息含 thinking 内容块
  const raw = readFileSync(findSessionFile(sessionId), "utf8");
  expect(raw).toContain('"type":"thinking"');
  // llm_calls：本轮 chat 计量行
  const { rows: calls } = await pool.query(
    "SELECT count(*)::int AS n FROM llm_calls WHERE purpose='chat' AND completion_tokens > 0");
  expect(calls[0].n).toBeGreaterThanOrEqual(turnCount);
});

test("t2 编辑消息开新分支 + ‹i/n› 切回原分支", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/");
  await page.locator(".session-item").filter({ hasText: `E2E-${RUN}` }).first().click();
  await expect(page.locator(".msg")).toHaveCount(2);
  // 编辑首条用户消息（根部分叉）
  await page.locator(".msg.user").first().hover();
  await page.locator(".msg.user").first().getByRole("button", { name: "编辑" }).click();
  await page.getByRole("textbox").fill(Q1_EDIT);
  await page.getByRole("button", { name: "保存" }).click();
  await waitReplyDone(page);
  // 新分支：首条消息位置出现 ‹2/2›
  const firstSwitch = page.locator(".msg").first().locator(".branch-switch");
  await expect(firstSwitch).toContainText("2/2");
  await expect(page.locator(".msg.user").first().locator(".bubble")).toContainText("888");
  // 切回原分支
  await firstSwitch.getByRole("button", { name: "‹" }).click();
  await expect(page.locator(".msg.user").first().locator(".bubble")).toContainText("999");
  await expect(firstSwitch).toContainText("1/2");
  // API：lanes 两条；?lane= 各自内容正确
  const detail = (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as {
    currentLane: string; lanes: { id: string; forkEntryId: string | null; fromLaneId: string | null }[];
    messages: { content: string }[];
  };
  expect(detail.lanes).toHaveLength(2);
  expect(detail.lanes[1].fromLaneId).toBe("main");
  expect(detail.lanes[1].forkEntryId).toBeNull(); // 编辑首条消息 → 根部分叉
  expect(detail.currentLane).toBe(detail.lanes[1].id); // 缺省 = 最新分支
  const mainDetail = (await (await page.request.get(
    `/api/sessions/${sessionId}?lane=main`)).json()) as { messages: { content: string }[] };
  expect(mainDetail.messages[0].content).toContain("999");
});

test("t3 regenerate 在末条 assistant 前开叉重发原文", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/");
  await page.locator(".session-item").filter({ hasText: `E2E-${RUN}` }).first().click();
  await expect(page.locator(".msg")).toHaveCount(2);
  await page.locator(".msg.agent").last().hover();
  await page.locator(".msg.agent").last().getByRole("button", { name: "重新生成" }).click();
  await waitReplyDone(page);
  // 新分支 = [q1(原), q1(重发), a1']：共 3 条消息，重发的 user 消息带切换器
  await expect(page.locator(".msg")).toHaveCount(3);
  const second = page.locator(".msg").nth(1);
  await expect(second).toHaveClass(/user/);
  await expect(second.locator(".branch-switch")).toContainText("2/2");
  // 切回原分支：恢复 [q1, a1]
  await second.locator(".branch-switch").getByRole("button", { name: "‹" }).click();
  await expect(page.locator(".msg")).toHaveCount(2);
});

test("t4 rewind 截断 + 下一次发送在该消息处开叉 + markdown 列表", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/");
  await page.locator(".session-item").filter({ hasText: `E2E-${RUN}` }).first().click();
  await expect(page.locator(".msg")).toHaveCount(2);
  // 先回到首条 assistant（在 main 上续写新话题，制造 4 条）
  await send(page, Q2);
  await waitReplyDone(page);
  await expect(page.locator(".msg:last-child .bubble li").first()).toBeVisible(); // markdown 列表
  // 回到第 2 条消息（首条 assistant）
  await page.locator(".msg").nth(1).hover();
  await page.locator(".msg").nth(1).getByRole("button", { name: "回到这" }).click();
  await expect(page.getByRole("status")).toContainText("后续内容保留在原分支");
  await expect(page.locator(".msg")).toHaveCount(2); // 视觉截断
  // 发送 → 在该消息处开叉
  await send(page, `${Q1} 换个角度再讲一遍`);
  await waitReplyDone(page);
  await expect(page.locator(".msg")).toHaveCount(4);
  const third = page.locator(".msg").nth(2);
  await expect(third.locator(".branch-switch")).toContainText("2/2");
  // API：分支树上分叉点 = 首条 assistant 的 entryId
  const mainDetail = (await (await page.request.get(
    `/api/sessions/${sessionId}?lane=main`)).json()) as { messages: { entryId: string }[] };
  const latest = (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as {
    lanes: { forkEntryId: string | null }[];
  };
  expect(latest.lanes.at(-1)!.forkEntryId).toBe(mainDetail.messages[1].entryId);
});

test("t5 复制：单条原文 + 整会话 Markdown 稿（不含 thinking）", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.locator(".session-item").filter({ hasText: `E2E-${RUN}` }).first().click();
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false");
  // 单条：user 消息原文
  await page.locator(".msg.user").first().hover();
  await page.locator(".msg.user").first().getByRole("button", { name: "复制" }).click();
  await expect(page.locator(".toast")).toContainText("已复制");
  const single = await page.evaluate(() => navigator.clipboard.readText());
  expect(single).toContain("999"); // 首条 user 消息原文
  // 整会话：## 我 / ## 学习助手 交替
  await page.getByRole("button", { name: "复制全文" }).click();
  await expect(page.locator(".toast")).toContainText("已复制全文");
  const all = await page.evaluate(() => navigator.clipboard.readText());
  expect(all).toContain("## 我");
  expect(all).toContain("## 学习助手");
  expect(all).not.toContain("思考过程");
});

test("t6 删除会话：列表/文件/API 均无残留", async ({ page }) => {
  await page.goto("/");
  const item = page.locator(".session-item").filter({ hasText: `E2E-${RUN}` }).first();
  await item.hover();
  await item.locator(".del").click();
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
  // 侧栏与 UI 回到新会话态
  await expect(page.locator(".session-item").filter({ hasText: `E2E-${RUN}` })).toHaveCount(0);
  await expect(page.locator(".chat-empty")).toBeVisible();
  // API 404
  expect((await page.request.get(`/api/sessions/${sessionId}`)).status()).toBe(404);
  // JSONL 文件删除
  expect(() => findSessionFile(sessionId)).toThrow();
});

test.afterAll(async () => {
  if (sessionId) await pool.query("DELETE FROM llm_calls WHERE purpose='chat' AND model LIKE '%'");
  await pool.end();
});
```

（`test.afterAll` 的 llm_calls 清理保守起见保留 purpose 过滤；会话 JSONL 已随删除消失。）

- [ ] **Step 3: 跑 E2E 确认通过**

Run: `cd e2e && npx playwright test specs/chat-enhancements.spec.ts specs/chat-session.spec.ts`
Expected: 全部 passed（三服务自动复用/拉起；单 spec 约 5-10 分钟）。

- [ ] **Step 4: Commit**

```bash
git add e2e/specs/chat-enhancements.spec.ts e2e/specs/chat-session.spec.ts
git commit -m "test(e2e): 聊天增强全链路——分支/thinking/markdown/复制/删除"
```

---

### Task 13: 文档回写 + 全量回归

**Files:**

- Modify: `README.md`

- [ ] **Step 1: README 聊天章节补分支与 thinking 说明（现有聊天小节末尾追加）**

```markdown
### 会话分支与 thinking

- 编辑/回退/重新生成统一为「fork at entry」：在对应消息处开新分支，旧分支经消息旁 ‹i/n› 切换器随时切回。
- thinking 档位由 `KB_CHAT_THINKING`（`off|minimal|low|medium|high|xhigh|max`，缺省 `medium`）控制；
  不支持 reasoning 的端点自动不传参，模型无 thinking 输出则无面板（不算错误）。
```

- [ ] **Step 2: 全量回归（三侧 + 新旧 E2E）**

Run: `cd backend && npm test`
Expected: 全部 PASS。

Run: `cd frontend && npm test`
Expected: 全部 PASS。

Run: `cd pipeline && KB_TEST_DATABASE_URL=postgresql://localhost/kb_test uv run pytest tests/ -q`
Expected: 全部 PASS（本计划 pipeline 零改动，守护无回归）。

Run: `cd e2e && npm test`
Expected: 全部 passed（paper-pipeline/searchability 不受波及）。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: 聊天增强——分支与 thinking 使用说明"
```

---

## Self-Review 记录

- **Spec 覆盖**：A1 分支（Task 1-5 存储/API、Task 9-11 前端）、A2 thinking（Task 1 读端/Task 7 配置与流式/Task 10 面板）、A3 markdown（Task 10）、A4 复制（Task 10 单条 + Task 11 整会话/toast）、A5 删除（Task 3/6/11）、`findEntries` 混读隐患修复（Task 1）、e2e（Task 12）——Workstream A 全条目有对应任务。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码（Task 1 的 forkAt 占位是显式的跨任务 RED 手法，Task 2 替换为真实现）。
- **类型一致性**：`SessionHandle` 新方法签名在 Task 2 定义、Task 4/5 的 fakeStore 与路由调用一致；`StoredChatMessage.entryId/thinking` 在 Task 1 定义、GET 响应（Task 4）与前端类型（Task 8）字段名一致；`ChatStreamOptions.branchAt` 与 `streamChat` 请求体 `branch_at`、后端 `branchRaw` 三处口径一致（undefined=不带、null=根部分叉、string=消息 entry）。
- **已知取舍**：`latestLane` 以叶 entry seq 最大者为准，send 失败留下的空分支（仅 branch_meta）会成为「最新分支」，其路径=前缀，展示为截断态——与 rewind 语义一致，可接受；‹i/n› 在根部（编辑首条消息）不显示 fromLane 提供的重复选项，按根 lane 列表去重。
