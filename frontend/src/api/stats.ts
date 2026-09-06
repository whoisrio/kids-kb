/** 统计/用量 API：类型与 backend routes/stats.ts、usage.ts 对齐。
    订正写回复用既有路由：item 题 POST /api/attempts；试卷题 PUT confirm（内部即该题 attempt 的 upsert）。 */

export interface StatsHero {
  weekWrong: number;
  weekTotal: number;
  weekRate: number | null;
  lastWeekRate: number | null;
  rateDelta: number | null;
  corrected: number;
  pending: number;
}

export interface PendingEntry {
  id: string;
  kind: "item" | "paper";
  content: string;
  source: string;
  errorCause: string | null;
  lastAt: string;
}

export interface StatsOverview {
  hero: StatsHero;
  causes: { cause: string; count: number }[];
  weakTags: { tag: string; count: number }[];
  trend: { weekStart: string; total: number; correct: number; rate: number | null }[];
  pendingList: PendingEntry[];
}

export interface UsageOverview {
  hero: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    calls: number;
    textTokens: number;
    imageTokens: number;
  };
  byPurpose: { purpose: string; calls: number; tokens: number }[];
  byModel: { model: string; calls: number; tokens: number }[];
  recent: {
    id: string;
    created_at: string;
    purpose: string;
    model: string;
    modality: string;
    prompt_tokens: number;
    completion_tokens: number;
  }[];
}

type FetchLike = typeof fetch;

async function responseError(resp: Response): Promise<Error> {
  let message = `请求失败: ${resp.status}`;
  try {
    message = ((await resp.json()) as { error?: string }).error ?? message;
  } catch {
    // 非 JSON 错误体
  }
  return new Error(message);
}

async function getJson<T>(url: string, fetchImpl: FetchLike): Promise<T> {
  const resp = await fetchImpl(url);
  if (!resp.ok) throw await responseError(resp);
  return (await resp.json()) as T;
}

export function fetchStatsOverview(childId: string, fetchImpl: FetchLike = fetch): Promise<StatsOverview> {
  return getJson(`/api/stats/overview?child_id=${encodeURIComponent(childId)}`, fetchImpl);
}

export function fetchUsageOverview(fetchImpl: FetchLike = fetch): Promise<UsageOverview> {
  return getJson("/api/usage/overview", fetchImpl);
}

export async function recordCorrection(
  entry: PendingEntry,
  childId: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const url = entry.kind === "item" ? "/api/attempts" : `/api/paper-questions/${encodeURIComponent(entry.id)}/confirm`;
  const body = entry.kind === "item"
    ? { child_id: childId, item_id: entry.id, result: "correct" }
    : { result: "correct" };
  const resp = await fetchImpl(url, {
    method: entry.kind === "item" ? "POST" : "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await responseError(resp);
}
