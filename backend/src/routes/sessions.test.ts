/** GET /api/sessions 列表 + GET /api/sessions/:id 回看。 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { sessionsRoutes } from "./sessions.js";
import type { SessionHandle, SessionStore } from "../agent/sessions.js";

function makeStore(opts: {
  list?: Awaited<ReturnType<SessionStore["list"]>>;
  sessions?: Record<string, { role: "user" | "assistant"; content: string }[]>;
}): SessionStore {
  return {
    create: async () => {
      throw new Error("未使用");
    },
    open: async (id): Promise<SessionHandle | null> => {
      const msgs = opts.sessions?.[id];
      if (!msgs) return null;
      return {
        id,
        currentModel: async () => "m",
        messages: async () => msgs,
        appendMessage: async () => {},
        markModelChange: async () => {},
      };
    },
    list: async () => opts.list ?? [],
  };
}

function app(store: SessionStore) {
  const a = new Hono();
  a.route("/api/sessions", sessionsRoutes(store));
  return a;
}

describe("/api/sessions", () => {
  it("GET / 返回会话摘要列表", async () => {
    const store = makeStore({
      list: [{ id: "s1", title: "口算题", model: "qwen3:4b", createdAt: 1, modifiedAt: 2 }],
    });
    const resp = await app(store).request("/api/sessions");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual([
      { id: "s1", title: "口算题", model: "qwen3:4b", createdAt: 1, modifiedAt: 2 },
    ]);
  });

  it("GET /:id 返回按序消息", async () => {
    const store = makeStore({
      sessions: {
        s1: [
          { role: "user", content: "问题" },
          { role: "assistant", content: "回答" },
        ],
      },
    });
    const resp = await app(store).request("/api/sessions/s1");
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      messages: [
        { role: "user", content: "问题" },
        { role: "assistant", content: "回答" },
      ],
    });
  });

  it("GET /:id 不存在 → 404", async () => {
    const resp = await app(makeStore({})).request("/api/sessions/ghost");
    expect(resp.status).toBe(404);
  });
});
