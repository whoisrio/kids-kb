/** 薄弱点自动出题的领域类型。字段出参 snake_case，与 DB 列/前端契约对齐。 */

export type QuizQuestionType = "single" | "multiple" | "short_answer";

export interface QuizOption {
  value: string;
  label: string;
}

/** 出题/判分共用的题目模型（normalize 产物；short_answer 的 options/answer 恒为 null）。 */
export interface QuizQuestion {
  id: string;
  type: QuizQuestionType;
  question: string;
  options?: QuizOption[] | null;
  answer?: string[] | null;
  analysis?: string | null;
  /** 简答评分要点（rubric）。 */
  commentPrompt?: string | null;
  /** 缺省判分时按 1 计；出题入库缺省 10。 */
  points?: number;
}

export interface QuizSummary {
  id: string;
  child_id: string;
  title: string;
  tags: string[];
  status: "pending" | "submitted";
  created_at: string;
  submitted_at: string | null;
  question_count: number;
  total_points: number;
  /** pending 恒为 null；submitted 为各题实得分之和。 */
  earned_points: number | null;
}

export interface QuizDetailQuestion {
  id: string;
  seq: number;
  type: QuizQuestionType;
  question: string;
  options: QuizOption[] | null;
  points: number;
  /** pending 恒为 null（防偷看），submitted 后全量返回。 */
  answer: string[] | null;
  analysis: string | null;
}

export interface QuizDetail extends QuizSummary {
  questions: QuizDetailQuestion[];
  /** submitted 时由 attempts 还原（comment 未持久化，恒为 null）；pending 时缺省。 */
  results?: QuestionResult[];
}

export interface QuestionResult {
  question_id: string;
  result: "correct" | "wrong" | "partial";
  earned: number;
  points: number;
  comment: string | null;
}
