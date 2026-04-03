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
  formatDuplicateKey,
  jsonResponse,
  lookupBarcode,
  parseBloodPressurePayload,
  parseFoodLogPayload,
  parseImportPayload,
  parseImportedBloodPressureText,
  parseSettingsPayload,
  readJson,
  toIsoString,
} from './shared.js'

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
}
