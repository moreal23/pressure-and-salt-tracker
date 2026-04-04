const { Pool } = require('pg')

function createBackupSafeFitbitState(fitbitState) {
  return {
    connection: null,
    summary: fitbitState?.summary ?? null,
    history: fitbitState?.history ?? [],
  }
}

function normalizeFitbitHistory(history = []) {
  return [...history]
    .filter(Boolean)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-14)
}

function mergeFitbitHistory(history = [], summary) {
  if (!summary?.lastSyncAt) {
    return normalizeFitbitHistory(history)
  }

  const date = toDayKey(summary.lastSyncAt)
  const nextHistory = history.filter((entry) => entry.date !== date)

  nextHistory.push({
    date,
    stepsToday: Number(summary.stepsToday ?? 0),
    restingHeartRate: summary.restingHeartRate ?? null,
    latestHeartRate: summary.latestHeartRate ?? null,
    sleepMinutes: Number(summary.sleepMinutes ?? 0),
    weightValue: summary.weightValue ?? null,
    lastSyncAt: summary.lastSyncAt,
  })

  return normalizeFitbitHistory(nextHistory)
}

function toDayKey(value) {
  return new Date(value).toISOString().slice(0, 10)
}

function listLastSevenDays() {
  const dates = []
  const now = new Date()

  for (let index = 6; index >= 0; index -= 1) {
    const next = new Date(now)
    next.setHours(0, 0, 0, 0)
    next.setDate(now.getDate() - index)
    dates.push(next)
  }

  return dates
}

function getCurrentWeekStart() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - date.getDay())
  return date
}

class PostgresStore {
  constructor(connectionString) {
    this.storageMode = 'postgres'
    this.pool = new Pool({
      connectionString,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    })
  }

  async initialize() {
    await this.pool.query(`
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

      ALTER TABLE reminders
      ADD COLUMN IF NOT EXISTS dosage TEXT NOT NULL DEFAULT '';

      ALTER TABLE app_settings
      ADD COLUMN IF NOT EXISTS privacy_pin_hash TEXT NOT NULL DEFAULT '';

      ALTER TABLE fitbit_connection
      ADD COLUMN IF NOT EXISTS history_json JSONB;

      CREATE TABLE IF NOT EXISTS reminder_deliveries (
        id UUID PRIMARY KEY,
        reminder_id TEXT NOT NULL,
        day_key DATE NOT NULL,
        channel TEXT NOT NULL,
        sent_at TIMESTAMPTZ NOT NULL,
        UNIQUE(reminder_id, day_key, channel)
      );

      INSERT INTO app_settings (id, sodium_goal_mg)
      VALUES (1, 2300)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO auth_account (id, username, password_hash, password_salt, session_hash, session_expires_at)
      VALUES (1, '', '', '', '', NULL)
      ON CONFLICT (id) DO NOTHING;
    `)
  }

  async getSettings() {
    const result = await this.pool.query('SELECT sodium_goal_mg FROM app_settings WHERE id = 1')
    return {
      sodiumGoalMg: result.rows[0]?.sodium_goal_mg ?? 2300,
    }
  }

  async getPrivacyPinHash() {
    const result = await this.pool.query('SELECT privacy_pin_hash FROM app_settings WHERE id = 1')
    return result.rows[0]?.privacy_pin_hash ?? ''
  }

  async getAuthState() {
    const result = await this.pool.query(
      `
        SELECT
          username,
          password_hash AS "passwordHash",
          password_salt AS "passwordSalt",
          session_hash AS "sessionHash",
          session_expires_at AS "sessionExpiresAt"
        FROM auth_account
        WHERE id = 1
      `
    )

    return (
      result.rows[0] ?? {
        username: '',
        passwordHash: '',
        passwordSalt: '',
        sessionHash: '',
        sessionExpiresAt: '',
      }
    )
  }

  async createAuthAccount(entry) {
    await this.pool.query(
      `
        INSERT INTO auth_account (id, username, password_hash, password_salt, session_hash, session_expires_at, updated_at)
        VALUES (1, $1, $2, $3, $4, $5, NOW())
        ON CONFLICT (id)
        DO UPDATE SET
          username = EXCLUDED.username,
          password_hash = EXCLUDED.password_hash,
          password_salt = EXCLUDED.password_salt,
          session_hash = EXCLUDED.session_hash,
          session_expires_at = EXCLUDED.session_expires_at,
          updated_at = NOW()
      `,
      [entry.username, entry.passwordHash, entry.passwordSalt, entry.sessionHash ?? '', entry.sessionExpiresAt ?? null]
    )

    return this.getAuthState()
  }

