const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { createSeedData } = require('./seed')

const dataFilePath = path.join(__dirname, '..', '..', 'data', 'dev-data.json')

function createBackupSafeFitbitState(fitbitState) {
  return {
    connection: null,
    summary: fitbitState?.summary ?? null,
    pendingAuthState: '',
  }
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

class JsonStore {
  constructor() {
    this.storageMode = 'json'
  }

  async ensureDataFile() {
    try {
      await fs.access(dataFilePath)
    } catch {
      const seed = createSeedData()
      await fs.mkdir(path.dirname(dataFilePath), { recursive: true })
      await fs.writeFile(dataFilePath, JSON.stringify(seed, null, 2))
    }
  }

  async readData() {
    await this.ensureDataFile()
    const raw = await fs.readFile(dataFilePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed.fitbit) {
      parsed.fitbit = {
        connection: null,
        summary: null,
      }
    }
    if (!parsed.goalBadges) {
      parsed.goalBadges = []
    }
    if (!parsed.medicationLogs) {
      parsed.medicationLogs = []
    }
    if (!parsed.reminders) {
      parsed.reminders = []
    }
    if (!parsed.reminderDeliveries) {
      parsed.reminderDeliveries = []
    }
    if (!parsed.favoriteFoods) {
      parsed.favoriteFoods = []
    }
    if (!parsed.settings) {
      parsed.settings = { sodiumGoalMg: 2300, privacyPinHash: '' }
    }
    if (!parsed.settings.privacyPinHash) {
      parsed.settings.privacyPinHash = ''
    }
    parsed.reminders = parsed.reminders.map((entry) => ({
      dosage: '',
      ...entry,
    }))
    return parsed
  }

  async writeData(data) {
    await fs.writeFile(dataFilePath, JSON.stringify(data, null, 2))
  }

  async getDashboard() {
    const data = await this.readData()
    const todayKey = toDayKey(new Date())
    const todayFoods = data.foodLogs.filter((entry) => toDayKey(entry.loggedAt) === todayKey)
    const todayReadings = data.bloodPressureLogs.filter((entry) => toDayKey(entry.recordedAt) === todayKey)
    const sodiumTotalMg = todayFoods.reduce((total, entry) => total + entry.sodiumMg, 0)
    const recentBloodPressure = [...data.bloodPressureLogs]
      .sort((left, right) => new Date(right.recordedAt) - new Date(left.recordedAt))
      .slice(0, 5)
    const recentFoodLogs = [...data.foodLogs]
      .sort((left, right) => new Date(right.loggedAt) - new Date(left.loggedAt))
      .slice(0, 6)
    const latestBloodPressure = recentBloodPressure[0] ?? null
    const weeklyTrend = listLastSevenDays().map((date) => {
      const key = toDayKey(date)
      const foods = data.foodLogs.filter((entry) => toDayKey(entry.loggedAt) === key)
      const readings = data.bloodPressureLogs.filter((entry) => toDayKey(entry.recordedAt) === key)

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
      settings: data.settings,
      latestBloodPressure,
      recentBloodPressure,
      recentFoodLogs,
      today: {
        date: todayKey,
        sodiumTotalMg,
        sodiumRemainingMg: data.settings.sodiumGoalMg - sodiumTotalMg,
        sodiumPercent: Math.round((sodiumTotalMg / data.settings.sodiumGoalMg) * 100),
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
        totalEntries: data.bloodPressureLogs.length + data.foodLogs.length,
      },
      weeklyTrend,
    }
  }

  async updateSettings(nextSettings) {
    const data = await this.readData()
    data.settings = {
      ...data.settings,
      ...nextSettings,
    }
    await this.writeData(data)
    return data.settings
  }

  async getBloodPressureLogs() {
    const data = await this.readData()
    return [...data.bloodPressureLogs].sort(
      (left, right) => new Date(right.recordedAt) - new Date(left.recordedAt)
    )
  }

  async getFoodLogs() {
    const data = await this.readData()
    return [...data.foodLogs].sort((left, right) => new Date(right.loggedAt) - new Date(left.loggedAt))
  }

  async getFavoriteFoods() {
    const data = await this.readData()
    return [...data.favoriteFoods].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
  }

  async addFavoriteFood(entry) {
    const data = await this.readData()
    const nextEntry = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      ...entry,
    }
    data.favoriteFoods.push(nextEntry)
    await this.writeData(data)
    return nextEntry
  }

  async deleteFavoriteFood(id) {
    const data = await this.readData()
    const nextFavorites = data.favoriteFoods.filter((entry) => entry.id !== id)

    if (nextFavorites.length === data.favoriteFoods.length) {
      return false
    }

    data.favoriteFoods = nextFavorites
    await this.writeData(data)
    return true
  }

  async findFavoriteFoodByBarcode(barcode) {
    const normalizedBarcode = String(barcode ?? '').trim()

    if (!normalizedBarcode) {
      return null
    }

    const favorites = await this.getFavoriteFoods()
    return favorites.find((entry) => String(entry.barcode ?? '').trim() === normalizedBarcode) ?? null
  }

  async getPrivacyStatus() {
    const data = await this.readData()
    return {
      pinEnabled: Boolean(data.settings?.privacyPinHash),
    }
  }

  async getPrivacyPinHash() {
    const data = await this.readData()
    return data.settings?.privacyPinHash ?? ''
  }

  async setPrivacyPinHash(hash) {
    const data = await this.readData()
    data.settings = {
      ...data.settings,
      privacyPinHash: hash,
    }
    await this.writeData(data)
    return this.getPrivacyStatus()
  }

  async verifyPrivacyPinHash(hash) {
    const savedHash = await this.getPrivacyPinHash()
    return Boolean(savedHash) && savedHash === hash
  }

  async clearPrivacyPinHash() {
    const data = await this.readData()
    data.settings = {
      ...data.settings,
      privacyPinHash: '',
    }
    await this.writeData(data)
    return this.getPrivacyStatus()
  }

  async getFitbitState() {
    const data = await this.readData()
    return data.fitbit ?? {
      connection: null,
      summary: null,
    }
  }

  async getGoalBadges() {
    const data = await this.readData()
    return [...data.goalBadges].sort((left, right) => right.date.localeCompare(left.date))
  }

  async claimGoalBadge(badge) {
    const data = await this.readData()
    const existingBadge = data.goalBadges.find((entry) => entry.date === badge.date)

    if (existingBadge) {
      return {
        created: false,
        badge: existingBadge,
        goalBadges: [...data.goalBadges].sort((left, right) => right.date.localeCompare(left.date)),
      }
    }

    data.goalBadges.push(badge)
    data.goalBadges.sort((left, right) => right.date.localeCompare(left.date))
    await this.writeData(data)

    return {
      created: true,
      badge,
      goalBadges: data.goalBadges,
    }
  }

  async getMedicationLogs() {
    const data = await this.readData()
    const cutoff = getCurrentWeekStart().getTime()
    const nextLogs = data.medicationLogs.filter((entry) => new Date(entry.takenAt).getTime() >= cutoff)

    if (nextLogs.length !== data.medicationLogs.length) {
      data.medicationLogs = nextLogs
      await this.writeData(data)
    }

    return [...data.medicationLogs].sort((left, right) => new Date(right.takenAt) - new Date(left.takenAt))
  }

  async addMedicationLog(entry) {
    const data = await this.readData()
    const cutoff = getCurrentWeekStart().getTime()
    data.medicationLogs = data.medicationLogs.filter((item) => new Date(item.takenAt).getTime() >= cutoff)
    const nextEntry = {
      id: randomUUID(),
      ...entry,
    }
    data.medicationLogs.push(nextEntry)
    await this.writeData(data)
    return nextEntry
  }

  async deleteMedicationLog(id) {
    const data = await this.readData()
    const nextLogs = data.medicationLogs.filter((entry) => entry.id !== id)

    if (nextLogs.length === data.medicationLogs.length) {
      return false
    }

    data.medicationLogs = nextLogs
    await this.writeData(data)
    return true
  }

  async getReminders() {
    const data = await this.readData()
    return [...data.reminders].sort((left, right) => left.timeOfDay.localeCompare(right.timeOfDay))
  }

  async addReminder(entry) {
    const data = await this.readData()
    const nextEntry = {
      id: randomUUID(),
      dosage: '',
      ...entry,
    }
    data.reminders.push(nextEntry)
    await this.writeData(data)
    return nextEntry
  }

  async deleteReminder(id) {
    const data = await this.readData()
    const nextReminders = data.reminders.filter((entry) => entry.id !== id)

    if (nextReminders.length === data.reminders.length) {
      return false
    }

    data.reminders = nextReminders
    await this.writeData(data)
    return true
  }

  async hasReminderDelivery(reminderId, dayKey, channel) {
    const data = await this.readData()
    return data.reminderDeliveries.some(
      (entry) => entry.reminderId === reminderId && entry.dayKey === dayKey && entry.channel === channel
    )
  }

  async recordReminderDelivery(entry) {
    const data = await this.readData()
    const exists = data.reminderDeliveries.some(
      (item) => item.reminderId === entry.reminderId && item.dayKey === entry.dayKey && item.channel === entry.channel
    )

    if (!exists) {
      data.reminderDeliveries.push({
        id: randomUUID(),
        ...entry,
      })
      await this.writeData(data)
    }

    return entry
  }

  async getBackupData() {
    const data = await this.readData()
    return {
      exportedAt: new Date().toISOString(),
      version: 1,
      data: {
        ...data,
        fitbit: createBackupSafeFitbitState(data.fitbit),
      },
    }
  }

  async restoreBackupData(backup) {
    const nextData = {
      settings: backup.settings ?? { sodiumGoalMg: 2300 },
      bloodPressureLogs: backup.bloodPressureLogs ?? [],
      foodLogs: backup.foodLogs ?? [],
      medicationLogs: backup.medicationLogs ?? [],
      reminders: backup.reminders ?? [],
      favoriteFoods: backup.favoriteFoods ?? [],
      fitbit: createBackupSafeFitbitState(backup.fitbit),
      goalBadges: backup.goalBadges ?? [],
    }

    nextData.settings = {
      sodiumGoalMg: nextData.settings.sodiumGoalMg ?? 2300,
      privacyPinHash: nextData.settings.privacyPinHash ?? '',
    }

    await this.writeData(nextData)
    return this.getBackupData()
  }

  async saveFitbitState(nextState) {
    const data = await this.readData()
    data.fitbit = {
      connection: null,
      summary: null,
      ...(data.fitbit ?? {}),
      ...nextState,
    }
    await this.writeData(data)
    return data.fitbit
  }

  async clearFitbitState() {
    const data = await this.readData()
    data.fitbit = {
      connection: null,
      summary: null,
    }
    await this.writeData(data)
    return data.fitbit
  }

  async addBloodPressureLog(entry) {
    const data = await this.readData()
    const nextEntry = {
      id: randomUUID(),
      ...entry,
    }
    data.bloodPressureLogs.push(nextEntry)
    await this.writeData(data)
    return nextEntry
  }

  async deleteBloodPressureLog(id) {
    const data = await this.readData()
    const nextLogs = data.bloodPressureLogs.filter((entry) => entry.id !== id)

    if (nextLogs.length === data.bloodPressureLogs.length) {
      return false
    }

    data.bloodPressureLogs = nextLogs
    await this.writeData(data)
    return true
  }

  async addFoodLog(entry) {
    const data = await this.readData()
    const nextEntry = {
      id: randomUUID(),
      ...entry,
    }
    data.foodLogs.push(nextEntry)
    await this.writeData(data)
    return nextEntry
  }

  async deleteFoodLog(id) {
    const data = await this.readData()
    const nextLogs = data.foodLogs.filter((entry) => entry.id !== id)

    if (nextLogs.length === data.foodLogs.length) {
      return false
    }

    data.foodLogs = nextLogs
    await this.writeData(data)
    return true
  }
}

module.exports = {
  JsonStore,
}
