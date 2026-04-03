export const barcodeFallbacks = {
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

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

export function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status)
}

export function toIsoString(value) {
  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('Invalid date/time value.')
  }

  return parsed.toISOString()
}

export function toDayKey(value) {
  return new Date(value).toISOString().slice(0, 10)
}

export function listLastSevenDays() {
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

export function ensureNumber(value, name, min, max) {
  const numericValue = Number(value)

  if (!Number.isFinite(numericValue) || !Number.isInteger(numericValue)) {
    throw new Error(`${name} must be a whole number.`)
  }

  if (numericValue < min || numericValue > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`)
  }

  return numericValue
}

export function ensureString(value, name, minLength, maxLength) {
  const normalized = String(value ?? '').trim()

  if (normalized.length < minLength || normalized.length > maxLength) {
    if (minLength > 0) {
      throw new Error(`${name} must be between ${minLength} and ${maxLength} characters.`)
    }

    throw new Error(`${name} must be ${maxLength} characters or less.`)
  }

  return normalized
}

export function parseSettingsPayload(body) {
  return {
    sodiumGoalMg: ensureNumber(body?.sodiumGoalMg, 'Daily sodium goal', 500, 10000),
  }
}

export function parseBloodPressurePayload(body) {
  return {
    systolic: ensureNumber(body?.systolic, 'Systolic', 50, 280),
    diastolic: ensureNumber(body?.diastolic, 'Diastolic', 30, 200),
    pulse: ensureNumber(body?.pulse, 'Pulse', 30, 220),
    notes: ensureString(body?.notes ?? '', 'Notes', 0, 600),
    recordedAt: toIsoString(body?.recordedAt),
  }
}

export function parseFoodLogPayload(body) {
  return {
    foodName: ensureString(body?.foodName, 'Food name', 2, 180),
    servingSize: ensureString(body?.servingSize, 'Serving size', 1, 120),
    sodiumMg: ensureNumber(body?.sodiumMg, 'Sodium', 0, 10000),
    mealType: ensureString(body?.mealType ?? 'Meal', 'Meal type', 1, 40),
    barcode: ensureString(body?.barcode ?? '', 'Barcode', 0, 80),
    loggedAt: toIsoString(body?.loggedAt),
  }
}

export function parseImportPayload(body) {
  const rawText = ensureString(body?.rawText, 'Import text', 8, 100000)
  return { rawText }
}

export function parseGoalBadgePayload(body) {
  const date = ensureString(body?.date, 'Badge date', 10, 10)
  const steps = ensureNumber(body?.steps, 'Steps', 0, 200000)
  const sodiumTotalMg = ensureNumber(body?.sodiumTotalMg, 'Sodium total', 0, 10000)
  const sodiumGoalMg = ensureNumber(body?.sodiumGoalMg, 'Sodium goal', 500, 10000)

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Badge date must be in YYYY-MM-DD format.')
  }

  return {
    date,
    steps,
    sodiumTotalMg,
    sodiumGoalMg,
  }
}

export function normalizeHeaderName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

export function detectDelimiter(line) {
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

export function parseDelimitedLine(line, delimiter) {
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

export function looksLikeTime(value) {
  return /^(\d{1,2}:\d{2})(:\d{2})?\s*(am|pm)?$/i.test(String(value ?? '').trim())
}

export function parseImportedDate(dateValue, timeValue = '') {
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

export function createHeaderMap(fields) {
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

export function extractImportedRow(fields, headerMap) {
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

export function parseImportedBloodPressureText(rawText) {
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
      errors: ['The import format was not recognized. Use tab, comma, pipe, or semicolon separated rows.'],
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

export function formatDuplicateKey(entry) {
  return `${entry.recordedAt}|${entry.systolic}|${entry.diastolic}|${entry.pulse}`
}

export function parseNutrientToMg(value, unit) {
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

export async function lookupBarcode(barcode) {
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

export async function readJson(request) {
  try {
    return await request.json()
  } catch {
    throw new Error('Request body must be valid JSON.')
  }
}