  async saveAuthSession(entry) {
    await this.pool.query(
      `
        UPDATE auth_account
        SET session_hash = $1, session_expires_at = $2, updated_at = NOW()
        WHERE id = 1
      `,
      [entry.sessionHash ?? '', entry.sessionExpiresAt ?? null]
    )

    return this.getAuthState()
  }

  async clearAuthSession() {
    await this.pool.query(
      `
        UPDATE auth_account
        SET session_hash = '', session_expires_at = NULL, updated_at = NOW()
        WHERE id = 1
      `
    )

    return this.getAuthState()
  }

  async getDashboard() {
    const settings = await this.getSettings()
    const bpResult = await this.pool.query(
      'SELECT id, systolic, diastolic, pulse, notes, recorded_at AS "recordedAt" FROM blood_pressure_logs ORDER BY recorded_at DESC'
    )
    const foodResult = await this.pool.query(
      'SELECT id, food_name AS "foodName", serving_size AS "servingSize", sodium_mg AS "sodiumMg", meal_type AS "mealType", barcode, logged_at AS "loggedAt" FROM food_logs ORDER BY logged_at DESC'
    )

    const bloodPressureLogs = bpResult.rows
    const foodLogs = foodResult.rows
    const todayKey = toDayKey(new Date())
    const todayFoods = foodLogs.filter((entry) => toDayKey(entry.loggedAt) === todayKey)
    const todayReadings = bloodPressureLogs.filter((entry) => toDayKey(entry.recordedAt) === todayKey)
    const sodiumTotalMg = todayFoods.reduce((sum, entry) => sum + entry.sodiumMg, 0)
    const weeklyTrend = listLastSevenDays().map((date) => {
      const key = toDayKey(date)
      const foods = foodLogs.filter((entry) => toDayKey(entry.loggedAt) === key)
      const readings = bloodPressureLogs.filter((entry) => toDayKey(entry.recordedAt) === key)

      return {
        date: key,
        label: date.toLocaleDateString('en-US', { weekday: 'short' }),
        sodiumTotalMg: foods.reduce((sum, entry) => sum + entry.sodiumMg, 0),
        averageSystolic: readings.length
          ? Math.round(readings.reduce((sum, entry) => sum + entry.systolic, 0) / readings.length)
          : 0,
        averageDiastolic: readings.length
          ? Math.round(readings.reduce((sum, entry) => sum + entry.diastolic, 0) / readings.length)
          : 0,
      }
    })
    const readingsForAverage = weeklyTrend.filter((entry) => entry.averageSystolic > 0)

    return {
      storageMode: this.storageMode,
      settings,
      latestBloodPressure: bloodPressureLogs[0] ?? null,
      recentBloodPressure: bloodPressureLogs.slice(0, 5),
      recentFoodLogs: foodLogs.slice(0, 6),
      today: {
        date: todayKey,
        sodiumTotalMg,
        sodiumRemainingMg: settings.sodiumGoalMg - sodiumTotalMg,
        sodiumPercent: Math.round((sodiumTotalMg / settings.sodiumGoalMg) * 100),
        bloodPressureCount: todayReadings.length,
        foodCount: todayFoods.length,
        scanCount: todayFoods.filter((entry) => entry.mealType === 'Scan' || entry.barcode).length,
      },
      weeklySummary: {
        averageSystolic: readingsForAverage.length
          ? Math.round(
              readingsForAverage.reduce((sum, entry) => sum + entry.averageSystolic, 0) /
                readingsForAverage.length
            )
          : 0,
        averageDiastolic: readingsForAverage.length
          ? Math.round(
              readingsForAverage.reduce((sum, entry) => sum + entry.averageDiastolic, 0) /
                readingsForAverage.length
            )
          : 0,
        totalEntries: bloodPressureLogs.length + foodLogs.length,
      },
      weeklyTrend,
    }
  }

