CREATE TABLE IF NOT EXISTS medication_supplies (
  id TEXT PRIMARY KEY,
  medication_name TEXT NOT NULL,
  tablets_remaining INTEGER NOT NULL,
  tablets_per_dose INTEGER NOT NULL DEFAULT 1,
  low_threshold INTEGER NOT NULL DEFAULT 14,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
