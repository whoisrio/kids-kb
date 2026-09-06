/** 用量聚合：本月自然月口径；modality 空的历史行计入文本；纪律：token 统计不进统计页。 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { Hono } from "hono";
import { resetDbForTest } from "../db.js";
import { usageRoutes } from "./usage.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("usage API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    app = new Hono();
    app.route("/api/usage", usageRoutes(pool));
    const ins = async (offset: string, cols: string, vals: unknown[]) =>
      pool.query(
        `INSERT INTO llm_calls (${cols}, created_at)
         VALUES (${vals.map((_, index) => `$${index + 1}`).join(",")}, date_trunc('month', now()) + ${offset})`,
        vals,
      );
    await ins(
      "interval '1 hour'", "purpose, model, modality, prompt_tokens, completion_tokens",
      ["chat", "qwen3.5:4b", "text", 100, 50],
    );
    await ins(
      "interval '2 hours'", "purpose, model, modality, prompt_tokens, completion_tokens",
      ["chat", "qwen3.5:4b", "text", 60, 40],
    );
    await ins(
      "interval '3 hours'", "purpose, model, modality, prompt_tokens, completion_tokens",
      ["vlm", "qwen3.8-27b", "image", 200, 100],
    );
    await ins(
      "interval '4 hours'", "purpose, model, prompt_tokens, completion_tokens",
      ["parse", "qwen3.5:2b", 10, 5],
    );
    await ins(
      "- interval '10 days'", "purpose, model, modality, prompt_tokens, completion_tokens",
      ["chat", "qwen3.5:4b", "text", 999, 999],
    );
  });
  afterAll(async () => { await pool.end(); });

  it("hero：本月 token 总量/文本图像分列/调用次数（modality 空计入文本）", async () => {
    const resp = await app.request("/api/usage/overview");
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.hero).toEqual({
      promptTokens: 370,
      completionTokens: 195,
      totalTokens: 565,
      calls: 4,
      textTokens: 265,
      imageTokens: 300,
    });
  });

  it("byPurpose / byModel：本月聚合", async () => {
    const { byPurpose, byModel } = await (await app.request("/api/usage/overview")).json();
    expect(byPurpose).toEqual([
      { purpose: "chat", calls: 2, tokens: 250 },
      { purpose: "vlm", calls: 1, tokens: 300 },
      { purpose: "parse", calls: 1, tokens: 15 },
    ]);
    expect(byModel).toEqual([
      { model: "qwen3.5:4b", calls: 2, tokens: 250 },
      { model: "qwen3.8-27b", calls: 1, tokens: 300 },
      { model: "qwen3.5:2b", calls: 1, tokens: 15 },
    ]);
  });

  it("recent：最新 50 条流水（含上月行，按时间倒序）", async () => {
    const { recent } = await (await app.request("/api/usage/overview")).json();
    expect(recent).toHaveLength(5);
    expect(recent[0].purpose).toBe("parse");
    expect(recent[4].prompt_tokens).toBe(999);
    expect(recent[0]).toMatchObject({ model: "qwen3.5:2b", modality: "text", prompt_tokens: 10, completion_tokens: 5 });
  });
});
