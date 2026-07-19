-- One-way migration: flashcard.node_id -> flashcard.node_uuid
-- Idempotent so it can be re-run safely on databases that already migrated.

DO $$
BEGIN
    -- Only migrate if the legacy integer column still exists.
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'flashcard' AND column_name = 'node_id'
    ) THEN
        -- Add the UUID column if missing.
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'flashcard' AND column_name = 'node_uuid'
        ) THEN
            ALTER TABLE flashcard ADD COLUMN node_uuid UUID;
        END IF;

        -- Backfill from the legacy node table.
        UPDATE flashcard f
        SET node_uuid = n.uuid
        FROM node n
        WHERE n.id = f.node_id;

        -- Fail hard if any row could not be mapped; old data must be repairable.
        IF EXISTS (SELECT 1 FROM flashcard WHERE node_uuid IS NULL) THEN
            RAISE EXCEPTION 'Flashcard rows exist with unmapped node_id values';
        END IF;

        -- Make UUID required and drop the legacy column.
        ALTER TABLE flashcard ALTER COLUMN node_uuid SET NOT NULL;
        ALTER TABLE flashcard DROP COLUMN node_id;

        -- Recreate unique constraint and index on the UUID column.
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE table_name = 'flashcard' AND constraint_name = 'flashcard_node_uuid_key'
        ) THEN
            ALTER TABLE flashcard ADD CONSTRAINT flashcard_node_uuid_key UNIQUE (node_uuid);
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_indexes WHERE indexname = 'idx_flashcard_node'
        ) THEN
            CREATE INDEX idx_flashcard_node ON flashcard(node_uuid);
        END IF;
    END IF;
END $$;
