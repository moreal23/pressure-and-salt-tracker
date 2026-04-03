import { listLastSevenDays, toDayKey } from './shared.js'

function createBackupSafeFitbitState(fitbitState) {
  return {
    connection: null,
    summary: fitbitState?.summary ?? null,
    history: fitbitState?.history ?? [],
    pendingAuthState: '',
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

function getCurrentWeekStart() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - date.getDay())
  return date
}

export class D1Store {
  constructor(env) {
    this.env = env
    this.storageMode = 'd1'
  }

  get db() {
    if (!this.env.DB) {
      throw new Error('Cloudflare D1 is not configured yet. Create the D1 database and bind it as DB.')
    }

    return this.env.DB
  }

  async ensureSetup() {
    try {
      await this.db.prepare("ALTER TABLE app_settings ADD COLUMN privacy_pin_hash TEXT NOT NULL DEFAULT ''").run()
    } catch {
      // The column already exists on upgraded databases.
    }

    try {
      await this.db.prepare("ALTER TABLE fitbit_connection ADD COLUMN history_json TEXT").run()
    } catch {
      // The column already exists on upgraded databases.
    }

    await this.db.prepare(
      `
        INSERT OR IGNORE INTO app_settings (id, sodium_goal_mg, updated_at)
        VALUES (1, 2300, CURRENT_TIMESTAMP)
      `
    ).run()

    await this.db.prepare(
      `
        CREATE TABLE IF NOT EXISTS favorite_foods (
          id TEXT PRIMARY KEY,
          food_name TEXT NOT NULL,
          serving_size TEXT NOT NULL,
          sodium_mg INTEGER NOT NULL,
          meal_type TEXT NOT NULL DEFAULT 'Meal',
          barcode TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `
    ).run()

    await this.db.prepare(
      `
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
        VALUES (1, NULL, NULL, NULL, '', '', '', NULL, '', CURRENT_TIMESTAMP)
      `
    ).run()

    await this.db.prepare(
      `
        CREATE TABLE IF NOT EXISTS auth_account (
          id INTEGER PRIMARY KEY,
          username TEXT NOT NULL DEFAULT '',
          password_hash TEXT NOT NULL DEFAULT '',
          password_salt TEXT NOT NULL DEFAULT '',
          session_hash TEXT NOT NULL DEFAULT '',
          session_expires_at TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `
    ).run()

    await this.db.prepare(
      `
        INSERT OR IGNORE INTO auth_account (
          id,
          username,
          password_hash,
          password_salt,
          session_hash,
          session_expires_at,
          updated_at
        )
        VALUES (1, '', '', '', '', NULL, CURRENT_TIMESTAMP)
      `
    ).run()

    await this.db.prepare(
      `
        CREATE TABLE IF NOT EXISTS goal_badges (
          date_key TEXT PRIMARY KEY,
          steps INTEGER NOT NULL,
          sodium_total_mg INTEGER NOT NULL,
          sodium_goal_mg INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `
    ).run()

    await this.db.prepare(
      `
        CREATE TABLE IF NOT EXISTS medication_logs (
          id TEXT PRIMARY KEY,
          medication_name TEXT NOT NULL,
          dosage TEXT NOT NULL,
          taken_at TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT ''
        )
      `
    ).run()

    await this.db.prepare(
      `
        CREATE TABLE IF NOT EXISTS reminders (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          reminder_type TEXT NOT NULL,
          time_of_day TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          medication_name TEXT NOT NULL DEFAULT '',
          dosage TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT ''
        )
      `
    ).run()

    await this.db.prepare(
      `
        CREATE TABLE IF NOT EXISTS reminder_deliveries (
          id TEXT PRIMARY KEY,
          reminder_id TEXT NOT NULL,
          day_key TEXT NOT NULL,
          channel TEXT NOT NULL,
          sent_at TEXT NOT NULL,
          UNIQUE(reminder_id, day_key, channel)
        )
      `
    ).run()
  }

  mapBloodPressureRow(row) {
    return {
      id: row.id,
      systolic: Number(row.systolic),
      diastolic: Number(row.diastolic),
      pulse: Number(row.pulse),
      notes: row.notes ?? '',
      recordedAt: row.recordedAt,
    }
  }

