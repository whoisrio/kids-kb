/** 历史会话 API：列表 + 回看。
    注意：列表项的 model 是创建时模型（header 不可变，list 不开会话）；
    当前模型（含 model_change 留痕）看 GET /:id 的 currentModel。 */
import { Hono } from "hono";
import type { SessionStore } from "../agent/sessions.js";

export function sessionsRoutes(store: SessionStore) {
  // strict: false —— 与 children/attempts 对齐（裸路径 /api/sessions 两种模式下本都命中，此处统一写法）
  const app = new Hono({ strict: false });
  app.get("/", async (c) => c.json(await store.list()));
  app.get("/:id", async (c) => {
    const handle = await store.open(c.req.param("id"));
    if (!handle) return c.json({ error: "会话不存在" }, 404);
    return c.json({
      title: handle.title,
      currentModel: await handle.currentModel(),
      messages: await handle.messages(),
    });
  });
  return app;
}
