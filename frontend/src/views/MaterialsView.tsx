import { useCallback, useEffect, useState } from "react";
import {
  fetchReviewDocs, fetchReviewItems, fetchReviewPages, fetchReviewItem,
  fetchReviewChapters, reviewSearch, type ReviewChapter, type ReviewDoc, type ReviewItemDetail, type ReviewItemSummary,
  type ReviewPageSummary, type ReviewSearchHit,
} from "../api/review";
import { ItemDetail } from "../components/ItemDetail";
import { PageDetail } from "../components/PageDetail";

type Block = "pending" | "approved" | "chapters" | "items" | "search";

const BLOCKS: [Block, string][] = [
  ["pending", "待复核页"], ["approved", "已通过页"], ["chapters", "章节"], ["items", "条目"], ["search", "试搜"],
];

/** 资料 tab：文档下拉（待复核徽标）+ 四块（对应旧静态页）。initialDocId 用于外部跳入时预选文档。 */
export function MaterialsView({ fetchImpl = fetch, initialDocId }: { fetchImpl?: typeof fetch; initialDocId?: string }) {
  const [docs, setDocs] = useState<ReviewDoc[]>([]);
  const [docId, setDocId] = useState(initialDocId ?? "");
  const [block, setBlock] = useState<Block>("pending");
  const [pages, setPages] = useState<ReviewPageSummary[]>([]);
  const [chapters, setChapters] = useState<ReviewChapter[]>([]);
  const [items, setItems] = useState<ReviewItemSummary[]>([]);
  const [pageId, setPageId] = useState<string | null>(null);
  const [item, setItem] = useState<ReviewItemDetail | null>(null);
  const [q, setQ] = useState("");
  const [subject, setSubject] = useState("");
  const [hits, setHits] = useState<ReviewSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reloadDocs = useCallback(async () => {
    try { setDocs(await fetchReviewDocs(fetchImpl)); } catch (e) { console.error(e); }
  }, [fetchImpl]);

  const reloadBlock = useCallback(async () => {
    setError("");
    try {
      if (block === "pending" || block === "approved") {
        setPages((await fetchReviewPages(docId || undefined, block, fetchImpl)).pages);
      } else if (block === "chapters") {
        setChapters((await fetchReviewChapters(docId || undefined, fetchImpl)).chapters);
      } else if (block === "items") {
        setItems((await fetchReviewItems(docId || undefined, "pending", fetchImpl)).items);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [block, docId, fetchImpl]);

  useEffect(() => { void reloadDocs(); }, [reloadDocs]);
  useEffect(() => { void reloadBlock(); }, [reloadBlock]);

  const openItem = async (id: string) => {
    try { setItem(await fetchReviewItem(id, fetchImpl)); } catch (e) { console.error(e); }
  };

  const doSearch = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    try { setHits((await reviewSearch(q.trim(), subject || undefined, fetchImpl)).hits); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="materials">
      <div className="mat-toolbar">
        <select aria-label="选择文档" value={docId} onChange={(e) => setDocId(e.target.value)}>
          <option value="">全部文档</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}{d.pending_pages > 0 ? `（待复核 ${d.pending_pages} 页）` : ""}
            </option>
          ))}
        </select>
        <div className="mat-blocks">
          {BLOCKS.map(([b, label]) => (
            <button key={b} className={block === b ? "active" : ""} onClick={() => { setBlock(b); setHits(null); }}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}

      {pageId && (
        <PageDetail
          pageId={pageId}
          fetchImpl={fetchImpl}
          onExit={() => { setPageId(null); void reloadBlock(); void reloadDocs(); }}
          onError={setError}
        />
      )}
      {item && (
        <ItemDetail
          item={item}
          onReload={async () => { await openItem(item.id); void reloadBlock(); void reloadDocs(); }}
          onExit={() => { setItem(null); void reloadBlock(); void reloadDocs(); }}
          onError={setError}
          fetchImpl={fetchImpl}
        />
      )}

      {!pageId && !item && (block === "pending" || block === "approved") && (
        <div className="page-cards">
          {pages.length === 0 && (
            <div className="chat-empty">{block === "pending" ? "没有待复核页" : "没有已通过页"}</div>
          )}
          {pages.map((p) => (
            <button key={p.id} className="page-card" onClick={() => setPageId(p.id)}>
              <img src={`/api/review/pages/${p.id}/image`} alt={`第 ${p.page_no} 页`} loading="lazy" />
              <div className="meta">
                <span className="doc">{p.doc_title} · 第 {p.page_no} 页</span>
                {p.pending_reasons.map((r) => <span key={r} className="badge">{r}</span>)}
              </div>
            </button>
          ))}
        </div>
      )}

      {!pageId && !item && block === "items" && (
        <div className="item-rows">
          {items.length === 0 && <div className="chat-empty">没有待复核条目</div>}
          {items.map((it) => (
            <button key={it.id} className="item-row" onClick={() => void openItem(it.id)}>
              <span className="label">{it.label ?? it.content_type}</span>
              <span className="chap">{it.doc_title} · {it.chapter ?? "-"}</span>
              <span className="content">{(it.content_md ?? "").slice(0, 60)}</span>
              {it.pending_reasons.map((r) => <span key={r} className="badge">{r.slice(0, 40)}</span>)}
            </button>
          ))}
        </div>
      )}

      {!pageId && !item && block === "chapters" && (
        <div className="item-rows">
          {chapters.length === 0 && <div className="chat-empty">没有章节内容</div>}
          {chapters.map((chapter) => (
            <div key={chapter.id} className="item-row">
              <span className="label">{chapter.title}</span>
              <span className="chap">{chapter.doc_title} · 第 {chapter.chapter_no} 章</span>
              <span className="content">{(chapter.content_md ?? "").slice(0, 160)}</span>
            </div>
          ))}
        </div>
      )}

      {!pageId && !item && block === "search" && (
        <div className="mat-search">
          <input placeholder="语义检索，如：除法竖式谜 倒推法" value={q}
                 onChange={(e) => setQ(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") void doSearch(); }} />
          <select aria-label="科目" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">全部科目</option>
            {["语文", "数学", "英语"].map((s) => <option key={s}>{s}</option>)}
          </select>
          <button className="btn-primary" onClick={() => void doSearch()} disabled={busy || !q.trim()}>检索</button>
          {hits && (hits.length === 0
            ? <div className="chat-empty">没有命中</div>
            : <ul className="hits">
                {hits.map((h, i) => (
                  <li key={h.item_id ?? h.chapter_id ?? i}>
                    <span className="src">《{h.doc_title}》{h.chapter ?? ""}{h.label ? ` · ${h.label}` : ""}</span>
                    <p>{h.content_md.slice(0, 120)}</p>
                  </li>
                ))}
              </ul>)}
        </div>
      )}
    </div>
  );
}