  mapFoodRow(row) {
    return {
      id: row.id,
      foodName: row.foodName,
      servingSize: row.servingSize,
      sodiumMg: Number(row.sodiumMg),
      mealType: row.mealType,
      barcode: row.barcode ?? '',
      loggedAt: row.loggedAt,
    }
  }

  mapFavoriteFoodRow(row) {
    return {
      id: row.id,
      foodName: row.foodName,
      servingSize: row.servingSize,
      sodiumMg: Number(row.sodiumMg),
      mealType: row.mealType,
      barcode: row.barcode ?? '',
      notes: row.notes ?? '',
      createdAt: row.createdAt,
    }
  }

  async getSettings() {
    await this.ensureSetup()
    const row = await this.db
      .prepare('SELECT sodium_goal_mg AS sodiumGoalMg FROM app_settings WHERE id = 1')
      .first()

    return {
      sodiumGoalMg: Number(row?.sodiumGoalMg ?? 2300),
    }
  }

  async getPrivacyPinHash() {
    await this.ensureSetup()
    const row = await this.db
      .prepare('SELECT privacy_pin_hash AS privacyPinHash FROM app_settings WHERE id = 1')
      .first()

    return row?.privacyPinHash ?? ''
  }

  async getAuthState() {
    await this.ensureSetup()
    const row = await this.db
      .prepare(
        `
          SELECT
            username,
            password_hash AS passwordHash,
            password_salt AS passwordSalt,
            session_hash AS sessionHash,
            session_expires_at AS sessionExpiresAt
          FROM auth_account
          WHERE id = 1
        `
      )
      .first()

    return {
      username: row?.username ?? '',
      passwordHash: row?.passwordHash ?? '',
      passwordSalt: row?.passwordSalt ?? '',
      sessionHash: row?.sessionHash ?? '',
      sessionExpiresAt: row?.sessionExpiresAt ?? '',
    }
  }

  async createAuthAccount(entry) {
    await this.ensureSetup()
    await this.db
      .prepare(
        `
          INSERT INTO auth_account (id, username, password_hash, password_salt, session_hash, session_expires_at, updated_at)
          VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id)
          DO UPDATE SET
            username = excluded.username,
            password_hash = excluded.password_hash,
            password_salt = excluded.password_salt,
            session_hash = excluded.session_hash,
            session_expires_at = excluded.session_expires_at,
            updated_at = CURRENT_TIMESTAMP
        `
      )
      .bind(
        entry.username,
        entry.passwordHash,
        entry.passwordSalt,
        entry.sessionHash ?? '',
        entry.sessionExpiresAt ?? null
      )
      .run()

    return this.getAuthState()
  }

  async saveAuthSession(entry) {
    await this.ensureSetup()
    await this.db
      .prepare(
        `
          UPDATE auth_account
          SET session_hash = ?, session_expires_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 1
        `
      )
      .bind(entry.sessionHash ?? '', entry.sessionExpiresAt ?? null)
      .run()

    return this.getAuthState()
  }

  async clearAuthSession() {
    await this.ensureSetup()
    await this.db
      .prepare(
        `
          UPDATE auth_account
          SET session_hash = '', session_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = 1
        `
      )
      .run()

    return this.getAuthState()
  }

  async updateSettings(nextSettings) {
    await this.ensureSetup()
    await this.db
      .prepare(
        `
          INSERT INTO app_settings (id, sodium_goal_mg, updated_at)
          VALUES (1, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id)
          DO UPDATE SET sodium_goal_mg = excluded.sodium_goal_mg, updated_at = CURRENT_TIMESTAMP
        `
      )
      .bind(nextSettings.sodiumGoalMg)
      .run()

    return this.getSettings()
  }

  async getBloodPressureLogs() {
    await this.ensureSetup()
    const result = await this.db
      .prepare(
        `
          SELECT
            id,
            systolic,
            diastolic,
            pulse,
            notes,
            recorded_at AS recordedAt
          FROM blood_pressure_logs
          ORDER BY recorded_at DESC
        `
      )
      .all()

    return (result.results ?? []).map((row) => this.mapBloodPressureRow(row))
  }

