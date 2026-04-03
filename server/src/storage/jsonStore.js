const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { createSeedData } = require('./seed')

const dataFilePath = path.join(__dirname, '..', '..', 'data', 'dev-data.json')

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

  async getFitbitState() {
    const data = await this.readData()
    return data.fitbit ?? {
      connection: null,
      summary: null,
    }
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
