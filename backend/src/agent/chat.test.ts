import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { chatRoute } from "./chat.js";
import type { AgentFactory, AgentLike, ChatDeps } from "./chat.js";
import type { SessionHandle, SessionStore, StoredChatMessage } from "./sessions.js";

/** 造一个假 agent：prompt() 内按序推送事件（真实 Agent 在 prompt() 内发事件并 await 订阅者）。 */
function fakeAgent(events: any[]): AgentLike & { abortCount: number } {
  let listener: ((event: any) => void | Promise<void>) | null = null;
  const self = {
    abortCount: 0,
    subscribe: (fn: (event: any) => void | Promise<void>) => {
      listener = fn;
      return () => {};
    },
    prompt: async () => {
      for (const e of events) await listener?.(e);
    },
    abort: () => {
      self.abortCount++;
    },
  };
  return self;
}

function app(factory: AgentFactory, deps?: ChatDeps) {
  const app = new Hono();
  app.post("/api/chat", chatRoute(factory, deps));
  return app;
}

/** 内存 fake SessionStore：lane-aware；可预置已有会话，记录写入/fork/删除。 */
function fakeStore(initial?: Record<string, {
  model?: string; messages?: StoredChatMessage[]; title?: string;
  lanes?: string[];
}>) {
  const data: Record<string, { model: string; messages: StoredChatMessage[]; title: string; lanes: string[] }> = {};
  for (const [id, value] of Object.entries(initial ?? {})) {
    data[id] = {
      model: value.model ?? "m", messages: value.messages ?? [],
      title: value.title ?? "", lanes: value.lanes ?? ["main"],
    };
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
    currentModel: async () => data[id].model,
    messages: async () => data[id].messages,
    appendMessage: async (message, lane) => { (appended[id] ??= []).push({ lane, message }); },
    markModelChange: async (modelId, lane) => {
      (marks[id] ??= []).push({ lane, model: modelId });
      data[id].model = modelId;
    },
    lanes: async () => data[id].lanes.map((lane) =>
      lane === "main" ? { id: "main", forkEntryId: null, fromLaneId: null }
        : { id: lane, forkEntryId: "e-fork", fromLaneId: "main" }),
    latestLane: async () => data[id].lanes.at(-1)!,
    forkAt: async (entryId, fromLane) => {
      const lane = `br-${++laneSeq}`;
      data[id].lanes.push(lane);
      forks.push({ sessionId: id, entryId, fromLane, lane });
      return lane;
    },
    laneExists: async (lane) => data[id].lanes.includes(lane),
    entryExists: async (entryId) => entryId === "e-exists",
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

function post(a: Hono, body: unknown, raw = false) {
  return a.request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

const delta = (text: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta: text },
});

describe("/api/chat", () => {
  it("SSE 流出 text_delta 并收尾 done", async () => {
    const agent = fakeAgent([delta("你好"), delta("呀"), { type: "agent_end", messages: [] }]);
    const resp = await post(app(() => agent), { messages: [{ role: "user", content: "hi" }] });
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    const body = await resp.text();
    expect(body).toContain("你好");
    expect(body).toContain("呀");
    expect(body).toContain("event: done");
  });

  it("message_end 携带 usage 时 onUsage 汇总且只调用一次", async () => {
    const onUsage = vi.fn(async () => {});
    const agent = fakeAgent([
      delta("答"),
      { type: "message_end", message: { role: "assistant", usage: { input: 10, output: 5 } } },
      { type: "message_end", message: { role: "assistant", usage: { input: 3, output: 2 } } },
      { type: "agent_end", messages: [] },
    ]);
    const resp = await post(app(() => agent, { onUsage, defaultModel: "default-model" }), { messages: [{ role: "user", content: "hi" }] });
    const body = await resp.text();
    expect(body).toContain("event: done");
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ input: 13, output: 7 }, "default-model");
  });

  it("onUsage 抛异常不影响 done 收尾", async () => {
    const onUsage = vi.fn(async () => {
      throw new Error("db down");
    });
    const agent = fakeAgent([
      { type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1 } } },
      { type: "agent_end", messages: [] },
    ]);
    const resp = await post(app(() => agent, { onUsage }), { messages: [{ role: "user", content: "hi" }] });
    const body = await resp.text();
    expect(body).toContain("event: done");
  });

  it("LLM 失败（agent_end 携带 stopReason=error 的 assistant 消息）发 error 而非 done，且不外泄错误原文", async () => {
    const agent = fakeAgent([{
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "connection refused: secret-host:11434", content: [] }],
    }]);
    const resp = await post(app(() => agent), { messages: [{ role: "user", content: "hi" }] });
    const body = await resp.text();
    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");
    expect(body).not.toContain("secret-host");
  });

  it("prompt() 自身抛异常时发 error 而非 done", async () => {
    let listener: ((event: any) => void | Promise<void>) | null = null;
    const agent: AgentLike = {
      subscribe: (fn) => {
        listener = fn;
        return () => {};
      },
      prompt: async () => {
        throw new Error("socket hangup internal detail");
      },
    };
    void listener;
    const resp = await post(app(() => agent), { messages: [{ role: "user", content: "hi" }] });
    const body = await resp.text();
    expect(body).toContain("event: error");
    expect(body).not.toContain("event: done");
    expect(body).not.toContain("internal detail");
  });

  it("请求体不是合法 JSON → 400", async () => {
    const resp = await post(app(() => fakeAgent([])), "not json", true);
    expect(resp.status).toBe(400);
  });

  it("messages 为空数组 → 400", async () => {
    const resp = await post(app(() => fakeAgent([])), { messages: [] });
    expect(resp.status).toBe(400);
  });

  it("最后一条消息不是 user → 400", async () => {
    const resp = await post(app(() => fakeAgent([])), {
      messages: [{ role: "assistant", content: "hi" }],
    });
    expect(resp.status).toBe(400);
  });

  it("content 不是字符串或 role 非法 → 400", async () => {
    const a = app(() => fakeAgent([]));
    expect((await post(a, { messages: [{ role: "user", content: 123 }] })).status).toBe(400);
    expect((await post(a, { messages: [{ role: "system", content: "x" }, { role: "user", content: "hi" }] })).status).toBe(400);
  });
});

