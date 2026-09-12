-- Sets the three LIVE event dates used by JST sales-day resolution.

CREATE TABLE migration_0003_guard (
  actual_count INTEGER NOT NULL CHECK (actual_count = 1)
) STRICT;

INSERT INTO migration_0003_guard (actual_count)
SELECT COUNT(*)
FROM workspaces
WHERE id = 'workspace-live-1' AND kind = 'LIVE' AND status = 'ACTIVE';

UPDATE workspaces
SET config_revision = 'd1-v3-event-dates',
    config_snapshot_json = json_set(
      config_snapshot_json,
      '$.EVENT_DATES.1', '2026-09-18',
      '$.EVENT_DATES.2', '2026-09-19',
      '$.EVENT_DATES.3', '2026-09-20'
    )
WHERE id = 'workspace-live-1' AND kind = 'LIVE' AND status = 'ACTIVE';

UPDATE business_days
SET event_date = CASE day_number
  WHEN 1 THEN '2026-09-18'
  WHEN 2 THEN '2026-09-19'
  WHEN 3 THEN '2026-09-20'
END
WHERE workspace_id = 'workspace-live-1' AND day_number IN (1, 2, 3);

DELETE FROM migration_0003_guard;

INSERT INTO migration_0003_guard (actual_count)
SELECT CASE WHEN COUNT(*) = 3 THEN 1 ELSE 0 END
FROM business_days
WHERE workspace_id = 'workspace-live-1'
  AND (
    (day_number = 1 AND event_date = '2026-09-18') OR
    (day_number = 2 AND event_date = '2026-09-19') OR
    (day_number = 3 AND event_date = '2026-09-20')
  );

DROP TABLE migration_0003_guard;

INSERT INTO schema_migrations (version, name, applied_at_ms)
VALUES (3, '0003_event_dates', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

PRAGMA optimize;
