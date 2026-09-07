import { useCallback, useEffect, useMemo, useState } from "react";
import {
  approveLibraryDoc, deleteLibraryDoc, fetchLibraryDocs, fetchLibrarySummary,
  type LibraryDoc, type LibrarySummary, type Pagination,
} from "../api/library";
import { Icon } from "../components/Icon";
import { LibraryDetail } from "../components/LibraryDetail";
import { UploadDialog } from "../components/UploadDialog";

const STATUS_TEXT: Record<string, string> = {
  pending: "未审核", passed: "已通过", needs_review: "需复核", failed: "失败",
  unreviewed: "未处理", approved: "通过", rejected: "打回",
  indexed: "已索引", partial: "部分索引", stale: "已过期",
  not_indexed: "未索引", excluded: "有排除页",
};

const DOC_TYPE_TEXT: Record<string, string> = { workbook: "同步教辅", exam: "试卷" };
const DOC_TYPE_TABS: [string, string][] = [["", "全部资料"], ["workbook", "同步教辅"], ["exam", "试卷"]];

const URL_KEYS: Record<string, string> = {
  q: "q", subject: "subject", fileType: "file_type", docType: "doc_type",
  autoReview: "auto_review", reviewStatus: "review_status", indexStatus: "index_status", page: "page",
};

function queryValue(query: string, name: string) {
  return new URLSearchParams(query).get(name) ?? "";
}

/** 科目 → 封面兜底色块/徽章的图标与配色（数学=蓝、语文=indigo、英语=sky）。 */
function subjectMeta(subject: string | null): { cls: string; icon: string } {
  if (subject === "数学") return { cls: "subj-math", icon: "calculate" };
  if (subject === "语文") return { cls: "subj-chinese", icon: "auto_stories" };
  if (subject === "英语") return { cls: "subj-english", icon: "translate" };
  return { cls: "subj-other", icon: "menu_book" };
}

