/** JsonlSessionStore 集成测试：真 JsonlSessionRepo + tmp 目录，验证落盘/恢复/列表/模型留痕。 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { JsonlSessionStore } from "./sessions.js";

const zeroUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMsg(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function assistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "chat",
    model: "qwen3:4b",
    usage: zeroUsage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** 只有 toolCall、没有 text 段的 assistant 消息（工具调用中间态）。 */
function toolCallOnlyAssistantMsg(): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name: "search", arguments: {} }],
    api: "openai-completions",
    provider: "chat",
    model: "qwen3:4b",
    usage: zeroUsage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

let dirs: string[] = [];
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "kb-sessions-"));
  dirs.push(dir);
  return { store: new JsonlSessionStore({ sessionsRoot: dir, cwd: dir }), dir };
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("JsonlSessionStore", () => {
  it("create 后 appendMessage 落盘，open 后 messages() 按序返回 user/assistant 文本", async () => {
    const { store, dir } = makeStore();
    const h = await store.create({ title: "四口算题", model: "qwen3:4b" });
    await h.appendMessage(userMsg("帮我出几道口算题"));
    await h.appendMessage(assistantMsg("好的，这是三道题"));

    // 真实 JSONL 落盘
    const files = readdirSync(dir, { recursive: true }) as string[];
    const jsonl = files.find((f) => f.endsWith(".jsonl"));
    expect(jsonl).toBeTruthy();
    const raw = readFileSync(join(dir, jsonl!), "utf-8");
    expect(raw).toContain("帮我出几道口算题");
    expect(raw).toContain("好的，这是三道题");

    const reopened = await store.open(h.id);
    expect(reopened).not.toBeNull();
    expect(await reopened!.messages()).toEqual([
      { role: "user", content: "帮我出几道口算题" },
      { role: "assistant", content: "好的，这是三道题" },
    ]);
  });

  it("list 返回 metadata 的 title/model，按 modifiedAt 倒序", async () => {
    const { store } = makeStore();
    const a = await store.create({ title: "会话A", model: "qwen3:4b" });
    await new Promise((r) => setTimeout(r, 10));
    const b = await store.create({ title: "会话B", model: "deepseek-v3" });
    await new Promise((r) => setTimeout(r, 10));
    await a.appendMessage(userMsg("让 A 变得更近"));

    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual([a.id, b.id]);
    expect(list.find((s) => s.id === b.id)).toMatchObject({ title: "会话B", model: "deepseek-v3" });
    for (const s of list) {
      expect(typeof s.createdAt).toBe("number");
      expect(typeof s.modifiedAt).toBe("number");
    }
  });

  it("open 不存在的 id 返回 null", async () => {
    const { store } = makeStore();
    expect(await store.open("no-such-session")).toBeNull();
  });

  it("markModelChange 后 currentModel 变新模型，重开仍在；list 展示创建时模型", async () => {
    const { store } = makeStore();
    const h = await store.create({ title: "t", model: "qwen3:4b" });
    expect(await h.currentModel()).toBe("qwen3:4b");
    await h.markModelChange("deepseek-v3");
    expect(await h.currentModel()).toBe("deepseek-v3");

    const reopened = await store.open(h.id);
    expect(await reopened!.currentModel()).toBe("deepseek-v3");
    const list = await store.list();
    expect(list[0].model).toBe("qwen3:4b");
  });

  it("同一 id 重复 open 不冲突（进程内缓存单写者），追加不丢", async () => {
    const { store } = makeStore();
    const h = await store.create({ title: "t", model: "m" });
    await h.appendMessage(userMsg("一"));
    const h1 = await store.open(h.id);
    const h2 = await store.open(h.id);
    await h1!.appendMessage(assistantMsg("二"));
    await h2!.appendMessage(userMsg("三"));
    expect((await h2!.messages()).map((m) => m.content)).toEqual(["一", "二", "三"]);
  });

  it("并发 open 同一未缓存 id 拿到同一 handle（Promise 缓存消竞态）", async () => {
    const { store, dir } = makeStore();
    const h = await store.create({ title: "t", model: "m" });
    // 新 store 实例指向同一目录，保证目标 id 不在缓存里
    const fresh = new JsonlSessionStore({ sessionsRoot: dir, cwd: dir });
    const [a, b] = await Promise.all([fresh.open(h.id), fresh.open(h.id)]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("只含 toolCall 的 assistant 消息不进 messages()", async () => {
    const { store } = makeStore();
    const h = await store.create({ title: "t", model: "m" });
    await h.appendMessage(userMsg("查一下"));
    await h.appendMessage(toolCallOnlyAssistantMsg());
    await h.appendMessage(assistantMsg("查到了"));
    expect((await h.messages()).map((m) => m.content)).toEqual(["查一下", "查到了"]);
  });

  it("toolResult 角色的消息不进 messages()（读端 role 白名单）", async () => {
    const { store } = makeStore();
    const h = await store.create({ title: "t", model: "m" });
    await h.appendMessage(userMsg("查一下"));
    await h.appendMessage({
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "search",
      content: [{ type: "text", text: "工具原始输出不应出现在历史" }],
      isError: false,
      timestamp: Date.now(),
    });
    await h.appendMessage(assistantMsg("查到了"));
    expect((await h.messages()).map((m) => m.content)).toEqual(["查一下", "查到了"]);
  });

  it("handle 暴露 title（创建时 metadata）", async () => {
    const { store } = makeStore();
    const h = await store.create({ title: "四口算题", model: "m" });
    expect(h.title).toBe("四口算题");
    const reopened = await store.open(h.id);
    expect(reopened!.title).toBe("四口算题");
  });
});