  async updateSettings(nextSettings) {
    const sodiumGoalMg = nextSettings.sodiumGoalMg

    await this.pool.query(
      `
        INSERT INTO app_settings (id, sodium_goal_mg, updated_at)
        VALUES (1, $1, NOW())
        ON CONFLICT (id)
        DO UPDATE SET sodium_goal_mg = EXCLUDED.sodium_goal_mg, updated_at = NOW()
      `,
      [sodiumGoalMg]
    )

    return {
      sodiumGoalMg,
    }
  }

  async getBloodPressureLogs() {
    const result = await this.pool.query(
      'SELECT id, systolic, diastolic, pulse, notes, recorded_at AS "recordedAt" FROM blood_pressure_logs ORDER BY recorded_at DESC'
    )

    return result.rows
  }

  async getFoodLogs() {
    const result = await this.pool.query(
      'SELECT id, food_name AS "foodName", serving_size AS "servingSize", sodium_mg AS "sodiumMg", meal_type AS "mealType", barcode, logged_at AS "loggedAt" FROM food_logs ORDER BY logged_at DESC'
    )

    return result.rows
  }

  async getFavoriteFoods() {
    const result = await this.pool.query(
      `
        SELECT
          id,
          food_name AS "foodName",
          serving_size AS "servingSize",
          sodium_mg AS "sodiumMg",
          meal_type AS "mealType",
          barcode,
          notes,
          created_at AS "createdAt"
        FROM favorite_foods
        ORDER BY created_at DESC
      `
    )

    return result.rows
  }

  async addFavoriteFood(entry) {
    const result = await this.pool.query(
      `
        INSERT INTO favorite_foods (id, food_name, serving_size, sodium_mg, meal_type, barcode, notes, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
        RETURNING
          id,
          food_name AS "foodName",
          serving_size AS "servingSize",
          sodium_mg AS "sodiumMg",
          meal_type AS "mealType",
          barcode,
          notes,
          created_at AS "createdAt"
      `,
      [
        entry.id,
        entry.foodName,
        entry.servingSize,
        entry.sodiumMg,
        entry.mealType,
        entry.barcode ?? '',
        entry.notes ?? '',
        entry.createdAt ?? null,
      ]
    )

    return result.rows[0]
  }

  async deleteFavoriteFood(id) {
    const result = await this.pool.query('DELETE FROM favorite_foods WHERE id = $1', [id])
    return result.rowCount > 0
  }

