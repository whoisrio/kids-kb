-- pipeline trajectory 事件日志：run + event 模型；删文档/删页级联清。
CREATE TABLE pipeline_events (
    id BIGSERIAL PRIMARY KEY,
    run_id UUID NOT NULL,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    item_id UUID REFERENCES items(id) ON DELETE SET NULL,
    stage TEXT NOT NULL,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload JSONB,
    model TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'skipped')),
    actor TEXT NOT NULL DEFAULT 'pipeline',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pipeline_events_doc_ts ON pipeline_events (document_id, created_at);
CREATE INDEX pipeline_events_doc_page_ts ON pipeline_events (document_id, page_id, created_at);
CREATE INDEX pipeline_events_run ON pipeline_events (run_id);
