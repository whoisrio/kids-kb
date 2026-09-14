/** 资料库文档后台任务:调 pipeline ingest(pdf/docx/md 统一端点,同步阻塞)。
    进程内去重(inflight),pipeline 以 source_path 幂等可重驱动;
    失败置 documents.parse_status='failed'(细节可查 pipeline_events)。 */
import type pg from "pg";

export interface DocJobDeps {
  pipelineUrl: string;
  fetchImpl?: typeof fetch;
}

/** pipeline /internal/ingest-doc 的请求体。 */
export interface DocJobPayload {
  source_path: string;
  title: string;
  subject?: string | null;
  grade?: string | null;
  doc_type: string;
}

const inflight = new Map<string, Promise<void>>();

export function driveDoc(
  pool: pg.Pool,
  deps: DocJobDeps,
  docId: string,
  payload: DocJobPayload,
): Promise<void> {
  const running = inflight.get(docId);
  if (running) return running;
  const job = runDocJob(deps, payload)
    .catch(async (err) => {
      console.error(`文档 ${docId} 入库失败`, err);
      await pool.query(
        "UPDATE documents SET parse_status='failed' WHERE id=$1",
        [docId],
      );
    })
    .finally(() => inflight.delete(docId));
  inflight.set(docId, job);
  return job;
}

async function runDocJob(deps: DocJobDeps, payload: DocJobPayload) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.pipelineUrl.replace(/\/$/, "");
  // pdf 整本解析(layout/OCR/VLM 逐页)可远超数分钟,显式 30 分钟超时
  const resp = await fetchImpl(`${base}/internal/ingest-doc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(1_800_000),
  });
  if (!resp.ok) {
    const detail = (await resp.json().catch(() => ({}))) as { detail?: unknown };
    throw new Error(String(detail.detail ?? `pipeline ${resp.status}`));
  }
}

/** backend 启动时重驱动滞留 pending/parsing 的文档(pipeline 幂等,安全)。 */
export async function redriveStuckDocs(pool: pg.Pool, deps: DocJobDeps): Promise<number> {
  const { rows } = await pool.query<{
    id: string; source_path: string; title: string;
    subject: string | null; grade: string | null; doc_type: string;
  }>(
    `SELECT id::text, source_path, title, subject, grade, doc_type
     FROM documents WHERE parse_status IN ('pending','parsing')`);
  for (const r of rows) {
    void driveDoc(pool, deps, r.id, {
      source_path: r.source_path, title: r.title,
      subject: r.subject, grade: r.grade, doc_type: r.doc_type,
    });
  }
  return rows.length;
}
