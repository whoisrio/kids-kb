import { useCallback, useEffect, useState } from "react";
import {
  approveLibraryDoc, fetchLibraryDoc, fetchLibraryChunks, reindexLibraryUnit, setPageExclusion,
  type LibraryChunk, type LibraryDetail as LibraryDetailData, type Pagination,
} from "../api/library";

const AUTO_LABELS: Record<string, string> = {
  pending: "自动未审核", passed: "自动通过", needs_review: "自动需复核", failed: "自动失败",
};
const MANUAL_LABELS: Record<string, string> = {
  unreviewed: "人工未处理", approved: "人工通过", rejected: "人工打回",
};
const INDEX_LABELS: Record<string, string> = {
  not_indexed: "未索引", indexed: "已索引", stale: "索引过期",
};

export function StatusBadge({ kind, value }: { kind: "auto" | "manual" | "index"; value: string }) {
  const labels = kind === "auto" ? AUTO_LABELS : kind === "manual" ? MANUAL_LABELS : INDEX_LABELS;
  return <span className={`badge ${kind}-${value}`}>{labels[value] ?? value}</span>;
}

export function Pager({ pagination, onPage }: { pagination: Pagination; onPage: (page: number) => void }) {
  return (
    <div className="ledger-pager">
      <button disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}>← 上一页</button>
      <span>第 {pagination.page} / {Math.max(1, pagination.totalPages)} 页 · 共 {pagination.total} 条</span>
      <button disabled={pagination.page >= pagination.totalPages} onClick={() => onPage(pagination.page + 1)}>下一页 →</button>
    </div>
  );
}

