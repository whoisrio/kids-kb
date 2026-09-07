import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchLibraryDocs, type LibraryDoc, type Pagination } from "../api/library";
import { LibraryDetail } from "../components/LibraryDetail";

const STATUS_TEXT: Record<string, string> = {
  pending: "未审核", passed: "已通过", needs_review: "需复核", failed: "失败",
  unreviewed: "未处理", approved: "通过", rejected: "打回",
  indexed: "已索引", partial: "部分索引", stale: "已过期",
  not_indexed: "未索引", excluded: "有排除页",
};

function queryValue(query: string, name: string) {
  return new URLSearchParams(query).get(name) ?? "";
}

export function LibraryView({ fetchImpl = fetch, onOpenDoc }: {
  fetchImpl?: typeof fetch; onOpenDoc?: (doc: LibraryDoc) => void;
}) {
  const initialQuery = typeof window === "undefined" ? "" : window.location.search.replace(/^\?/, "");
  const [filters, setFilters] = useState({
    q: queryValue(initialQuery, "q"),
    subject: queryValue(initialQuery, "subject"),
    fileType: queryValue(initialQuery, "file_type"),
    autoReview: queryValue(initialQuery, "auto_review"),
    reviewStatus: queryValue(initialQuery, "review_status"),
    indexStatus: queryValue(initialQuery, "index_status"),
    page: Number(queryValue(initialQuery, "page")) || 1,
  });
  const [searchDraft, setSearchDraft] = useState(filters.q);
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const [error, setError] = useState("");
  const [openDocId, setOpenDocId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((current) => current.q === searchDraft ? current : { ...current, q: searchDraft, page: 1 });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  const reload = useCallback(async () => {
    const query = new URLSearchParams({
      page: String(filters.page), pageSize: "20",
      q: filters.q, subject: filters.subject, file_type: filters.fileType,
      auto_review: filters.autoReview, review_status: filters.reviewStatus,
      index_status: filters.indexStatus,
    });
    for (const [key, value] of [...query.entries()]) if (!value) query.delete(key);
    try {
      const data = await fetchLibraryDocs({
        page: filters.page, pageSize: 20, q: filters.q,
        subject: filters.subject, fileType: filters.fileType,
        autoReview: filters.autoReview, reviewStatus: filters.reviewStatus,
        indexStatus: filters.indexStatus,
      }, fetchImpl);
      setDocs(data.documents);
      setPagination(data.pagination);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [filters, fetchImpl]);
  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const query = new URLSearchParams(
        Object.entries(filters).filter(([, value]) => String(value)).map(([key, value]) => [key, String(value)]),
      );
      window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
    }
  }, [filters]);

  const subjects = useMemo(
    () => [...new Set(docs.map((doc) => doc.subject).filter((subject): subject is string => Boolean(subject)))],
    [docs],
  );

  if (openDocId) {
    return <LibraryDetail docId={openDocId} fetchImpl={fetchImpl} onError={setError}
      onExit={() => { setOpenDocId(null); void reload(); }} />;
  }

  const update = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, page: 1, ...patch }));

  return (
    <div className="library">
      <div className="ledger-head">
        <div>
          <h2>资料库</h2>
          <span className="ledger-meta">{pagination.total} 份资料</span>
        </div>
        <div className="view-toggle" role="group" aria-label="呈现方式">
          <button className={viewMode === "table" ? "primary" : "ghost"} onClick={() => setViewMode("table")}>表格</button>
          <button className={viewMode === "cards" ? "primary" : "ghost"} onClick={() => setViewMode("cards")}>卡片</button>
        </div>
      </div>
      <div className="library-toolbar">
        <input aria-label="搜索书名" placeholder="搜索书名" value={searchDraft}
               onChange={(e) => setSearchDraft(e.target.value)} />
        <select aria-label="科目" value={filters.subject} onChange={(e) => update({ subject: e.target.value })}>
          <option value="">全部科目</option>
          {subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
        </select>
        <select aria-label="文件类型" value={filters.fileType} onChange={(e) => update({ fileType: e.target.value })}>
          <option value="">全部类型</option><option value="pdf">PDF</option>
          <option value="docx">DOCX</option><option value="md">Markdown</option>
        </select>
        <select aria-label="自动审核" value={filters.autoReview} onChange={(e) => update({ autoReview: e.target.value })}>
          <option value="">自动审核</option>
          {["pending", "passed", "needs_review", "failed"].map((value) => (
            <option key={value} value={value}>{STATUS_TEXT[value]}</option>
          ))}
        </select>
        <select aria-label="人工复核" value={filters.reviewStatus} onChange={(e) => update({ reviewStatus: e.target.value })}>
          <option value="">人工复核</option>
          {["unreviewed", "approved", "rejected"].map((value) => (
            <option key={value} value={value}>{STATUS_TEXT[value]}</option>
          ))}
        </select>
        <select aria-label="索引状态" value={filters.indexStatus} onChange={(e) => update({ indexStatus: e.target.value })}>
          <option value="">索引状态</option>
          {["indexed", "partial", "stale", "not_indexed", "excluded"].map((value) => (
            <option key={value} value={value}>{STATUS_TEXT[value]}</option>
          ))}
        </select>
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      {viewMode === "table" ? (
        <div className="library-table">
          <table>
            <thead>
              <tr><th>资料</th><th>类型</th><th>自动审核</th><th>人工复核</th><th>索引</th><th>操作</th></tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id}>
                  <td>
                    <button className="doc-title" onClick={() => { setOpenDocId(doc.id); onOpenDoc?.(doc); }}>
                      {doc.title}
                    </button>
                    <span className="mono">{doc.total_units} 单元 · {new Date(doc.created_at).toLocaleDateString()}</span>
                  </td>
                  <td>{doc.subject ?? "未分类"} · {doc.file_type.toUpperCase()}</td>
                  <td>
                    <span className="badge auto-passed">{doc.auto_review.passed} 通过</span>
                    {(doc.auto_review.needs_review || doc.auto_review.failed || doc.auto_review.pending) > 0 && (
                      <span className="badge auto-pending">{doc.auto_review.pending + doc.auto_review.needs_review + doc.auto_review.failed} 待处理</span>
                    )}
                  </td>
                  <td>
                    <span className="badge manual-approved">{doc.manual_review.approved} 通过</span>
                    <span className="badge manual-unreviewed">{doc.manual_review.unreviewed} 未处理</span>
                  </td>
                  <td>
                    <span className="badge index-indexed">{doc.index.indexed} 已索引</span>
                    {doc.index.stale > 0 && <span className="badge index-stale">{doc.index.stale} 过期</span>}
                    {doc.index.excluded > 0 && <span className="badge excluded">{doc.index.excluded} 排除</span>}
                  </td>
                  <td><button className="ghost" onClick={() => setOpenDocId(doc.id)}>查看</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="page-cards">
          {docs.map((doc) => (
            <button key={doc.id} className="lib-card" onClick={() => setOpenDocId(doc.id)}>
              <span className="title">{doc.title}</span>
              <span className="meta">{doc.subject ?? "未分类"} · {doc.file_type.toUpperCase()}</span>
              <span className="mono">索引 {doc.index.indexed}/{doc.total_units}</span>
            </button>
          ))}
        </div>
      )}
      {docs.length === 0 && !error && (
        <div className="chat-empty">没有匹配的资料，试试清除索引或科目筛选。</div>
      )}
      <div className="ledger-pager">
        <button disabled={pagination.page <= 1}
                onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}>← 上一页</button>
        <span>第 {pagination.page} / {Math.max(1, pagination.totalPages)} 页</span>
        <button disabled={pagination.page >= pagination.totalPages}
                onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}>下一页 →</button>
      </div>
    </div>
  );
}