  async getFoodLogs() {
    await this.ensureSetup()
    const result = await this.db
      .prepare(
        `
          SELECT
            id,
            food_name AS foodName,
            serving_size AS servingSize,
            sodium_mg AS sodiumMg,
            meal_type AS mealType,
            barcode,
            logged_at AS loggedAt
          FROM food_logs
          ORDER BY logged_at DESC
        `
      )
      .all()

    return (result.results ?? []).map((row) => this.mapFoodRow(row))
  }

  async getFavoriteFoods() {
    await this.ensureSetup()
    const result = await this.db
      .prepare(
        `
          SELECT
            id,
            food_name AS foodName,
            serving_size AS servingSize,
            sodium_mg AS sodiumMg,
            meal_type AS mealType,
            barcode,
            notes,
            created_at AS createdAt
          FROM favorite_foods
          ORDER BY created_at DESC
        `
      )
      .all()

    return (result.results ?? []).map((row) => this.mapFavoriteFoodRow(row))
  }

  async addFavoriteFood(entry) {
    await this.ensureSetup()
    const createdAt = entry.createdAt ?? new Date().toISOString()
    await this.db
      .prepare(
        `
          INSERT INTO favorite_foods (id, food_name, serving_size, sodium_mg, meal_type, barcode, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        entry.id,
        entry.foodName,
        entry.servingSize,
        entry.sodiumMg,
        entry.mealType,
        entry.barcode ?? '',
        entry.notes ?? '',
        createdAt
      )
      .run()

    return {
      ...entry,
      barcode: entry.barcode ?? '',
      notes: entry.notes ?? '',
      createdAt,
    }
  }

  async deleteFavoriteFood(id) {
    await this.ensureSetup()
    const result = await this.db.prepare('DELETE FROM favorite_foods WHERE id = ?').bind(id).run()
    return Number(result.meta?.changes ?? 0) > 0
  }

  async findFavoriteFoodByBarcode(barcode) {
    await this.ensureSetup()
    const row = await this.db
      .prepare(
        `
          SELECT
            id,
            food_name AS foodName,
            serving_size AS servingSize,
            sodium_mg AS sodiumMg,
            meal_type AS mealType,
            barcode,
            notes,
            created_at AS createdAt
          FROM favorite_foods
          WHERE barcode = ?
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
      .bind(barcode)
      .first()

    return row ? this.mapFavoriteFoodRow(row) : null
  }

  async getPrivacyStatus() {
    return {
      pinEnabled: Boolean(await this.getPrivacyPinHash()),
    }
  }

  async setPrivacyPinHash(hash) {
    await this.ensureSetup()
    await this.db
      .prepare('UPDATE app_settings SET privacy_pin_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
      .bind(hash)
      .run()

    return this.getPrivacyStatus()
  }

  async verifyPrivacyPinHash(hash) {
    const savedHash = await this.getPrivacyPinHash()
    return Boolean(savedHash) && savedHash === hash
  }

  async clearPrivacyPinHash() {
    await this.ensureSetup()
    await this.db
      .prepare("UPDATE app_settings SET privacy_pin_hash = '', updated_at = CURRENT_TIMESTAMP WHERE id = 1")
      .run()

    return this.getPrivacyStatus()
  }

  async addBloodPressureLog(entry) {
    await this.ensureSetup()
    await this.db
      .prepare(
        `
          INSERT INTO blood_pressure_logs (id, systolic, diastolic, pulse, notes, recorded_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `
      )
      .bind(entry.id, entry.systolic, entry.diastolic, entry.pulse, entry.notes, entry.recordedAt)
      .run()

    return entry
  }

  async deleteBloodPressureLog(id) {
    await this.ensureSetup()
    const result = await this.db.prepare('DELETE FROM blood_pressure_logs WHERE id = ?').bind(id).run()
    return Number(result.meta?.changes ?? 0) > 0
  }

  async addFoodLog(entry) {
    await this.ensureSetup()
    await this.db
      .prepare(
        `
          INSERT INTO food_logs (id, food_name, serving_size, sodium_mg, meal_type, barcode, logged_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        entry.id,
        entry.foodName,
        entry.servingSize,
        entry.sodiumMg,
        entry.mealType,
        entry.barcode,
        entry.loggedAt
      )
      .run()

    return entry
  }

  async deleteFoodLog(id) {
    await this.ensureSetup()
    const result = await this.db.prepare('DELETE FROM food_logs WHERE id = ?').bind(id).run()
    return Number(result.meta?.changes ?? 0) > 0
  }

  async getFitbitState() {
    await this.ensureSetup()
    const row = await this.db
      .prepare(
        `
          SELECT
            access_token AS accessToken,
            refresh_token AS refreshToken,
            expires_at AS expiresAt,
            scope,
            fitbit_user_id AS fitbitUserId,
            profile_name AS profileName,
            summary_json AS summaryJson,
            history_json AS historyJson,
            pending_auth_state AS pendingAuthState
          FROM fitbit_connection
          WHERE id = 1
        `
      )
      .first()

    const summary = row?.summaryJson ? JSON.parse(row.summaryJson) : null
    const hasConnection = Boolean(row?.accessToken)
    const history = row?.historyJson ? normalizeFitbitHistory(JSON.parse(row.historyJson)) : []

    return {
      connection: hasConnection
        ? {
            accessToken: row.accessToken,
            refreshToken: row.refreshToken,
            expiresAt: row.expiresAt,
            scope: row.scope ?? '',
            fitbitUserId: row.fitbitUserId ?? '',
            profileName: row.profileName ?? '',
          }
        : null,
      summary,
      history,
      pendingAuthState: row?.pendingAuthState ?? '',
    }
  }

  async getGoalBadges() {
    await this.ensureSetup()
    const result = await this.db
      .prepare(
        `
          SELECT
            date_key AS date,
            steps,
            sodium_total_mg AS sodiumTotalMg,
            sodium_goal_mg AS sodiumGoalMg,
            created_at AS createdAt
          FROM goal_badges
          ORDER BY date_key DESC
        `
      )
      .all()

    return (result.results ?? []).map((row) => ({
      date: row.date,
      steps: Number(row.steps),
      sodiumTotalMg: Number(row.sodiumTotalMg),
      sodiumGoalMg: Number(row.sodiumGoalMg),
      createdAt: row.createdAt,
    }))
  }

  async claimGoalBadge(badge) {
    await this.ensureSetup()
    const result = await this.db
      .prepare(
        `
          INSERT OR IGNORE INTO goal_badges (date_key, steps, sodium_total_mg, sodium_goal_mg, created_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `
      )
      .bind(badge.date, badge.steps, badge.sodiumTotalMg, badge.sodiumGoalMg)
      .run()

    const savedBadge = await this.db
      .prepare(
        `
          SELECT
            date_key AS date,
            steps,
            sodium_total_mg AS sodiumTotalMg,
            sodium_goal_mg AS sodiumGoalMg,
            created_at AS createdAt
          FROM goal_badges
          WHERE date_key = ?
        `
      )
      .bind(badge.date)
      .first()

    return {
      created: Number(result.meta?.changes ?? 0) > 0,
      badge: savedBadge
        ? {
            date: savedBadge.date,
            steps: Number(savedBadge.steps),
            sodiumTotalMg: Number(savedBadge.sodiumTotalMg),
            sodiumGoalMg: Number(savedBadge.sodiumGoalMg),
            createdAt: savedBadge.createdAt,
          }
        : null,
      goalBadges: await this.getGoalBadges(),
    }
  }

  async getMedicationLogs() {
    await this.ensureSetup()
    await this.db
      .prepare('DELETE FROM medication_logs WHERE taken_at < ?')
      .bind(getCurrentWeekStart().toISOString())
      .run()

    const result = await this.db
      .prepare(
        `
          SELECT
            id,
            medication_name AS medicationName,
            dosage,
            taken_at AS takenAt,
            notes
          FROM medication_logs
          ORDER BY taken_at DESC
        `
      )
      .all()

    return result.results ?? []
  }

  async addMedicationLog(entry) {
    await this.ensureSetup()
    await this.db
      .prepare('DELETE FROM medication_logs WHERE taken_at < ?')
      .bind(getCurrentWeekStart().toISOString())
      .run()

    await this.db
      .prepare(
        `
          INSERT INTO medication_logs (id, medication_name, dosage, taken_at, notes)
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .bind(entry.id, entry.medicationName, entry.dosage, entry.takenAt, entry.notes)
      .run()

    return entry
  }

  async deleteMedicationLog(id) {
    await this.ensureSetup()
    const result = await this.db.prepare('DELETE FROM medication_logs WHERE id = ?').bind(id).run()
    return Number(result.meta?.changes ?? 0) > 0
  }

  async getReminders() {
    await this.ensureSetup()
    const result = await this.db
      .prepare(
        `
          SELECT
            id,
            title,
            reminder_type AS reminderType,
            time_of_day AS timeOfDay,
            enabled,
            medication_name AS medicationName,
            dosage,
            notes
          FROM reminders
          ORDER BY time_of_day ASC, title ASC
        `
      )
      .all()

    return (result.results ?? []).map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
    }))
  }

  async addReminder(entry) {
    await this.ensureSetup()
    await this.db
      .prepare(
        `
          INSERT INTO reminders (id, title, reminder_type, time_of_day, enabled, medication_name, dosage, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .bind(
        entry.id,
        entry.title,
        entry.reminderType,
        entry.timeOfDay,
        entry.enabled ? 1 : 0,
        entry.medicationName,
        entry.dosage,
        entry.notes
      )
      .run()

    return entry
  }

  async deleteReminder(id) {
    await this.ensureSetup()
    const result = await this.db.prepare('DELETE FROM reminders WHERE id = ?').bind(id).run()
    return Number(result.meta?.changes ?? 0) > 0
  }

  async hasReminderDelivery(reminderId, dayKey, channel) {
    await this.ensureSetup()
    const result = await this.db
      .prepare(
        `
          SELECT id
          FROM reminder_deliveries
          WHERE reminder_id = ? AND day_key = ? AND channel = ?
          LIMIT 1
        `
      )
      .bind(reminderId, dayKey, channel)
      .first()

    return Boolean(result?.id)
  }

  async recordReminderDelivery(entry) {
    await this.ensureSetup()
    await this.db
      .prepare(
        `
          INSERT OR IGNORE INTO reminder_deliveries (id, reminder_id, day_key, channel, sent_at)
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .bind(entry.id, entry.reminderId, entry.dayKey, entry.channel, entry.sentAt)
      .run()

    return entry
  }

  async getBackupData() {
    const [settings, privacyPinHash, bloodPressureLogs, foodLogs, favoriteFoods, medicationLogs, reminders, fitbit, goalBadges] =
      await Promise.all([
        this.getSettings(),
        this.getPrivacyPinHash(),
        this.getBloodPressureLogs(),
        this.getFoodLogs(),
        this.getFavoriteFoods(),
        this.getMedicationLogs(),
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
        reminders,
        fitbit: createBackupSafeFitbitState(fitbit),
        goalBadges,
      },
    }
  }

  async restoreBackupData(backup) {
    await this.ensureSetup()
    await this.db.batch([
      this.db.prepare('DELETE FROM blood_pressure_logs'),
      this.db.prepare('DELETE FROM food_logs'),
      this.db.prepare('DELETE FROM favorite_foods'),
      this.db.prepare('DELETE FROM medication_logs'),
      this.db.prepare('DELETE FROM reminders'),
      this.db.prepare('DELETE FROM goal_badges'),
      this.db.prepare('DELETE FROM fitbit_connection'),
    ])

    await this.updateSettings(backup.settings ?? { sodiumGoalMg: 2300 })

    for (const entry of backup.bloodPressureLogs ?? []) {
      await this.addBloodPressureLog({
        id: entry.id,
        systolic: Number(entry.systolic),
        diastolic: Number(entry.diastolic),
        pulse: Number(entry.pulse),
        notes: entry.notes ?? '',
        recordedAt: entry.recordedAt,
      })
    }

    for (const entry of backup.foodLogs ?? []) {
      await this.addFoodLog({
        id: entry.id,
        foodName: entry.foodName,
        servingSize: entry.servingSize,
        sodiumMg: Number(entry.sodiumMg),
        mealType: entry.mealType,
        barcode: entry.barcode ?? '',
        loggedAt: entry.loggedAt,
      })
    }

    for (const entry of backup.favoriteFoods ?? []) {
      await this.addFavoriteFood({
        id: entry.id,
        foodName: entry.foodName,
        servingSize: entry.servingSize,
        sodiumMg: Number(entry.sodiumMg),
        mealType: entry.mealType,
        barcode: entry.barcode ?? '',
        notes: entry.notes ?? '',
        createdAt: entry.createdAt ?? null,
      })
    }

    for (const entry of backup.medicationLogs ?? []) {
      await this.addMedicationLog({
        id: entry.id,
        medicationName: entry.medicationName,
        dosage: entry.dosage,
        takenAt: entry.takenAt,
        notes: entry.notes ?? '',
      })
    }

    for (const entry of backup.reminders ?? []) {
      await this.addReminder({
        id: entry.id,
        title: entry.title,
        reminderType: entry.reminderType,
        timeOfDay: entry.timeOfDay,
        enabled: entry.enabled !== false,
        medicationName: entry.medicationName ?? '',
        dosage: entry.dosage ?? '',
        notes: entry.notes ?? '',
      })
    }

    for (const entry of backup.goalBadges ?? []) {
      await this.claimGoalBadge({
        date: entry.date,
        steps: Number(entry.steps),
        sodiumTotalMg: Number(entry.sodiumTotalMg),
        sodiumGoalMg: Number(entry.sodiumGoalMg),
      })
    }

    await this.saveFitbitState(createBackupSafeFitbitState(backup.fitbit))
    await this.setPrivacyPinHash(backup.settings?.privacyPinHash ?? '')
    return this.getBackupData()
  }

  async saveFitbitState(nextState) {
    await this.ensureSetup()
    const current = await this.getFitbitState()
    const connection =
      nextState.connection === null
        ? null
        : nextState.connection
          ? { ...(current.connection ?? {}), ...nextState.connection }
          : current.connection
    const summary = Object.prototype.hasOwnProperty.call(nextState, 'summary')
      ? nextState.summary
      : current.summary
    const history = Object.prototype.hasOwnProperty.call(nextState, 'history')
      ? normalizeFitbitHistory(nextState.history)
      : Object.prototype.hasOwnProperty.call(nextState, 'summary')
        ? mergeFitbitHistory(current.history, summary)
        : current.history
    const pendingAuthState = Object.prototype.hasOwnProperty.call(nextState, 'pendingAuthState')
      ? nextState.pendingAuthState
      : current.pendingAuthState

    await this.db
      .prepare(
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
            pending_auth_state,
            updated_at
          )
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id)
          DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            expires_at = excluded.expires_at,
            scope = excluded.scope,
            fitbit_user_id = excluded.fitbit_user_id,
            profile_name = excluded.profile_name,
            summary_json = excluded.summary_json,
            history_json = excluded.history_json,
            pending_auth_state = excluded.pending_auth_state,
            updated_at = CURRENT_TIMESTAMP
        `
      )
      .bind(
        connection?.accessToken ?? null,
        connection?.refreshToken ?? null,
        connection?.expiresAt ?? null,
        connection?.scope ?? '',
        connection?.fitbitUserId ?? '',
        connection?.profileName ?? '',
        summary != null ? JSON.stringify(summary) : null,
        JSON.stringify(history),
        pendingAuthState ?? ''
      )
      .run()

    return {
      connection,
      summary,
      history,
      pendingAuthState,
    }
  }

  async clearFitbitState() {
    return this.saveFitbitState({
      connection: null,
      summary: null,
      pendingAuthState: '',
    })
  }

  async getDashboard() {
    const [settings, bloodPressureLogs, foodLogs] = await Promise.all([
      this.getSettings(),
      this.getBloodPressureLogs(),
      this.getFoodLogs(),
    ])
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
}
