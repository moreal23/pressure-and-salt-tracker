CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  sodium_goal_mg INTEGER NOT NULL DEFAULT 2300,
  privacy_pin_hash TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT single_settings_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS blood_pressure_logs (
  id UUID PRIMARY KEY,
  systolic INTEGER NOT NULL,
  diastolic INTEGER NOT NULL,
  pulse INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  recorded_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS food_logs (
  id UUID PRIMARY KEY,
  food_name TEXT NOT NULL,
  serving_size TEXT NOT NULL,
  sodium_mg INTEGER NOT NULL,
  meal_type TEXT NOT NULL DEFAULT 'Meal',
  barcode TEXT NOT NULL DEFAULT '',
  logged_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS favorite_foods (
  id UUID PRIMARY KEY,
  food_name TEXT NOT NULL,
  serving_size TEXT NOT NULL,
  sodium_mg INTEGER NOT NULL,
  meal_type TEXT NOT NULL DEFAULT 'Meal',
  barcode TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fitbit_connection (
  id INTEGER PRIMARY KEY DEFAULT 1,
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  scope TEXT NOT NULL DEFAULT '',
  fitbit_user_id TEXT NOT NULL DEFAULT '',
  profile_name TEXT NOT NULL DEFAULT '',
  summary_json JSONB,
  history_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT single_fitbit_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS auth_account (
  id INTEGER PRIMARY KEY DEFAULT 1,
  username TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  password_salt TEXT NOT NULL DEFAULT '',
  session_hash TEXT NOT NULL DEFAULT '',
  session_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT single_auth_row CHECK (id = 1)
);

CREATE TABLE IF NOT EXISTS goal_badges (
  date_key DATE PRIMARY KEY,
  steps INTEGER NOT NULL,
  sodium_total_mg INTEGER NOT NULL,
  sodium_goal_mg INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS medication_logs (
  id UUID PRIMARY KEY,
  medication_name TEXT NOT NULL,
  dosage TEXT NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS medication_supplies (
  id UUID PRIMARY KEY,
  medication_name TEXT NOT NULL,
  tablets_remaining INTEGER NOT NULL,
  tablets_per_dose INTEGER NOT NULL DEFAULT 1,
  low_threshold INTEGER NOT NULL DEFAULT 14,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  reminder_type TEXT NOT NULL,
  time_of_day TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  medication_name TEXT NOT NULL DEFAULT '',
  dosage TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reminder_deliveries (
  id UUID PRIMARY KEY,
  reminder_id TEXT NOT NULL,
  day_key DATE NOT NULL,
  channel TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  UNIQUE (reminder_id, day_key, channel)
);

INSERT INTO app_settings (id, sodium_goal_mg)
VALUES (1, 2300)
ON CONFLICT (id) DO NOTHING;