  async findFavoriteFoodByBarcode(barcode) {
    const result = await this.pool.query(
      `
        SELECT
          id,
          food_name AS "foodName",
          serving_size AS "servingSize",
          sodium_mg AS "sodiumMg",
          meal_type AS "mealType",
          barcode,
          notes,
          created_at AS "createdAt"
        FROM favorite_foods
        WHERE barcode = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [barcode]
    )

    return result.rows[0] ?? null
  }

  async getPrivacyStatus() {
    return {
      pinEnabled: Boolean(await this.getPrivacyPinHash()),
    }
  }

  async setPrivacyPinHash(hash) {
    await this.pool.query(
      `
        INSERT INTO app_settings (id, sodium_goal_mg, privacy_pin_hash, updated_at)
        VALUES (1, COALESCE((SELECT sodium_goal_mg FROM app_settings WHERE id = 1), 2300), $1, NOW())
        ON CONFLICT (id)
        DO UPDATE SET privacy_pin_hash = EXCLUDED.privacy_pin_hash, updated_at = NOW()
      `,
      [hash]
    )

    return this.getPrivacyStatus()
  }

  async verifyPrivacyPinHash(hash) {
    const savedHash = await this.getPrivacyPinHash()
    return Boolean(savedHash) && savedHash === hash
  }

  async clearPrivacyPinHash() {
    await this.pool.query('UPDATE app_settings SET privacy_pin_hash = \'\', updated_at = NOW() WHERE id = 1')
    return this.getPrivacyStatus()
  }

  async getFitbitState() {
    const result = await this.pool.query(
      'SELECT access_token AS "accessToken", refresh_token AS "refreshToken", expires_at AS "expiresAt", scope, fitbit_user_id AS "fitbitUserId", profile_name AS "profileName", summary_json AS summary, history_json AS history FROM fitbit_connection WHERE id = 1'
    )
    const row = result.rows[0]

    if (!row) {
      return {
        connection: null,
        summary: null,
        history: [],
      }
    }

    return {
      connection: row.accessToken
        ? {
            accessToken: row.accessToken,
            refreshToken: row.refreshToken,
            expiresAt: row.expiresAt,
            scope: row.scope,
            fitbitUserId: row.fitbitUserId,
            profileName: row.profileName,
          }
        : null,
      summary: row.summary ?? null,
      history: normalizeFitbitHistory(row.history ?? []),
    }
  }

  async getGoalBadges() {
    const result = await this.pool.query(
      `
        SELECT
          date_key::text AS date,
          steps,
          sodium_total_mg AS "sodiumTotalMg",
          sodium_goal_mg AS "sodiumGoalMg",
          created_at AS "createdAt"
        FROM goal_badges
        ORDER BY date_key DESC
      `
    )

    return result.rows
  }

  async claimGoalBadge(badge) {
    const insertResult = await this.pool.query(
      `
        INSERT INTO goal_badges (date_key, steps, sodium_total_mg, sodium_goal_mg)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (date_key) DO NOTHING
        RETURNING
          date_key::text AS date,
          steps,
          sodium_total_mg AS "sodiumTotalMg",
          sodium_goal_mg AS "sodiumGoalMg",
          created_at AS "createdAt"
      `,
      [badge.date, badge.steps, badge.sodiumTotalMg, badge.sodiumGoalMg]
    )

    const created = insertResult.rowCount > 0
    const savedBadge =
      insertResult.rows[0] ??
      (await this.pool.query(
        `
          SELECT
            date_key::text AS date,
            steps,
            sodium_total_mg AS "sodiumTotalMg",
            sodium_goal_mg AS "sodiumGoalMg",
            created_at AS "createdAt"
          FROM goal_badges
          WHERE date_key = $1
        `,
        [badge.date]
      )).rows[0]

    return {
      created,
      badge: savedBadge,
      goalBadges: await this.getGoalBadges(),
    }
  }

  async getMedicationLogs() {
    await this.pool.query('DELETE FROM medication_logs WHERE taken_at < $1', [getCurrentWeekStart().toISOString()])

    const result = await this.pool.query(
      `
        SELECT
          id,
          medication_name AS "medicationName",
          dosage,
          taken_at AS "takenAt",
          notes
        FROM medication_logs
        ORDER BY taken_at DESC
      `
    )

    return result.rows
  }

  async addMedicationLog(entry) {
    await this.pool.query('DELETE FROM medication_logs WHERE taken_at < $1', [getCurrentWeekStart().toISOString()])

    await this.pool.query(
      `
        INSERT INTO medication_logs (id, medication_name, dosage, taken_at, notes)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [entry.id, entry.medicationName, entry.dosage, entry.takenAt, entry.notes]
    )

    await this.adjustMedicationSupply(entry.medicationName, -1)

    return entry
  }

  async deleteMedicationLog(id) {
    const existing = await this.pool.query(
      'SELECT medication_name AS "medicationName" FROM medication_logs WHERE id = $1',
      [id]
    )
    const result = await this.pool.query('DELETE FROM medication_logs WHERE id = $1', [id])

    if (result.rowCount > 0 && existing.rows[0]?.medicationName) {
      await this.adjustMedicationSupply(existing.rows[0].medicationName, 1)
    }

    return result.rowCount > 0
  }

  async getMedicationSupplies() {
    const result = await this.pool.query(
      `
        SELECT
          id,
          medication_name AS "medicationName",
          tablets_remaining AS "tabletsRemaining",
          tablets_per_dose AS "tabletsPerDose",
          low_threshold AS "lowThreshold",
          updated_at AS "updatedAt"
        FROM medication_supplies
        ORDER BY medication_name ASC
      `
    )

    return result.rows
  }

  async saveMedicationSupply(entry) {
    const result = await this.pool.query(
      `
        INSERT INTO medication_supplies (
          id, medication_name, tablets_remaining, tablets_per_dose, low_threshold, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (id)
        DO UPDATE SET
          medication_name = EXCLUDED.medication_name,
          tablets_remaining = EXCLUDED.tablets_remaining,
          tablets_per_dose = EXCLUDED.tablets_per_dose,
          low_threshold = EXCLUDED.low_threshold,
          updated_at = NOW()
        RETURNING
          id,
          medication_name AS "medicationName",
          tablets_remaining AS "tabletsRemaining",
          tablets_per_dose AS "tabletsPerDose",
          low_threshold AS "lowThreshold",
          updated_at AS "updatedAt"
      `,
      [
        entry.id,
        entry.medicationName,
        entry.tabletsRemaining,
        entry.tabletsPerDose,
        entry.lowThreshold,
      ]
    )

    return result.rows[0]
  }

