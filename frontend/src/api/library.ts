export interface LibraryDoc {
  id: string; title: string; subject: string | null; file_type: string;
  parse_status: string; review_status: string; uploaded_by: string | null;
  created_at: string; pending_pages: number; total_pages: number; indexed_pages: number;
}

type FetchLike = typeof fetch;

async function req<T>(url: string, fetchImpl: FetchLike = fetch): Promise<T> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export async function fetchLibraryDocs(fetchImpl: FetchLike = fetch): Promise<LibraryDoc[]> {
  const data = await req<{ documents: LibraryDoc[] }>("/api/library", fetchImpl);
  return data.documents;
}

export async function deleteLibraryDoc(id: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const res = await fetchImpl(`/api/library/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error(`${res.status}`);
}

export async function fetchLibraryDoc(id: string, fetchImpl: FetchLike = fetch) {
  return req<{
    id: string; title: string; subject: string | null; file_type: string;
    parse_status: string; review_status: string; uploaded_by: string | null;
    created_at: string; struct_mode: string | null;
    pages?: { id: string; page_no: number; review_status: string; index_status: string }[];
    chapters?: ChapterSummary[];
  }>(`/api/library/${encodeURIComponent(id)}`, fetchImpl);
}

export interface ChapterSummary {
  id: string; chapter_no: number; title: string; content_md: string;
  review_status: string; index_status: string;
}
