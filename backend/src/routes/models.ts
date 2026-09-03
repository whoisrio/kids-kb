/** GET /api/models：chat provider 下注册的模型列表（供前端模型下拉）。 */
import { Hono } from "hono";

export function modelsRoutes(chatModels: string[]) {
  const app = new Hono();
  app.get("/", (c) => c.json(chatModels.map((id) => ({ provider: "chat", id, name: id }))));
  return app;
}
