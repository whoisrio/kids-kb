import { useState } from "react";

export interface ChapterSummary {
  id: string; chapter_no: number; title: string; content_md: string;
  review_status: string; index_status: string;
}

export function ChapterDetail({ docId, chapters, onExit }: {
  docId: string; chapters: ChapterSummary[]; onExit: () => void;
}) {
  const [selected, setSelected] = useState(chapters[0]?.id ?? "");
  const current = chapters.find((c) => c.id === selected);
  return (
    <div className="chapter-detail">
      <button className="ghost" onClick={onExit}>← 返回列表</button>
      <div className="cd-body">
        <nav className="cd-toc">
          {chapters.map((c) => (
            <button key={c.id} className={c.id === selected ? "active" : ""}
                    onClick={() => setSelected(c.id)}>
              {c.title}
              <span className={`badge idx-${c.index_status}`}>
                {c.index_status === "indexed" ? "已索引" : c.index_status === "stale" ? "索引已过期" : "未索引"}
              </span>
            </button>
          ))}
        </nav>
        <div className="cd-content">
          {current && <pre>{current.content_md}</pre>}
        </div>
      </div>
    </div>
  );
}
