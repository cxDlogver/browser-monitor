-- Failure time is unknown for historical rows. Do not backfill it from created_at.
ALTER TABLE outbox_tasks ADD COLUMN IF NOT EXISTS last_failed_at timestamptz;
CREATE INDEX IF NOT EXISTS outbox_project_failure_idx
  ON outbox_tasks(project_id, last_failed_at DESC) WHERE last_error IS NOT NULL;
