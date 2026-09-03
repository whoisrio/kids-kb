/** 试卷后台任务:调 pipeline 加工 -> 逐题自动匹配 -> 状态推进。
    进程内去重(inflight),幂等可重驱动;匹配失败不致命(复核页人工匹配兜底)。 */
import type pg from "pg";
import { matchQuestion } from "../retrieval/match.js";
import type { RerankFn } from "../retrieval/rerank.js";

export interface PaperJobDeps {
  pipelineUrl: string;
  matchThreshold: number;
  embed: (texts: string[]) => Promise<number[][]>;
  rerank: RerankFn | null;
  fetchImpl?: typeof fetch;
}

const inflight = new Map<string, Promise<void>>();

export function drivePaper(
  pool: pg.Pool,
  deps: PaperJobDeps,
  paperId: string,
  opts: { pdfBytes?: Uint8Array; pageNo?: number } = {},
): Promise<void> {
  const running = inflight.get(paperId);
  if (running) return running;
  const job = runPaperJob(pool, deps, paperId, opts)
    .catch(async (err) => {
      console.error(`试卷 ${paperId} 处理失败`, err);
      await pool.query(
        "UPDATE papers SET status='failed', error=$1, updated_at=now() WHERE id=$2",
        [err instanceof Error ? err.message : String(err), paperId],
      );
    })
    .finally(() => inflight.delete(paperId));
  inflight.set(paperId, job);
  return job;
}

async function runPaperJob(pool: pg.Pool, deps: PaperJobDeps, paperId: string,
                           opts: { pdfBytes?: Uint8Array; pageNo?: number }) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.pipelineUrl.replace(/\/$/, "");
  // 整卷加工可长达数分钟(VLM 逐页),显式 10 分钟超时;undici 默认 300s 且长任务可能整卷卡死
  const TIMEOUT_MS = 600_000;
  const timeout = () => AbortSignal.timeout(TIMEOUT_MS);

  let resp: Response;
  if (opts.pageNo === undefined) {
    const url = `${base}/internal/ingest-paper?paper_id=${encodeURIComponent(paperId)}`;
    if (opts.pdfBytes) {
      const form = new FormData();
      form.append("file", new Blob([opts.pdfBytes as BlobPart], { type: "application/pdf" }), "source.pdf");
      resp = await fetchImpl(url, { method: "POST", body: form, signal: timeout() });
    } else {
      resp = await fetchImpl(url, { method: "POST", signal: timeout() });  // 重驱动:复用 pipeline 已存 source.pdf
    }
  } else {
    resp = await fetchImpl(`${base}/internal/recognize-page`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paper_id: paperId, page_no: opts.pageNo }),
      signal: timeout(),
    });
  }
  if (!resp.ok) {
    const detail = (await resp.json().catch(() => ({}))) as { detail?: unknown };
    throw new Error(String(detail.detail ?? `pipeline ${resp.status}`));
  }

  // 逐题自动匹配(失败不致命:人工匹配兜底)
  const { rows: questions } = await pool.query<{ id: string; content_md: string; subject: string }>(
    `SELECT pq.id::text, pq.content_md, p.subject FROM paper_questions pq
     JOIN papers p ON p.id = pq.paper_id
     WHERE pq.paper_id = $1 AND pq.matched_item_id IS NULL`,
    [paperId],
  );
  for (const q of questions) {
    try {
      const { auto } = await matchQuestion(
        pool, { embed: deps.embed, rerank: deps.rerank }, q.content_md, q.subject, deps.matchThreshold);
      if (auto) {
        await pool.query(
          `UPDATE paper_questions SET matched_item_id=$1, match_score=$2, matched_at=now()
           WHERE id=$3`, [auto.item_id, auto.vec_score, q.id]);
      }
    } catch (err) {
      console.error(`题目 ${q.id} 匹配失败(可人工匹配兜底)`, err);
    }
  }

  const { rows: [{ n }] } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM paper_questions WHERE paper_id=$1", [paperId]);
  if (n === 0) throw new Error("未识别出题目");
  await pool.query(
    "UPDATE papers SET status='ready_for_review', error=NULL, updated_at=now() WHERE id=$1",
    [paperId],
  );
}

/** backend 启动时重驱动滞留 processing 的卷(pipeline 幂等,安全)。 */
export async function redriveStuckPapers(pool: pg.Pool, deps: PaperJobDeps): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id::text FROM papers WHERE status='processing'");
  for (const r of rows) void drivePaper(pool, deps, r.id);
  return rows.length;
}

/**
 * 探活 pipeline 就绪后才重驱动。规避启动竞态:backend 先于 pipeline 起来时,
 * redrive 对每卷调 ingest 会立即失败并把 processing 卷误打成 failed。
 * 探活点用 /internal/rerank 空 docs(不加载模型权重,恒 200);失败按退避重试。
 */
export async function redriveWhenPipelineReady(
  pool: pg.Pool,
  deps: PaperJobDeps,
  opts: { attempts?: number; retryMs?: number; probeTimeoutMs?: number } = {},
): Promise<number> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = deps.pipelineUrl.replace(/\/$/, "");
  const attempts = opts.attempts ?? 30;
  const retryMs = opts.retryMs ?? 2_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 5_000;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetchImpl(`${base}/internal/rerank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "", docs: [] }),
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (resp.ok) return redriveStuckPapers(pool, deps);
    } catch {
      // pipeline 未就绪,退避重试
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, retryMs));
  }
  console.warn(`pipeline ${base} ${attempts} 次探活未就绪,跳过滞留试卷重驱动`);
  return 0;
}
