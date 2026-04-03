const express = require('express')
const cors = require('cors')
const { z } = require('zod')
const { createHash, pbkdf2Sync, randomBytes, randomUUID } = require('node:crypto')
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

const dateTimeInputSchema = z.string().min(1).refine((value) => !Number.isNaN(new Date(value).getTime()), {
  message: 'Invalid date/time value.',
})

const bloodPressureSchema = z.object({
  systolic: z.number().int().min(50).max(280),
  diastolic: z.number().int().min(30).max(200),
  pulse: z.number().int().min(30).max(220),
  notes: z.string().max(600).default(''),
  recordedAt: dateTimeInputSchema,
})

const foodLogSchema = z.object({
  foodName: z.string().min(2).max(180),
  servingSize: z.string().min(1).max(120),
  sodiumMg: z.number().int().min(0).max(10000),
  mealType: z.string().min(1).max(40).default('Meal'),
  barcode: z.string().max(80).optional().default(''),
  loggedAt: dateTimeInputSchema,
})

const favoriteFoodSchema = z.object({
  foodName: z.string().min(2).max(180),
  servingSize: z.string().min(1).max(120),
  sodiumMg: z.number().int().min(0).max(10000),
  mealType: z.string().min(1).max(40).default('Meal'),
  barcode: z.string().max(80).optional().default(''),
  notes: z.string().max(300).optional().default(''),
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

const medicationSchema = z.object({
  medicationName: z.string().min(2).max(120),
  dosage: z.string().min(1).max(80),
  takenAt: dateTimeInputSchema,
  notes: z.string().max(300).default(''),
})

const reminderSchema = z.object({
  title: z.string().min(2).max(120),
  reminderType: z.string().min(2).max(40),
  timeOfDay: z.string().regex(/^\d{2}:\d{2}$/),
  enabled: z.boolean().default(true),
  medicationName: z.string().max(120).default(''),
  dosage: z.string().max(80).default(''),
  notes: z.string().max(300).default(''),
})

const pinValueSchema = z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits.')

const privacyPinSchema = z.object({
  pin: pinValueSchema,
  currentPin: pinValueSchema.optional(),
})

const privacyClearSchema = z.object({
  currentPin: pinValueSchema,
})

const authCredentialsSchema = z.object({
  username: z.string().trim().min(3).max(80),
  password: z.string().min(6).max(128),
})

const backupRestoreSchema = z.object({
  data: z.object({
    settings: z.object({
      sodiumGoalMg: z.number().int().min(500).max(10000),
      privacyPinHash: z.string().optional(),
    }).optional(),
    bloodPressureLogs: z.array(z.any()).optional(),
    foodLogs: z.array(z.any()).optional(),
    favoriteFoods: z.array(z.any()).optional(),
    medicationLogs: z.array(z.any()).optional(),
    reminders: z.array(z.any()).optional(),
    fitbit: z.any().optional(),
    goalBadges: z.array(z.any()).optional(),
  }),
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
  timeZone: process.env.REMINDER_TIMEZONE ?? 'America/New_York',
  scopes: (process.env.FITBIT_SCOPES ?? 'activity heartrate profile sleep weight')
    .split(/\s+/)
    .filter(Boolean),
}

const SESSION_COOKIE_NAME = 'pressure_salt_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
const PASSWORD_HASH_ITERATIONS = 100000

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

function hashPrivacyPin(pin) {
  return createHash('sha256').update(pin).digest('hex')
}

function hashPassword(password, salt) {
  return pbkdf2Sync(password, salt, PASSWORD_HASH_ITERATIONS, 32, 'sha256').toString('hex')
}

function parseCookies(headerValue = '') {
  return Object.fromEntries(
    String(headerValue)
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...rest] = part.split('=')
        return [name, decodeURIComponent(rest.join('='))]
      })
  )
}

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function createSessionCookie(request, token) {
  const isSecure = request.secure || request.headers['x-forwarded-proto'] === 'https'
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${isSecure ? '; Secure' : ''}`
}

function clearSessionCookie(request) {
  const isSecure = request.secure || request.headers['x-forwarded-proto'] === 'https'
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure ? '; Secure' : ''}`
}