  async deleteMedicationSupply(id) {
    const result = await this.pool.query('DELETE FROM medication_supplies WHERE id = $1', [id])
    return result.rowCount > 0
  }

  async adjustMedicationSupply(medicationName, doseCountDelta) {
    const normalizedMedication = String(medicationName ?? '').trim().toLowerCase()

    if (!normalizedMedication || !doseCountDelta) {
      return null
    }

    const result = await this.pool.query(
      `
        UPDATE medication_supplies
        SET
          tablets_remaining = GREATEST(0, tablets_remaining + ($1 * tablets_per_dose)),
          updated_at = NOW()
        WHERE LOWER(TRIM(medication_name)) = $2
        RETURNING
          id,
          medication_name AS "medicationName",
          tablets_remaining AS "tabletsRemaining",
          tablets_per_dose AS "tabletsPerDose",
          low_threshold AS "lowThreshold",
          updated_at AS "updatedAt"
      `,
      [doseCountDelta, normalizedMedication]
    )

    return result.rows[0] ?? null
  }

  async getReminders() {
    const result = await this.pool.query(
      `
        SELECT
          id,
          title,
          reminder_type AS "reminderType",
          time_of_day AS "timeOfDay",
          enabled,
          medication_name AS "medicationName",
          dosage,
          notes
        FROM reminders
        ORDER BY time_of_day ASC, title ASC
      `
    )

    return result.rows
  }

