import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

export interface ChapterSummary {
  id: string; chapter_no: number; title: string; content_md: string;
  review_status: string; index_status: string;
}

export function ChapterDetail({ chapters, onExit }: {
  docId?: string; chapters: ChapterSummary[]; onExit: () => void;
}) {
  const [selected, setSelected] = useState(chapters[0]?.id ?? "");
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const currentDoc = chapters.find((c) => c.id === selected);
  return (
    <div className="chapter-detail">
      <button className="ghost" onClick={onExit}>← 返回列表</button>
      <div className="cd-toolbar">
        <button className={view === "rendered" ? "primary" : "ghost"} onClick={() => setView("rendered")}>Markdown 渲染</button>
        <button className={view === "raw" ? "primary" : "ghost"} onClick={() => setView("raw")}>原始 Markdown</button>
      </div>
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
          {currentDoc && view === "rendered" && (
            <div className="md">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                {currentDoc.content_md}
              </ReactMarkdown>
            </div>
          )}
          {currentDoc && view === "raw" && <pre>{currentDoc.content_md}</pre>}
        </div>
      </div>
    </div>
  );
}
