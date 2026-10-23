CREATE TABLE IF NOT EXISTS chairman_state (
  id INTEGER PRIMARY KEY CHECK (id=1), current_status TEXT,
  available_keys_json TEXT NOT NULL DEFAULT '[]', observations_json TEXT NOT NULL DEFAULT '[]', booking_url TEXT,
  last_success_at TEXT, last_checked_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  failure_started_at TEXT, last_error TEXT, source_status TEXT, updated_at TEXT
);
INSERT OR IGNORE INTO chairman_state(id) VALUES(1);
CREATE TABLE IF NOT EXISTS chairman_checks (
  id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, status TEXT NOT NULL, http_status INTEGER,
  error TEXT, result_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chairman_checks_observed ON chairman_checks(observed_at DESC);
CREATE TABLE IF NOT EXISTS monitor_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitor_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, queued_at TEXT,
  delivered_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(event_id,channel), FOREIGN KEY(event_id) REFERENCES monitor_events(id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_pending ON monitor_deliveries(status,queued_at,id);
