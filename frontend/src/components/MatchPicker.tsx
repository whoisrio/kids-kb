import { useEffect, useState } from "react";
import { fetchCandidates, matchQuestion, type MatchCandidate, type PaperQuestion } from "../api/papers";

/** 候选浮层:实时检索 top-5,点选关联;已匹配可清除。 */
export function MatchPicker({ question, onMatched }: {
  question: PaperQuestion;
  onMatched: (q: PaperQuestion) => void;
}) {
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchCandidates(question.id).then((r) => setCandidates(r.candidates)).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [question.id]);

  const pick = async (item: MatchCandidate | null) => {
    try {
      await matchQuestion(question.id, item?.item_id ?? null, item?.vec_score);
      onMatched({
        ...question,
        matched_item_id: item?.item_id ?? null,
        match_score: item?.vec_score ?? null,
        matched_label: item?.label ?? null,
        matched_chapter: item?.chapter ?? null,
        matched_doc_title: item?.doc_title ?? null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="dialog-mask">
      <div className="dialog" role="dialog" aria-label="选择题库条目">
        <h2>匹配题库条目</h2>
        <div className="cand-list">
          {error && <div className="form-error">{error}</div>}
          {!error && candidates.length === 0 && <div className="empty">没有候选</div>}
          {candidates.map((c) => (
            <button key={c.item_id} className="cand" onClick={() => void pick(c)}>
              <span className="t">{c.content_md.slice(0, 60)}</span>
              <span className="m">
                {c.doc_title}{c.chapter ? ` · ${c.chapter}` : ""}{c.label ? ` · ${c.label}` : ""}
                {c.vec_score != null && ` · ${c.vec_score.toFixed(2)}`}
              </span>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          {question.matched_item_id && (
            <button onClick={() => void pick(null)}>清除匹配</button>
          )}
          <button className="primary" onClick={() => onMatched(question)}>关闭</button>
        </div>
      </div>
    </div>
  );
}
