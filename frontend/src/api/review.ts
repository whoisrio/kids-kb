/** 资料 API（frontend 视角）：类型与 backend routes/review.ts 对齐。 */

export interface ReviewDoc {
  id: string; title: string; subject: string | null; doc_type: string;
  status: string; struct_mode: string | null; pending_pages: number;
}

export interface ReviewPageSummary {
  id: string; page_no: number; doc_title: string; pending_reasons: string[];
}

export interface ReviewBlock {
  id: string; block_type: string; bbox: number[] | null; content_md: string | null;
  source_model: string | null; pending: { id: string; reason: string }[];
  crop_url?: string;
  items?: { id: string; label: string | null; content_type: string; role: string }[];
  annotations: { id: string; block_id: string; author: string; body: string; created_at: string; updated_at: string }[];
  origin?: string;
  /** block_type 血缘：layout 版面检测 | vlm VLM 改判（如 text 被 VLM 确认为公式） */
  block_type_origin?: string;
  /** 标题层级 1/2/3（仅 title 块；NULL=未判定或非标题） */
  title_level?: number | null;
  geometry_revision?: number;
  crop_pad?: number[];
}

export interface BlockGeometryPreview {
  text: string;
  source_model: string;
  crop_pad: [number, number];
  staging: string;
}

export interface ReviewPageDetail {
  id: string; page_no: number; doc_title: string; image_url: string;
  doc_id: string; struct_mode: string | null; parse_status: string;
  page_md: string | null; page_md_model: string | null;
  adopted_source: "blocks" | "page_md";
  /** 采用口径的整页 markdown（adopted=page_md 用整页稿，否则拼块跳页眉页脚） */
  content_md: string;
  blocks: ReviewBlock[];
  page_pending: { id: string; reason: string }[];
  questions?: ReviewPageQuestion[];
  review_status: string;
  auto_review_status: string;
  manual_review_status: string;
  excluded_from_index: boolean;
  index_error: string | null;
  index_status: string;
}

export interface ReviewPageQuestion {
  id: string; label: string | null; content_type: string;
  content_md: string | null; qc_status: string;
  block_ids: string[]; block_crops: string[];
  answer: {
    id: string; content_md: string | null; qc_status: string;
    block_ids: string[]; block_crops: string[];
  } | null;
}

export interface ReviewItemSummary {
  id: string; content_type: string; label: string | null; chapter: string | null;
  qc_status: string; doc_title: string; pending_reasons: string[];
  content_md: string | null; source_model: string | null;
}

export interface ReviewChapter {
  id: string; document_id: string; doc_title: string;
  chapter_no: number; title: string; content_md: string | null;
}

export interface ReviewItemDetail {
  id: string; content_type: string; label: string | null; chapter: string | null;
  qc_status: string; content_md: string | null; taxonomy: string | null; tags: string[] | null;
  doc_title: string; source_model: string | null;
  blocks: { id: string; role: string; block_type: string; content_md: string | null; source_model: string | null; crop_url: string }[];
  reviews: { id: string; reason: string; status: string }[];
}

export interface ReviewSearchHit {
  item_id: string | null; chapter_id: string | null; document_id: string;
  content_md: string; score: number; doc_title?: string; chapter?: string;
  label?: string | null; subject?: string | null;
}

type FetchLike = typeof fetch;