  async addReminder(entry) {
    await this.pool.query(
      `
        INSERT INTO reminders (id, title, reminder_type, time_of_day, enabled, medication_name, dosage, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        entry.id,
        entry.title,
        entry.reminderType,
        entry.timeOfDay,
        entry.enabled,
        entry.medicationName,
        entry.dosage,
        entry.notes,
      ]
    )

    return entry
  }

  async deleteReminder(id) {
    const result = await this.pool.query('DELETE FROM reminders WHERE id = $1', [id])
    return result.rowCount > 0
  }

  async hasReminderDelivery(reminderId, dayKey, channel) {
    const result = await this.pool.query(
      `
        SELECT id
        FROM reminder_deliveries
        WHERE reminder_id = $1 AND day_key = $2 AND channel = $3
        LIMIT 1
      `,
      [reminderId, dayKey, channel]
    )

    return result.rowCount > 0
  }

  async recordReminderDelivery(entry) {
    await this.pool.query(
      `
        INSERT INTO reminder_deliveries (id, reminder_id, day_key, channel, sent_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (reminder_id, day_key, channel) DO NOTHING
      `,
      [entry.id, entry.reminderId, entry.dayKey, entry.channel, entry.sentAt]
    )

    return entry
  }

  async getBackupData() {
    const [settings, privacyPinHash, bloodPressureLogs, foodLogs, favoriteFoods, medicationLogs, medicationSupplies, reminders, fitbitState, goalBadges] =
      await Promise.all([
        this.getSettings(),
        this.getPrivacyPinHash(),
        this.getBloodPressureLogs(),
        this.getFoodLogs(),
        this.getFavoriteFoods(),
        this.getMedicationLogs(),
        this.getMedicationSupplies(),
        this.getReminders(),
        this.getFitbitState(),
        this.getGoalBadges(),
      ])

    return {
      exportedAt: new Date().toISOString(),
      version: 1,
      data: {
        settings: {
          ...settings,
          privacyPinHash,
        },
        bloodPressureLogs,
        foodLogs,
        favoriteFoods,
        medicationLogs,
        medicationSupplies,
        reminders,
        fitbit: createBackupSafeFitbitState(fitbitState),
        goalBadges,
      },
    }
  }

  async restoreBackupData(backup) {
    const client = await this.pool.connect()

    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM blood_pressure_logs')
      await client.query('DELETE FROM food_logs')
      await client.query('DELETE FROM favorite_foods')
      await client.query('DELETE FROM medication_logs')
      await client.query('DELETE FROM medication_supplies')
      await client.query('DELETE FROM reminders')
      await client.query('DELETE FROM goal_badges')
      await client.query('DELETE FROM fitbit_connection')

      if (backup.settings?.sodiumGoalMg) {
        await client.query(
          `
            INSERT INTO app_settings (id, sodium_goal_mg, updated_at)
            VALUES (1, $1, NOW())
            ON CONFLICT (id)
            DO UPDATE SET sodium_goal_mg = EXCLUDED.sodium_goal_mg, updated_at = NOW()
          `,
          [backup.settings.sodiumGoalMg]
        )
      }

      for (const entry of backup.bloodPressureLogs ?? []) {
        await client.query(
          `
            INSERT INTO blood_pressure_logs (id, systolic, diastolic, pulse, notes, recorded_at)
            VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [entry.id, entry.systolic, entry.diastolic, entry.pulse, entry.notes ?? '', entry.recordedAt]
        )
      }

      for (const entry of backup.foodLogs ?? []) {
        await client.query(
          `
            INSERT INTO food_logs (id, food_name, serving_size, sodium_mg, meal_type, barcode, logged_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
          `,
          [entry.id, entry.foodName, entry.servingSize, entry.sodiumMg, entry.mealType, entry.barcode ?? '', entry.loggedAt]
        )
      }

      for (const entry of backup.favoriteFoods ?? []) {
        await client.query(
          `
            INSERT INTO favorite_foods (id, food_name, serving_size, sodium_mg, meal_type, barcode, notes, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
          `,
          [
            entry.id,
            entry.foodName,
            entry.servingSize,
            entry.sodiumMg,
            entry.mealType,
            entry.barcode ?? '',
            entry.notes ?? '',
            entry.createdAt ?? null,
          ]
        )
      }

      for (const entry of backup.medicationLogs ?? []) {
        await client.query(
          `
            INSERT INTO medication_logs (id, medication_name, dosage, taken_at, notes)
            VALUES ($1, $2, $3, $4, $5)
          `,
          [entry.id, entry.medicationName, entry.dosage, entry.takenAt, entry.notes ?? '']
        )
      }

      for (const entry of backup.medicationSupplies ?? []) {
        await client.query(
          `
            INSERT INTO medication_supplies (id, medication_name, tablets_remaining, tablets_per_dose, low_threshold, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
          `,
          [
            entry.id,
            entry.medicationName,
            entry.tabletsRemaining,
            entry.tabletsPerDose ?? 1,
            entry.lowThreshold ?? 14,
          ]
        )
      }

      for (const entry of backup.reminders ?? []) {
        await client.query(
          `
            INSERT INTO reminders (id, title, reminder_type, time_of_day, enabled, medication_name, dosage, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            entry.id,
            entry.title,
            entry.reminderType,
            entry.timeOfDay,
            entry.enabled !== false,
            entry.medicationName ?? '',
            entry.dosage ?? '',
            entry.notes ?? '',
          ]
        )
      }

      for (const entry of backup.goalBadges ?? []) {
        await client.query(
          `
            INSERT INTO goal_badges (date_key, steps, sodium_total_mg, sodium_goal_mg, created_at)
            VALUES ($1, $2, $3, $4, COALESCE($5, NOW()))
          `,
          [entry.date, entry.steps, entry.sodiumTotalMg, entry.sodiumGoalMg, entry.createdAt ?? null]
        )
      }

      const fitbit = createBackupSafeFitbitState(backup.fitbit)
      await client.query(
        `
          INSERT INTO fitbit_connection (
            id, access_token, refresh_token, expires_at, scope, fitbit_user_id, profile_name, summary_json, history_json, updated_at
          )
          VALUES (1, $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, NOW())
          ON CONFLICT (id)
          DO UPDATE SET
            access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token,
            expires_at = EXCLUDED.expires_at,
            scope = EXCLUDED.scope,
            fitbit_user_id = EXCLUDED.fitbit_user_id,
            profile_name = EXCLUDED.profile_name,
            summary_json = EXCLUDED.summary_json,
            history_json = EXCLUDED.history_json,
            updated_at = NOW()
        `,
        [
          fitbit.connection?.accessToken ?? null,
          fitbit.connection?.refreshToken ?? null,
          fitbit.connection?.expiresAt ?? null,
          fitbit.connection?.scope ?? '',
          fitbit.connection?.fitbitUserId ?? '',
          fitbit.connection?.profileName ?? '',
          JSON.stringify(fitbit.summary ?? null),
          JSON.stringify(fitbit.history ?? []),
        ]
      )

      await client.query(
        'UPDATE app_settings SET privacy_pin_hash = $1, updated_at = NOW() WHERE id = 1',
        [backup.settings?.privacyPinHash ?? '']
      )

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    return this.getBackupData()
  }

  async saveFitbitState(nextState) {
    const current = await this.getFitbitState()
    const connection = nextState.connection ?? current.connection
    const hasSummary = Object.prototype.hasOwnProperty.call(nextState, 'summary')
    const summary = hasSummary ? nextState.summary : current.summary
    const history = Object.prototype.hasOwnProperty.call(nextState, 'history')
      ? normalizeFitbitHistory(nextState.history)
      : hasSummary
        ? mergeFitbitHistory(current.history, summary)
        : current.history

    await this.pool.query(
      `
        INSERT INTO fitbit_connection (
          id,
          access_token,
          refresh_token,
          expires_at,
          scope,
          fitbit_user_id,
          profile_name,
          summary_json,
          history_json,
          updated_at
        )
        VALUES (1, $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, NOW())
        ON CONFLICT (id)
        DO UPDATE SET
          access_token = EXCLUDED.access_token,
          refresh_token = EXCLUDED.refresh_token,
          expires_at = EXCLUDED.expires_at,
          scope = EXCLUDED.scope,
          fitbit_user_id = EXCLUDED.fitbit_user_id,
          profile_name = EXCLUDED.profile_name,
          summary_json = EXCLUDED.summary_json,
          history_json = EXCLUDED.history_json,
          updated_at = NOW()
      `,
      [
        connection?.accessToken ?? null,
        connection?.refreshToken ?? null,
        connection?.expiresAt ?? null,
        connection?.scope ?? '',
        connection?.fitbitUserId ?? '',
        connection?.profileName ?? '',
        JSON.stringify(summary ?? null),
        JSON.stringify(history),
      ]
    )

    return {
      connection,
      summary,
      history,
    }
  }

  async clearFitbitState() {
    await this.pool.query(
      `
        INSERT INTO fitbit_connection (
          id,
          access_token,
          refresh_token,
          expires_at,
          scope,
          fitbit_user_id,
          profile_name,
          summary_json,
          history_json,
          updated_at
        )
        VALUES (1, NULL, NULL, NULL, '', '', '', NULL, COALESCE((SELECT history_json FROM fitbit_connection WHERE id = 1), '[]'::jsonb), NOW())
        ON CONFLICT (id)
        DO UPDATE SET
          access_token = NULL,
          refresh_token = NULL,
          expires_at = NULL,
          scope = '',
          fitbit_user_id = '',
          profile_name = '',
          summary_json = NULL,
          history_json = COALESCE(fitbit_connection.history_json, '[]'::jsonb),
          updated_at = NOW()
      `
    )

    return {
      connection: null,
      summary: null,
    }
  }

  async addBloodPressureLog(entry) {
    await this.pool.query(
      `
        INSERT INTO blood_pressure_logs (id, systolic, diastolic, pulse, notes, recorded_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [entry.id, entry.systolic, entry.diastolic, entry.pulse, entry.notes, entry.recordedAt]
    )

    return entry
  }

  async deleteBloodPressureLog(id) {
    const result = await this.pool.query('DELETE FROM blood_pressure_logs WHERE id = $1', [id])
    return result.rowCount > 0
  }

  async addFoodLog(entry) {
    await this.pool.query(
      `
        INSERT INTO food_logs (id, food_name, serving_size, sodium_mg, meal_type, barcode, logged_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        entry.id,
        entry.foodName,
        entry.servingSize,
        entry.sodiumMg,
        entry.mealType,
        entry.barcode,
        entry.loggedAt,
      ]
    )

    return entry
  }

  async deleteFoodLog(id) {
    const result = await this.pool.query('DELETE FROM food_logs WHERE id = $1', [id])
    return result.rowCount > 0
  }
}

module.exports = {
  PostgresStore,
}
