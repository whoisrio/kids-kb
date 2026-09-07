import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetDbForTest } from "../db.js";
import { trajectoryRoutes } from "./trajectory.js";

const url = process.env.KB_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("trajectory API（真库）", () => {
  let pool: pg.Pool;
  let app: Hono;
  let docId: string;
  let pageId: string;
  let runId: string;
  let eventId: number;

  beforeAll(async () => {
    pool = await resetDbForTest(url!);
    app = new Hono();
    app.route("/api", trajectoryRoutes(pool));
    docId = crypto.randomUUID();
    pageId = crypto.randomUUID();
    runId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO documents (id, title, source_path) VALUES ($1,$2,$3)",
      [docId, "traj 测试", `/tmp/${docId}.pdf`]);
    await pool.query(
      "INSERT INTO pages (id, document_id, page_no, image_path) VALUES ($1,$2,$3,$4)",
      [pageId, docId, 1, "/tmp/p1.png"]);
    const { rows: [ev] } = await pool.query(
      `INSERT INTO pipeline_events
         (run_id, document_id, page_id, stage, event_type, summary, payload, status)
       VALUES ($1,$2,$3,'parse','llm_call','transcribe qwen3:4b','{"prompt":"p"}','ok')
       RETURNING id`,
      [runId, docId, pageId]);
    eventId = Number(ev.id);
    await pool.query(
      `INSERT INTO pipeline_events (run_id, document_id, stage, event_type, summary, status)
       VALUES ($1,$2,'parse','error','块转录失败','error')`,
      [runId, docId]);
  });

  afterAll(async () => { await pool.end(); });

  it("GET /api/documents/:id/trajectory 返回 run 列表", async () => {
    const resp = await app.request(`/api/documents/${docId}/trajectory`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].run_id).toBe(runId);
    expect(data.runs[0].event_count).toBe(2);
    expect(data.runs[0].error_count).toBe(1);
    expect(data.runs[0].first_stage).toBe("parse");
  });

  it("GET /api/documents/:id/trajectory?level=event&run_id=X 返回事件流（不含 payload）", async () => {
    const resp = await app.request(
      `/api/documents/${docId}/trajectory?level=event&run_id=${runId}`);
    const data = await resp.json();
    expect(data.events).toHaveLength(2);
    expect(data.events[0].summary).toBe("transcribe qwen3:4b");
    expect(data.events[0]).not.toHaveProperty("payload");
  });

  it("事件流支持 page_id 过滤", async () => {
    const resp = await app.request(
      `/api/documents/${docId}/trajectory?level=event&run_id=${runId}&page_id=${pageId}`);
    const data = await resp.json();
    expect(data.events).toHaveLength(1);
    expect(data.events[0].page_id).toBe(pageId);
  });

  it("GET /api/pages/:id/trajectory 返回该页事件", async () => {
    const resp = await app.request(`/api/pages/${pageId}/trajectory`);
    const data = await resp.json();
    expect(data.events).toHaveLength(1);
    expect(data.events[0].stage).toBe("parse");
  });

  it("GET /api/trajectory/events/:id 返回 payload 详情", async () => {
    const resp = await app.request(`/api/trajectory/events/${eventId}`);
    const data = await resp.json();
    expect(data.payload).toEqual({ prompt: "p" });
  });

  it("非法 UUID 返回 422", async () => {
    const resp = await app.request("/api/documents/not-a-uuid/trajectory");
    expect(resp.status).toBe(422);
  });
});
