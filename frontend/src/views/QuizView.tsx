import { useCallback, useEffect, useState } from "react";
import {
  fetchQuiz,
  fetchQuizzes,
  submitQuiz,
  type QuestionResult,
  type QuizAnswers,
  type QuizDetail,
  type QuizQuestion,
  type QuizSummary,
} from "../api/quizzes";

type Phase = "cover" | "answering" | "submitting" | "reviewing";

const TYPE_LABEL: Record<QuizQuestion["type"], string> = {
  single: "单选",
  multiple: "多选",
  short_answer: "简答",
};

const RESULT_LABEL: Record<QuestionResult["result"], string> = {
  correct: "答对了",
  wrong: "答错了",
  partial: "部分正确",
};

function isAnswered(question: QuizQuestion, answer: string | string[] | undefined): boolean {
  if (question.type === "multiple") return Array.isArray(answer) && answer.length > 0;
  if (question.type === "short_answer") return typeof answer === "string" && answer.trim() !== "";
  return typeof answer === "string" && answer !== "";
}

/** 选项值 → 「B. 2」式展示；多选用顿号连接。 */
function formatChoice(question: QuizQuestion, values: string[]): string {
  return values
    .map((value) => {
      const option = question.options?.find((item) => item.value === value);
      return option ? `${option.value}. ${option.label}` : value;
    })
    .join("、");
}

function formatAnswer(question: QuizQuestion, answer: string | string[] | undefined): string {
  if (answer === undefined) return "—";
  if (Array.isArray(answer)) return formatChoice(question, answer);
  if (question.type === "single") return formatChoice(question, [answer]);
  return answer;
}

