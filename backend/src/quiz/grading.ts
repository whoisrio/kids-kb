/** 选择题判分纯函数，移植自 openMAIC lib/quiz/grading.ts（MIT）：
    集合相等（顺序无关）、全对全分否则零分、无部分分。
    未作答的选择题仍是选择题，按答案比对判错，不改道 AI 判分。 */
import type { QuizQuestion } from "./types.js";

export interface ChoiceGrade {
  questionId: string;
  correct: boolean;
  earned: number;
  points: number;
}

export function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

export function toArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** 是否简答题（走 AI 判分）。只按显式 type 判定，不看 answer 有无。 */
export function isShortAnswer(q: QuizQuestion): boolean {
  return q.type === "short_answer";
}

/** 选择题本地判分，只返回非简答题的结果。points 缺省按 1 计。 */
export function gradeChoiceQuestions(
  questions: QuizQuestion[],
  answers: Record<string, string | string[]>,
): ChoiceGrade[] {
  return questions
    .filter((q) => !isShortAnswer(q))
    .map((q) => {
      const pts = q.points ?? 1;
      const correct = arraysEqual(toArray(answers[q.id]), toArray(q.answer ?? undefined));
      return { questionId: q.id, correct, earned: correct ? pts : 0, points: pts };
    });
}
