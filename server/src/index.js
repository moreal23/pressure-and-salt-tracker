const express = require('express')
const cors = require('cors')
const { z } = require('zod')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { attachId, createStore } = require('./storage')

const app = express()
const port = Number(process.env.PORT ?? 4000)

const barcodeFallbacks = {
  '041196910503': {
    foodName: 'Campbell tomato soup',
    servingSize: '1 cup',
    sodiumMg: 920,
  },
  '013800100125': {
    foodName: 'Frozen chicken dinner',
    servingSize: '1 tray',
    sodiumMg: 870,
  },
  '070662030057': {
    foodName: 'Instant noodles',
    servingSize: '1 pack',
    sodiumMg: 1460,
  },
}

const settingsSchema = z.object({
  sodiumGoalMg: z.number().int().min(500).max(10000),
})

const bloodPressureSchema = z.object({
  systolic: z.number().int().min(50).max(280),
  diastolic: z.number().int().min(30).max(200),
  pulse: z.number().int().min(30).max(220),
  notes: z.string().max(600).default(''),
  recordedAt: z.string().datetime(),
})

const foodLogSchema = z.object({
  foodName: z.string().min(2).max(180),
  servingSize: z.string().min(1).max(120),
  sodiumMg: z.number().int().min(0).max(10000),
  mealType: z.string().min(1).max(40).default('Meal'),
  barcode: z.string().max(80).optional().default(''),
  loggedAt: z.string().datetime(),
})

const importSchema = z.object({
  rawText: z.string().min(8).max(100000),
})

const goalBadgeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  steps: z.number().int().min(0).max(200000),
  sodiumTotalMg: z.number().int().min(0).max(10000),
  sodiumGoalMg: z.number().int().min(500).max(10000),
})

let storePromise = createStore()
let fitbitAuthState = ''
const clientDistPath = path.resolve(__dirname, '..', '..', 'client', 'dist')

app.use(cors())
app.use(express.json())

const fitbitConfig = {
  clientId: process.env.FITBIT_CLIENT_ID ?? '',
  clientSecret: process.env.FITBIT_CLIENT_SECRET ?? '',
  redirectUri: process.env.FITBIT_REDIRECT_URI ?? 'http://localhost:4000/api/fitbit/callback',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  scopes: (process.env.FITBIT_SCOPES ?? 'activity heartrate profile sleep weight')
    .split(/\s+/)
    .filter(Boolean),
}

function isFitbitConfigured() {
  return Boolean(fitbitConfig.clientId && fitbitConfig.clientSecret && fitbitConfig.redirectUri)
}

function buildFitbitFrontendRedirect(status, message = '') {
  const url = new URL(fitbitConfig.frontendUrl)
  url.searchParams.set('fitbit', status)

  if (message) {
    url.searchParams.set('message', message)
  }

  return url.toString()
}

function getFitbitAuthorizationHeader() {
  return `Basic ${Buffer.from(`${fitbitConfig.clientId}:${fitbitConfig.clientSecret}`).toString('base64')}`
}

function buildFitbitAuthorizeUrl() {
  fitbitAuthState = randomUUID()

  const params = new URLSearchParams({
    client_id: fitbitConfig.clientId,
    response_type: 'code',
    scope: fitbitConfig.scopes.join(' '),
    redirect_uri: fitbitConfig.redirectUri,
    expires_in: '31536000',
    state: fitbitAuthState,
  })

  return `https://www.fitbit.com/oauth2/authorize?${params.toString()}`
}

async function exchangeFitbitToken(body) {
  const response = await fetch('https://api.fitbit.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: getFitbitAuthorizationHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  })

  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(payload.errors?.[0]?.message ?? 'Fitbit token exchange failed.')
  }

  return payload
}

