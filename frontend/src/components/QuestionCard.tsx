import { questionImageUrl, type PaperQuestion } from "../api/papers";

/** 当前题双栏:原卷裁图 | 识别内容(题干/作答/痕迹/匹配行)。 */
export function QuestionCard({ question }: { question: PaperQuestion }) {
  return (
    <div className="qcard-paper">
      <div className="pane">
        <h3>原卷裁图</h3>
        <div className="crop-box">
          <img src={questionImageUrl(question.id)} alt={`第 ${question.seq} 题裁图`}
               onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
        </div>
      </div>
      <div className="pane">
        <h3>识别出的题目</h3>
        <div className="content">
          <p className="stem">{question.content_md}</p>
          {question.answer_excerpt && (
            <p className="muted">识别到的作答：{question.answer_excerpt}</p>
          )}
          {question.mark_desc && <p className="muted">批改痕迹：{question.mark_desc}</p>}
          {question.matched_doc_title ? (
            <p className="match-line">
              题库匹配：{question.matched_doc_title}
              {question.matched_chapter ? ` · ${question.matched_chapter}` : ""}
              {question.matched_label ? ` · ${question.matched_label}` : ""}
              {question.match_score != null && ` · ${(question.match_score).toFixed(2)}`}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
