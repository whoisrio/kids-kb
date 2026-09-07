export interface LibraryCounts {
  auto_review: { pending: number; passed: number; needs_review: number; failed: number };
  manual_review: { unreviewed: number; approved: number; rejected: number };
  index: { indexed: number; stale: number; not_indexed: number; excluded: number };
}

export interface Pagination {
  page: number; pageSize: number; total: number; totalPages: number;
}

export interface LibraryDoc extends LibraryCounts {
  id: string; title: string; subject: string | null; file_type: string;
  doc_type: string | null; cover_url: string | null;
  parse_status: string; review_status: string; uploaded_by: string | null;
  created_at: string; struct_mode: string | null;
  total_pages: number; total_chapters: number; total_units: number;
}

export interface LibrarySummary {
  total_docs: number;
  by_subject: { subject: string | null; count: number }[];
  by_doc_type: { doc_type: string | null; count: number }[];
  indexed_units: number;
  pending_review_pages: number;
}

export interface LibraryPage {
  id: string; page_no: number; parse_status: string;
  auto_review_status: string; manual_review_status: string; index_status: string;
  excluded_from_index: boolean; index_error: string | null;
  block_count: number; chunk_count: number; thumbnail_url: string;
}

export interface LibraryChapter {
  id: string; chapter_no: number; title: string; content_preview: string | null;
  auto_review_status: string; manual_review_status: string; index_status: string;
  chunk_count: number;
}

export interface LibraryDetail {
  id: string; title: string; subject: string | null; file_type: string;
  parse_status: string; review_status: string; struct_mode: string | null;
  total_pages: number; total_chapters: number; total_units: number;
  unit_type: "pages" | "chapters";
  pages?: LibraryPage[]; chapters?: LibraryChapter[];
  aggregates: LibraryCounts; pagination: Pagination;
}

export interface LibraryChunk {
  id: string; seq: number; page_no: number | null; seg_no: number | null;
  content_preview: string; source_block_ids: string[];
  item_id: string | null; chapter_id: string | null; created_at: string;
}

export interface LibraryListFilters extends Partial<Pick<Pagination, "page" | "pageSize">> {
  q?: string; subject?: string; fileType?: string; docType?: string;
  autoReview?: string; reviewStatus?: string; indexStatus?: string;
  sort?: "updated" | "name" | "units";
}

type FetchLike = typeof fetch;

async function req<T>(url: string, fetchImpl: FetchLike = fetch, init?: RequestInit): Promise<T> {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function params(values: Record<string, string | number | undefined> = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export async function fetchLibraryDocs(
  filters: LibraryListFilters = {}, fetchImpl: FetchLike = fetch,
): Promise<{ documents: LibraryDoc[]; pagination: Pagination }> {
  return req(`/api/library${params({
    page: filters.page, pageSize: filters.pageSize, q: filters.q,
    subject: filters.subject, file_type: filters.fileType, doc_type: filters.docType,
    auto_review: filters.autoReview, review_status: filters.reviewStatus,
    index_status: filters.indexStatus, sort: filters.sort,
  })}`, fetchImpl);
}

export async function fetchLibrarySummary(fetchImpl: FetchLike = fetch): Promise<LibrarySummary> {
  return req("/api/library/summary", fetchImpl);
}

export async function fetchLibraryDoc(
  id: string, filters: Pick<LibraryListFilters, "page" | "pageSize"> = {}, fetchImpl: FetchLike = fetch,
): Promise<LibraryDetail> {
  return req(`/api/library/${encodeURIComponent(id)}${params(filters)}`, fetchImpl);
}

export async function fetchLibraryChunks(
  id: string, filters: Pick<LibraryListFilters, "page" | "pageSize"> = {}, fetchImpl: FetchLike = fetch,
): Promise<{ chunks: LibraryChunk[]; pagination: Pagination }> {
  return req(`/api/library/${encodeURIComponent(id)}/chunks${params(filters)}`, fetchImpl);
}

export async function setPageExclusion(
  pageId: string, excluded: boolean, fetchImpl: FetchLike = fetch,
): Promise<{ page_id: string; excluded: boolean; deleted_chunks: number }> {
  return req(`/api/library/pages/${encodeURIComponent(pageId)}/exclusion`, fetchImpl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ excluded }),
  });
}

export async function deleteLibraryDoc(id: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const res = await fetchImpl(`/api/library/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
}

export async function reindexLibraryUnit(
  docId: string, type: "page" | "chapter", id: string, fetchImpl: FetchLike = fetch,
): Promise<{ chunks: number; status: string }> {
  return req(`/api/library/${encodeURIComponent(docId)}/reindex`, fetchImpl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, id }),
  });
}