async function fetchFitbitJson(path, accessToken, options = {}) {
  const response = await fetch(`https://api.fitbit.com${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (options.optional && !response.ok) {
    return null
  }

  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(payload.errors?.[0]?.message ?? `Fitbit request failed for ${path}.`)
  }

  return payload
}

async function refreshFitbitConnectionIfNeeded(store) {
  const fitbitState = await store.getFitbitState()
  const connection = fitbitState.connection

  if (!connection) {
    return fitbitState
  }

  const expiresAt = connection.expiresAt ? new Date(connection.expiresAt).getTime() : 0

  if (expiresAt > Date.now() + 60_000) {
    return fitbitState
  }

  const refreshed = await exchangeFitbitToken({
    grant_type: 'refresh_token',
    refresh_token: connection.refreshToken,
  })

  return store.saveFitbitState({
    connection: {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? connection.refreshToken,
      expiresAt: new Date(Date.now() + Number(refreshed.expires_in ?? 3600) * 1000).toISOString(),
      scope: refreshed.scope ?? connection.scope,
      fitbitUserId: refreshed.user_id ?? connection.fitbitUserId,
      profileName: connection.profileName ?? '',
    },
    summary: fitbitState.summary,
  })
}

async function fetchFitbitSummary(accessToken) {
  const today = new Date().toISOString().slice(0, 10)
  const [profile, steps, heart, sleep, weight] = await Promise.all([
    fetchFitbitJson('/1/user/-/profile.json', accessToken, { optional: true }),
    fetchFitbitJson(`/1/user/-/activities/steps/date/${today}/1d.json`, accessToken, { optional: true }),
    fetchFitbitJson(`/1/user/-/activities/heart/date/${today}/1d/1min.json`, accessToken, { optional: true }),
    fetchFitbitJson(`/1.2/user/-/sleep/date/${today}.json`, accessToken, { optional: true }),
    fetchFitbitJson(`/1/user/-/body/log/weight/date/${today}.json`, accessToken, { optional: true }),
  ])

  const heartDataset = heart?.['activities-heart-intraday']?.dataset ?? []
  const latestHeartPoint = heartDataset[heartDataset.length - 1] ?? null
  const sleepSummary = sleep?.summary ?? {}
  const weightEntry = weight?.weight?.[0] ?? null

  return {
    profileName: profile?.user?.displayName ?? profile?.user?.fullName ?? '',
    memberSince: profile?.user?.memberSince ?? '',
    stepsToday: Number(steps?.['activities-steps']?.[0]?.value ?? 0),
    restingHeartRate: heart?.['activities-heart']?.[0]?.value?.restingHeartRate ?? null,
    latestHeartRate: latestHeartPoint?.value ?? null,
    latestHeartRateTime: latestHeartPoint?.time ?? '',
    sleepMinutes: sleepSummary.totalMinutesAsleep ?? 0,
    sleepRecords: sleepSummary.totalSleepRecords ?? 0,
    weightValue: weightEntry?.weight ?? null,
    weightDate: weightEntry?.date ?? '',
    lastSyncAt: new Date().toISOString(),
  }
}

async function syncFitbitData(store) {
  const fitbitState = await refreshFitbitConnectionIfNeeded(store)

  if (!fitbitState.connection?.accessToken) {
    throw new Error('Fitbit is not connected yet.')
  }

  const summary = await fetchFitbitSummary(fitbitState.connection.accessToken)

  return store.saveFitbitState({
    connection: {
      ...fitbitState.connection,
      profileName: summary.profileName || fitbitState.connection.profileName || '',
    },
    summary,
  })
}

function normalizeToDateTime(value) {
  const date = new Date(value)
  return date.toISOString()
}

function normalizeHeaderName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function detectDelimiter(line) {
  const candidates = ['\t', ',', '|', ';']
  let bestDelimiter = ''
  let bestCount = 0

  for (const candidate of candidates) {
    const count = line.split(candidate).length - 1

    if (count > bestCount) {
      bestCount = count
      bestDelimiter = candidate
    }
  }

  return bestCount > 0 ? bestDelimiter : ''
}

function parseDelimitedLine(line, delimiter) {
  const values = []
  let current = ''
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    const nextCharacter = line[index + 1]

    if (character === '"') {
      if (inQuotes && nextCharacter === '"') {
        current += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (character === delimiter && !inQuotes) {
      values.push(current.trim())
      current = ''
      continue
    }

    current += character
  }

  values.push(current.trim())
  return values
}

function looksLikeTime(value) {
  return /^(\d{1,2}:\d{2})(:\d{2})?\s*(am|pm)?$/i.test(String(value ?? '').trim())
}

function parseImportedDate(dateValue, timeValue = '') {
  const combined = `${String(dateValue ?? '').trim()} ${String(timeValue ?? '').trim()}`.trim()

  if (!combined) {
    return null
  }

  const parsed = new Date(combined)

  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed.toISOString()
}

function extractImportedRow(fields, headerMap) {
  if (headerMap) {
    const dateValue = fields[headerMap.date] ?? fields[headerMap.recordedAt] ?? ''
    const timeValue = fields[headerMap.time] ?? ''
    const systolic = fields[headerMap.systolic]
    const diastolic = fields[headerMap.diastolic]
    const pulse = fields[headerMap.pulse]
    const notes = fields[headerMap.notes] ?? ''

    return {
      recordedAt: parseImportedDate(dateValue, timeValue),
      systolic: Number(systolic),
      diastolic: Number(diastolic),
      pulse: Number(pulse),
      notes: String(notes ?? '').trim(),
    }
  }

  if (fields.length >= 5 && looksLikeTime(fields[1])) {
    return {
      recordedAt: parseImportedDate(fields[0], fields[1]),
      systolic: Number(fields[2]),
      diastolic: Number(fields[3]),
      pulse: Number(fields[4]),
      notes: fields.slice(5).join(' ').trim(),
    }
  }

  if (fields.length >= 4) {
    return {
      recordedAt: parseImportedDate(fields[0]),
      systolic: Number(fields[1]),
      diastolic: Number(fields[2]),
      pulse: Number(fields[3]),
      notes: fields.slice(4).join(' ').trim(),
    }
  }

  return null
}

function createHeaderMap(fields) {
  const aliases = {
    date: ['date', 'readingdate', 'measurementdate'],
    recordedAt: ['datetime', 'recordedat', 'recorded', 'timestamp'],
    time: ['time', 'readingtime', 'measurementtime'],
    systolic: ['systolic', 'top', 'sys'],
    diastolic: ['diastolic', 'bottom', 'dia'],
    pulse: ['pulse', 'pulserate', 'heartrate', 'hr'],
    notes: ['notes', 'note', 'comment', 'comments', 'context'],
  }

  const map = {}

  fields.forEach((field, index) => {
    const normalized = normalizeHeaderName(field)

    for (const [key, values] of Object.entries(aliases)) {
      if (values.includes(normalized)) {
        map[key] = index
      }
    }
  })

  if ((map.date != null || map.recordedAt != null) && map.systolic != null && map.diastolic != null && map.pulse != null) {
    return map
  }

  return null
}

function formatDuplicateKey(entry) {
  return `${entry.recordedAt}|${entry.systolic}|${entry.diastolic}|${entry.pulse}`
}

function parseImportedBloodPressureText(rawText) {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (!lines.length) {
    return {
      rows: [],
      errors: ['No readable rows were found in the import text.'],
    }
  }

  const delimiter = detectDelimiter(lines[0])

  if (!delimiter) {
    return {
      rows: [],
      errors: [
        'The import format was not recognized. Use tab, comma, pipe, or semicolon separated rows.',
      ],
    }
  }

  const firstFields = parseDelimitedLine(lines[0], delimiter)
  const headerMap = createHeaderMap(firstFields)
  const startIndex = headerMap ? 1 : 0
  const rows = []
  const errors = []

  for (let index = startIndex; index < lines.length; index += 1) {
    const fields = parseDelimitedLine(lines[index], delimiter).filter(
      (field, fieldIndex, values) => !(field === '' && fieldIndex === values.length - 1)
    )
    const row = extractImportedRow(fields, headerMap)

    if (!row) {
      errors.push(`Row ${index + 1}: not enough columns to import.`)
      continue
    }

    if (!row.recordedAt) {
      errors.push(`Row ${index + 1}: could not read the date/time value.`)
      continue
    }

    if ([row.systolic, row.diastolic, row.pulse].some((value) => Number.isNaN(value))) {
      errors.push(`Row ${index + 1}: systolic, diastolic, and pulse must be numbers.`)
      continue
    }

    rows.push(row)
  }

  return {
    rows,
    errors,
  }
}

function parseNutrientToMg(value, unit) {
  if (value == null) {
    return null
  }

  const numericValue = Number(value)

  if (Number.isNaN(numericValue)) {
    return null
  }

  const normalizedUnit = String(unit ?? 'mg').toLowerCase()

  if (normalizedUnit === 'mg') {
    return Math.round(numericValue)
  }

  if (normalizedUnit === 'g') {
    return Math.round(numericValue * 1000)
  }

  if (normalizedUnit === 'µg' || normalizedUnit === 'ug' || normalizedUnit === 'mcg') {
    return Math.round(numericValue / 1000)
  }

  return Math.round(numericValue)
}

async function lookupBarcode(barcode) {
  const fallbackItem = barcodeFallbacks[barcode]

  try {
    const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`)

    if (!response.ok) {
      throw new Error('The nutrition lookup service is not available right now.')
    }

    const payload = await response.json()

    if (!payload.product) {
      if (fallbackItem) {
        return {
          barcode,
          ...fallbackItem,
        }
      }

      throw new Error('Food not found for that barcode.')
    }

    const product = payload.product
    const nutriments = product.nutriments ?? {}
    const sodiumFromSalt =
      parseNutrientToMg(nutriments.salt_serving, nutriments.salt_serving_unit) ??
      parseNutrientToMg(nutriments.salt_value, nutriments.salt_unit) ??
      parseNutrientToMg(nutriments.salt, nutriments.salt_unit)
    const sodiumMg =
      parseNutrientToMg(nutriments.sodium_serving, nutriments.sodium_serving_unit) ??
      parseNutrientToMg(nutriments.sodium_value, nutriments.sodium_unit) ??
      parseNutrientToMg(nutriments.sodium, nutriments.sodium_unit) ??
      (sodiumFromSalt != null ? Math.round(sodiumFromSalt * 0.393) : null)

    if (sodiumMg == null || Number.isNaN(sodiumMg)) {
      throw new Error('The food was found, but sodium details were missing.')
    }

    return {
      barcode,
      foodName: product.product_name || product.generic_name || 'Scanned food',
      servingSize: product.serving_size || '1 serving',
      sodiumMg: Math.round(sodiumMg),
    }
  } catch (error) {
    if (fallbackItem) {
      return {
        barcode,
        ...fallbackItem,
      }
    }

    throw error
  }
}

