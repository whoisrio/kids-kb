/** AI 出题输出归一化，移植自 openMAIC packages/@openmaic/generation/src/scene-generator.ts（MIT）：
    string options → {value:"A".."Z", label}；answer ?? correctAnswer ?? correct_answer 兼容；
    short_answer 清掉 options/answer。 */
import type { QuizOption, QuizQuestion, QuizQuestionType } from "./types.js";

const TYPES = new Set<QuizQuestionType>(["single", "multiple", "short_answer"]);

/** options 归一化为 {value,label}[]；非数组返回 undefined。 */
export function normalizeQuizOptions(options: unknown): QuizOption[] | undefined {
  if (!options || !Array.isArray(options)) return undefined;
  return options.map((opt, index) => {
    const letter = String.fromCharCode(65 + index); // A, B, C, D...
    if (typeof opt === "string") return { value: letter, label: opt };
    if (typeof opt === "object" && opt !== null) {
      const obj = opt as Record<string, unknown>;
      return {
        value: typeof obj.value === "string" ? obj.value : letter,
        label: typeof obj.label === "string" ? obj.label : String(obj.value || obj.text || letter),
      };
    }
    return { value: letter, label: String(opt) };
  });
}

/** answer ?? correctAnswer ?? correct_answer 归一化为 string[]；缺省返回 undefined。 */
export function normalizeQuizAnswer(question: Record<string, unknown>): string[] | undefined {
  const raw = question.answer ?? question.correctAnswer ?? question.correct_answer;
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw.map(String);
  return [String(raw)];
}

/**
 * 清洗 AI 出题输出为 QuizQuestion[]；任何一题不合法（缺题干/未知类型/选择题缺选项或答案）
 * 或整体不是非空数组时返回 null（调用方映射 502 invalid_model_output）。
 */
export function normalizeGeneratedQuestions(raw: unknown): QuizQuestion[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: QuizQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") return null;
    const type = item.type as QuizQuestionType;
    if (!TYPES.has(type)) return null;
    if (typeof item.question !== "string" || !item.question.trim()) return null;
    const points = Number.isFinite(item.points) && Number(item.points) > 0
      ? Math.round(Number(item.points))
      : 10;
    const base: QuizQuestion = {
      id: typeof item.id === "string" && item.id ? item.id : `q${i + 1}`,
      type,
      question: item.question,
      analysis: typeof item.analysis === "string" ? item.analysis : null,
      points,
    };
    if (type === "short_answer") {
      const commentPrompt = item.commentPrompt ?? item.comment_prompt;
      out.push({
        ...base,
        options: null,
        answer: null,
        commentPrompt: typeof commentPrompt === "string" ? commentPrompt : null,
      });
    } else {
      const options = normalizeQuizOptions(item.options);
      const answer = normalizeQuizAnswer(item);
      if (!options || options.length < 2 || !answer || answer.length === 0) return null;
      out.push({ ...base, options, answer });
    }
  }
  return out;
}
