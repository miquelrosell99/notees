-- ============================================================
-- RELAY STORAGE (operation log)
-- ============================================================

-- Migration: the relay previously stored encrypted payloads as ciphertext+iv.
-- Since the operation log can be re-seeded and there are no active users,
-- drop the old table and recreate it with a plaintext JSONB payload column.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'relay_envelope' AND column_name = 'ciphertext'
    ) THEN
        DROP TABLE relay_envelope CASCADE;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS relay_envelope (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    physical BIGINT NOT NULL,
    logical BIGINT NOT NULL,
    affected_node_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    op_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    timestamp TIMESTAMPTZ,
    protocol_version INTEGER NOT NULL DEFAULT 1,
    seq BIGINT GENERATED ALWAYS AS IDENTITY
);

-- Existing databases created before the protocol version field was persisted.
ALTER TABLE relay_envelope
    ADD COLUMN IF NOT EXISTS protocol_version INTEGER NOT NULL DEFAULT 1;

-- Server-assigned sequence number: the authoritative catch-up cursor.
-- GENERATED ALWAYS AS IDENTITY is supported as an ADD COLUMN on populated
-- tables since PostgreSQL 10; existing rows are backfilled from the new
-- sequence (order unspecified, which is acceptable — the relay log can be
-- re-seeded and the HLC columns remain the causal metadata). The sequence is
-- global, so per-workspace seq values may have gaps; only monotonicity and
-- uniqueness within a workspace are guaranteed.
ALTER TABLE relay_envelope
    ADD COLUMN IF NOT EXISTS seq BIGINT GENERATED ALWAYS AS IDENTITY;

CREATE INDEX IF NOT EXISTS idx_relay_envelope_workspace_seq
    ON relay_envelope (workspace_id, seq);

CREATE INDEX IF NOT EXISTS idx_relay_envelope_workspace_hlc
    ON relay_envelope (workspace_id, physical, logical, id);

CREATE INDEX IF NOT EXISTS idx_relay_envelope_actor
    ON relay_envelope (actor_id);

CREATE INDEX IF NOT EXISTS idx_relay_envelope_affected_node_ids
    ON relay_envelope USING GIN (affected_node_ids jsonb_path_ops);

CREATE TABLE IF NOT EXISTS relay_snapshot (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workspace_id TEXT NOT NULL,
    hlc JSONB NOT NULL,
    state_hash TEXT,
    data BYTEA,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    up_to_seq BIGINT
);

-- Seq cursor covered by the snapshot, so post-restore catch-up can resume by
-- seq instead of HLC. NULL on snapshots created before the column existed.
ALTER TABLE relay_snapshot
    ADD COLUMN IF NOT EXISTS up_to_seq BIGINT;

CREATE INDEX IF NOT EXISTS idx_relay_snapshot_workspace
    ON relay_snapshot (workspace_id);

CREATE INDEX IF NOT EXISTS idx_relay_snapshot_workspace_created
    ON relay_snapshot (workspace_id, created_at DESC);

-- Supports latest-snapshot lookups that order by the numeric HLC fields
-- (ORDER BY (hlc->>'physical')::bigint DESC, (hlc->>'logical')::bigint DESC).
CREATE INDEX IF NOT EXISTS idx_relay_snapshot_workspace_hlc
    ON relay_snapshot (workspace_id, ((hlc->>'physical')::bigint) DESC, ((hlc->>'logical')::bigint) DESC);

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

-- Dropped: idx_compacted_segment_to_hlc indexed the TEXT extraction of the
-- numeric HLC fields (lexicographic order, so '10' < '9') and no query used
-- it. The DROP removes it from databases where it was already created.
DROP INDEX IF EXISTS idx_compacted_segment_to_hlc;
