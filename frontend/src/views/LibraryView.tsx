import { useCallback, useEffect, useState } from "react";
import { deleteLibraryDoc, fetchLibraryDocs, type LibraryDoc } from "../api/library";
import { fetchLibraryDoc } from "../api/library";
import { PageDetail } from "../components/PageDetail";
import { ChapterDetail, type ChapterSummary } from "./ChapterDetail";

export function LibraryView({ fetchImpl = fetch, onOpenDoc }: {
  fetchImpl?: typeof fetch; onOpenDoc?: (doc: LibraryDoc) => void;
}) {
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<{ file_type: string; pages?: { id: string; page_no: number; review_status: string; index_status: string }[]; chapters?: ChapterSummary[] } | null>(null);
  const [openPageId, setOpenPageId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setDocs(await fetchLibraryDocs(fetchImpl));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [fetchImpl]);
  useEffect(() => { void reload(); }, [reload]);

  const doDelete = async (id: string) => {
    try {
      await deleteLibraryDoc(id, fetchImpl);
      setConfirmDelete(null);
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const subjects = [...new Set(docs.map((d) => d.subject ?? "未分类"))];

  const openDetail = async (doc: LibraryDoc) => {
    setOpenDocId(doc.id);
    try {
      const detail = await fetchLibraryDoc(doc.id, fetchImpl);
      setOpenDoc(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (openPageId) {
    return (
      <PageDetail
        pageId={openPageId}
        fetchImpl={fetchImpl}
        onExit={() => { setOpenPageId(null); void reload(); }}
        onError={setError}
      />
    );
  }

  if (openDocId) {
    return (
      <div className="library-detail">
        <button className="ghost" onClick={() => { setOpenDocId(null); setOpenDoc(null); void reload(); }}>← 返回列表</button>
        {openDoc?.file_type === "pdf" && (
          <div className="page-cards">
            {openDoc.pages?.map((p) => (
              <button key={p.id} className="page-card" onClick={() => setOpenPageId(p.id)}>
                <img src={`/api/review/pages/${p.id}/image`} alt={`第 ${p.page_no} 页`} loading="lazy" />
                <div className="meta">
                  <span className="doc">第 {p.page_no} 页</span>
                  <span className={`badge review-${p.review_status}`}>{p.review_status}</span>
                  {p.index_status === "stale" && <span className="badge stale">索引过期</span>}
                </div>
              </button>
            ))}
          </div>
        )}
        {openDoc && openDoc.file_type !== "pdf" && (
          <ChapterDetail docId={openDocId} chapters={openDoc.chapters ?? []} onExit={() => { setOpenDocId(null); setOpenDoc(null); void reload(); }} />
        )}
      </div>
    );
  }
  return (
    <div className="library">
      {error && <div className="form-error" role="alert">{error}</div>}
      {subjects.map((subject) => (
        <section key={subject}>
          <h2>{subject}</h2>
          {docs.filter((d) => (d.subject ?? "未分类") === subject).map((d) => (
            <div key={d.id} className="lib-card" onClick={() => void openDetail(d)}>
              <span className="title">{d.title}</span>
              <span className="meta">{d.file_type} · {d.parse_status}</span>
              <span className={`badge review-${d.review_status}`}>{d.review_status}</span>
              <span>{d.pending_pages > 0 ? `待复核 ${d.pending_pages} 页` : ""}</span>
              <button className="danger" onClick={(e) => {
                e.stopPropagation(); setConfirmDelete(d.id);
              }}>删除</button>
            </div>
          ))}
        </section>
      ))}
      {confirmDelete && (
        <div className="dialog-mask" role="dialog">
          <p>删除这份资料？删除后不可恢复。</p>
          <button className="danger" onClick={() => void doDelete(confirmDelete)}>确认删除</button>
          <button className="ghost" onClick={() => setConfirmDelete(null)}>取消</button>
        </div>
      )}
    </div>
  );
}
