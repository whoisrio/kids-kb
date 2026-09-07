# Library Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the library as a paginated, filterable review surface with explicit index state, page exclusion, chunk preview, and OCR editing.

**Architecture:** PostgreSQL owns review/index facts; backend Hono exposes paginated reads and control writes; Python pipeline owns content assembly, chunk preview, exclusion rebuild, and embedding. React consumes one paginated list API, one detail API, and focused page/chunk APIs.

**Tech Stack:** PostgreSQL, Hono/TypeScript, FastAPI-style Python internal API, React 19, Vitest, Playwright.

---

## Task 1: Database Controls

**Files:**
- Create: `pipeline/kb/migrations/0016_library_index_controls.sql`

- [ ] Add explicit auto/manual review fields to pages and chapters.
- [ ] Add page exclusion and index error fields.
- [ ] Add block annotations and chunk source columns.
- [ ] Backfill new review fields from legacy review status.

## Task 2: Paginated Library API

**Files:**
- Modify: `backend/src/routes/library.ts`
- Test: `backend/src/routes/library.test.ts`

- [ ] Write failing list pagination/filter tests.
- [ ] Implement normalized status counts, pagination, and filters.
- [ ] Write failing detail pagination tests for PDF and chapter documents.
- [ ] Return page/chapter aggregates plus document totals.
- [ ] Run backend tests.

## Task 3: Page and Chunk APIs

**Files:**
- Modify: `backend/src/routes/library.ts`
- Modify: `backend/src/routes/review.ts`
- Test: `backend/src/routes/library.test.ts`
- Test: `backend/src/routes/review.test.ts`

- [ ] Add document chunk ledger endpoint.
- [ ] Add page index preview endpoint backed by pipeline.
- [ ] Add page exclusion/restore endpoint.
- [ ] Add page content edit and block annotation endpoints.
- [ ] Ensure edits mark stale state and affected chunks are removed.
- [ ] Run backend tests.

## Task 4: Pipeline Exclusion and Preview

**Files:**
- Modify: `pipeline/kb/flat.py`
- Modify: `pipeline/kb/internal_api.py`
- Test: `pipeline/tests/test_flat.py`
- Test: `pipeline/tests/test_internal_api.py`

- [ ] Write failing exclusion filter tests.
- [ ] Filter excluded pages from flat and structured content assembly.
- [ ] Implement `/internal/page-exclusion` transactionally.
- [ ] Implement `/internal/index-preview` using segment logic without embedding.
- [ ] Persist page number and source block IDs on page chunks.
- [ ] Run pipeline tests.

## Task 5: Library List UI

**Files:**
- Modify: `frontend/src/api/library.ts`
- Modify: `frontend/src/views/LibraryView.tsx`
- Test: `frontend/src/api/library.test.ts`
- Test: `frontend/src/views/LibraryView.test.tsx`
- Modify: `frontend/src/theme.css`

- [ ] Write failing API-client tests for pagination and filters.
- [ ] Implement table default, card toggle, toolbar, pagination, and status counts.
- [ ] Add index-ledger visual styling and accessible status badges.
- [ ] Run frontend tests.

## Task 6: Library Detail UI

**Files:**
- Create: `frontend/src/components/LibraryDetail.tsx`
- Modify: `frontend/src/views/LibraryView.tsx`
- Test: `frontend/src/components/LibraryDetail.test.tsx`
- Modify: `frontend/src/theme.css`

- [ ] Write failing detail tests for page/chapter pagination.
- [ ] Implement page table, thumbnail view, and chapter table.
- [ ] Implement explicit auto-review/manual-review/index badges.
- [ ] Add exclude toggle and reindex action.

## Task 7: Chunk Ledger and Page Review UI

**Files:**
- Create: `frontend/src/components/IndexLedger.tsx`
- Modify: `frontend/src/components/PageDetail.tsx`
- Test: `frontend/src/components/IndexLedger.test.tsx`
- Test: `frontend/src/components/PageDetail.test.tsx`
- Modify: `frontend/src/api/review.ts`
- Modify: `frontend/src/theme.css`

- [ ] Write failing chunk ledger tests.
- [ ] Render chunk sequence, sources, preview, and status.
- [ ] Add page content editor and index preview/rebuild flow.
- [ ] Add per-block annotation create/edit/delete.
- [ ] Keep bbox/block selection synchronized.
- [ ] Run frontend tests.

## Task 8: End-to-End Regression

**Files:**
- Create: `e2e/specs/library-management.spec.ts`

- [ ] Ingest a fixture PDF through the real services.
- [ ] Verify list filtering, detail paging, OCR editing, annotation, exclusion, and reindex.
- [ ] Query DB chunks directly and search only indexed content.
- [ ] Run frontend, backend, pipeline, and Playwright suites.
