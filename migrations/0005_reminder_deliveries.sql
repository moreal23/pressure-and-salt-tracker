CREATE TABLE IF NOT EXISTS reminder_deliveries (
  id TEXT PRIMARY KEY,
  reminder_id TEXT NOT NULL,
  day_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  UNIQUE(reminder_id, day_key, channel)
);