async function req<T>(url: string, fetchImpl: FetchLike, init?: RequestInit): Promise<T> {
  const resp = await fetchImpl(url, init);
  if (!resp.ok) {
    let msg = `请求失败: ${resp.status}`;
    try { msg = ((await resp.json()) as { error?: string }).error ?? msg; } catch { /* 非 JSON 错误体 */ }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export function fetchReviewDocs(fetchImpl: FetchLike = fetch): Promise<ReviewDoc[]> {
  return req("/api/review/docs", fetchImpl);
}

export function fetchReviewPages(
  docId: string | undefined, status: "pending" | "approved", fetchImpl: FetchLike = fetch,
): Promise<{ pages: ReviewPageSummary[] }> {
  const q = new URLSearchParams({ status });
  if (docId) q.set("doc_id", docId);
  return req(`/api/review/pages?${q}`, fetchImpl);
}

export function fetchReviewPage(id: string, fetchImpl: FetchLike = fetch): Promise<ReviewPageDetail> {
  return req(`/api/review/pages/${encodeURIComponent(id)}`, fetchImpl);
}

export function fetchReviewItems(
  docId: string | undefined, status: "pending" | undefined, fetchImpl: FetchLike = fetch,
): Promise<{ items: ReviewItemSummary[] }> {
  const q = new URLSearchParams();
  if (docId) q.set("doc_id", docId);
  if (status) q.set("status", status);
  const s = q.toString();
  return req(`/api/review/items${s ? `?${s}` : ""}`, fetchImpl);
}

export function fetchReviewChapters(
  docId: string | undefined, fetchImpl: FetchLike = fetch,
): Promise<{ chapters: ReviewChapter[] }> {
  const q = new URLSearchParams();
  if (docId) q.set("doc_id", docId);
  const s = q.toString();
  return req(`/api/review/chapters${s ? `?${s}` : ""}`, fetchImpl);
}

export function fetchReviewItem(id: string, fetchImpl: FetchLike = fetch): Promise<ReviewItemDetail> {
  return req(`/api/review/items/${encodeURIComponent(id)}`, fetchImpl);
}

export function updateReviewBlock(id: string, contentMd: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/blocks/${encodeURIComponent(id)}`, fetchImpl, json("PATCH", { content_md: contentMd }));
}

export function mergeBlocks(blockIds: string[], fetchImpl: FetchLike = fetch) {
  return req<{ id: string }>("/api/review/blocks/merge", fetchImpl, json("POST", { block_ids: blockIds }));
}

export function splitBlock(id: string, lineIndex: number, fetchImpl: FetchLike = fetch) {
  return req<{ ids: string[] }>(
    `/api/review/blocks/${encodeURIComponent(id)}/split`, fetchImpl, json("POST", { line_index: lineIndex }));
}

export function deleteBlock(id: string, fetchImpl: FetchLike = fetch) {
  return req<{ ok: boolean }>(
    `/api/review/blocks/${encodeURIComponent(id)}`, fetchImpl, { method: "DELETE" });
}

export function previewBlockGeometry(id: string, bbox: number[], fetchImpl: FetchLike = fetch) {
  return req<BlockGeometryPreview>(
    `/api/review/blocks/${encodeURIComponent(id)}/geometry-preview`, fetchImpl, json("POST", { bbox }));
}

export function commitBlockGeometry(
  id: string, bbox: number[], staging: string, adoptedText: string, sourceModel: string,
  fetchImpl: FetchLike = fetch,
) {
  return req<{ ok: boolean }>(
    `/api/review/blocks/${encodeURIComponent(id)}/geometry-commit`, fetchImpl,
    json("POST", { bbox, staging, adopted_text: adoptedText, source_model: sourceModel }));
}

export function createBlock(pageId: string, bbox: number[], blockType: string, fetchImpl: FetchLike = fetch) {
  return req<{ block: ReviewBlock }>(
    `/api/review/pages/${encodeURIComponent(pageId)}/blocks`, fetchImpl,
    json("POST", { bbox, block_type: blockType }));
}

export function updateReviewPage(id: string, pageMd: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/pages/${encodeURIComponent(id)}`, fetchImpl, json("PATCH", { page_md: pageMd }));
}

export function createBlockAnnotation(blockId: string, body: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/blocks/${encodeURIComponent(blockId)}/annotations`, fetchImpl, json("POST", { body }));
}

export function updateBlockAnnotation(id: string, body: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/block-annotations/${encodeURIComponent(id)}`, fetchImpl, json("PATCH", { body }));
}

export function deleteBlockAnnotation(id: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/block-annotations/${encodeURIComponent(id)}`, fetchImpl, { method: "DELETE" });
}

export function updateReviewItem(id: string, contentMd: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/items/${encodeURIComponent(id)}`, fetchImpl, json("PATCH", { content_md: contentMd }));
}

export function rejectReviewPage(id: string, reason: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/pages/${encodeURIComponent(id)}/reject`, fetchImpl, json("POST", { reason }));
}

export function rejectReviewItem(id: string, reason: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/items/${encodeURIComponent(id)}/reject`, fetchImpl, json("POST", { reason }));
}

export function adoptReviewPage(id: string, source: "blocks" | "page_md", fetchImpl: FetchLike = fetch) {
  return req(`/api/review/pages/${encodeURIComponent(id)}/adopt`, fetchImpl, json("POST", { source }));
}

export function approveReviewPage(id: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/pages/${encodeURIComponent(id)}/approve`, fetchImpl, { method: "POST" });
}

export function approveReviewItem(id: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/items/${encodeURIComponent(id)}/approve`, fetchImpl, { method: "POST" });
}

export function pageVlm(id: string, fetchImpl: FetchLike = fetch) {
  return req(`/api/review/pages/${encodeURIComponent(id)}/page-vlm`, fetchImpl, { method: "POST" });
}

export function reviewSearch(q: string, subject: string | undefined, fetchImpl: FetchLike = fetch) {
  const params = new URLSearchParams({ q });
  if (subject) params.set("subject", subject);
  return req<{ hits: ReviewSearchHit[] }>(`/api/review/search?${params}`, fetchImpl);
}
