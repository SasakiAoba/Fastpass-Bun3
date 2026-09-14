-- One D1, independent Production and Preview operational state.
ALTER TABLE sessions ADD COLUMN environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'preview'));
ALTER TABLE workspaces ADD COLUMN environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'preview'));
DROP INDEX idx_workspaces_one_active_kind;
CREATE UNIQUE INDEX idx_workspaces_one_active_kind ON workspaces(environment, kind) WHERE status = 'ACTIVE';
ALTER TABLE purged_operation_receipts ADD COLUMN environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'preview'));
ALTER TABLE business_operations ADD COLUMN environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'preview'));
CREATE INDEX idx_business_operations_environment ON business_operations(environment);
ALTER TABLE audit_logs ADD COLUMN environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production', 'preview'));
CREATE TABLE system_state_next ( singleton_id INTEGER PRIMARY KEY CHECK (singleton_id IN (1, 2)), mode TEXT NOT NULL CHECK ( mode IN ('LIVE', 'ENTERING_DEV', 'DEVELOPMENT', 'PURGING_DEV') ), mode_epoch INTEGER NOT NULL CHECK (mode_epoch >= 1), maintenance INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0, 1)), current_live_workspace_id TEXT NOT NULL, current_dev_workspace_id TEXT, updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms > 0), FOREIGN KEY (current_live_workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT, FOREIGN KEY (current_dev_workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL, CHECK ( (mode = 'LIVE' AND current_dev_workspace_id IS NULL) OR (mode <> 'LIVE' AND current_dev_workspace_id IS NOT NULL) ) ) STRICT;
INSERT INTO system_state_next SELECT * FROM system_state;
DROP TABLE system_state;
ALTER TABLE system_state_next RENAME TO system_state;

-- A stopped Preview configuration container cannot accept business mutations.
INSERT INTO workspaces (id, kind, status, sequence, config_revision, config_snapshot_json, ticket_prefix, unit_price_yen, max_ticket_number, max_items_per_operation, max_tendered_yen, checkout_hold_seconds, last_ticket_number, last_group_number, selected_test_day, started_at_ms, ended_at_ms, environment)
SELECT 'workspace-preview-config-1', 'LIVE', 'ACTIVE', (SELECT MAX(sequence) + 1 FROM workspaces WHERE kind = 'LIVE'), config_revision, config_snapshot_json, ticket_prefix, unit_price_yen, max_ticket_number, max_items_per_operation, max_tendered_yen, checkout_hold_seconds, 0, 0, 1, CAST(strftime('%s','now') AS INTEGER)*1000, NULL, 'preview'
FROM workspaces WHERE id = (SELECT current_live_workspace_id FROM system_state WHERE singleton_id = 1);
INSERT INTO business_days (workspace_id, day_number, event_date, ticket_limit, sold_count)
SELECT 'workspace-preview-config-1', day_number, event_date, ticket_limit, 0 FROM business_days
WHERE workspace_id = (SELECT current_live_workspace_id FROM system_state WHERE singleton_id = 1);
INSERT INTO system_state VALUES (2, 'LIVE', 1, 1, 'workspace-preview-config-1', NULL, CAST(strftime('%s','now') AS INTEGER)*1000);

CREATE TRIGGER trg_system_environment_insert BEFORE INSERT ON system_state
WHEN NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.current_live_workspace_id AND kind = 'LIVE' AND environment = CASE NEW.singleton_id WHEN 1 THEN 'production' ELSE 'preview' END)
OR (NEW.current_dev_workspace_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.current_dev_workspace_id AND kind = 'DEV' AND environment = CASE NEW.singleton_id WHEN 1 THEN 'production' ELSE 'preview' END))
BEGIN SELECT RAISE(ABORT, 'WORKSPACE_ENVIRONMENT_MISMATCH'); END;
CREATE TRIGGER trg_system_environment_update BEFORE UPDATE ON system_state
WHEN NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.current_live_workspace_id AND kind = 'LIVE' AND environment = CASE NEW.singleton_id WHEN 1 THEN 'production' ELSE 'preview' END)
OR (NEW.current_dev_workspace_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.current_dev_workspace_id AND kind = 'DEV' AND environment = CASE NEW.singleton_id WHEN 1 THEN 'production' ELSE 'preview' END))
BEGIN SELECT RAISE(ABORT, 'WORKSPACE_ENVIRONMENT_MISMATCH'); END;
CREATE TRIGGER trg_workspace_environment_immutable BEFORE UPDATE OF environment ON workspaces
WHEN NEW.environment <> OLD.environment BEGIN SELECT RAISE(ABORT, 'WORKSPACE_ENVIRONMENT_IMMUTABLE'); END;
CREATE INDEX idx_audit_environment ON audit_logs(environment);
CREATE INDEX idx_audit_environment_time ON audit_logs(environment, occurred_at_ms DESC);
CREATE TRIGGER trg_operation_environment_insert BEFORE INSERT ON business_operations
WHEN NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND environment = NEW.environment)
BEGIN SELECT RAISE(ABORT, 'OPERATION_ENVIRONMENT_MISMATCH'); END;
CREATE TRIGGER trg_audit_environment_insert BEFORE INSERT ON audit_logs
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id AND environment = NEW.environment)
BEGIN SELECT RAISE(ABORT, 'AUDIT_ENVIRONMENT_MISMATCH'); END;
INSERT INTO schema_migrations VALUES (5, '0005_shared_d1_environment_scopes', CAST(strftime('%s','now') AS INTEGER)*1000);