function getSessionExpiryIso() {
  return new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString()
}

async function getAuthStatus(request) {
  const store = await storePromise
  const authState = await store.getAuthState()
  const cookies = parseCookies(request.headers.cookie ?? '')
  const sessionToken = cookies[SESSION_COOKIE_NAME] ?? ''
  const sessionHash = sessionToken ? hashSessionToken(sessionToken) : ''
  const hasAccount = Boolean(authState.passwordHash)
  const authenticated =
    hasAccount &&
    Boolean(sessionHash) &&
    authState.sessionHash === sessionHash &&
    Boolean(authState.sessionExpiresAt) &&
    new Date(authState.sessionExpiresAt).getTime() > Date.now()

  return {
    hasAccount,
    authenticated,
    username: authenticated ? authState.username : authState.username ?? '',
    authState,
    store,
  }
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

function getDateForTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function mergeFitbitSummary(previousSummary, nextSummary) {
  const nextHasSignal = Boolean(
    nextSummary.profileName ||
      nextSummary.stepsToday > 0 ||
      nextSummary.restingHeartRate ||
      nextSummary.latestHeartRate ||
      nextSummary.sleepMinutes > 0 ||
      nextSummary.sleepRecords > 0 ||
      nextSummary.weightValue
  )

  if (nextHasSignal || !previousSummary) {
    return nextSummary
  }

  return {
    ...previousSummary,
    lastSyncAt: nextSummary.lastSyncAt,
  }
}

function mergeFitbitHistory(previousHistory = [], summary) {
  if (!summary?.lastSyncAt) {
    return [...(previousHistory ?? [])]
      .filter(Boolean)
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-14)
  }

  const date = summary.lastSyncAt.slice(0, 10)
  const nextHistory = (previousHistory ?? []).filter((entry) => entry?.date !== date)

  nextHistory.push({
    date,
    stepsToday: Number(summary.stepsToday ?? 0),
    restingHeartRate: summary.restingHeartRate ?? null,
    latestHeartRate: summary.latestHeartRate ?? null,
    sleepMinutes: Number(summary.sleepMinutes ?? 0),
    weightValue: summary.weightValue ?? null,
    lastSyncAt: summary.lastSyncAt,
  })

  return nextHistory.sort((left, right) => left.date.localeCompare(right.date)).slice(-14)
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
  const today = getDateForTimeZone(fitbitConfig.timeZone)
  const [profile, steps, heart, sleep, weight] = await Promise.all([
    fetchFitbitJson('/1/user/-/profile.json', accessToken, { optional: true }),
    fetchFitbitJson(`/1/user/-/activities/steps/date/${today}/1d.json`, accessToken),
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

  const summary = mergeFitbitSummary(
    fitbitState.summary,
    await fetchFitbitSummary(fitbitState.connection.accessToken)
  )
  const history = mergeFitbitHistory(fitbitState.history, summary)

  return store.saveFitbitState({
    connection: {
      ...fitbitState.connection,
      profileName: summary.profileName || fitbitState.connection.profileName || '',
    },
    summary,
    history,
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

function getBarcodeLookupCandidates(barcode) {
  const normalized = String(barcode ?? '').replace(/\D/g, '')
  const candidates = [normalized]

  if (normalized.length === 10) {
    candidates.push(`0${normalized}`)
    candidates.push(`00${normalized}`)
  } else if (normalized.length === 11) {
    candidates.push(`0${normalized}`)
  } else if (normalized.length === 12) {
    candidates.push(`0${normalized}`)
  }

  return [...new Set(candidates)].filter(Boolean)
}

function mapOpenFoodFactsProduct(product, fallbackName = 'Scanned food') {
  const nutriments = product?.nutriments ?? {}
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
    return null
  }

  return {
    barcode: String(product?.code ?? '').trim(),
    foodName: product?.product_name || product?.generic_name || fallbackName,
    servingSize: product?.serving_size || '1 serving',
    sodiumMg: Math.round(sodiumMg),
  }
}

async function lookupBarcode(barcode) {
  const fallbackItem = barcodeFallbacks[barcode]
  const candidates = getBarcodeLookupCandidates(barcode)

  try {
    for (const candidate of candidates) {
      const response = await fetch(`https://world.openfoodfacts.org/api/v0/product/${candidate}.json`)
      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        throw new Error('The nutrition lookup service is not available right now.')
      }

      if (!payload.product || payload.status === 0) {
        continue
      }

      const item = mapOpenFoodFactsProduct(payload.product)

      if (!item) {
        throw new Error('The food was found, but sodium details were missing.')
      }

      return {
        ...item,
        barcode: item.barcode || candidate,
      }
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

  if (fallbackItem) {
    return {
      barcode,
      ...fallbackItem,
    }
  }

  throw new Error('Food not found for that barcode.')
}

async function searchFoodsByName(query) {
  const normalizedQuery = String(query ?? '').trim()

  if (normalizedQuery.length < 2) {
    throw new Error('Enter at least 2 letters to search foods by name.')
  }

  const url = new URL('https://world.openfoodfacts.org/cgi/search.pl')
  url.searchParams.set('search_terms', normalizedQuery)
  url.searchParams.set('search_simple', '1')
  url.searchParams.set('action', 'process')
  url.searchParams.set('json', '1')
  url.searchParams.set('page_size', '12')

  const response = await fetch(url)
  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error('The food search service is not available right now.')
  }

  const items = (payload.products ?? [])
    .map((product) => mapOpenFoodFactsProduct(product, 'Food result'))
    .filter(Boolean)
    .sort((left, right) => left.sodiumMg - right.sodiumMg)
    .slice(0, 8)

  if (!items.length) {
    throw new Error('No foods with sodium details were found for that search.')
  }

  return items
}

function buildLocalFoodSearchResults(query, favoriteFoods = [], foodLogs = []) {
  const normalizedQuery = String(query ?? '').trim().toLowerCase()

  if (!normalizedQuery) {
    return []
  }

  const seen = new Set()
  const localMatches = []
  const candidates = [
    ...favoriteFoods.map((entry) => ({ ...entry, source: 'favorite' })),
    ...foodLogs.map((entry) => ({ ...entry, source: 'recent' })),
  ]

  for (const entry of candidates) {
    const haystack = [entry.foodName, entry.servingSize, entry.barcode].join(' ').toLowerCase()

    if (!haystack.includes(normalizedQuery)) {
      continue
    }

    const key = [entry.foodName, entry.servingSize, entry.sodiumMg, entry.barcode].join('|').toLowerCase()

    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    localMatches.push({
      foodName: entry.foodName,
      servingSize: entry.servingSize,
      sodiumMg: Number(entry.sodiumMg),
      barcode: entry.barcode ?? '',
      source: entry.source,
    })

    if (localMatches.length === 8) {
      break
    }
  }

  return localMatches
}

app.get('/api/health', async (request, response) => {
  const store = await storePromise
  response.json({
    ok: true,
    storageMode: store.storageMode,
  })
})

app.get('/api/auth/status', async (request, response, next) => {
  try {
    const auth = await getAuthStatus(request)
    response.json({
      hasAccount: auth.hasAccount,
      authenticated: auth.authenticated,
      username: auth.authenticated ? auth.username : '',
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/register', async (request, response, next) => {
  try {
    const auth = await getAuthStatus(request)

    if (auth.hasAccount) {
      response.status(400).json({ error: 'An account already exists for this app.' })
      return
    }

    const parsed = authCredentialsSchema.parse(request.body)
    const passwordSalt = randomBytes(16).toString('hex')
    const passwordHash = hashPassword(parsed.password, passwordSalt)
    const sessionToken = randomBytes(32).toString('hex')
    const sessionHash = hashSessionToken(sessionToken)
    const sessionExpiresAt = getSessionExpiryIso()

    await auth.store.createAuthAccount({
      username: parsed.username,
      passwordHash,
      passwordSalt,
      sessionHash,
      sessionExpiresAt,
    })

    response.setHeader('Set-Cookie', createSessionCookie(request, sessionToken))
    response.status(201).json({
      hasAccount: true,
      authenticated: true,
      username: parsed.username,
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/login', async (request, response, next) => {
  try {
    const auth = await getAuthStatus(request)

    if (!auth.hasAccount) {
      response.status(400).json({ error: 'Create your account first.' })
      return
    }

    const parsed = authCredentialsSchema.parse(request.body)
    const usernameMatches = auth.authState.username === parsed.username
    const passwordHash = hashPassword(parsed.password, auth.authState.passwordSalt)

    if (!usernameMatches || passwordHash !== auth.authState.passwordHash) {
      response.status(401).json({ error: 'The username or password did not match.' })
      return
    }

    const sessionToken = randomBytes(32).toString('hex')
    const sessionHash = hashSessionToken(sessionToken)
    const sessionExpiresAt = getSessionExpiryIso()

    await auth.store.saveAuthSession({ sessionHash, sessionExpiresAt })

    response.setHeader('Set-Cookie', createSessionCookie(request, sessionToken))
    response.json({
      hasAccount: true,
      authenticated: true,
      username: parsed.username,
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/auth/logout', async (request, response, next) => {
  try {
    const auth = await getAuthStatus(request)
    await auth.store.clearAuthSession()
    response.setHeader('Set-Cookie', clearSessionCookie(request))
    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.use('/api', async (request, response, next) => {
  if (
    request.path === '/api/health' ||
    request.path === '/api/auth/status' ||
    request.path === '/api/auth/register' ||
    request.path === '/api/auth/login'
  ) {
    next()
    return
  }

  try {
    const auth = await getAuthStatus(request)

    if (!auth.authenticated) {
      response.status(401).json({ error: 'Please sign in to continue.' })
      return
    }

    next()
  } catch (error) {
    next(error)
  }
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

app.get('/api/medications', async (request, response, next) => {
  try {
    const store = await storePromise
    response.json({
      medicationLogs: await store.getMedicationLogs(),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/medications', async (request, response, next) => {
  try {
    const parsed = medicationSchema.parse(request.body)
    const store = await storePromise
    const entry = attachId({
      ...parsed,
      takenAt: normalizeToDateTime(parsed.takenAt),
    })
    response.status(201).json({ entry: await store.addMedicationLog(entry) })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/medications/:id', async (request, response, next) => {
  try {
    const store = await storePromise
    const deleted = await store.deleteMedicationLog(request.params.id)

    if (!deleted) {
      response.status(404).json({ error: 'Medication log not found.' })
      return
    }

    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.get('/api/reminders', async (request, response, next) => {
  try {
    const store = await storePromise
    response.json({
      reminders: await store.getReminders(),
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/favorite-foods', async (request, response, next) => {
  try {
    const store = await storePromise
    response.json({
      favoriteFoods: await store.getFavoriteFoods(),
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/favorite-foods', async (request, response, next) => {
  try {
    const store = await storePromise
    const parsed = favoriteFoodSchema.parse(request.body)
    const entry = await store.addFavoriteFood({
      id: randomUUID(),
      ...parsed,
      barcode: parsed.barcode ?? '',
      notes: parsed.notes ?? '',
    })
    response.status(201).json({ entry })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/favorite-foods/:id', async (request, response, next) => {
  try {
    const store = await storePromise
    const deleted = await store.deleteFavoriteFood(request.params.id)

    if (!deleted) {
      response.status(404).json({ error: 'Favorite food not found.' })
      return
    }

    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.get('/api/privacy/status', async (request, response, next) => {
  try {
    const store = await storePromise
    response.json(await store.getPrivacyStatus())
  } catch (error) {
    next(error)
  }
})

app.post('/api/privacy/set', async (request, response, next) => {
  try {
    const store = await storePromise
    const parsed = privacyPinSchema.parse(request.body)
    const privacyStatus = await store.getPrivacyStatus()

    if (privacyStatus.pinEnabled) {
      if (!parsed.currentPin) {
        response.status(400).json({ error: 'Enter your current PIN to change it.' })
        return
      }

      const verified = await store.verifyPrivacyPinHash(hashPrivacyPin(parsed.currentPin))

      if (!verified) {
        response.status(400).json({ error: 'The current PIN did not match.' })
        return
      }
    }

    await store.setPrivacyPinHash(hashPrivacyPin(parsed.pin))
    response.status(201).json({ pinEnabled: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/privacy/verify', async (request, response, next) => {
  try {
    const store = await storePromise
    const parsed = privacyPinSchema.pick({ pin: true }).parse(request.body)
    const verified = await store.verifyPrivacyPinHash(hashPrivacyPin(parsed.pin))

    if (!verified) {
      response.status(401).json({ error: 'That PIN did not match.' })
      return
    }

    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/privacy/clear', async (request, response, next) => {
  try {
    const store = await storePromise
    const parsed = privacyClearSchema.parse(request.body)
    const verified = await store.verifyPrivacyPinHash(hashPrivacyPin(parsed.currentPin))

    if (!verified) {
      response.status(401).json({ error: 'That PIN did not match.' })
      return
    }

    await store.clearPrivacyPinHash()
    response.json({ pinEnabled: false })
  } catch (error) {
    next(error)
  }
})

app.post('/api/reminders', async (request, response, next) => {
  try {
    const parsed = reminderSchema.parse(request.body)
    const store = await storePromise
    const entry = attachId(parsed)
    response.status(201).json({ entry: await store.addReminder(entry) })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/reminders/:id', async (request, response, next) => {
  try {
    const store = await storePromise
    const deleted = await store.deleteReminder(request.params.id)

    if (!deleted) {
      response.status(404).json({ error: 'Reminder not found.' })
      return
    }

    response.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

app.get('/api/backup', async (request, response, next) => {
  try {
    const store = await storePromise
    response.json(await store.getBackupData())
  } catch (error) {
    next(error)
  }
})

app.post('/api/backup/restore', async (request, response, next) => {
  try {
    const parsed = backupRestoreSchema.parse(request.body)
    const store = await storePromise
    response.status(201).json(await store.restoreBackupData(parsed.data))
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
      history: fitbitState.history ?? [],
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
      history: fitbitState.history ?? [],
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
    const store = await storePromise

    if (!barcode) {
      response.status(400).json({ error: 'A barcode is required.' })
      return
    }

    const favoriteMatch = await store.findFavoriteFoodByBarcode(barcode)

    if (favoriteMatch) {
      response.json({
        item: {
          foodName: favoriteMatch.foodName,
          servingSize: favoriteMatch.servingSize,
          sodiumMg: favoriteMatch.sodiumMg,
          barcode: favoriteMatch.barcode,
          source: 'favorite',
        },
      })
      return
    }

    const item = await lookupBarcode(barcode)
    response.json({ item })
  } catch (error) {
    next(error)
  }
})

app.get('/api/food-search', async (request, response, next) => {
  try {
    const store = await storePromise
    const [favoriteFoods, foodLogs] = await Promise.all([store.getFavoriteFoods(), store.getFoodLogs()])
    const localItems = buildLocalFoodSearchResults(request.query.q ?? '', favoriteFoods, foodLogs)
    let remoteItems = []

    try {
      remoteItems = await searchFoodsByName(request.query.q ?? '')
    } catch (error) {
      if (!localItems.length) {
        throw error
      }
    }

    const items = [...localItems]
    const seen = new Set(localItems.map((entry) => [entry.foodName, entry.servingSize, entry.sodiumMg, entry.barcode].join('|').toLowerCase()))

    for (const entry of remoteItems) {
      const key = [entry.foodName, entry.servingSize, entry.sodiumMg, entry.barcode].join('|').toLowerCase()
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      items.push(entry)
      if (items.length === 8) {
        break
      }
    }

    response.json({ items })
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