function ShelfCard({ doc, onOpen, onReview, onDelete, onApprove, approving }: {
  doc: LibraryDoc; onOpen: (doc: LibraryDoc) => void;
  onReview?: (doc: LibraryDoc) => void; onDelete: (doc: LibraryDoc) => void;
  onApprove: (doc: LibraryDoc) => void; approving: boolean;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const subj = subjectMeta(doc.subject);
  const pending = doc.auto_review.needs_review + doc.auto_review.pending;
  return (
    <div className={`shelf-card${pending > 0 ? " has-pending" : ""}`}>
      <div className="sc-badges">
        <div className="sc-tags">
          <span className={`sc-subj ${subj.cls}`}>
            <Icon name={subj.icon} />{doc.subject ?? "未分类"}
          </span>
          {doc.doc_type && <span className="sc-type">{DOC_TYPE_TEXT[doc.doc_type] ?? doc.doc_type}</span>}
        </div>
        {pending > 0 ? (
          <span className="sc-status pending"><Icon name="report_problem" />{pending} 页待确认</span>
        ) : (
          <span className="sc-status ok"><span className="sc-dot" />全部就绪</span>
        )}
      </div>
      <div className="sc-main">
        <div className={`sc-cover ${subj.cls}`}>
          {doc.cover_url && !coverFailed ? (
            <img src={doc.cover_url} alt={`《${doc.title}》封面`} loading="lazy"
                 onError={() => setCoverFailed(true)} />
          ) : (
            <Icon name={subj.icon} />
          )}
          <span className="sc-pages">
            {doc.total_pages > 0 ? `${doc.total_pages}页` : `${doc.total_chapters}章`}
          </span>
        </div>
        <div className="sc-info">
          <button className="sc-title" onClick={() => onOpen(doc)}>{doc.title}</button>
          <span className="sc-meta">
            {doc.file_type.toUpperCase()} · {new Date(doc.created_at).toLocaleDateString()}
          </span>
          <span className="sc-stats"><b>{doc.index.indexed}</b> / {doc.total_units} 单元已索引</span>
        </div>
      </div>
      <div className="sc-actions">
        <button className="btn-soft grow" onClick={() => onOpen(doc)}>
          <Icon name="list_alt" />查看清单
        </button>
        {pending > 0 && (
          <button className="btn-accent grow" onClick={() => (onReview ?? onOpen)(doc)}>
            <Icon name="fact_check" />前往复核 ({pending})
          </button>
        )}
        <div className="sc-more">
          <button className="btn-ghost" aria-label={`更多操作 ${doc.title}`}
                  onClick={() => setMenuOpen((open) => !open)}>
            <Icon name="more_horiz" />
          </button>
          {menuOpen && (
            <div className="sc-menu">
              <button disabled={approving}
                      onClick={() => { setMenuOpen(false); onApprove(doc); }}>
                <Icon name="playlist_add_check" />{approving ? "入库中…" : "整本入库"}
              </button>
              <button className="danger" onClick={() => { setMenuOpen(false); onDelete(doc); }}>
                <Icon name="delete" />删除资料
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function LibraryView({ fetchImpl = fetch, onOpenDoc, onOpenReview, kids = [] }: {
  fetchImpl?: typeof fetch;
  onOpenDoc?: (doc: LibraryDoc) => void;
  onOpenReview?: (docId: string) => void;
  kids?: { id: string; name: string }[];
}) {
  const initialQuery = typeof window === "undefined" ? "" : window.location.search.replace(/^\?/, "");
  const [filters, setFilters] = useState({
    q: queryValue(initialQuery, "q"),
    subject: queryValue(initialQuery, "subject"),
    fileType: queryValue(initialQuery, "file_type"),
    docType: queryValue(initialQuery, "doc_type"),
    autoReview: queryValue(initialQuery, "auto_review"),
    reviewStatus: queryValue(initialQuery, "review_status"),
    indexStatus: queryValue(initialQuery, "index_status"),
    page: Number(queryValue(initialQuery, "page")) || 1,
  });
  const [searchDraft, setSearchDraft] = useState(filters.q);
  const [sort, setSort] = useState<"updated" | "name" | "units">("updated");
  const [viewMode, setViewMode] = useState<"cards" | "table">("cards");
  const [docs, setDocs] = useState<LibraryDoc[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 0 });
  const [summary, setSummary] = useState<LibrarySummary | null>(null);
  const [error, setError] = useState("");
  const [openDocId, setOpenDocId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<LibraryDoc | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters((current) => current.q === searchDraft ? current : { ...current, q: searchDraft, page: 1 });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchDraft]);

  const reload = useCallback(async () => {
    try {
      const data = await fetchLibraryDocs({
        page: filters.page, pageSize: 20, q: filters.q,
        subject: filters.subject, fileType: filters.fileType, docType: filters.docType,
        autoReview: filters.autoReview, reviewStatus: filters.reviewStatus,
        indexStatus: filters.indexStatus, sort,
      }, fetchImpl);
      setDocs(data.documents);
      setPagination(data.pagination);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [filters, sort, fetchImpl]);
  useEffect(() => { void reload(); }, [reload]);

  // 后端未提供 summary（旧版本）时指标卡降级为「—」，不阻塞列表
  const reloadSummary = useCallback(async () => {
    try { setSummary(await fetchLibrarySummary(fetchImpl)); } catch { /* 忽略 */ }
  }, [fetchImpl]);
  useEffect(() => { void reloadSummary(); }, [reloadSummary]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (String(value)) query.set(URL_KEYS[key] ?? key, String(value));
      }
      window.history.replaceState(null, "", `${window.location.pathname}?${query}`);
    }
  }, [filters]);

  const subjects = useMemo(
    () => [...new Set(docs.map((doc) => doc.subject).filter((subject): subject is string => Boolean(subject)))],
    [docs],
  );

  // 类型 tab 计数来自 summary.by_doc_type（全量统计，不随筛选/分页变化）
  const docTypeCount = (value: string): number | null => {
    if (!summary?.by_doc_type) return null;
    if (!value) return summary.total_docs;
    return summary.by_doc_type.find((entry) => entry.doc_type === value)?.count ?? 0;
  };

  if (openDocId) {
    return <LibraryDetail docId={openDocId} fetchImpl={fetchImpl} onError={setError}
      onExit={() => { setOpenDocId(null); void reload(); void reloadSummary(); }} />;
  }

  const update = (patch: Partial<typeof filters>) => setFilters((current) => ({ ...current, page: 1, ...patch }));

  const openDoc = (doc: LibraryDoc) => { setOpenDocId(doc.id); onOpenDoc?.(doc); };

  const doDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteLibraryDoc(confirmDelete.id, fetchImpl);
      setConfirmDelete(null);
      void reload();
      void reloadSummary();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConfirmDelete(null);
    }
  };

  const doApprove = async (doc: LibraryDoc) => {
    setApprovingId(doc.id);
    try {
      await approveLibraryDoc(doc.id, fetchImpl);
      void reload();
      void reloadSummary();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApprovingId(null);
    }
  };

  return (
    <div className="library">
      <header className="lib-head">
        <div className="lib-head-text">
          <nav className="crumbs" aria-label="面包屑">
            <span>知库工作台</span>
            <Icon name="chevron_right" />
            <span className="cur">资料库</span>
          </nav>
          <h1>数字书架与资料库</h1>
          <p className="lib-desc">
            收录孩子日常练习、单元测试与错题笔记，已智能梳理考点章节并生成专属数字资料库。
          </p>
        </div>
        <button className="btn-primary" onClick={() => setUploadOpen(true)}>
          <Icon name="add_photo_alternate" />上传新教辅 / 试卷
        </button>
      </header>

      <div className="metric-cards">
        <div className="metric-card">
          <div>
            <span className="mc-label">在库资料</span>
            <span className="mc-num">{summary ? summary.total_docs : "—"}
              <span className="mc-unit">本 / 套</span>
            </span>
            {summary && summary.by_subject.length > 0 && (
              <span className="mc-sub">
                {summary.by_subject.map((s) => `${s.subject ?? "未分类"} ${s.count}`).join(" · ")}
              </span>
            )}
          </div>
          <div className="mc-icon blue"><Icon name="library_books" /></div>
        </div>
        <div className="metric-card">
          <div>
            <span className="mc-label">已索引单元</span>
            <span className="mc-num">{summary ? summary.indexed_units.toLocaleString("zh-CN") : "—"}
              <span className="mc-unit">个</span>
            </span>
            <span className="mc-sub">
              <Icon name="verified" size={14} />聊天检索可用的题目与章节
            </span>
          </div>
          <div className="mc-icon green"><Icon name="quiz" /></div>
        </div>
        <button className="metric-card warn" onClick={() => update({ autoReview: "needs_review" })}>
          <div>
            <span className="mc-label">待复核页</span>
            <span className="mc-num">{summary ? summary.pending_review_pages : "—"}
              <span className="mc-unit">页需核对</span>
            </span>
            <span className="mc-sub">
              点击筛选需复核资料<Icon name="arrow_forward" size={14} />
            </span>
          </div>
          <div className="mc-icon amber"><Icon name="pending_actions" /></div>
        </button>
      </div>

      <div className="lib-filterbar">
        <div className="lib-tabs" role="group" aria-label="资料类型">
          {DOC_TYPE_TABS.map(([value, label]) => {
            const count = docTypeCount(value);
            return (
              <button key={value} className={filters.docType === value ? "active" : ""}
                      onClick={() => update({ docType: value })}>
                {label}{count !== null ? ` (${count})` : ""}
              </button>
            );
          })}
        </div>
        <div className="lib-filter-right">
          <select aria-label="科目" value={filters.subject} onChange={(e) => update({ subject: e.target.value })}>
            <option value="">全部科目</option>
            {subjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
          </select>
          <select aria-label="排序" value={sort}
                  onChange={(e) => setSort(e.target.value as "updated" | "name" | "units")}>
            <option value="updated">最新更新</option>
            <option value="name">资料名称</option>
            <option value="units">单元最多</option>
          </select>
          <div className="seg" role="group" aria-label="呈现方式">
            <button className={viewMode === "cards" ? "active" : ""} onClick={() => setViewMode("cards")}>
              <Icon name="grid_view" />书架视图
            </button>
            <button className={viewMode === "table" ? "active" : ""} onClick={() => setViewMode("table")}>
              <Icon name="table_chart" />明细表格
            </button>
          </div>
        </div>
      </div>

      <div className="library-toolbar">
        <input aria-label="搜索书名" placeholder="搜索书名" value={searchDraft}
               onChange={(e) => setSearchDraft(e.target.value)} />
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
                    <button className="doc-title" onClick={() => openDoc(doc)}>
                      {doc.title}
                    </button>
                    <span className="mono">{doc.total_units} 单元 · {new Date(doc.created_at).toLocaleDateString()}</span>
                  </td>
                  <td>
                    {doc.subject ?? "未分类"}
                    {doc.doc_type ? ` · ${DOC_TYPE_TEXT[doc.doc_type] ?? doc.doc_type}` : ""}
                    {" · "}{doc.file_type.toUpperCase()}
                  </td>
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
                  <td><button className="btn-ghost" onClick={() => openDoc(doc)}>查看</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="shelf-grid">
          {docs.map((doc) => (
            <ShelfCard key={doc.id} doc={doc} onOpen={openDoc} onDelete={setConfirmDelete}
                       onReview={onOpenReview ? (d) => onOpenReview(d.id) : undefined}
                       onApprove={(d) => void doApprove(d)} approving={approvingId === doc.id} />
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

      {uploadOpen && (
        <UploadDialog
          children={kids}
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setUploadOpen(false);
            void reload();
            void reloadSummary();
          }}
        />
      )}
      {confirmDelete && (
        <div className="dialog-mask" role="dialog" aria-label="删除资料">
          <div className="dialog">
            <p>删除《{confirmDelete.title}》？其页面、条目与索引将一并删除，不可恢复。</p>
            <div className="dialog-actions">
              <button className="danger" onClick={() => void doDelete()}>删除</button>
              <button className="btn-ghost" onClick={() => setConfirmDelete(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
