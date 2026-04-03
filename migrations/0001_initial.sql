CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sodium_goal_mg INTEGER NOT NULL DEFAULT 2300,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS blood_pressure_logs (
  id TEXT PRIMARY KEY,
  systolic INTEGER NOT NULL,
  diastolic INTEGER NOT NULL,
  pulse INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS food_logs (
  id TEXT PRIMARY KEY,
  food_name TEXT NOT NULL,
  serving_size TEXT NOT NULL,
  sodium_mg INTEGER NOT NULL,
  meal_type TEXT NOT NULL DEFAULT 'Meal',
  barcode TEXT NOT NULL DEFAULT '',
  logged_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fitbit_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  refresh_token TEXT,
  expires_at TEXT,
  scope TEXT NOT NULL DEFAULT '',
  fitbit_user_id TEXT NOT NULL DEFAULT '',
  profile_name TEXT NOT NULL DEFAULT '',
  summary_json TEXT,
  pending_auth_state TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO app_settings (id, sodium_goal_mg, updated_at)
VALUES (1, 2300, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO fitbit_connection (
  id,
  access_token,
  refresh_token,
  expires_at,
  scope,
  fitbit_user_id,
  profile_name,
  summary_json,
  pending_auth_state,
  updated_at
)
VALUES (1, NULL, NULL, NULL, '', '', '', NULL, '', CURRENT_TIMESTAMP);
