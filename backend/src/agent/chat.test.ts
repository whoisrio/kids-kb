import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { chatRoute } from "./chat.js";
import type { AgentFactory, AgentLike } from "./chat.js";

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

function app(factory: AgentFactory, onUsage?: (u: { input: number; output: number }) => Promise<void>) {
  const app = new Hono();
  app.post("/api/chat", chatRoute(factory, onUsage));
  return app;
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
    const resp = await post(app(() => agent, onUsage), { messages: [{ role: "user", content: "hi" }] });
    const body = await resp.text();
    expect(body).toContain("event: done");
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ input: 13, output: 7 });
  });

  it("onUsage 抛异常不影响 done 收尾", async () => {
    const onUsage = vi.fn(async () => {
      throw new Error("db down");
    });
    const agent = fakeAgent([
      { type: "message_end", message: { role: "assistant", usage: { input: 1, output: 1 } } },
      { type: "agent_end", messages: [] },
    ]);
    const resp = await post(app(() => agent, onUsage), { messages: [{ role: "user", content: "hi" }] });
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
