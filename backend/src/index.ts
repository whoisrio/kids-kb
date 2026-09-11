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
import { statsRoutes } from "./routes/stats.js";
import { usageRoutes } from "./routes/usage.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { modelsRoutes } from "./routes/models.js";
import { papersRoutes } from "./routes/papers.js";
import { paperQuestionsRoutes } from "./routes/paperQuestions.js";
import { reviewRoutes } from "./routes/review.js";
import { trajectoryRoutes } from "./routes/trajectory.js";
import { libraryRoutes } from "./routes/library.js";
import { quizRoutes } from "./routes/quizzes.js";
import { makeCallText } from "./llm.js";
import { redriveWhenPipelineReady, type PaperJobDeps } from "./papers/jobs.js";

export function createApp(
  cfg: BackendConfig = loadConfig(),
  opts: { paperJobs?: PaperJobDeps } = {},
) {
  const app = new Hono();
  const pool = getPool(cfg.databaseUrl);
  const rerank = makeReranker(cfg.rerankProvider, cfg.pipelineUrl);
  const search = (q: string, filters?: Record<string, string>) =>
    hybridSearch(pool, {
      embed: (texts) => embedTexts(cfg.embedBaseUrl, cfg.embedModel, texts),
      rerank,
    }, q, { filters });
  const paperJobs: PaperJobDeps = opts.paperJobs ?? {
    pipelineUrl: cfg.pipelineUrl,
    matchThreshold: cfg.matchThreshold,
    embed: (texts) => embedTexts(cfg.embedBaseUrl, cfg.embedModel, texts),
    rerank,
  };
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
  app.route("/api/stats", statsRoutes(pool));
  app.route("/api/usage", usageRoutes(pool));
  app.route("/api/papers", papersRoutes(pool, paperJobs, cfg));
  app.route("/api/paper-questions", paperQuestionsRoutes(pool, paperJobs, cfg.storageRoot));
  app.route("/api/review", reviewRoutes(pool, {
    search, pipelineUrl: cfg.pipelineUrl, storageRoot: cfg.storageRoot,
  }));
  app.route("/api", trajectoryRoutes(pool));
  app.route("/api/library", libraryRoutes(pool, { pipelineUrl: cfg.pipelineUrl, search }, cfg));
  app.route("/api/quizzes", quizRoutes(pool, { callText: makeCallText(cfg) }));
  return app;
}

if (process.env.VITEST === undefined) {
  const cfg = loadConfig();
  serve({ fetch: createApp(cfg).fetch, port: cfg.port }, (info) => {
    console.log(`backend  listening on http://127.0.0.1:${info.port}`);
    // 启动重驱动:滞留 processing 的卷(pipeline 幂等,安全)
    const pool = getPool(cfg.databaseUrl);
    const jobs: PaperJobDeps = {
      pipelineUrl: cfg.pipelineUrl,
      matchThreshold: cfg.matchThreshold,
      embed: (texts) => embedTexts(cfg.embedBaseUrl, cfg.embedModel, texts),
      rerank: makeReranker(cfg.rerankProvider, cfg.pipelineUrl),
    };
    // 启动重驱动:探活 pipeline 就绪后才驱动滞留 processing 的卷,
    // 避免 backend 先起时把卷误打成 failed(pipeline 幂等,安全)
    void redriveWhenPipelineReady(pool, jobs, { attempts: 30, retryMs: 2_000 }).then((n) => {
      if (n > 0) console.log(`重驱动 ${n} 卷滞留 processing 的试卷`);
    });
  });
}