export function QuizView({
  childId,
  fetchImpl = fetch,
}: {
  childId: string | null;
  fetchImpl?: typeof fetch;
}) {
  const [quizzes, setQuizzes] = useState<QuizSummary[] | null>(null);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<QuizDetail | null>(null);
  const [phase, setPhase] = useState<Phase>("cover");
  const [answers, setAnswers] = useState<QuizAnswers>({});
  const [results, setResults] = useState<QuestionResult[] | null>(null);

  const load = useCallback(async () => {
    if (!childId) return;
    setError("");
    try {
      setQuizzes(await fetchQuizzes(childId, fetchImpl));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [childId, fetchImpl]);

  useEffect(() => {
    setDetail(null);
    setQuizzes(null);
    void load();
  }, [load]);

  const open = async (id: string) => {
    setError("");
    try {
      const quiz = await fetchQuiz(id, fetchImpl);
      setDetail(quiz);
      setAnswers({});
      // 已提交的练习：后端由 attempts 还原逐题结果，直接进入回顾
      setResults(quiz.status === "submitted" ? (quiz.results ?? null) : null);
      setPhase(quiz.status === "submitted" ? "reviewing" : "cover");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const back = () => {
    setDetail(null);
    setResults(null);
    void load();
  };

  const chooseSingle = (questionId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  };

  const toggleMulti = (questionId: string, value: string) => {
    setAnswers((prev) => {
      const current = prev[questionId];
      const list = Array.isArray(current) ? current : [];
      return {
        ...prev,
        [questionId]: list.includes(value)
          ? list.filter((item) => item !== value)
          : [...list, value],
      };
    });
  };

  const answeredCount = detail
    ? detail.questions.filter((question) => isAnswered(question, answers[question.id])).length
    : 0;

  const submit = async () => {
    if (!detail || phase !== "answering" || answeredCount < detail.questions.length) return;
    setPhase("submitting");
    setError("");
    try {
      const out = await submitQuiz(detail.id, answers, fetchImpl);
      setResults(out.results);
      // submit 响应不含正确答案/解析，重新拉详情（此时已 submitted）供回顾
      setDetail(await fetchQuiz(detail.id, fetchImpl));
      setPhase("reviewing");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("answering");
    }
  };

  if (!childId) {
    return <div className="qz-root chat-empty">还没有孩子档案——先在复核页上传试卷时添加孩子。</div>;
  }

  if (!detail) {
    return (
      <div className="qz-root">
        {error && <div className="form-error" role="alert">{error}</div>}
        {!quizzes && !error && <div className="chat-empty">加载中…</div>}
        {quizzes && quizzes.length === 0 && (
          <div className="chat-empty">还没有练习，去统计页针对薄弱点出题</div>
        )}
        {quizzes && quizzes.length > 0 && (
          <div className="qz-list">
            {quizzes.map((quiz) => (
              <button key={quiz.id} type="button" className="qz-card" onClick={() => void open(quiz.id)}>
                <div className="qz-card-main">
                  <div className="qz-card-title">{quiz.title}</div>
                  {quiz.tags.length > 0 && (
                    <div className="qz-tags">
                      {quiz.tags.map((tag) => (
                        <span key={tag} className="qz-chip">{tag}</span>
                      ))}
                    </div>
                  )}
                  <div className="qz-card-meta">
                    {quiz.question_count} 题 · {quiz.total_points} 分
                    {quiz.status === "submitted" && quiz.earned_points !== null && (
                      <span className="qz-card-score">得分 {quiz.earned_points}/{quiz.total_points}</span>
                    )}
                  </div>
                </div>
                <span className={`qz-badge qz-badge--${quiz.status}`}>
                  {quiz.status === "submitted" ? "已完成" : "待作答"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="qz-root">
      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="qz-quiz-head">
        <button type="button" className="qz-back" onClick={back}>返回列表</button>
        <div className="qz-quiz-title">{detail.title}</div>
        {phase === "answering" && (
          <>
            <span className="qz-progress">已答 {answeredCount}/{detail.questions.length}</span>
            <button
              type="button"
              className="qz-submit"
              disabled={answeredCount < detail.questions.length}
              onClick={() => void submit()}
            >
              提交答案
            </button>
          </>
        )}
      </div>

      {phase === "cover" && (
        <div className="qz-cover">
          <div className="qz-cover-title">{detail.title}</div>
          {detail.tags.length > 0 && (
            <div className="qz-tags">
              {detail.tags.map((tag) => (
                <span key={tag} className="qz-chip">{tag}</span>
              ))}
            </div>
          )}
          <div className="qz-cover-meta">共 {detail.question_count} 题 · 总分 {detail.total_points} 分</div>
          <button type="button" className="qz-start" onClick={() => setPhase("answering")}>
            开始答题
          </button>
        </div>
      )}

      {phase === "submitting" && <div className="chat-empty">判分中…</div>}

      {(phase === "answering" || phase === "reviewing") && (
        <div className="qz-questions">
          {phase === "reviewing" && detail.earned_points !== null && (
            <ScoreBanner earned={detail.earned_points} total={detail.total_points} />
          )}
          {detail.questions.map((question) => {
            const result = results?.find((item) => item.question_id === question.id) ?? null;
            return phase === "answering" ? (
              <AnsweringCard
                key={question.id}
                question={question}
                answer={answers[question.id]}
                onSingle={chooseSingle}
                onMulti={toggleMulti}
                onText={(value) => setAnswers((prev) => ({ ...prev, [question.id]: value }))}
              />
            ) : (
              <ReviewCard
                key={question.id}
                question={question}
                answer={answers[question.id]}
                result={result}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ScoreBanner({ earned, total }: { earned: number; total: number }) {
  const rate = total > 0 ? earned / total : 0;
  const level = rate >= 0.8 ? "high" : rate >= 0.6 ? "mid" : "low";
  return (
    <div className={`qz-banner qz-banner--${level}`}>
      <span className="qz-banner-score">{earned}/{total} 分</span>
      <span className="qz-banner-rate">正确率 {Math.round(rate * 100)}%</span>
    </div>
  );
}

function AnsweringCard({
  question,
  answer,
  onSingle,
  onMulti,
  onText,
}: {
  question: QuizQuestion;
  answer: string | string[] | undefined;
  onSingle: (questionId: string, value: string) => void;
  onMulti: (questionId: string, value: string) => void;
  onText: (value: string) => void;
}) {
  return (
    <div className="qz-question">
      <div className="qz-question-head">
        <span className="qz-seq">第 {question.seq} 题</span>
        <span className="qz-type">{TYPE_LABEL[question.type]}</span>
        <span className="qz-points">{question.points} 分</span>
      </div>
      <div className="qz-question-text">{question.question}</div>
      {question.type === "short_answer" ? (
        <textarea
          className="qz-textarea"
          aria-label={`第 ${question.seq} 题作答`}
          value={typeof answer === "string" ? answer : ""}
          onChange={(event) => onText(event.target.value)}
          placeholder="写下你的答案…"
        />
      ) : (
        <div className={question.type === "multiple" ? "qz-options qz-options--multi" : "qz-options"}>
          {(question.options ?? []).map((option) => {
            const selected = Array.isArray(answer)
              ? answer.includes(option.value)
              : answer === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                className={selected ? "qz-option qz-option--on" : "qz-option"}
                onClick={() =>
                  question.type === "multiple"
                    ? onMulti(question.id, option.value)
                    : onSingle(question.id, option.value)
                }
              >
                {option.value}. {option.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ReviewCard({
  question,
  answer,
  result,
}: {
  question: QuizQuestion;
  answer: string | string[] | undefined;
  result: QuestionResult | null;
}) {
  return (
    <div className={result ? `qz-question qz-question--${result.result}` : "qz-question"}>
      <div className="qz-question-head">
        <span className="qz-seq">第 {question.seq} 题</span>
        <span className="qz-type">{TYPE_LABEL[question.type]}</span>
        <span className="qz-points">{question.points} 分</span>
        {result && (
          <span className={`qz-verdict qz-verdict--${result.result}`}>
            {RESULT_LABEL[result.result]} · {result.earned}/{result.points} 分
          </span>
        )}
      </div>
      <div className="qz-question-text">{question.question}</div>
      {result && answer !== undefined && <div className="qz-line">你的作答：{formatAnswer(question, answer)}</div>}
      {question.answer && question.answer.length > 0 && (
        <div className="qz-line qz-line--answer">正确答案：{formatChoice(question, question.answer)}</div>
      )}
      {question.analysis && <div className="qz-analysis">解析：{question.analysis}</div>}
      {result?.comment && <div className="qz-comment">AI 评语：{result.comment}</div>}
    </div>
  );
}
