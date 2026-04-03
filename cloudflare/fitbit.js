export function getFitbitConfig(env, request = null) {
  const origin = request ? new URL(request.url).origin : env.FRONTEND_URL ?? ''

  return {
    clientId: env.FITBIT_CLIENT_ID ?? '',
    clientSecret: env.FITBIT_CLIENT_SECRET ?? '',
    redirectUri: env.FITBIT_REDIRECT_URI ?? `${origin}/api/fitbit/callback`,
    frontendUrl: env.FRONTEND_URL ?? origin,
    timeZone: env.REMINDER_TIMEZONE ?? 'America/New_York',
    scopes: (env.FITBIT_SCOPES ?? 'activity heartrate profile sleep weight').split(/\s+/).filter(Boolean),
  }
}

export function isFitbitConfigured(config) {
  return Boolean(config.clientId && config.clientSecret && config.redirectUri)
}

function getFitbitAuthorizationHeader(config) {
  return `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`
}

export function buildFitbitAuthorizeUrl(config, state) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: config.scopes.join(' '),
    redirect_uri: config.redirectUri,
    expires_in: '31536000',
    state,
  })

  return `https://www.fitbit.com/oauth2/authorize?${params.toString()}`
}

export function buildFitbitFrontendRedirect(request, config, status, message = '') {
  const url = new URL(config.frontendUrl || new URL(request.url).origin)
  url.searchParams.set('fitbit', status)

  if (message) {
    url.searchParams.set('message', message)
  }

  return url.toString()
}

export async function exchangeFitbitToken(config, body) {
  const response = await fetch('https://api.fitbit.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: getFitbitAuthorizationHeader(config),
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

async function fetchFitbitSummary(accessToken, timeZone) {
  const today = getDateForTimeZone(timeZone)
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

async function refreshFitbitConnectionIfNeeded(store, config) {
  const fitbitState = await store.getFitbitState()
  const connection = fitbitState.connection

  if (!connection) {
    return fitbitState
  }

  const expiresAt = connection.expiresAt ? new Date(connection.expiresAt).getTime() : 0

  if (expiresAt > Date.now() + 60_000) {
    return fitbitState
  }

  const refreshed = await exchangeFitbitToken(config, {
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
  })
}

export async function syncFitbitData(store, config) {
  const fitbitState = await refreshFitbitConnectionIfNeeded(store, config)

  if (!fitbitState.connection?.accessToken) {
    throw new Error('Fitbit is not connected yet.')
  }

  const summary = mergeFitbitSummary(
    fitbitState.summary,
    await fetchFitbitSummary(fitbitState.connection.accessToken, config.timeZone)
  )

  return store.saveFitbitState({
    connection: {
      ...fitbitState.connection,
      profileName: summary.profileName || fitbitState.connection.profileName || '',
    },
    summary,
    pendingAuthState: '',
  })
}

export async function syncFitbitIfStale(store, config, maxAgeMs = 15 * 60 * 1000) {
  const fitbitState = await store.getFitbitState()

  if (!fitbitState.connection?.accessToken) {
    return fitbitState
  }

  const lastSyncAt = fitbitState.summary?.lastSyncAt ? new Date(fitbitState.summary.lastSyncAt).getTime() : 0
  const isFresh = lastSyncAt && Date.now() - lastSyncAt < maxAgeMs

  if (isFresh) {
    return fitbitState
  }

  return syncFitbitData(store, config)
}