app.get('/api/health', async (request, response) => {
  const store = await storePromise
  response.json({
    ok: true,
    storageMode: store.storageMode,
  })
})

app.get('/api/dashboard', async (request, response, next) => {
  try {
    const store = await storePromise
    const dashboard = await store.getDashboard()
    response.json(dashboard)
  } catch (error) {
    next(error)
  }
})

app.get('/api/history', async (request, response, next) => {
  try {
    const store = await storePromise
    const [bloodPressureLogs, foodLogs] = await Promise.all([
      store.getBloodPressureLogs(),
      store.getFoodLogs(),
    ])

    response.json({
      bloodPressureLogs,
      foodLogs,
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/celebrations', async (request, response, next) => {
  try {
    const store = await storePromise
    response.json({
      goalBadges: await store.getGoalBadges(),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/celebrations/claim', async (request, response, next) => {
  try {
    const store = await storePromise
    const badge = goalBadgeSchema.parse(request.body)
    const result = await store.claimGoalBadge(badge)
    response.status(result.created ? 201 : 200).json(result)
  } catch (error) {
    next(error)
  }
})

app.get('/api/fitbit/status', async (request, response, next) => {
  try {
    const store = await storePromise
    const fitbitState = await store.getFitbitState()

    response.json({
      configured: isFitbitConfigured(),
      connected: Boolean(fitbitState.connection?.accessToken),
      scopes: fitbitConfig.scopes,
      profileName: fitbitState.connection?.profileName ?? '',
      summary: fitbitState.summary ?? null,
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/fitbit/connect-url', async (request, response) => {
  if (!isFitbitConfigured()) {
    response.status(400).json({
      error: 'Fitbit app credentials are not configured yet.',
    })
    return
  }

  response.json({
    authorizeUrl: buildFitbitAuthorizeUrl(),
  })
})

app.get('/api/fitbit/callback', async (request, response) => {
  const { code, state, error } = request.query

  if (error) {
    response.redirect(buildFitbitFrontendRedirect('error', String(error)))
    return
  }

  if (!code || !state || state !== fitbitAuthState) {
    response.redirect(buildFitbitFrontendRedirect('error', 'fitbit-state-mismatch'))
    return
  }

  try {
    const payload = await exchangeFitbitToken({
      client_id: fitbitConfig.clientId,
      grant_type: 'authorization_code',
      redirect_uri: fitbitConfig.redirectUri,
      code: String(code),
    })
    const store = await storePromise

    await store.saveFitbitState({
      connection: {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
        expiresAt: new Date(Date.now() + Number(payload.expires_in ?? 3600) * 1000).toISOString(),
        scope: payload.scope ?? '',
        fitbitUserId: payload.user_id ?? '',
        profileName: '',
      },
      summary: null,
    })

    await syncFitbitData(store)
    response.redirect(buildFitbitFrontendRedirect('connected'))
  } catch (callbackError) {
    response.redirect(buildFitbitFrontendRedirect('error', callbackError.message))
  }
})

app.post('/api/fitbit/sync', async (request, response, next) => {
  try {
    if (!isFitbitConfigured()) {
      response.status(400).json({ error: 'Fitbit app credentials are not configured yet.' })
      return
    }

    const store = await storePromise
    const fitbitState = await syncFitbitData(store)

    response.json({
      connected: Boolean(fitbitState.connection?.accessToken),
      profileName: fitbitState.connection?.profileName ?? '',
      summary: fitbitState.summary ?? null,
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/fitbit/disconnect', async (request, response, next) => {
  try {
    const store = await storePromise
    await store.clearFitbitState()
    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/settings', async (request, response, next) => {
  try {
    const body = settingsSchema.parse(request.body)
    const store = await storePromise
    const settings = await store.updateSettings(body)
    response.status(201).json({ settings })
  } catch (error) {
    next(error)
  }
})

app.post('/api/blood-pressure', async (request, response, next) => {
  try {
    const parsed = bloodPressureSchema.parse(request.body)
    const store = await storePromise
    const entry = attachId({
      ...parsed,
      recordedAt: normalizeToDateTime(parsed.recordedAt),
    })
    const saved = await store.addBloodPressureLog(entry)
    response.status(201).json({ entry: saved })
  } catch (error) {
    next(error)
  }
})

app.post('/api/food-logs', async (request, response, next) => {
  try {
    const parsed = foodLogSchema.parse(request.body)
    const store = await storePromise
    const entry = attachId({
      ...parsed,
      barcode: parsed.barcode ?? '',
      loggedAt: normalizeToDateTime(parsed.loggedAt),
    })
    const saved = await store.addFoodLog(entry)
    response.status(201).json({ entry: saved })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/blood-pressure/:id', async (request, response, next) => {
  try {
    const store = await storePromise
    const deleted = await store.deleteBloodPressureLog(request.params.id)

    if (!deleted) {
      response.status(404).json({ error: 'Blood pressure entry not found.' })
      return
    }

    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/food-logs/:id', async (request, response, next) => {
  try {
    const store = await storePromise
    const deleted = await store.deleteFoodLog(request.params.id)

    if (!deleted) {
      response.status(404).json({ error: 'Food entry not found.' })
      return
    }

    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/import/blood-pressure', async (request, response, next) => {
  try {
    const { rawText } = importSchema.parse(request.body)
    const parsed = parseImportedBloodPressureText(rawText)

    if (!parsed.rows.length) {
      response.status(400).json({
        error: parsed.errors[0] ?? 'No importable rows were found.',
        details: parsed.errors,
      })
      return
    }

    const store = await storePromise
    const existingLogs = await store.getBloodPressureLogs()
    const existingKeys = new Set(existingLogs.map(formatDuplicateKey))
    const importedEntries = []
    let duplicateCount = 0

    for (const row of parsed.rows) {
      const normalizedRow = {
        ...row,
        recordedAt: normalizeToDateTime(row.recordedAt),
        notes: row.notes ?? '',
      }
      const duplicateKey = formatDuplicateKey(normalizedRow)

      if (existingKeys.has(duplicateKey)) {
        duplicateCount += 1
        continue
      }

      const saved = await store.addBloodPressureLog(
        attachId({
          ...normalizedRow,
        })
      )
      importedEntries.push(saved)
      existingKeys.add(duplicateKey)
    }

    response.status(201).json({
      importedCount: importedEntries.length,
      duplicateCount,
      skippedCount: parsed.errors.length + duplicateCount,
      errors: parsed.errors.slice(0, 5),
      importedEntries: importedEntries.slice(0, 5),
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/barcode/:barcode', async (request, response, next) => {
  try {
    const barcode = request.params.barcode.replace(/\D/g, '')

    if (!barcode) {
      response.status(400).json({ error: 'A barcode is required.' })
      return
    }

    const item = await lookupBarcode(barcode)
    response.json({ item })
  } catch (error) {
    next(error)
  }
})

app.use((error, request, response, next) => {
  if (error instanceof z.ZodError) {
    response.status(400).json({
      error: error.issues[0]?.message ?? 'Invalid request.',
    })
    return
  }

  response.status(500).json({
    error: error.message ?? 'Unexpected server error.',
  })
})

if (fs.existsSync(path.join(clientDistPath, 'index.html'))) {
  app.use(express.static(clientDistPath))

  app.get('*splat', (request, response, next) => {
    if (request.path.startsWith('/api')) {
      next()
      return
    }

    response.sendFile(path.join(clientDistPath, 'index.html'))
  })
}

app.listen(port, () => {
  console.log(`API server running at http://localhost:${port}`)
})
