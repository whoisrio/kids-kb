/** 试卷产品 API(frontend 视角)。类型与 backend 路由返回对齐。 */

export type PaperStatus = "processing" | "ready_for_review" | "done" | "failed";

export interface PaperSummary {
  id: string;
  title: string;
  subject: string;
  status: PaperStatus;
  error: string | null;
  page_count: number;
  created_at: string;
  total_questions: number;
  confirmed_questions: number;
  child_name?: string;
}

export interface PaperQuestion {
  id: string;
  paper_id: string;
  page_no: number;
  seq_in_page: number;
  seq: number;
  content_md: string;
  answer_excerpt: string | null;
  mark_desc: string | null;
  recognized_result: "correct" | "wrong" | "partial" | null;
  confirmed_result: "correct" | "wrong" | "partial" | null;
  error_cause: string | null;
  note: string | null;
  matched_item_id: string | null;
  match_score: number | null;
  matched_label: string | null;
  matched_chapter: string | null;
  matched_doc_title: string | null;
}

export interface PaperDetail extends PaperSummary {
  child_id: string;
  questions: PaperQuestion[];
}

export interface MatchCandidate {
  item_id: string;
  content_md: string;
  vec_score?: number;
  label?: string | null;
  chapter?: string | null;
  doc_title?: string | null;
  /** 题库条目的块裁图（裁图对照呈现用；无块条目为空数组，前端回退文本摘录） */
  blocks?: ItemBlock[];
}

export interface ItemBlock {
  block_id: string;
  block_type: string;
  content_md: string | null;
  crop_url: string;
}

type FetchLike = typeof fetch;

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `请求失败: ${resp.status}`);
  }
  return (await resp.json()) as T;
}

export function uploadPaper(
  form: { child_id: string; title: string; subject: string; files: File[] },
  fetchImpl: FetchLike = fetch,
): Promise<PaperSummary> {
  const fd = new FormData();
  fd.append("child_id", form.child_id);
  fd.append("title", form.title);
  fd.append("subject", form.subject);
  form.files.forEach((f) => fd.append("files", f));
  return fetchImpl("/api/papers", { method: "POST", body: fd }).then((r) => json<PaperSummary>(r));
}

export function fetchPapers(childId?: string, fetchImpl: FetchLike = fetch) {
  const qs = childId ? `?child_id=${encodeURIComponent(childId)}` : "";
  return fetchImpl(`/api/papers${qs}`).then((r) => json<{ papers: PaperSummary[] }>(r));
}

export function fetchPaperDetail(id: string, fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/papers/${encodeURIComponent(id)}`).then((r) => json<PaperDetail>(r));
}

export function patchPaper(id: string, body: { title?: string; subject?: string; child_id?: string },
                           fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/papers/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => json<PaperSummary>(r));
}

export function retryPaper(id: string, fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/papers/${encodeURIComponent(id)}/retry`, { method: "POST" })
    .then((r) => json<{ id: string; status: PaperStatus }>(r));
}

export function reRecognizePaper(id: string, pageNo: number, fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/papers/${encodeURIComponent(id)}/re-recognize`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ page_no: pageNo }),
  }).then((r) => json<{ id: string; status: PaperStatus }>(r));
}

export function confirmQuestion(
  id: string,
  body: { result: string; error_cause?: string; note?: string },
  fetchImpl: FetchLike = fetch,
) {
  return fetchImpl(`/api/paper-questions/${encodeURIComponent(id)}/confirm`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => json<{ id: string; paper_status: PaperStatus }>(r));
}

export function matchQuestion(
  id: string,
  itemId: string | null,
  score?: number,
  fetchImpl: FetchLike = fetch,
) {
  return fetchImpl(`/api/paper-questions/${encodeURIComponent(id)}/match`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ item_id: itemId, score }),
  }).then((r) => json<{ id: string; matched_item_id: string | null }>(r));
}

export function fetchCandidates(id: string, fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/paper-questions/${encodeURIComponent(id)}/candidates`)
    .then((r) => json<{ candidates: MatchCandidate[] }>(r));
}

export function questionImageUrl(id: string): string {
  return `/api/paper-questions/${encodeURIComponent(id)}/image`;
}

export function pageImageUrl(paperId: string, pageNo: number): string {
  return `/api/papers/${encodeURIComponent(paperId)}/pages/${pageNo}/image`;
}

export function sourcePdfUrl(paperId: string): string {
  return `/api/papers/${encodeURIComponent(paperId)}/source.pdf`;
}

export function fetchPaperPages(paperId: string, fetchImpl: FetchLike = fetch) {
  return fetchImpl(`/api/papers/${encodeURIComponent(paperId)}/pages`)
    .then((r) => json<{ pages: number[] }>(r));
}
