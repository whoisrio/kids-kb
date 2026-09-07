type FetchLike = typeof fetch;

export interface TrajectoryRun {
  run_id: string;
  started_at: string;
  ended_at: string;
  event_count: number;
  error_count: number;
  first_stage: string;
  actor: string;
  first_summary: string;
}

export interface TrajectoryEvent {
  id: number;
  run_id: string;
  document_id: string;
  page_id: string | null;
  item_id: string | null;
  stage: string;
  event_type: string;
  summary: string;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  duration_ms: number | null;
  status: "ok" | "error" | "skipped";
  actor: string;
  created_at: string;
  payload?: Record<string, unknown> | null;
}

async function req<T>(url: string, fetchImpl: FetchLike): Promise<T> {
  const resp = await fetchImpl(url);
  if (!resp.ok) {
    let msg = `请求失败: ${resp.status}`;
    try { msg = ((await resp.json()) as { error?: string }).error ?? msg; } catch { /* 非 JSON */ }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}

export function fetchDocRuns(docId: string, fetchImpl: FetchLike = fetch) {
  return req<{ runs: TrajectoryRun[] }>(
    `/api/documents/${encodeURIComponent(docId)}/trajectory`, fetchImpl);
}

export function fetchDocEvents(docId: string, runId: string, fetchImpl: FetchLike = fetch) {
  return req<{ events: TrajectoryEvent[] }>(
    `/api/documents/${encodeURIComponent(docId)}/trajectory?level=event&run_id=${encodeURIComponent(runId)}`,
    fetchImpl);
}

export function fetchPageEvents(pageId: string, fetchImpl: FetchLike = fetch) {
  return req<{ events: TrajectoryEvent[] }>(
    `/api/pages/${encodeURIComponent(pageId)}/trajectory`, fetchImpl);
}

export function fetchEventDetail(id: number, fetchImpl: FetchLike = fetch) {
  return req<TrajectoryEvent>(`/api/trajectory/events/${id}`, fetchImpl);
}
