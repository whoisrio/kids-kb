import type { PaperSummary } from "../api/papers";

const STATUS_TEXT: Record<string, string> = {
  processing: "处理中",
  ready_for_review: "待复核",
  done: "已完成",
  failed: "失败",
};

interface PaperQueueProps {
  papers: PaperSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUpload: () => void;
}

export function PaperQueue({ papers, selectedId, onSelect, onUpload }: PaperQueueProps) {
  return (
    <aside className="papers-queue">
      <div className="pq-head">
        <span className="label">试卷</span>
        <button className="new-btn" onClick={onUpload}>＋ 上传试卷</button>
      </div>
      <div className="pq-list">
        {papers.length === 0 && <div className="empty">还没有上传试卷</div>}
        {papers.map((p) => (
          <button
            key={p.id}
            className={`paper-item${p.id === selectedId ? " active" : ""}`}
            onClick={() => onSelect(p.id)}
          >
            <span className="t">{p.title}</span>
            <span className="m">
              <span className={`status ${p.status}`}>{STATUS_TEXT[p.status]}</span>
              {p.status === "failed" && <span className="err" title={p.error ?? ""}>重试</span>}
              {p.total_questions > 0 && (
                <span>{p.confirmed_questions}/{p.total_questions}</span>
              )}
              <span>{p.subject}</span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