export function IndexLedger({ docId, fetchImpl = fetch }: {
  docId: string; fetchImpl?: typeof fetch;
}) {
  const [chunks, setChunks] = useState<LibraryChunk[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 10, total: 0, totalPages: 0 });
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  const reload = useCallback(async () => {
    try {
      const data = await fetchLibraryChunks(docId, { page, pageSize: 10 }, fetchImpl);
      setChunks(data.chunks);
      setPagination(data.pagination);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [docId, page, fetchImpl]);
  useEffect(() => { void reload(); }, [reload]);

  return (
    <div className="index-ledger">
      {error && <div className="form-error" role="alert">{error}</div>}
      {chunks.length === 0 && <p className="ledger-empty">还没有 chunk。通过复核后触发索引即可生成。</p>}
      <ol className="chunk-line">
        {chunks.map((chunk) => (
          <li key={chunk.id}>
            <span className="chunk-no">{String(chunk.seq).padStart(2, "0")}</span>
            <span className="chunk-source">P{chunk.page_no ?? "?"} / B{chunk.source_block_ids.length || "整页"}</span>
            <span className="chunk-text">{chunk.content_preview || "（空）"}</span>
          </li>
        ))}
      </ol>
      <Pager pagination={pagination} onPage={setPage} />
    </div>
  );
}

export function LibraryDetail({ docId, fetchImpl = fetch, onExit, onError }: {
  docId: string; fetchImpl?: typeof fetch; onExit: () => void; onError: (error: string) => void;
}) {
  const [data, setData] = useState<LibraryDetailData | null>(null);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<"table" | "thumbnails" | "chunks">("table");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try { setData(await fetchLibraryDoc(docId, { page, pageSize: 10 }, fetchImpl)); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  }, [docId, page, fetchImpl, onError]);
  useEffect(() => { void reload(); }, [reload]);

  const toggleExcluded = async (pageId: string, excluded: boolean) => {
    setBusy(true);
    try { await setPageExclusion(pageId, excluded, fetchImpl); await reload(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const reindexPage = async (pageId: string) => {
    if (!data) return;
    setBusy(true);
    try { await reindexLibraryUnit(data.id, "page", pageId, fetchImpl); await reload(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const approveDoc = async () => {
    if (!data) return;
    setBusy(true);
    try { await approveLibraryDoc(data.id, fetchImpl); await reload(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="library-detail"><div className="chat-empty">加载中…</div></div>;
  return (
    <div className="library-detail">
      <div className="ledger-head">
        <button className="btn-ghost" onClick={onExit}>← 资料库</button>
        <h2>{data.title}</h2>
        <span className="ledger-meta">
          {data.file_type.toUpperCase()} · {data.total_units} 单元
        </span>
        <span className="ledger-stats">
          自动 {data.aggregates.auto_review.passed}/{data.total_units} ·
          人工 {data.aggregates.manual_review.approved}/{data.total_units} ·
          索引 {data.aggregates.index.indexed}/{data.total_units} ·
          排除 {data.aggregates.index.excluded}
        </span>
        <button className="btn-primary" disabled={busy} onClick={() => void approveDoc()}>
          {busy ? "入库中…" : "整本入库"}
        </button>
      </div>
      <div className="detail-tabs">
        <button className={view === "table" ? "btn-primary" : "btn-ghost"} onClick={() => setView("table")}>页面表</button>
        <button className={view === "thumbnails" ? "btn-primary" : "btn-ghost"} onClick={() => setView("thumbnails")}>缩略图</button>
        <button className={view === "chunks" ? "btn-primary" : "btn-ghost"} onClick={() => setView("chunks")}>索引账页</button>
      </div>
      {view === "chunks" && <IndexLedger docId={data.id} fetchImpl={fetchImpl} />}
      {view !== "chunks" && (
        <div className={view === "table" ? "page-table" : "page-cards"}>
          {view === "table" ? (
            <table>
              <thead><tr><th>页</th><th>自动审核</th><th>人工复核</th><th>索引</th><th>块/段</th><th>排除</th><th>操作</th></tr></thead>
              <tbody>
                {data.pages?.map((item) => (
                  <tr key={item.id} className={item.excluded_from_index ? "excluded" : ""}>
                    <td>{item.page_no}</td>
                    <td><StatusBadge kind="auto" value={item.excluded_from_index ? "pending" : item.auto_review_status} /></td>
                    <td><StatusBadge kind="manual" value={item.excluded_from_index ? "unreviewed" : item.manual_review_status} /></td>
                    <td>
                      {item.excluded_from_index
                        ? <span className="badge excluded">已排除</span>
                        : <StatusBadge kind="index" value={item.index_status} />}
                    </td>
                    <td className="mono">{item.block_count} / {item.chunk_count}</td>
                    <td>
                      <label className="switch-label">
                      <input type="checkbox" checked={item.excluded_from_index} disabled={busy}
                             aria-label={`排除 第 ${item.page_no} 页`}
                               onChange={(e) => void toggleExcluded(item.id, e.target.checked)} />
                        {item.excluded_from_index ? "恢复" : "排除"}
                      </label>
                    </td>
                    <td>
                      <button className="btn-ghost" disabled={busy || item.excluded_from_index}
                              onClick={() => void reindexPage(item.id)}>重建</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : data.pages?.map((item) => (
            <div key={item.id} className={`page-card${item.excluded_from_index ? " excluded" : ""}`}>
              <img src={item.thumbnail_url} alt={`第 ${item.page_no} 页`} loading="lazy" />
              <div className="meta">
                <span>第 {item.page_no} 页</span>
                <StatusBadge kind="index" value={item.excluded_from_index ? "not_indexed" : item.index_status} />
                <span>{item.chunk_count} 段</span>
              </div>
            </div>
          ))}
          {data.chapters?.map((chapter) => (
            <div key={chapter.id} className="chapter-row">
              <span className="chapter-no">{chapter.chapter_no}</span>
              <strong>{chapter.title}</strong>
              <StatusBadge kind="auto" value={chapter.auto_review_status} />
              <StatusBadge kind="manual" value={chapter.manual_review_status} />
              <StatusBadge kind="index" value={chapter.index_status} />
              <span className="mono">{chapter.chunk_count} 段</span>
            </div>
          ))}
        </div>
      )}
      <Pager pagination={data.pagination} onPage={setPage} />
    </div>
  );
}
