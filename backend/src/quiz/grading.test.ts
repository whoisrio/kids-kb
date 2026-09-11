/** 选择题判分纯函数：集合相等、全对全分否则零分、无部分分（移植自 openMAIC lib/quiz/grading.ts）。 */
import { describe, expect, it } from "vitest";
import { arraysEqual, gradeChoiceQuestions, isShortAnswer, toArray } from "./grading.js";
import type { QuizQuestion } from "./types.js";

const q = (partial: Partial<QuizQuestion> & { id: string }): QuizQuestion => ({
  type: "single",
  question: "题干",
  ...partial,
});

describe("arraysEqual", () => {
  it("集合相等与顺序无关", () => {
    expect(arraysEqual(["A", "C"], ["C", "A"])).toBe(true);
    expect(arraysEqual(["A"], ["A"])).toBe(true);
    expect(arraysEqual([], [])).toBe(true);
  });
  it("长度或元素不同则不等", () => {
    expect(arraysEqual(["A"], ["A", "B"])).toBe(false);
    expect(arraysEqual(["A"], ["B"])).toBe(false);
    expect(arraysEqual([], ["A"])).toBe(false);
  });
});

describe("toArray", () => {
  it("string → [string]，数组原样，空值 → []", () => {
    expect(toArray("A")).toEqual(["A"]);
    expect(toArray(["A", "B"])).toEqual(["A", "B"]);
    expect(toArray(undefined)).toEqual([]);
  });
});

describe("isShortAnswer", () => {
  it("仅按 type 判定，answer 有无不改判", () => {
    expect(isShortAnswer(q({ id: "a", type: "short_answer" }))).toBe(true);
    expect(isShortAnswer(q({ id: "b", answer: undefined }))).toBe(false);
  });
});

describe("gradeChoiceQuestions", () => {
  it("单选答对得满分，答错零分", () => {
    const [r] = gradeChoiceQuestions(
      [q({ id: "q1", answer: ["B"], points: 10 })],
      { q1: "B" },
    );
    expect(r).toMatchObject({ questionId: "q1", correct: true, earned: 10, points: 10 });
    const [w] = gradeChoiceQuestions(
      [q({ id: "q1", answer: ["B"], points: 10 })],
      { q1: "A" },
    );
    expect(w).toMatchObject({ correct: false, earned: 0 });
  });

  it("多选集合相等（顺序无关）得满分", () => {
    const [r] = gradeChoiceQuestions(
      [q({ id: "q2", type: "multiple", answer: ["A", "C"], points: 15 })],
      { q2: ["C", "A"] },
    );
    expect(r).toMatchObject({ correct: true, earned: 15 });
  });

  it("多选少选/多选/错选一律零分（无部分分）", () => {
    const question = q({ id: "q2", type: "multiple", answer: ["A", "C"], points: 15 });
    for (const ans of [["A"], ["A", "B"], ["A", "C", "D"], ["B", "D"]]) {
      const [r] = gradeChoiceQuestions([question], { q2: ans });
      expect(r.correct).toBe(false);
      expect(r.earned).toBe(0);
    }
  });

  it("未作答判错（空答案 ≠ 正确答案）", () => {
    const [r] = gradeChoiceQuestions(
      [q({ id: "q1", answer: ["A"], points: 10 })],
      {},
    );
    expect(r).toMatchObject({ correct: false, earned: 0 });
  });

  it("points 缺省按 1 计", () => {
    const [r] = gradeChoiceQuestions(
      [q({ id: "q1", answer: ["A"] })],
      { q1: ["A"] },
    );
    expect(r).toMatchObject({ correct: true, earned: 1, points: 1 });
  });

  it("short_answer 不参与本地判分", () => {
    const results = gradeChoiceQuestions(
      [q({ id: "q1", answer: ["A"] }), q({ id: "q3", type: "short_answer" })],
      { q1: "A", q3: "一大段文字" },
    );
    expect(results).toHaveLength(1);
    expect(results[0].questionId).toBe("q1");
  });
});