describe("/api/chat 会话持久化", () => {
  it("无 session_id → 创建会话，SSE 首帧 event: session 在 delta 之前，title 取首条用户消息前 20 字", async () => {
    const { store, createCalls } = fakeStore();
    const agent = fakeAgent([delta("答"), { type: "agent_end", messages: [] }]);
    const longQuestion = "这是一道超过二十个字的孩子数学题目需要助手来解答一下";
    const resp = await post(app(() => agent, { store, defaultModel: "qwen3:4b" }), {
      messages: [{ role: "user", content: longQuestion }],
    });
    const body = await resp.text();
    expect(createCalls).toEqual([{ title: longQuestion.slice(0, 20), model: "qwen3:4b" }]);
    expect(body).toContain("event: session");
    expect(body).toContain('"session_id":"s-1"');
    expect(body.indexOf("event: session")).toBeLessThan(body.indexOf("event: delta"));
    expect(body).toContain("event: done");
  });

  it("message_end 的 user 与 assistant 消息各落盘一次，toolResult 不落盘", async () => {
    const { store, appended } = fakeStore();
    const userMsg = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 };
    const assistantMsg = { role: "assistant", content: [{ type: "text", text: "答" }] };
    const toolResultMsg = { role: "toolResult", toolCallId: "t1", content: [] };
    const agent = fakeAgent([
      { type: "message_end", message: userMsg },
      { type: "message_end", message: toolResultMsg },
      { type: "message_end", message: assistantMsg },
      { type: "agent_end", messages: [] },
    ]);
    const resp = await post(app(() => agent, { store, defaultModel: "m" }), {
      messages: [{ role: "user", content: "hi" }],
    });
    await resp.text();
    expect(appended["s-1"].map(({ message }) => message)).toEqual([userMsg, assistantMsg]);
  });

  it("带 session_id → 用会话历史（服务端权威）而非客户端历史构造 agent", async () => {
    const { store } = fakeStore({
      "s-x": {
        model: "qwen3:4b",
        messages: [
          { role: "user", content: "之前的问题", entryId: "m1" },
          { role: "assistant", content: "之前的回答", entryId: "m2" },
        ],
      },
    });
    let factoryMessages: { role: string; content: string }[] | null = null;
    const agent = fakeAgent([
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "agent_end", messages: [] },
    ]);
    const factory: AgentFactory = (messages) => {
      factoryMessages = messages;
      return agent;
    };
    const resp = await post(app(factory, { store, defaultModel: "m" }), {
      session_id: "s-x",
      messages: [{ role: "user", content: "客户端夹带的旧消息" }, { role: "assistant", content: "旧答" }, { role: "user", content: "新问题" }],
    });
    const body = await resp.text();
    expect(body).toContain('"session_id":"s-x"');
    expect(factoryMessages).toMatchObject([
      { role: "user", content: "之前的问题" },
      { role: "assistant", content: "之前的回答" },
    ]);
  });

  it("session_id 不存在 → 404，不进 SSE", async () => {
    const { store } = fakeStore();
    const resp = await post(app(() => fakeAgent([]), { store, defaultModel: "m" }), {
      session_id: "ghost",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.status).toBe(404);
    expect(resp.headers.get("content-type")).not.toContain("text/event-stream");
  });

  it("请求 model 与会话当前模型不同 → 该轮用新模型并留痕；onUsage 带新模型", async () => {
    const { store, marks } = fakeStore({ "s-x": { model: "qwen3:4b", messages: [] } });
    let factoryModel: string | undefined;
    const onUsage = vi.fn(async () => {});
    const agent = fakeAgent([
      { type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1 } } },
      { type: "agent_end", messages: [] },
    ]);
    const factory: AgentFactory = (_messages, model) => {
      factoryModel = model;
      return agent;
    };
    const resp = await post(app(factory, { store, onUsage, defaultModel: "qwen3:4b", models: ["qwen3:4b", "deepseek-v3"] }), {
      session_id: "s-x",
      model: "deepseek-v3",
      messages: [{ role: "user", content: "hi" }],
    });
    await resp.text();
    expect(factoryModel).toBe("deepseek-v3");
    expect(marks["s-x"]).toEqual([{ lane: "main", model: "deepseek-v3" }]);
    expect(onUsage).toHaveBeenCalledWith({ input: 1, output: 1 }, "deepseek-v3");
  });

  it("请求 model 与会话当前模型相同 → 不留痕", async () => {
    const { store, marks } = fakeStore({ "s-x": { model: "qwen3:4b", messages: [] } });
    let factoryModel: string | undefined;
    const agent = fakeAgent([
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "agent_end", messages: [] },
    ]);
    const factory: AgentFactory = (_messages, model) => {
      factoryModel = model;
      return agent;
    };
    const resp = await post(app(factory, { store, defaultModel: "qwen3:4b", models: ["qwen3:4b", "deepseek-v3"] }), {
      session_id: "s-x",
      model: "qwen3:4b",
      messages: [{ role: "user", content: "hi" }],
    });
    await resp.text();
    expect(factoryModel).toBe("qwen3:4b");
    expect(marks["s-x"]).toBeUndefined();
  });

  it("带 session_id 不带 model → 沿用会话当前模型", async () => {
    const { store } = fakeStore({ "s-x": { model: "deepseek-v3", messages: [] } });
    let factoryModel: string | undefined;
    const agent = fakeAgent([{ type: "agent_end", messages: [] }]);
    const factory: AgentFactory = (_messages, model) => {
      factoryModel = model;
      return agent;
    };
    const resp = await post(app(factory, { store, defaultModel: "qwen3:4b" }), {
      session_id: "s-x",
      messages: [{ role: "user", content: "hi" }],
    });
    await resp.text();
    expect(factoryModel).toBe("deepseek-v3");
  });

  it("新会话请求带 model → 用该模型创建", async () => {
    const { store, createCalls } = fakeStore();
    let factoryModel: string | undefined;
    const agent = fakeAgent([{ type: "agent_end", messages: [] }]);
    const factory: AgentFactory = (_messages, model) => {
      factoryModel = model;
      return agent;
    };
    const resp = await post(app(factory, { store, defaultModel: "qwen3:4b", models: ["qwen3:4b", "deepseek-v3"] }), {
      model: "deepseek-v3",
      messages: [{ role: "user", content: "hi" }],
    });
    await resp.text();
    expect(createCalls).toEqual([{ title: "hi", model: "deepseek-v3" }]);
    expect(factoryModel).toBe("deepseek-v3");
  });

  it("未知模型（factory 抛错）→ 400", async () => {
    const factory: AgentFactory = (_messages, model) => {
      if (model === "no-such-model") throw new Error(`未知模型: ${model}`);
      return fakeAgent([]);
    };
    const resp = await post(app(factory, { defaultModel: "m" }), {
      model: "no-such-model",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.status).toBe(400);
  });

  it("不在已注册列表的 model + 已有会话 → 400，不留 model_change，后续不带 model 正常", async () => {
    const { store, marks } = fakeStore({ "s-x": { model: "qwen3:4b", messages: [] } });
    const a = app(() => fakeAgent([{ type: "agent_end", messages: [] }]), {
      store, defaultModel: "qwen3:4b", models: ["qwen3:4b", "deepseek-v3"],
    });
    const bad = await post(a, {
      session_id: "s-x", model: "no-such-model", messages: [{ role: "user", content: "hi" }],
    });
    expect(bad.status).toBe(400);
    expect(marks["s-x"]).toBeUndefined();
    // 会话未被毒化：后续不带 model 的请求沿用会话模型，正常走完
    const ok = await post(a, { session_id: "s-x", messages: [{ role: "user", content: "hi" }] });
    expect((await ok.text())).toContain("event: done");
  });

  it("不在已注册列表的 model + 无 session_id → 400，不产生孤儿会话", async () => {
    const { store, createCalls } = fakeStore();
    const a = app(() => fakeAgent([]), {
      store, defaultModel: "qwen3:4b", models: ["qwen3:4b"],
    });
    const resp = await post(a, { model: "no-such-model", messages: [{ role: "user", content: "hi" }] });
    expect(resp.status).toBe(400);
    expect(createCalls).toEqual([]);
  });

  it("带 store 但未注入 models 白名单 → 任何带 model 的请求 400，不毒化会话", async () => {
    const { store, marks, createCalls } = fakeStore({ "s-x": { model: "qwen3:4b", messages: [] } });
    const a = app(() => fakeAgent([]), { store, defaultModel: "qwen3:4b" });
    const resp = await post(a, {
      session_id: "s-x", model: "deepseek-v3", messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.status).toBe(400);
    expect(marks["s-x"]).toBeUndefined();
    const resp2 = await post(a, { model: "deepseek-v3", messages: [{ role: "user", content: "hi" }] });
    expect(resp2.status).toBe(400);
    expect(createCalls).toEqual([]);
  });
});

