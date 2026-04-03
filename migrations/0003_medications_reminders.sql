CREATE TABLE IF NOT EXISTS medication_logs (
  id TEXT PRIMARY KEY,
  medication_name TEXT NOT NULL,
  dosage TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  reminder_type TEXT NOT NULL,
  time_of_day TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  medication_name TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
