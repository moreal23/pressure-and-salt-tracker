import { listLastSevenDays, toDayKey } from './shared.js'

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
    await this.db.prepare(
      `
        INSERT OR IGNORE INTO app_settings (id, sodium_goal_mg, updated_at)
        VALUES (1, 2300, CURRENT_TIMESTAMP)
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
        CREATE TABLE IF NOT EXISTS goal_badges (
          date_key TEXT PRIMARY KEY,
          steps INTEGER NOT NULL,
          sodium_total_mg INTEGER NOT NULL,
          sodium_goal_mg INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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

  async getSettings() {
    await this.ensureSetup()
    const row = await this.db
      .prepare('SELECT sodium_goal_mg AS sodiumGoalMg FROM app_settings WHERE id = 1')
      .first()

    return {
      sodiumGoalMg: Number(row?.sodiumGoalMg ?? 2300),
    }
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
            pending_auth_state AS pendingAuthState
          FROM fitbit_connection
          WHERE id = 1
        `
      )
      .first()

    const summary = row?.summaryJson ? JSON.parse(row.summaryJson) : null
    const hasConnection = Boolean(row?.accessToken)

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
            pending_auth_state,
            updated_at
          )
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id)
          DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            expires_at = excluded.expires_at,
            scope = excluded.scope,
            fitbit_user_id = excluded.fitbit_user_id,
            profile_name = excluded.profile_name,
            summary_json = excluded.summary_json,
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
        pendingAuthState ?? ''
      )
      .run()

    return {
      connection,
      summary,
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
