ALTER TABLE app_settings ADD COLUMN privacy_pin_hash TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS favorite_foods (
  id TEXT PRIMARY KEY,
  food_name TEXT NOT NULL,
  serving_size TEXT NOT NULL,
  sodium_mg INTEGER NOT NULL,
  meal_type TEXT NOT NULL DEFAULT 'Meal',
  barcode TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
