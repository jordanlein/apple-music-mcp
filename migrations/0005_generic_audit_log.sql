-- Rebuild the audit table so existing deployments migrate the legacy actor
-- column by position while fresh deployments retain the generic client_id name.
CREATE TABLE audit_log_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT,
  tool_name TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO audit_log_v2 SELECT * FROM audit_log;
DROP TABLE audit_log;
ALTER TABLE audit_log_v2 RENAME TO audit_log;

CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);
