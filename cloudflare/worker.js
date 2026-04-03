import { D1Store } from './d1Store.js'
import {
  buildFitbitAuthorizeUrl,
  buildFitbitFrontendRedirect,
  exchangeFitbitToken,
  getFitbitConfig,
  isFitbitConfigured,
  syncFitbitData,
} from './fitbit.js'
import {
  errorResponse,
  ensurePin,
  formatDuplicateKey,
  jsonResponse,
  lookupBarcode,
  parseBackupRestorePayload,
  parseBloodPressurePayload,
  parseFavoriteFoodPayload,
  parseFoodLogPayload,
  parseGoalBadgePayload,
  parseImportPayload,
  parseImportedBloodPressureText,
  parseMedicationPayload,
  parseReminderPayload,
  parseSettingsPayload,
  readJson,
  toIsoString,
} from './shared.js'

const SESSION_COOKIE_NAME = 'pressure_salt_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
const PASSWORD_HASH_ITERATIONS = 100000

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

async function hashPrivacyPin(pin) {
  const encoded = new TextEncoder().encode(pin)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function createRandomToken() {
  const values = new Uint8Array(32)
  crypto.getRandomValues(values)
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function hashSessionToken(token) {
  const encoded = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function createSessionCookie(request, token) {
  const isSecure = new URL(request.url).protocol === 'https:'
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${isSecure ? '; Secure' : ''}`
}

function clearSessionCookie(request) {
  const isSecure = new URL(request.url).protocol === 'https:'
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure ? '; Secure' : ''}`
}

async function hashPassword(password, salt) {
  const encoder = new TextEncoder()
  const baseKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: PASSWORD_HASH_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    256
  )

  return [...new Uint8Array(derivedBits)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function getSessionExpiryIso() {
  return new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString()
}

async function getAuthStatus(store, request) {
  const authState = await store.getAuthState()
  const cookies = parseCookies(request.headers.get('cookie') ?? '')
  const sessionToken = cookies[SESSION_COOKIE_NAME] ?? ''
  const sessionHash = sessionToken ? await hashSessionToken(sessionToken) : ''
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
  }
}

function getTelegramConfig(env) {
  return {
    botToken: env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: env.TELEGRAM_CHAT_ID ?? '',
    reminderTimezone: env.REMINDER_TIMEZONE ?? 'America/New_York',
  }
}

function isTelegramConfigured(telegramConfig) {
  return Boolean(telegramConfig.botToken && telegramConfig.chatId)
}

function getReminderDateParts(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = formatter.formatToParts(new Date())
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))

  return {
    dayKey: `${values.year}-${values.month}-${values.day}`,
    timeOfDay: `${values.hour}:${values.minute}`,
  }
}

function buildTelegramReminderMessage(reminder, schedule) {
  const detailLines = [
    `Reminder: ${reminder.title}`,
    `Time: ${reminder.timeOfDay} (${schedule.reminderTimezone})`,
  ]

  if (reminder.medicationName) {
    detailLines.push(`Medication: ${reminder.medicationName}`)
  }

  if (reminder.dosage) {
    detailLines.push(`Dosage: ${reminder.dosage}`)
  }

  if (reminder.notes) {
    detailLines.push(`Notes: ${reminder.notes}`)
  }

  return detailLines.join('\n')
}

async function sendTelegramMessage(telegramConfig, text) {
  const response = await fetch(`https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: telegramConfig.chatId,
      text,
    }),
  })

  const payload = await response.json().catch(() => ({}))

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.description ?? 'Telegram message failed.')
  }

  return payload
}

async function sendDueReminderMessages(env) {
  const store = new D1Store(env)
  const telegramConfig = getTelegramConfig(env)

  if (!isTelegramConfigured(telegramConfig)) {
    return { sentCount: 0, reason: 'telegram-not-configured' }
  }

  const schedule = {
    reminderTimezone: telegramConfig.reminderTimezone,
    ...getReminderDateParts(telegramConfig.reminderTimezone),
  }
  const reminders = await store.getReminders()
  let sentCount = 0

  for (const reminder of reminders) {
    if (!reminder.enabled || reminder.timeOfDay !== schedule.timeOfDay) {
      continue
    }

    const alreadySent = await store.hasReminderDelivery(reminder.id, schedule.dayKey, 'telegram')

    if (alreadySent) {
      continue
    }

    await sendTelegramMessage(telegramConfig, buildTelegramReminderMessage(reminder, schedule))
    await store.recordReminderDelivery({
      id: crypto.randomUUID(),
      reminderId: reminder.id,
      dayKey: schedule.dayKey,
      channel: 'telegram',
      sentAt: new Date().toISOString(),
    })
    sentCount += 1
  }

  return { sentCount, reason: 'ok' }
}

async function handleApiRequest(request, env) {
  const url = new URL(request.url)
  const pathname = url.pathname
  const method = request.method.toUpperCase()
  const store = new D1Store(env)
  const fitbitConfig = getFitbitConfig(env, request)

  if (pathname === '/api/health' && method === 'GET') {
    return jsonResponse({
      ok: true,
      storageMode: env.DB ? 'd1' : 'unconfigured',
    })
  }

  if (pathname === '/api/auth/status' && method === 'GET') {
    const auth = await getAuthStatus(store, request)
    return jsonResponse({
      hasAccount: auth.hasAccount,
      authenticated: auth.authenticated,
      username: auth.authenticated ? auth.username : '',
    })
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await readJson(request)
    const username = String(body?.username ?? '').trim()
    const password = String(body?.password ?? '')
    const auth = await getAuthStatus(store, request)

    if (auth.hasAccount) {
      return errorResponse('An account already exists for this app.', 400)
    }

    if (username.length < 3 || username.length > 80) {
      return errorResponse('Username must be between 3 and 80 characters.', 400)
    }

    if (password.length < 6 || password.length > 128) {
      return errorResponse('Password must be between 6 and 128 characters.', 400)
    }

    const salt = crypto.randomUUID()
    const passwordHash = await hashPassword(password, salt)
    const sessionToken = createRandomToken()
    const sessionHash = await hashSessionToken(sessionToken)
    const sessionExpiresAt = getSessionExpiryIso()

    await store.createAuthAccount({
      username,
      passwordHash,
      passwordSalt: salt,
      sessionHash,
      sessionExpiresAt,
    })

    const response = jsonResponse({ hasAccount: true, authenticated: true, username }, 201)
    response.headers.set('Set-Cookie', createSessionCookie(request, sessionToken))
    return response
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJson(request)
    const username = String(body?.username ?? '').trim()
    const password = String(body?.password ?? '')
    const auth = await getAuthStatus(store, request)

    if (!auth.hasAccount) {
      return errorResponse('Create your account first.', 400)
    }

    const usernameMatches = auth.authState.username === username
    const passwordHash = await hashPassword(password, auth.authState.passwordSalt)

    if (!usernameMatches || passwordHash !== auth.authState.passwordHash) {
      return errorResponse('The username or password did not match.', 401)
    }

    const sessionToken = createRandomToken()
    const sessionHash = await hashSessionToken(sessionToken)
    const sessionExpiresAt = getSessionExpiryIso()

    await store.saveAuthSession({ sessionHash, sessionExpiresAt })

    const response = jsonResponse({ hasAccount: true, authenticated: true, username })
    response.headers.set('Set-Cookie', createSessionCookie(request, sessionToken))
    return response
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    await store.clearAuthSession()
    const response = jsonResponse({ ok: true })
    response.headers.set('Set-Cookie', clearSessionCookie(request))
    return response
  }

  const auth = await getAuthStatus(store, request)

  if (!auth.authenticated) {
    return errorResponse('Please sign in to continue.', 401)
  }

  if (pathname === '/api/dashboard' && method === 'GET') {
    return jsonResponse(await store.getDashboard())
  }

  if (pathname === '/api/history' && method === 'GET') {
    const [bloodPressureLogs, foodLogs] = await Promise.all([
      store.getBloodPressureLogs(),
      store.getFoodLogs(),
    ])

    return jsonResponse({
      bloodPressureLogs,
      foodLogs,
    })
  }

  if (pathname === '/api/medications' && method === 'GET') {
    return jsonResponse({
      medicationLogs: await store.getMedicationLogs(),
    })
  }

  if (pathname === '/api/medications' && method === 'POST') {
    const body = await readJson(request)
    const entry = {
      id: crypto.randomUUID(),
      ...parseMedicationPayload(body),
    }
    return jsonResponse({ entry: await store.addMedicationLog(entry) }, 201)
  }

  if (pathname.startsWith('/api/medications/') && method === 'DELETE') {
    const id = pathname.split('/').pop()
    const deleted = await store.deleteMedicationLog(id)

    if (!deleted) {
      return errorResponse('Medication log not found.', 404)
    }

    return jsonResponse({ ok: true })
  }

  if (pathname === '/api/reminders' && method === 'GET') {
    return jsonResponse({
      reminders: await store.getReminders(),
    })
  }

  if (pathname === '/api/reminders' && method === 'POST') {
    const body = await readJson(request)
    const entry = {
      id: crypto.randomUUID(),
      ...parseReminderPayload(body),
    }
    return jsonResponse({ entry: await store.addReminder(entry) }, 201)
  }

  if (pathname.startsWith('/api/reminders/') && method === 'DELETE') {
    const id = pathname.split('/').pop()
    const deleted = await store.deleteReminder(id)

    if (!deleted) {
      return errorResponse('Reminder not found.', 404)
    }

    return jsonResponse({ ok: true })
  }

  if (pathname === '/api/favorite-foods' && method === 'GET') {
    return jsonResponse({
      favoriteFoods: await store.getFavoriteFoods(),
    })
  }

  if (pathname === '/api/favorite-foods' && method === 'POST') {
    const body = await readJson(request)
    const entry = {
      id: crypto.randomUUID(),
      ...parseFavoriteFoodPayload(body),
    }
    return jsonResponse({ entry: await store.addFavoriteFood(entry) }, 201)
  }

  if (pathname.startsWith('/api/favorite-foods/') && method === 'DELETE') {
    const id = pathname.split('/').pop()
    const deleted = await store.deleteFavoriteFood(id)

    if (!deleted) {
      return errorResponse('Favorite food not found.', 404)
    }

    return jsonResponse({ ok: true })
  }

  if (pathname === '/api/privacy/status' && method === 'GET') {
    return jsonResponse(await store.getPrivacyStatus())
  }

  if (pathname === '/api/privacy/set' && method === 'POST') {
    const body = await readJson(request)
    const pin = ensurePin(body?.pin, 'PIN')
    const currentPin = body?.currentPin ? ensurePin(body.currentPin, 'Current PIN') : ''
    const privacyStatus = await store.getPrivacyStatus()

    if (privacyStatus.pinEnabled) {
      if (!currentPin) {
        return errorResponse('Enter your current PIN to change it.', 400)
      }

      const verified = await store.verifyPrivacyPinHash(await hashPrivacyPin(currentPin))

      if (!verified) {
        return errorResponse('The current PIN did not match.', 400)
      }
    }

    await store.setPrivacyPinHash(await hashPrivacyPin(pin))
    return jsonResponse({ pinEnabled: true }, 201)
  }

  if (pathname === '/api/privacy/verify' && method === 'POST') {
    const body = await readJson(request)
    const pin = ensurePin(body?.pin, 'PIN')
    const verified = await store.verifyPrivacyPinHash(await hashPrivacyPin(pin))

    if (!verified) {
      return errorResponse('That PIN did not match.', 401)
    }

    return jsonResponse({ ok: true })
  }

  if (pathname === '/api/privacy/clear' && method === 'POST') {
    const body = await readJson(request)
    const currentPin = ensurePin(body?.currentPin, 'Current PIN')
    const verified = await store.verifyPrivacyPinHash(await hashPrivacyPin(currentPin))

    if (!verified) {
      return errorResponse('That PIN did not match.', 401)
    }

    await store.clearPrivacyPinHash()
    return jsonResponse({ pinEnabled: false })
  }

  if (pathname === '/api/telegram/status' && method === 'GET') {
    const telegramConfig = getTelegramConfig(env)

    return jsonResponse({
      configured: isTelegramConfigured(telegramConfig),
      chatId: telegramConfig.chatId,
      reminderTimezone: telegramConfig.reminderTimezone,
    })
  }

  if (pathname === '/api/telegram/test' && method === 'POST') {
    const telegramConfig = getTelegramConfig(env)

    if (!isTelegramConfigured(telegramConfig)) {
      return errorResponse('Telegram is not configured yet.', 400)
    }

    await sendTelegramMessage(
      telegramConfig,
      `PressureSalt test message\nTime: ${new Date().toLocaleString('en-US', { timeZone: telegramConfig.reminderTimezone })}`
    )

    return jsonResponse({ ok: true }, 201)
  }

  if (pathname === '/api/backup' && method === 'GET') {
    return jsonResponse(await store.getBackupData())
  }

  if (pathname === '/api/backup/restore' && method === 'POST') {
    const body = await readJson(request)
    return jsonResponse(await store.restoreBackupData(parseBackupRestorePayload(body)), 201)
  }

  if (pathname === '/api/celebrations' && method === 'GET') {
    return jsonResponse({
      goalBadges: await store.getGoalBadges(),
    })
  }

  if (pathname === '/api/celebrations/claim' && method === 'POST') {
    const body = await readJson(request)
    const result = await store.claimGoalBadge(parseGoalBadgePayload(body))
    return jsonResponse(result, result.created ? 201 : 200)
  }

  if (pathname === '/api/fitbit/status' && method === 'GET') {
    const fitbitState = await store.getFitbitState()

    return jsonResponse({
      configured: isFitbitConfigured(fitbitConfig),
      connected: Boolean(fitbitState.connection?.accessToken),
      scopes: fitbitConfig.scopes,
      profileName: fitbitState.connection?.profileName ?? '',
      summary: fitbitState.summary ?? null,
    })
  }

  if (pathname === '/api/fitbit/connect-url' && method === 'GET') {
    if (!isFitbitConfigured(fitbitConfig)) {
      return errorResponse('Fitbit app credentials are not configured yet.', 400)
    }

    const state = crypto.randomUUID()
    await store.saveFitbitState({
      pendingAuthState: state,
    })

    return jsonResponse({
      authorizeUrl: buildFitbitAuthorizeUrl(fitbitConfig, state),
    })
  }

  if (pathname === '/api/fitbit/callback' && method === 'GET') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const remoteError = url.searchParams.get('error')

    if (remoteError) {
      return Response.redirect(buildFitbitFrontendRedirect(request, fitbitConfig, 'error', remoteError), 302)
    }

    const fitbitState = await store.getFitbitState()

    if (!code || !state || state !== fitbitState.pendingAuthState) {
      return Response.redirect(
        buildFitbitFrontendRedirect(request, fitbitConfig, 'error', 'fitbit-state-mismatch'),
        302
      )
    }

    try {
      const payload = await exchangeFitbitToken(fitbitConfig, {
        client_id: fitbitConfig.clientId,
        grant_type: 'authorization_code',
        redirect_uri: fitbitConfig.redirectUri,
        code,
      })

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
        pendingAuthState: '',
      })

      await syncFitbitData(store, fitbitConfig)
      return Response.redirect(buildFitbitFrontendRedirect(request, fitbitConfig, 'connected'), 302)
    } catch (error) {
      return Response.redirect(buildFitbitFrontendRedirect(request, fitbitConfig, 'error', error.message), 302)
    }
  }

  if (pathname === '/api/fitbit/sync' && method === 'POST') {
    if (!isFitbitConfigured(fitbitConfig)) {
      return errorResponse('Fitbit app credentials are not configured yet.', 400)
    }

    const fitbitState = await syncFitbitData(store, fitbitConfig)

    return jsonResponse({
      connected: Boolean(fitbitState.connection?.accessToken),
      profileName: fitbitState.connection?.profileName ?? '',
      summary: fitbitState.summary ?? null,
    })
  }

  if (pathname === '/api/fitbit/disconnect' && method === 'POST') {
    await store.clearFitbitState()
    return jsonResponse({ ok: true })
  }

  if (pathname === '/api/settings' && method === 'POST') {
    const body = await readJson(request)
    const settings = await store.updateSettings(parseSettingsPayload(body))
    return jsonResponse({ settings }, 201)
  }

  if (pathname === '/api/blood-pressure' && method === 'POST') {
    const body = await readJson(request)
    const parsed = parseBloodPressurePayload(body)
    const entry = {
      id: crypto.randomUUID(),
      ...parsed,
    }
    const saved = await store.addBloodPressureLog(entry)
    return jsonResponse({ entry: saved }, 201)
  }

  if (pathname === '/api/food-logs' && method === 'POST') {
    const body = await readJson(request)
    const parsed = parseFoodLogPayload(body)
    const entry = {
      id: crypto.randomUUID(),
      ...parsed,
    }
    const saved = await store.addFoodLog(entry)
    return jsonResponse({ entry: saved }, 201)
  }

  if (pathname.startsWith('/api/blood-pressure/') && method === 'DELETE') {
    const id = pathname.split('/').pop()
    const deleted = await store.deleteBloodPressureLog(id)

    if (!deleted) {
      return errorResponse('Blood pressure entry not found.', 404)
    }

    return jsonResponse({ ok: true })
  }

  if (pathname.startsWith('/api/food-logs/') && method === 'DELETE') {
    const id = pathname.split('/').pop()
    const deleted = await store.deleteFoodLog(id)

    if (!deleted) {
      return errorResponse('Food entry not found.', 404)
    }

    return jsonResponse({ ok: true })
  }

  if (pathname === '/api/import/blood-pressure' && method === 'POST') {
    const body = await readJson(request)
    const { rawText } = parseImportPayload(body)
    const parsed = parseImportedBloodPressureText(rawText)

    if (!parsed.rows.length) {
      return jsonResponse(
        {
          error: parsed.errors[0] ?? 'No importable rows were found.',
          details: parsed.errors,
        },
        400
      )
    }

    const existingLogs = await store.getBloodPressureLogs()
    const existingKeys = new Set(existingLogs.map(formatDuplicateKey))
    const importedEntries = []
    let duplicateCount = 0

    for (const row of parsed.rows) {
      const normalizedRow = {
        id: crypto.randomUUID(),
        ...row,
        recordedAt: toIsoString(row.recordedAt),
        notes: row.notes ?? '',
      }
      const duplicateKey = formatDuplicateKey(normalizedRow)

      if (existingKeys.has(duplicateKey)) {
        duplicateCount += 1
        continue
      }

      const saved = await store.addBloodPressureLog(normalizedRow)
      importedEntries.push(saved)
      existingKeys.add(duplicateKey)
    }

    return jsonResponse(
      {
        importedCount: importedEntries.length,
        duplicateCount,
        skippedCount: parsed.errors.length + duplicateCount,
        errors: parsed.errors.slice(0, 5),
        importedEntries: importedEntries.slice(0, 5),
      },
      201
    )
  }

  if (pathname.startsWith('/api/barcode/') && method === 'GET') {
    const barcode = pathname.split('/').pop().replace(/\D/g, '')

    if (!barcode) {
      return errorResponse('A barcode is required.', 400)
    }

    const favoriteMatch = await store.findFavoriteFoodByBarcode(barcode)

    if (favoriteMatch) {
      return jsonResponse({
        item: {
          foodName: favoriteMatch.foodName,
          servingSize: favoriteMatch.servingSize,
          sodiumMg: favoriteMatch.sodiumMg,
          barcode: favoriteMatch.barcode,
          source: 'favorite',
        },
      })
    }

    const item = await lookupBarcode(barcode)
    return jsonResponse({ item })
  }

  return errorResponse('Route not found.', 404)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApiRequest(request, env)
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request)
      }

      return new Response('Static assets are not configured yet.', { status: 404 })
    } catch (error) {
      if (url.pathname.startsWith('/api/')) {
        return jsonResponse({ error: error.message ?? 'Unexpected server error.' }, 500)
      }

      return new Response('Unexpected server error.', { status: 500 })
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sendDueReminderMessages(env))
  },
}
