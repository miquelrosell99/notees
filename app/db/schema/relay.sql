-- ============================================================
-- RELAY STORAGE (encrypted operation log)
-- ============================================================

CREATE TABLE IF NOT EXISTS relay_envelope (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    physical BIGINT NOT NULL,
    logical BIGINT NOT NULL,
    affected_node_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    op_type TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    timestamp TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_relay_envelope_workspace_hlc
    ON relay_envelope (workspace_id, physical, logical, id);

CREATE INDEX IF NOT EXISTS idx_relay_envelope_actor
    ON relay_envelope (actor_id);

CREATE TABLE IF NOT EXISTS relay_snapshot (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id TEXT NOT NULL,
    hlc JSONB NOT NULL,
    state_hash TEXT,
    data BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_relay_snapshot_workspace
    ON relay_snapshot (workspace_id);

CREATE INDEX IF NOT EXISTS idx_relay_snapshot_workspace_created
    ON relay_snapshot (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS compacted_operation_segment (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id TEXT NOT NULL,
    from_hlc JSONB NOT NULL,
    to_hlc JSONB NOT NULL,
    snapshot_id UUID REFERENCES relay_snapshot(id) ON DELETE SET NULL,
    operation_count BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compacted_segment_workspace
    ON compacted_operation_segment (workspace_id);

CREATE INDEX IF NOT EXISTS idx_compacted_segment_to_hlc
    ON compacted_operation_segment (workspace_id, (to_hlc->>'physical'), (to_hlc->>'logical'));
