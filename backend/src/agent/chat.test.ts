import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { chatRoute } from "./chat.js";
import type { AgentFactory } from "./chat.js";

describe("/api/chat", () => {
  it("SSE 流出 text_delta 并收尾 done", async () => {
    // 假 agent：按 pi-agent-core 事件形状推两个 delta（真实 Agent 在 prompt() 内发事件并 await 订阅者）
    const fakeFactory: AgentFactory = () => {
      let listener: ((event: any) => void | Promise<void>) | null = null;
      return {
        subscribe: (fn) => {
          listener = fn;
          return () => {};
        },
        prompt: async () => {
          await listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } });
          await listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "呀" } });
          await listener?.({ type: "agent_end", messages: [] });
        },
      };
    };
    const app = new Hono();
    app.post("/api/chat", chatRoute(fakeFactory));
    const resp = await app.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    const body = await resp.text();
    expect(body).toContain("你好");
    expect(body).toContain("呀");
  });
});