describe("/api/chat 分支", () => {
  it("branch_at 给定 → forkAt 创建分支并写入；SSE session 事件为 {session_id, lane_id} 对象", async () => {
    const { store, forks, appended } = fakeStore({
      "s-x": {
        model: "qwen3:4b", messages: [
          { role: "user", content: "q1", entryId: "e0" },
          { role: "assistant", content: "a1", entryId: "e1" },
        ],
      },
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
    expect(appended["s-x"].map((item) => item.lane)).toEqual(["br-1", "br-1"]);
    expect(body).toContain("event: session");
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
      "s-x": {
        model: "m",
        messages: [{ role: "user", content: "分支历史", entryId: "e0" }],
        lanes: ["main", "br-9"],
      },
    });
    let factoryMessages: { role: string; content: string }[] | null = null;
    const agent = fakeAgent([
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "agent_end", messages: [] },
    ]);
    const factory: AgentFactory = (messages) => { factoryMessages = messages; return agent; };
    await (await post(app(factory, { store, defaultModel: "m" }), {
      session_id: "s-x", lane_id: "br-9", messages: [{ role: "user", content: "hi" }],
    })).text();
    expect(factoryMessages).toMatchObject([{ role: "user", content: "分支历史" }]);
    expect(appended["s-x"][0]?.lane).toBe("br-9");
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
