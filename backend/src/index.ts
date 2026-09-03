import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig, type BackendConfig } from "./config.js";
import { getPool } from "./db.js";
import { chatRoute, makeAgentFactory } from "./agent/chat.js";
import { JsonlSessionStore } from "./agent/sessions.js";
import { embedTexts } from "./retrieval/embed.js";
import { makeReranker } from "./retrieval/rerank.js";
import { hybridSearch } from "./retrieval/search.js";
import { childrenRoutes } from "./routes/children.js";
import { attemptsRoutes } from "./routes/attempts.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { modelsRoutes } from "./routes/models.js";

export function createApp(cfg: BackendConfig = loadConfig()) {
  const app = new Hono();
  const pool = getPool(cfg.databaseUrl);
  const rerank = makeReranker(cfg.rerankProvider, cfg.pipelineUrl);
  const search = (q: string, filters?: Record<string, string>) =>
    hybridSearch(pool, {
      embed: (texts) => embedTexts(cfg.embedBaseUrl, cfg.embedModel, texts),
      rerank,
    }, q, { filters });
  const factory = makeAgentFactory(cfg, pool, search);
  const sessionStore = new JsonlSessionStore();
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.post("/api/chat", chatRoute(factory, {
    store: sessionStore,
    defaultModel: cfg.chatModel,
    models: cfg.chatModels,
    onUsage: async (u, model) => {
      await pool.query(
        `INSERT INTO llm_calls (document_id, purpose, model, modality, prompt_tokens, completion_tokens)
         VALUES (NULL, 'chat', $1, 'text', $2, $3)`,
        [model, u.input, u.output],
      );
    },
  }));
  app.route("/api/sessions", sessionsRoutes(sessionStore));
  app.route("/api/models", modelsRoutes(cfg.chatModels));
  app.route("/api/children", childrenRoutes(pool));
  app.route("/api/attempts", attemptsRoutes(pool));
  return app;
}

if (process.env.VITEST === undefined) {
  const cfg = loadConfig();
  serve({ fetch: createApp(cfg).fetch, port: cfg.port }, (info) => {
    console.log(`backend  listening on http://127.0.0.1:${info.port}`);
  });
}
