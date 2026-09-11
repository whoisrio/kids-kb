/** 练习 API：类型与 backend routes/quizzes.ts 对齐（薄弱点出题 + 列表 + 详情 + 提交判分）。 */

export type QuizStatus = "pending" | "submitted";
export type QuizQuestionType = "single" | "multiple" | "short_answer";
export type QuizAnswers = Record<string, string | string[]>;

export interface QuizSummary {
  id: string;
  child_id: string;
  title: string;
  tags: string[];
  status: QuizStatus;
  created_at: string;
  submitted_at: string | null;
  question_count: number;
  total_points: number;
  earned_points: number | null;
}

export interface QuizQuestion {
  id: string;
  seq: number;
  type: QuizQuestionType;
  question: string;
  options: { value: string; label: string }[] | null;
  points: number;
  /** pending 时为 null；submitted 后为正确答案（简答可为 null，参考解析看 analysis） */
  answer: string[] | null;
  /** pending 时为 null */
  analysis: string | null;
}

export interface QuizDetail extends QuizSummary {
  questions: QuizQuestion[];
  /** submitted 时后端由 attempts 还原的逐题结果（comment 未持久化，恒为 null）；pending 时缺省 */
  results?: QuestionResult[];
}

export interface QuestionResult {
  question_id: string;
  result: "correct" | "wrong" | "partial";
  earned: number;
  points: number;
  comment: string | null;
}

export interface GenerateQuizOptions {
  count?: number;
  difficulty?: string;
  types?: string[];
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

async function postJson<T>(url: string, body: unknown, fetchImpl: FetchLike): Promise<T> {
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await responseError(resp);
  return (await resp.json()) as T;
}

/** 针对薄弱知识点出题；409 no_weak_tags 表示还没有薄弱知识点记录。 */
export async function generateQuiz(
  childId: string,
  options?: GenerateQuizOptions,
  fetchImpl: FetchLike = fetch,
): Promise<QuizSummary> {
  const data = await postJson<{ quiz: QuizSummary }>(
    "/api/quizzes/generate",
    { child_id: childId, ...options },
    fetchImpl,
  );
  return data.quiz;
}

export async function fetchQuizzes(childId: string, fetchImpl: FetchLike = fetch): Promise<QuizSummary[]> {
  const data = await getJson<{ quizzes: QuizSummary[] }>(
    `/api/quizzes?child_id=${encodeURIComponent(childId)}`,
    fetchImpl,
  );
  return data.quizzes;
}

export async function fetchQuiz(id: string, fetchImpl: FetchLike = fetch): Promise<QuizDetail> {
  const data = await getJson<{ quiz: QuizDetail }>(`/api/quizzes/${encodeURIComponent(id)}`, fetchImpl);
  return data.quiz;
}

/** 提交作答并判分；409 already_submitted 表示该练习已提交过。 */
export async function submitQuiz(
  id: string,
  answers: QuizAnswers,
  fetchImpl: FetchLike = fetch,
): Promise<{ quiz: QuizSummary; results: QuestionResult[] }> {
  return postJson(`/api/quizzes/${encodeURIComponent(id)}/submit`, { answers }, fetchImpl);
}
