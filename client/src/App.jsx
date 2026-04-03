import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

const emptyBpForm = {
  systolic: '',
  diastolic: '',
  pulse: '',
  notes: '',
  recordedAt: '',
}

const emptyFoodForm = {
  foodName: '',
  servingSize: '',
  sodiumMg: '',
  mealType: 'Meal',
  barcode: '',
  loggedAt: '',
}

const emptyMedicationForm = {
  medicationName: '',
  dosage: '',
  takenAt: '',
  notes: '',
}

const emptyReminderForm = {
  title: '',
  reminderType: 'medication',
  timeOfDay: '08:00',
  medicationName: '',
  dosage: '',
  notes: '',
}

const importExample = `date,time,systolic,diastolic,pulse,notes
04/03/2026,8:15 AM,132,84,75,Morning reading
04/04/2026,7:40 AM,128,82,71,Before breakfast`
const CELEBRATION_STEPS_GOAL = 15000
const REMINDER_CHECK_INTERVAL_MS = 30_000

function formatImportDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const year = date.getFullYear()
  return `${month}/${day}/${year}`
}

function parseScreenshotDateLabel(label) {
  const cleaned = String(label ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[A-Za-z]{3,9},?\s+/, '')
    .trim()

  if (!cleaned) {
    return null
  }

  const now = new Date()
  const parsed = new Date(`${cleaned} ${now.getFullYear()} 12:00:00`)

  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  const lookAhead = new Date(now)
  lookAhead.setDate(now.getDate() + 14)

  if (parsed > lookAhead) {
    parsed.setFullYear(parsed.getFullYear() - 1)
  }

  return parsed
}

function extractBloodPressureRowsFromScreenshotText(rawText) {
  const compactText = String(rawText ?? '')
    .replace(/\r/g, '\n')
    .replace(/[|]/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')

  const pattern =
    /((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+[A-Za-z]{3,9}\s+\d{1,2})\s+(\d{1,2}:\d{2}\s*[AP]M)\s+(\d{2,3})\s*\/\s*(\d{2,3})\s*(?:mmHg|mmhg|mmha|mmhg\.?)?\s+(\d{2,3})\s*(?:bpm)?/gi
  const matches = Array.from(compactText.matchAll(pattern))

  return matches
    .map((match) => {
      const parsedDate = parseScreenshotDateLabel(match[1])

      if (!parsedDate) {
        return null
      }

      return {
        date: formatImportDate(parsedDate),
        time: match[2].replace(/\s+/g, ' ').trim(),
        systolic: Number(match[3]),
        diastolic: Number(match[4]),
        pulse: Number(match[5]),
        notes: 'Imported from screenshot',
      }
    })
    .filter(Boolean)
}

function createImportTextFromRows(rows) {
  const header = 'date,time,systolic,diastolic,pulse,notes'
  const body = rows.map((row) =>
    [row.date, row.time, row.systolic, row.diastolic, row.pulse, row.notes].join(',')
  )
  return [header, ...body].join('\n')
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

function formatDay(value) {
  const normalizedValue = value.length === 10 ? `${value}T12:00:00` : value
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(normalizedValue))
}

function formatDateOnly(value) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value))
}

function getLocalDayKey(value = new Date()) {
  const date = new Date(value)
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10)
}

function formatTimeOfDay(value) {
  if (!value) {
    return ''
  }

  const [hourText = '0', minuteText = '00'] = String(value).split(':')
  const date = new Date()
  date.setHours(Number(hourText), Number(minuteText), 0, 0)

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function getReminderMedicationName(reminder) {
  return reminder.medicationName?.trim() || reminder.title?.trim() || 'Medication'
}

function buildReminderMedicationNote(reminder) {
  return `Taken from reminder: ${reminder.title} at ${reminder.timeOfDay}`
}

function findReminderMedicationLogToday(reminder, medicationLogs) {
  const todayKey = getLocalDayKey()
  const targetMedication = getReminderMedicationName(reminder).toLowerCase()
  const targetNote = buildReminderMedicationNote(reminder)

  return medicationLogs.find((entry) => {
    if (getLocalDayKey(entry.takenAt) !== todayKey) {
      return false
    }

    const medicationMatches = String(entry.medicationName ?? '').trim().toLowerCase() === targetMedication
    const noteMatches = String(entry.notes ?? '').includes(targetNote)
    return medicationMatches && noteMatches
  })
}

function groupMedicationLogsByDay(medicationLogs) {
  const groups = new Map()

  for (const entry of medicationLogs) {
    const dayKey = getLocalDayKey(entry.takenAt)

    if (!groups.has(dayKey)) {
      groups.set(dayKey, [])
    }

    groups.get(dayKey).push(entry)
  }

  return [...groups.entries()]
    .sort((left, right) => right[0].localeCompare(left[0]))
    .map(([dayKey, entries]) => ({
      dayKey,
      entries: [...entries].sort((left, right) => new Date(right.takenAt) - new Date(left.takenAt)),
    }))
}

function escapeCsvCell(value) {
  const normalized = String(value ?? '')
  return /[",\n]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function buildCsv(rows, headers) {
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsvCell(row[header])).join(','))
  }
  return lines.join('\n')
}

function getReminderDueKey(reminderId, dayKey, timeOfDay) {
  return `${reminderId}|${dayKey}|${timeOfDay}`
}

function computeTrendInsights(dashboard, fitbitSummary, medicationLogs) {
  if (!dashboard) {
    return []
  }

  const insights = []
  const activeTrendDays = dashboard.weeklyTrend.filter((entry) => entry.averageSystolic > 0)

  if (activeTrendDays.length >= 2) {
    const highestSodiumDay = [...activeTrendDays].sort((left, right) => right.sodiumTotalMg - left.sodiumTotalMg)[0]
    const lowestSodiumDay = [...activeTrendDays].sort((left, right) => left.sodiumTotalMg - right.sodiumTotalMg)[0]

    if (highestSodiumDay && lowestSodiumDay && highestSodiumDay.averageSystolic > lowestSodiumDay.averageSystolic) {
      insights.push(
        `Higher sodium day ${highestSodiumDay.label} (${highestSodiumDay.sodiumTotalMg} mg) matched a higher average systolic reading than your lighter sodium day ${lowestSodiumDay.label}.`
      )
    }
  }

  if (dashboard.latestBloodPressure && dashboard.weeklySummary.averageSystolic) {
    const difference = dashboard.latestBloodPressure.systolic - dashboard.weeklySummary.averageSystolic

    if (Math.abs(difference) >= 8) {
      insights.push(
        difference > 0
          ? `Your latest systolic reading is ${difference} points above your weekly average.`
          : `Your latest systolic reading is ${Math.abs(difference)} points below your weekly average.`
      )
    }
  }

  if (fitbitSummary?.stepsToday >= CELEBRATION_STEPS_GOAL) {
    insights.push(`You already reached your ${CELEBRATION_STEPS_GOAL.toLocaleString()} step goal today.`)
  } else if (fitbitSummary?.stepsToday) {
    insights.push(
      `You are ${(CELEBRATION_STEPS_GOAL - fitbitSummary.stepsToday).toLocaleString()} steps away from today's celebration goal.`
    )
  }

  const medicationToday = medicationLogs.filter(
    (entry) => new Date(entry.takenAt).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)
  )

  if (medicationToday.length) {
    insights.push(`You logged ${medicationToday.length} medication ${medicationToday.length === 1 ? 'dose' : 'doses'} today.`)
  }

  return insights.slice(0, 4)
}

function getLocalDateTimeValue() {
  const now = new Date()
  const offset = now.getTimezoneOffset()
  const localDate = new Date(now.getTime() - offset * 60_000)
  return localDate.toISOString().slice(0, 16)
}

async function fetchJson(path, options) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
    ...options,
  })
  const body = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(body.error ?? 'Request failed')
  }

  return body
}

async function decodeBarcodeFromPhoto(file, scannerNodeRef, scannerInstanceRef) {
  const BarcodeDetectorClass = window.BarcodeDetector

  if (BarcodeDetectorClass) {
    try {
      const detector = new BarcodeDetectorClass({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'],
      })
      const bitmap = await createImageBitmap(file)

      try {
        const detected = await detector.detect(bitmap)
        const rawValue = detected.find((entry) => entry.rawValue?.trim())?.rawValue?.trim()

        if (rawValue) {
          return rawValue
        }
      } finally {
        bitmap.close?.()
      }
    } catch {
      // Fall through to the library decoder below.
    }
  }

  const { Html5Qrcode } = await import('html5-qrcode')

  if (!scannerNodeRef.current) {
    throw new Error('Scanner container is not ready yet.')
  }

  if (!scannerInstanceRef.current) {
    scannerInstanceRef.current = new Html5Qrcode(scannerNodeRef.current.id)
  }

  try {
    return await scannerInstanceRef.current.scanFile(file, true)
  } catch {
    return scannerInstanceRef.current.scanFile(file, false)
  }
}

async function playCelebrationSound() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext

  if (!AudioContextClass) {
    return
  }

  const audioContext = new AudioContextClass()

  try {
    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    const notes = [
      { frequency: 523.25, duration: 0.14 },
      { frequency: 659.25, duration: 0.14 },
      { frequency: 783.99, duration: 0.18 },
      { frequency: 1046.5, duration: 0.28 },
    ]
    let cursor = audioContext.currentTime

    for (const note of notes) {
      const oscillator = audioContext.createOscillator()
      const gainNode = audioContext.createGain()

      oscillator.type = 'triangle'
      oscillator.frequency.setValueAtTime(note.frequency, cursor)
      gainNode.gain.setValueAtTime(0.0001, cursor)
      gainNode.gain.exponentialRampToValueAtTime(0.18, cursor + 0.02)
      gainNode.gain.exponentialRampToValueAtTime(0.0001, cursor + note.duration)

      oscillator.connect(gainNode)
      gainNode.connect(audioContext.destination)
      oscillator.start(cursor)
      oscillator.stop(cursor + note.duration)

      cursor += note.duration * 0.82
    }

    window.setTimeout(() => {
      audioContext.close().catch(() => null)
    }, 900)
  } catch {
    audioContext.close().catch(() => null)
  }
}

function formatScannerError(error) {
  const message = String(error?.message ?? error ?? '')

  if (
    /permission|denied|notallowederror|securityerror|permission dismissed|access denied/i.test(message)
  ) {
    return 'Camera permission was denied. Allow camera access for this site in your browser settings, or use Scan from photo below.'
  }

  if (/secure context|https|insecure/i.test(message)) {
    return 'Camera scan needs a secure HTTPS page. Open the live website link and try again.'
  }

  if (/notfounderror|no camera/i.test(message)) {
    return 'No camera was found on this device. You can still use Scan from photo below.'
  }

  return message || 'The camera could not start. You can still use Scan from photo below.'
}

async function requestCameraPermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not support camera access.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
    },
    audio: false,
  })

  stream.getTracks().forEach((track) => track.stop())
}

function SummaryCard({ title, value, helper, tone = 'neutral' }) {
  return (
    <article className={`summary-card summary-card--${tone}`}>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
    </article>
  )
}

function GoalBadgesPanel({ goalBadges }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Badge Shelf</p>
          <h2>Successful day badges</h2>
        </div>
        <p className="panel-copy">
          Each gold badge marks a day when you reached 15,000 steps and stayed within your sodium goal.
        </p>
      </div>

      <div className="badge-summary">
        <strong>{goalBadges.length}</strong>
        <span>{goalBadges.length === 1 ? 'gold badge earned' : 'gold badges earned'}</span>
      </div>

      {goalBadges.length ? (
        <div className="badge-grid">
          {goalBadges.slice(0, 12).map((badge) => (
            <article key={badge.date} className="badge-card">
              <div className="badge-medal" aria-hidden="true">
                ★
              </div>
              <strong>{formatDay(badge.date)}</strong>
              <small>{badge.steps.toLocaleString()} steps</small>
              <small>
                {badge.sodiumTotalMg.toLocaleString()} / {badge.sodiumGoalMg.toLocaleString()} mg
              </small>
            </article>
          ))}
        </div>
      ) : (
        <div className="import-hint">
          Your first gold badge will appear here after you reach 15,000 steps and stay within your sodium goal for the day.
        </div>
      )}
    </section>
  )
}

function MedicationPanel({
  medicationLogs,
  medicationForm,
  setMedicationForm,
  onSubmit,
  onDelete,
  deletingId,
}) {
  const dailyGroups = groupMedicationLogsByDay(medicationLogs).slice(0, 7)

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Medication</p>
          <h2>Track medicine doses</h2>
        </div>
        <p className="panel-copy">Log what you took, the dosage, and when you took it.</p>
      </div>

      <form className="form-grid" onSubmit={onSubmit}>
        <label>
          <span>Medication name</span>
          <input
            type="text"
            value={medicationForm.medicationName}
            onChange={(event) =>
              setMedicationForm((current) => ({ ...current, medicationName: event.target.value }))
            }
            required
          />
        </label>
        <label>
          <span>Dosage</span>
          <input
            type="text"
            value={medicationForm.dosage}
            onChange={(event) =>
              setMedicationForm((current) => ({ ...current, dosage: event.target.value }))
            }
            required
          />
        </label>
        <label>
          <span>Date and time</span>
          <input
            type="datetime-local"
            value={medicationForm.takenAt}
            onChange={(event) =>
              setMedicationForm((current) => ({ ...current, takenAt: event.target.value }))
            }
            required
          />
        </label>
        <label className="full-width">
          <span>Notes</span>
          <textarea
            rows="2"
            value={medicationForm.notes}
            onChange={(event) =>
              setMedicationForm((current) => ({ ...current, notes: event.target.value }))
            }
          />
        </label>
        <button className="button button--solid" type="submit">
          Save medication log
        </button>
      </form>

      <div className="panel-subsection">
        <h3>Daily medication history</h3>
        <p className="panel-copy">Your recent medicine check-ins are grouped by day so you can confirm you took them.</p>
      </div>

      {dailyGroups.length ? (
        <div className="daily-log-list">
          {dailyGroups.map((group) => (
            <section key={group.dayKey} className="daily-log-card">
              <div className="history-main">
                <div>
                  <strong>{formatDateOnly(group.dayKey)}</strong>
                  <span>
                    {group.entries.length} {group.entries.length === 1 ? 'dose logged' : 'doses logged'}
                  </span>
                </div>
              </div>

              <ul className="activity-list">
                {group.entries.map((entry) => (
                  <li key={entry.id}>
                    <div className="history-main">
                      <div>
                        <strong>{entry.medicationName}</strong>
                        <span>{entry.dosage}</span>
                      </div>
                      <button
                        className="button button--danger"
                        type="button"
                        onClick={() => onDelete(entry)}
                        disabled={deletingId === entry.id}
                      >
                        {deletingId === entry.id ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                    <small>{formatDateTime(entry.takenAt)}</small>
                    {entry.notes ? <p>{entry.notes}</p> : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="import-hint">Your medication history will show up here once you log a dose.</div>
      )}
    </section>
  )
}

function RemindersPanel({
  reminders,
  medicationLogs,
  reminderForm,
  setReminderForm,
  notificationPermission,
  onEnableNotifications,
  onSubmit,
  onLogTaken,
  quickLogReminderId,
  onDelete,
  deletingId,
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Reminders</p>
          <h2>Daily reminders</h2>
        </div>
        <p className="panel-copy">Set medicine or check-in reminders that appear while the app is open, then tap Mark taken for a one-click daily log.</p>
      </div>

      <div className="fitbit-actions">
        <button className="button button--ghost" type="button" onClick={onEnableNotifications}>
          Notifications: {notificationPermission}
        </button>
      </div>

      <form className="form-grid" onSubmit={onSubmit}>
        <label className="full-width">
          <span>Reminder title</span>
          <input
            type="text"
            value={reminderForm.title}
            onChange={(event) =>
              setReminderForm((current) => ({ ...current, title: event.target.value }))
            }
            required
          />
        </label>
        <label>
          <span>Type</span>
          <select
            value={reminderForm.reminderType}
            onChange={(event) =>
              setReminderForm((current) => ({ ...current, reminderType: event.target.value }))
            }
          >
            <option value="medication">Medication</option>
            <option value="blood-pressure">Blood pressure</option>
            <option value="general">General</option>
          </select>
        </label>
        <label>
          <span>Time</span>
          <input
            type="time"
            value={reminderForm.timeOfDay}
            onChange={(event) =>
              setReminderForm((current) => ({ ...current, timeOfDay: event.target.value }))
            }
            required
          />
        </label>
        <label>
          <span>Medication name</span>
          <input
            type="text"
            value={reminderForm.medicationName}
            onChange={(event) =>
              setReminderForm((current) => ({ ...current, medicationName: event.target.value }))
            }
          />
        </label>
        <label>
          <span>Dosage</span>
          <input
            type="text"
            value={reminderForm.dosage}
            onChange={(event) =>
              setReminderForm((current) => ({ ...current, dosage: event.target.value }))
            }
            placeholder="Example: 10 mg"
          />
        </label>
        <label className="full-width">
          <span>Notes</span>
          <textarea
            rows="2"
            value={reminderForm.notes}
            onChange={(event) =>
              setReminderForm((current) => ({ ...current, notes: event.target.value }))
            }
          />
        </label>
        <button className="button button--solid" type="submit">
          Save reminder
        </button>
      </form>

      <ul className="activity-list">
        {reminders.map((entry) => (
          (() => {
            const todayLog = entry.reminderType === 'medication'
              ? findReminderMedicationLogToday(entry, medicationLogs)
              : null

            return (
              <li key={entry.id}>
                <div className="history-main">
                  <div>
                    <strong>{entry.title}</strong>
                    <span>{formatTimeOfDay(entry.timeOfDay)}</span>
                  </div>
                  <div className="history-actions">
                    {entry.reminderType === 'medication' ? (
                      <button
                        className="button button--solid"
                        type="button"
                        onClick={() => onLogTaken(entry)}
                        disabled={Boolean(todayLog) || quickLogReminderId === entry.id}
                      >
                        {quickLogReminderId === entry.id ? 'Saving...' : todayLog ? 'Taken today' : 'Mark taken'}
                      </button>
                    ) : null}
                    <button
                      className="button button--danger"
                      type="button"
                      onClick={() => onDelete(entry)}
                      disabled={deletingId === entry.id}
                    >
                      {deletingId === entry.id ? 'Deleting...' : 'Delete'}
                    </button>
                  </div>
                </div>
                <small>{entry.reminderType}</small>
                {entry.medicationName ? <p>Medication: {entry.medicationName}</p> : null}
                {entry.dosage ? <p>Dosage: {entry.dosage}</p> : null}
                {todayLog ? <p>Logged today at {formatDateTime(todayLog.takenAt)}.</p> : null}
                {entry.notes ? <p>{entry.notes}</p> : null}
              </li>
            )
          })()
        ))}
      </ul>
    </section>
  )
}

function ExportPanel({ onPrintReport, onExportBloodPressureCsv, onExportMedicationCsv, onBackupExport, onBackupImport }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Export</p>
          <h2>Print and save your data</h2>
        </div>
        <p className="panel-copy">Create a doctor-friendly report or save data for Excel and backup.</p>
      </div>

      <div className="export-grid">
        <button className="button button--solid" type="button" onClick={onPrintReport}>
          Print or Save PDF
        </button>
        <button className="button button--ghost" type="button" onClick={onExportBloodPressureCsv}>
          Export BP CSV
        </button>
        <button className="button button--ghost" type="button" onClick={onExportMedicationCsv}>
          Export Medication CSV
        </button>
        <button className="button button--ghost" type="button" onClick={onBackupExport}>
          Export Full Backup
        </button>
        <label className="button button--ghost export-upload">
          Restore Backup
          <input type="file" accept="application/json" onChange={onBackupImport} />
        </label>
      </div>
    </section>
  )
}

function InsightsPanel({ insights }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Insights</p>
          <h2>Trend insights</h2>
        </div>
        <p className="panel-copy">Helpful patterns pulled from your recent blood pressure, sodium, and Fitbit data.</p>
      </div>

      <ul className="insight-list">
        {insights.map((insight) => (
          <li key={insight}>{insight}</li>
        ))}
      </ul>
    </section>
  )
}

function getFoodSodiumAssessment(sodiumMg, dailyGoalMg, todayTotalMg) {
  const sodiumValue = Number(sodiumMg)

  if (!Number.isFinite(sodiumValue) || sodiumValue <= 0) {
    return null
  }

  let itemTone = 'good'
  let itemLabel = 'Low sodium'
  let itemMessage = 'This item is a relatively low-sodium choice per serving.'

  if (sodiumValue > 400) {
    itemTone = 'danger'
    itemLabel = 'High sodium'
    itemMessage = 'This item is high in sodium and may be a tough fit for a low-sodium day.'
  } else if (sodiumValue > 140) {
    itemTone = 'warning'
    itemLabel = 'Moderate sodium'
    itemMessage = 'This item is moderate in sodium, so portion size matters.'
  }

  const projectedTotal = todayTotalMg + sodiumValue
  const percentOfGoal = Math.round((sodiumValue / dailyGoalMg) * 100)
  const projectedPercent = Math.round((projectedTotal / dailyGoalMg) * 100)

  let goalTone = 'good'
  let goalMessage = `${sodiumValue} mg would use about ${percentOfGoal}% of your daily sodium goal.`

  if (projectedTotal > dailyGoalMg) {
    goalTone = 'danger'
    goalMessage = `If you save this item, you would go over your daily goal by ${projectedTotal - dailyGoalMg} mg.`
  } else if (projectedPercent >= 90) {
    goalTone = 'danger'
    goalMessage = `If you save this item, you would be very close to your limit at ${projectedTotal} mg for the day.`
  } else if (projectedPercent >= 75) {
    goalTone = 'warning'
    goalMessage = `If you save this item, you would be at ${projectedTotal} mg today, which is getting close to your limit.`
  }

  return {
    itemTone,
    itemLabel,
    itemMessage,
    goalTone,
    goalMessage,
    projectedTotal,
    percentOfGoal,
  }
}

function HistoryPanel({ history, formatDateTime, onDeleteBloodPressure, onDeleteFoodLog, deletingId }) {
  const [historyTab, setHistoryTab] = useState('blood-pressure')
  const [bpSearch, setBpSearch] = useState('')
  const [foodSearch, setFoodSearch] = useState('')

  const filteredBloodPressure = useMemo(() => {
    const query = bpSearch.trim().toLowerCase()

    if (!query) {
      return history.bloodPressureLogs
    }

    return history.bloodPressureLogs.filter((entry) =>
      [entry.notes, String(entry.systolic), String(entry.diastolic), String(entry.pulse)]
        .join(' ')
        .toLowerCase()
        .includes(query)
    )
  }, [history.bloodPressureLogs, bpSearch])

  const filteredFoodLogs = useMemo(() => {
    const query = foodSearch.trim().toLowerCase()

    if (!query) {
      return history.foodLogs
    }

    return history.foodLogs.filter((entry) =>
      [entry.foodName, entry.mealType, entry.servingSize, entry.barcode, String(entry.sodiumMg)]
        .join(' ')
        .toLowerCase()
        .includes(query)
    )
  }, [history.foodLogs, foodSearch])

  return (
    <section className="panel panel--history">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">History</p>
          <h2>Full entry history</h2>
        </div>
        <p className="panel-copy">
          Your older readings stay saved here so you can review trends beyond the dashboard cards.
        </p>
      </div>

      <div className="history-tabs">
        <button
          className={`history-tab ${historyTab === 'blood-pressure' ? 'history-tab--active' : ''}`}
          type="button"
          onClick={() => setHistoryTab('blood-pressure')}
        >
          Blood pressure
        </button>
        <button
          className={`history-tab ${historyTab === 'food' ? 'history-tab--active' : ''}`}
          type="button"
          onClick={() => setHistoryTab('food')}
        >
          Food + sodium
        </button>
      </div>

      {historyTab === 'blood-pressure' ? (
        <div className="history-section">
          <input
            type="text"
            placeholder="Search notes or values"
            value={bpSearch}
            onChange={(event) => setBpSearch(event.target.value)}
          />
            <div className="history-count">{filteredBloodPressure.length} blood pressure entries</div>
          <ul className="history-list">
            {filteredBloodPressure.map((entry) => (
              <li key={entry.id}>
                <div className="history-main">
                  <div>
                    <strong>
                      {entry.systolic}/{entry.diastolic}
                    </strong>
                    <span>Pulse {entry.pulse}</span>
                  </div>
                  <button
                    className="button button--danger"
                    type="button"
                    onClick={() => onDeleteBloodPressure(entry)}
                    disabled={deletingId === entry.id}
                  >
                    {deletingId === entry.id ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
                <small>{formatDateTime(entry.recordedAt)}</small>
                {entry.notes ? <p>{entry.notes}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="history-section">
          <input
            type="text"
            placeholder="Search food name, meal, barcode, or sodium"
            value={foodSearch}
            onChange={(event) => setFoodSearch(event.target.value)}
          />
          <div className="history-count">{filteredFoodLogs.length} food entries</div>
          <ul className="history-list">
            {filteredFoodLogs.map((entry) => (
              <li key={entry.id}>
                <div className="history-main">
                  <div>
                    <strong>{entry.foodName}</strong>
                    <span>{entry.sodiumMg} mg sodium</span>
                  </div>
                  <button
                    className="button button--danger"
                    type="button"
                    onClick={() => onDeleteFoodLog(entry)}
                    disabled={deletingId === entry.id}
                  >
                    {deletingId === entry.id ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
                <small>{`${entry.mealType} | ${entry.servingSize} | ${formatDateTime(entry.loggedAt)}`}</small>
                {entry.barcode ? <p>Barcode: {entry.barcode}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function FitbitPanel({ fitbit, busy, onConnect, onSync, onDisconnect }) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Fitbit</p>
          <h2>Connect your Fitbit account</h2>
        </div>
        <p className="panel-copy">
          Fitbit can bring in steps, heart rate, sleep, and weight so you can compare them with your
          blood pressure and sodium trends.
        </p>
      </div>

      {!fitbit.configured ? (
        <div className="status status--error">
          Fitbit app credentials are not configured yet. Add your Fitbit app keys to `.env` before
          connecting.
        </div>
      ) : null}

      {fitbit.connected ? (
        <div className="fitbit-panel">
          <div className="fitbit-actions">
            <button className="button button--solid" type="button" onClick={onSync} disabled={busy}>
              {busy ? 'Syncing Fitbit...' : 'Sync Fitbit'}
            </button>
            <button className="button button--ghost" type="button" onClick={onDisconnect} disabled={busy}>
              Disconnect Fitbit
            </button>
          </div>

          <div className="fitbit-summary">
            <div className="fitbit-card">
              <span>Account</span>
              <strong>{fitbit.profileName || fitbit.summary?.profileName || 'Connected'}</strong>
              <small>Fitbit connection is active</small>
            </div>
            <div className="fitbit-card">
              <span>Steps Today</span>
              <strong>{fitbit.summary?.stepsToday ?? 0}</strong>
              <small>From Fitbit activity data</small>
            </div>
            <div className="fitbit-card">
              <span>Heart Rate</span>
              <strong>
                {fitbit.summary?.latestHeartRate ?? fitbit.summary?.restingHeartRate ?? '--'}
              </strong>
              <small>
                {fitbit.summary?.latestHeartRate
                  ? `Latest reading at ${fitbit.summary?.latestHeartRateTime || 'today'}`
                  : fitbit.summary?.restingHeartRate
                    ? 'Resting heart rate'
                    : 'No heart rate data yet'}
              </small>
            </div>
            <div className="fitbit-card">
              <span>Sleep</span>
              <strong>{fitbit.summary?.sleepMinutes ?? 0} min</strong>
              <small>{fitbit.summary?.sleepRecords ?? 0} sleep record(s) today</small>
            </div>
            <div className="fitbit-card">
              <span>Weight</span>
              <strong>{fitbit.summary?.weightValue ?? '--'}</strong>
              <small>{fitbit.summary?.weightDate || 'No weight logged today'}</small>
            </div>
            <div className="fitbit-card">
              <span>Last Sync</span>
              <strong>
                {fitbit.summary?.lastSyncAt ? formatDateTime(fitbit.summary.lastSyncAt) : '--'}
              </strong>
              <small>Manual sync keeps data current</small>
            </div>
          </div>
        </div>
      ) : (
        <div className="fitbit-panel">
          <div className="fitbit-actions">
            <button
              className="button button--solid"
              type="button"
              onClick={onConnect}
              disabled={busy || !fitbit.configured}
            >
              {busy ? 'Preparing Fitbit...' : 'Connect Fitbit'}
            </button>
          </div>

          <div className="import-hint">
            Fitbit support in this app uses OAuth. After you create a Fitbit developer app and add
            the keys to `.env`, this button will open Fitbit sign-in and consent.
          </div>
        </div>
      )}
    </section>
  )
}

function ScannerPanel({ onLookupComplete, lookupState, setLookupState }) {
  const scannerNodeRef = useRef(null)
  const scannerInstanceRef = useRef(null)
  const fileInputRef = useRef(null)
  const [manualBarcode, setManualBarcode] = useState('')
  const [scannerReady, setScannerReady] = useState(false)
  const [fileScanBusy, setFileScanBusy] = useState(false)
  const [showCameraHelp, setShowCameraHelp] = useState(false)
  const [preferPhotoCapture, setPreferPhotoCapture] = useState(false)

  useEffect(() => {
    const isTouchDevice = window.matchMedia('(pointer: coarse)').matches
    const isPhoneLikeDevice = /android|iphone|ipad|ipod/i.test(window.navigator.userAgent)
    setPreferPhotoCapture(isTouchDevice || isPhoneLikeDevice)
  }, [])

  useEffect(() => {
    return () => {
      if (scannerInstanceRef.current) {
        scannerInstanceRef.current
          .stop()
          .catch(() => null)
          .finally(() => {
            scannerInstanceRef.current?.clear().catch(() => null)
          })
      }
    }
  }, [])

  async function lookupBarcode(barcode) {
    if (!barcode.trim()) {
      setLookupState({
        loading: false,
        error: 'Enter a barcode number to search.',
        message: '',
      })
      return
    }

    setLookupState({ loading: true, error: '', message: 'Looking up nutrition facts...' })

    try {
      const result = await fetchJson(`/api/barcode/${barcode.trim()}`)
      onLookupComplete(result.item)
      setLookupState({
        loading: false,
        error: '',
        message: `Loaded ${result.item.foodName}. Review it below and save it to your day log.`,
      })
    } catch (error) {
      setLookupState({
        loading: false,
        error: error.message,
        message: '',
      })
    }
  }

  async function startScanner() {
    setLookupState({ loading: true, error: '', message: 'Opening camera...' })

    try {
      await requestCameraPermission()

      const { Html5Qrcode } = await import('html5-qrcode')

      if (!scannerNodeRef.current) {
        throw new Error('Scanner container is not ready yet.')
      }

      if (!scannerInstanceRef.current) {
        scannerInstanceRef.current = new Html5Qrcode(scannerNodeRef.current.id)
      }

      const config = {
        fps: 10,
        qrbox: { width: 240, height: 120 },
        aspectRatio: 1.7777778,
      }
      const handleDecodedText = async (decodedText) => {
        setManualBarcode(decodedText)
        await scannerInstanceRef.current?.stop().catch(() => null)
        await lookupBarcode(decodedText)
        setScannerReady(false)
      }

      try {
        await scannerInstanceRef.current.start(
          { facingMode: { ideal: 'environment' } },
          config,
          handleDecodedText,
          () => null
        )
      } catch (constraintError) {
        const cameras = await Html5Qrcode.getCameras()

        if (!cameras.length) {
          throw constraintError
        }

        const preferredCamera =
          cameras.find((camera) => camera.label.toLowerCase().includes('back')) ?? cameras[0]

        await scannerInstanceRef.current.start(
          preferredCamera.id,
          config,
          handleDecodedText,
          () => null
        )
      }

      setScannerReady(true)
      setLookupState({
        loading: false,
        error: '',
        message: 'Point your camera at a package barcode.',
      })
    } catch (error) {
      setLookupState({
        loading: false,
        error: formatScannerError(error),
        message: '',
      })
    }
  }

  async function stopScanner() {
    if (!scannerInstanceRef.current) {
      return
    }

    await scannerInstanceRef.current.stop().catch(() => null)
    await scannerInstanceRef.current.clear().catch(() => null)
    setScannerReady(false)
    setLookupState({
      loading: false,
      error: '',
      message: 'Camera closed. You can still paste a barcode manually.',
    })
  }

  async function handleFileScan(event) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    setFileScanBusy(true)
    setLookupState({
      loading: false,
      error: '',
      message: 'Reading barcode from your photo and looking up the food...',
    })

    try {
      const decodedText = await decodeBarcodeFromPhoto(file, scannerNodeRef, scannerInstanceRef)
      setManualBarcode(decodedText)
      await lookupBarcode(decodedText)
    } catch (error) {
      setLookupState({
        loading: false,
        error:
          'The photo was captured, but the barcode could not be read. Try another close, well-lit photo that shows only the barcode, or enter the barcode manually.',
        message: '',
      })
    } finally {
      event.target.value = ''
      setFileScanBusy(false)
    }
  }

  function handlePrimaryScanAction() {
    if (preferPhotoCapture) {
      fileInputRef.current?.click()
      return
    }

    startScanner()
  }

  return (
    <section className="panel panel--scanner">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Phone Scan</p>
          <h2>Scan packaged food with your camera</h2>
        </div>
        <p className="panel-copy">
          {preferPhotoCapture
            ? 'On phones, the main scan button opens your camera or photo picker, then the app reads the barcode from the photo and loads the food automatically.'
            : 'On larger screens, the scanner opens inside the website so you can scan a barcode without leaving the page.'}
        </p>
      </div>

      <div className="scanner-actions">
        <button className="button button--solid" type="button" onClick={handlePrimaryScanAction}>
          {preferPhotoCapture ? 'Take barcode photo' : 'Start camera scan'}
        </button>
        <button
          className="button button--ghost"
          type="button"
          onClick={stopScanner}
          disabled={!scannerReady}
        >
          Stop camera
        </button>
        <button
          className="button button--ghost"
          type="button"
          onClick={() => setShowCameraHelp((current) => !current)}
        >
          {showCameraHelp ? 'Hide camera help' : 'Fix camera access'}
        </button>
      </div>

      {showCameraHelp ? (
        <div className="camera-help">
          <strong>Try these steps</strong>
          <div className="camera-help__grid">
            <article className="camera-help__card">
              <span>iPhone</span>
              <p>Open the site in Safari, tap the `aA` or site icon, then allow Camera and reload the page.</p>
            </article>
            <article className="camera-help__card">
              <span>Android</span>
              <p>Open the site in Chrome, tap the lock or settings icon by the address bar, allow Camera, then refresh.</p>
            </article>
            <article className="camera-help__card">
              <span>If it still fails</span>
              <p>Close the old tab, reopen the live website link, or use `Scan from photo` to upload a barcode image instead.</p>
            </article>
          </div>
        </div>
      ) : null}

      <div className="file-scan">
        <label htmlFor="barcodePhoto">Scan from photo</label>
        <input
          ref={fileInputRef}
          id="barcodePhoto"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileScan}
          disabled={fileScanBusy}
        />
      </div>

      <div className="import-hint">
        If camera permission is blocked on your phone, use Scan from photo or allow camera access in your browser site settings.
      </div>

      <div id="barcode-scanner" className="scanner-shell" ref={scannerNodeRef} />

      <div className="manual-lookup">
        <label htmlFor="manualBarcode">Manual barcode</label>
        <div className="inline-form">
          <input
            id="manualBarcode"
            type="text"
            inputMode="numeric"
            placeholder="Example: 041196910503"
            value={manualBarcode}
            onChange={(event) => setManualBarcode(event.target.value)}
          />
          <button
            className="button button--solid"
            type="button"
            onClick={() => lookupBarcode(manualBarcode)}
            disabled={lookupState.loading}
          >
            Find food
          </button>
        </div>
      </div>

      {lookupState.message ? <p className="status status--ok">{lookupState.message}</p> : null}
      {lookupState.error ? <p className="status status--error">{lookupState.error}</p> : null}
    </section>
  )
}

function App() {
  const [dashboard, setDashboard] = useState(null)
  const [history, setHistory] = useState({
    bloodPressureLogs: [],
    foodLogs: [],
  })
  const [fitbit, setFitbit] = useState({
    configured: false,
    connected: false,
    scopes: [],
    profileName: '',
    summary: null,
  })
  const [status, setStatus] = useState({ loading: true, error: '' })
  const [bpForm, setBpForm] = useState({
    ...emptyBpForm,
    recordedAt: getLocalDateTimeValue(),
  })
  const [foodForm, setFoodForm] = useState({
    ...emptyFoodForm,
    loggedAt: getLocalDateTimeValue(),
  })
  const [goalValue, setGoalValue] = useState('2300')
  const [savingState, setSavingState] = useState('')
  const [medicationLogs, setMedicationLogs] = useState([])
  const [reminders, setReminders] = useState([])
  const [medicationForm, setMedicationForm] = useState({
    ...emptyMedicationForm,
    takenAt: getLocalDateTimeValue(),
  })
  const [reminderForm, setReminderForm] = useState(emptyReminderForm)
  const [notificationPermission, setNotificationPermission] = useState(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  )
  const [lookupState, setLookupState] = useState({
    loading: false,
    error: '',
    message: '',
  })
  const [importText, setImportText] = useState('')
  const [importResult, setImportResult] = useState(null)
  const [screenshotFile, setScreenshotFile] = useState(null)
  const [screenshotFileName, setScreenshotFileName] = useState('')
  const [screenshotStatus, setScreenshotStatus] = useState({
    tone: '',
    message: '',
  })
  const [screenshotBusy, setScreenshotBusy] = useState(false)
  const [installPrompt, setInstallPrompt] = useState(null)
  const [installMessage, setInstallMessage] = useState('')
  const [isInstalled, setIsInstalled] = useState(false)
  const [deletingId, setDeletingId] = useState('')
  const [quickLogReminderId, setQuickLogReminderId] = useState('')
  const [fitbitBusy, setFitbitBusy] = useState(false)
  const [goalBadges, setGoalBadges] = useState([])
  const playedBadgeDatesRef = useRef(new Set())
  const fitbitSyncInFlightRef = useRef(false)
  const lastAutoSyncAttemptRef = useRef(0)
  const fitbitSessionAutoSyncRef = useRef(false)
  const triggeredRemindersRef = useRef(new Set())

  const foodAssessment = useMemo(() => {
    if (!dashboard) {
      return null
    }

    return getFoodSodiumAssessment(
      foodForm.sodiumMg,
      dashboard.settings.sodiumGoalMg,
      dashboard.today.sodiumTotalMg
    )
  }, [dashboard, foodForm.sodiumMg])

  async function loadDashboard(options = {}) {
    if (!options.silent || !dashboard) {
      setStatus({ loading: true, error: '' })
    }

    try {
      const [dashboardData, historyData, fitbitData, celebrationsData, medicationData, reminderData] = await Promise.all([
        fetchJson('/api/dashboard'),
        fetchJson('/api/history'),
        fetchJson('/api/fitbit/status'),
        fetchJson('/api/celebrations'),
        fetchJson('/api/medications'),
        fetchJson('/api/reminders'),
      ])
      setDashboard(dashboardData)
      setHistory(historyData)
      setFitbit(fitbitData)
      setGoalBadges(celebrationsData.goalBadges ?? [])
      setMedicationLogs(medicationData.medicationLogs ?? [])
      setReminders(reminderData.reminders ?? [])
      setGoalValue(String(dashboardData.settings.sodiumGoalMg))
      setStatus({ loading: false, error: '' })
    } catch (error) {
      setStatus({ loading: false, error: error.message })
    }
  }

  useEffect(() => {
    loadDashboard()
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const fitbitStatus = params.get('fitbit')
    const message = params.get('message')

    if (!fitbitStatus) {
      return
    }

    if (fitbitStatus === 'connected') {
      setSavingState('Fitbit connected successfully.')
      loadDashboard({ silent: true })
    } else if (fitbitStatus === 'error') {
      setSavingState(`Fitbit connection error: ${message || 'Unknown error'}`)
    }

    const nextUrl = new URL(window.location.href)
    nextUrl.searchParams.delete('fitbit')
    nextUrl.searchParams.delete('message')
    window.history.replaceState({}, '', nextUrl)
  }, [])

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true

    if (standalone) {
      setIsInstalled(true)
      setInstallMessage('This app is already installed on this device.')
    }

    function handleBeforeInstallPrompt(event) {
      event.preventDefault()
      setInstallPrompt(event)
      setInstallMessage('Install is available on supported phones and browsers.')
    }

    function handleAppInstalled() {
      setIsInstalled(true)
      setInstallPrompt(null)
      setInstallMessage('App installed. You can open it from your home screen.')
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  useEffect(() => {
    if (typeof Notification !== 'undefined') {
      setNotificationPermission(Notification.permission)
    }
  }, [])

  const sodiumTone = useMemo(() => {
    if (!dashboard) {
      return 'neutral'
    }

    if (dashboard.today.sodiumPercent >= 100) {
      return 'danger'
    }

    if (dashboard.today.sodiumPercent >= 75) {
      return 'warning'
    }

    return 'success'
  }, [dashboard])

  const celebration = useMemo(() => {
    if (!dashboard) {
      return null
    }

    const stepsToday = Number(fitbit.summary?.stepsToday ?? 0)
    const withinSodiumGoal = dashboard.today.sodiumTotalMg <= dashboard.settings.sodiumGoalMg

    if (stepsToday < CELEBRATION_STEPS_GOAL || !withinSodiumGoal) {
      return null
    }

    return {
      stepsToday,
      sodiumTotalMg: dashboard.today.sodiumTotalMg,
      sodiumGoalMg: dashboard.settings.sodiumGoalMg,
    }
  }, [dashboard, fitbit.summary?.stepsToday])

  const insights = useMemo(
    () => computeTrendInsights(dashboard, fitbit.summary, medicationLogs),
    [dashboard, fitbit.summary, medicationLogs]
  )

  useEffect(() => {
    if (!celebration || !dashboard) {
      return
    }

    let cancelled = false

    async function claimTodayBadge() {
      try {
        const result = await fetchJson('/api/celebrations/claim', {
          method: 'POST',
          body: JSON.stringify({
            date: dashboard.today.date,
            steps: celebration.stepsToday,
            sodiumTotalMg: celebration.sodiumTotalMg,
            sodiumGoalMg: celebration.sodiumGoalMg,
          }),
        })

        if (cancelled) {
          return
        }

        setGoalBadges(result.goalBadges ?? [])

        if (result.created && !playedBadgeDatesRef.current.has(dashboard.today.date)) {
          playedBadgeDatesRef.current.add(dashboard.today.date)
          setSavingState('Hooray! You earned a new gold badge today.')
          playCelebrationSound().catch(() => null)
        }
      } catch {
        // If the claim request fails, we still keep the visible celebration banner.
      }
    }

    claimTodayBadge()

    return () => {
      cancelled = true
    }
  }, [celebration, dashboard])

  async function handleInstallClick() {
    if (isInstalled) {
      setInstallMessage('This app is already installed on this device.')
      return
    }

    if (!installPrompt) {
      const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent)
      setInstallMessage(
        isIos
          ? 'Open this site in Safari, tap Share, then choose Add to Home Screen.'
          : 'Open this site in Chrome, tap the browser menu, then choose Install app or Add to Home screen.'
      )
      return
    }

    await installPrompt.prompt()
    const outcome = await installPrompt.userChoice

    if (outcome.outcome === 'accepted') {
      setInstallMessage('Install accepted. Finish adding it from your browser prompt.')
    } else {
      setInstallMessage('Install was dismissed. You can try again later.')
    }

    setInstallPrompt(null)
  }

  async function handleFitbitConnect() {
    setFitbitBusy(true)

    try {
      const result = await fetchJson('/api/fitbit/connect-url')
      window.location.href = result.authorizeUrl
    } catch (error) {
      setSavingState(error.message)
      setFitbitBusy(false)
    }
  }

  async function syncFitbitData(options = {}) {
    if (fitbitSyncInFlightRef.current) {
      return
    }

    fitbitSyncInFlightRef.current = true
    setFitbitBusy(true)

    if (!options.silent) {
      setSavingState('Syncing Fitbit data...')
    }

    try {
      const result = await fetchJson('/api/fitbit/sync', {
        method: 'POST',
      })
      setFitbit((current) => ({
        ...current,
        connected: result.connected,
        profileName: result.profileName,
        summary: result.summary,
      }))

      if (!options.silent) {
        setSavingState('Fitbit data synced.')
      }
    } catch (error) {
      if (!options.silent) {
        setSavingState(error.message)
      }
    } finally {
      fitbitSyncInFlightRef.current = false
      setFitbitBusy(false)
    }
  }

  async function handleFitbitSync() {
    await syncFitbitData()
  }

  async function handleFitbitDisconnect() {
    const confirmed = window.confirm('Disconnect Fitbit from this website?')

    if (!confirmed) {
      return
    }

    setFitbitBusy(true)
    setSavingState('Disconnecting Fitbit...')

    try {
      await fetchJson('/api/fitbit/disconnect', {
        method: 'POST',
      })
      fitbitSessionAutoSyncRef.current = false
      setFitbit((current) => ({
        ...current,
        connected: false,
        profileName: '',
        summary: null,
      }))
      setSavingState('Fitbit disconnected.')
    } catch (error) {
      setSavingState(error.message)
    } finally {
      setFitbitBusy(false)
    }
  }

  useEffect(() => {
    if (!fitbit.connected || !fitbit.configured) {
      fitbitSessionAutoSyncRef.current = false
      return
    }

    if (!fitbitSessionAutoSyncRef.current) {
      fitbitSessionAutoSyncRef.current = true
      lastAutoSyncAttemptRef.current = Date.now()
      syncFitbitData({ silent: true }).catch(() => null)
    }

    const syncIfNeeded = () => {
      const lastSyncAt = fitbit.summary?.lastSyncAt ? new Date(fitbit.summary.lastSyncAt).getTime() : 0
      const syncIsStale = !lastSyncAt || Date.now() - lastSyncAt > 5 * 60 * 1000
      const enoughTimeSinceAttempt = Date.now() - lastAutoSyncAttemptRef.current > 60 * 1000

      if (!syncIsStale || !enoughTimeSinceAttempt || document.visibilityState === 'hidden') {
        return
      }

      lastAutoSyncAttemptRef.current = Date.now()
      syncFitbitData({ silent: true }).catch(() => null)
    }

    syncIfNeeded()

    const intervalId = window.setInterval(syncIfNeeded, 5 * 60 * 1000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        syncIfNeeded()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [fitbit.connected, fitbit.configured, fitbit.summary?.lastSyncAt])

  useEffect(() => {
    if (!reminders.length) {
      return
    }

    const notifyDueReminders = () => {
      const now = new Date()
      const dayKey = now.toISOString().slice(0, 10)
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

      for (const reminder of reminders) {
        if (!reminder.enabled || reminder.timeOfDay !== currentTime) {
          continue
        }

        const dueKey = getReminderDueKey(reminder.id, dayKey, reminder.timeOfDay)

        if (triggeredRemindersRef.current.has(dueKey)) {
          continue
        }

        triggeredRemindersRef.current.add(dueKey)
        setSavingState(`Reminder: ${reminder.title}`)

        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification(reminder.title, {
            body: reminder.notes || `${reminder.reminderType} reminder for ${reminder.timeOfDay}`,
          })
        }
      }
    }

    notifyDueReminders()
    const intervalId = window.setInterval(notifyDueReminders, REMINDER_CHECK_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [reminders])

  async function handleGoalSubmit(event) {
    event.preventDefault()
    setSavingState('Saving sodium goal...')

    try {
      await fetchJson('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ sodiumGoalMg: Number(goalValue) }),
      })
      await loadDashboard({ silent: true })
      setSavingState('Daily sodium goal updated.')
    } catch (error) {
      setSavingState(error.message)
    }
  }

  async function handleMedicationSubmit(event) {
    event.preventDefault()
    setSavingState('Saving medication log...')

    try {
      await fetchJson('/api/medications', {
        method: 'POST',
        body: JSON.stringify(medicationForm),
      })
      setMedicationForm({
        ...emptyMedicationForm,
        takenAt: getLocalDateTimeValue(),
      })
      await loadDashboard({ silent: true })
      setSavingState('Medication log saved.')
    } catch (error) {
      setSavingState(error.message)
    }
  }

  async function handleDeleteMedication(entry) {
    if (!window.confirm(`Delete medication log for ${entry.medicationName}?`)) {
      return
    }

    setDeletingId(entry.id)
    setSavingState('Deleting medication log...')

    try {
      await fetchJson(`/api/medications/${entry.id}`, { method: 'DELETE' })
      await loadDashboard({ silent: true })
      setSavingState('Medication log deleted.')
    } catch (error) {
      setSavingState(error.message)
    } finally {
      setDeletingId('')
    }
  }

  async function handleReminderSubmit(event) {
    event.preventDefault()
    setSavingState('Saving reminder...')

    try {
      await fetchJson('/api/reminders', {
        method: 'POST',
        body: JSON.stringify({ ...reminderForm, enabled: true }),
      })
      setReminderForm(emptyReminderForm)
      await loadDashboard({ silent: true })
      setSavingState('Reminder saved.')
    } catch (error) {
      setSavingState(error.message)
    }
  }

  async function handleReminderTaken(entry) {
    const medicationName = getReminderMedicationName(entry)
    const dosage = entry.dosage?.trim() || 'Taken'

    setQuickLogReminderId(entry.id)
    setSavingState(`Logging ${medicationName} for today...`)

    try {
      await fetchJson('/api/medications', {
        method: 'POST',
        body: JSON.stringify({
          medicationName,
          dosage,
          takenAt: new Date().toISOString(),
          notes: [buildReminderMedicationNote(entry), entry.notes?.trim()].filter(Boolean).join(' • '),
        }),
      })
      await loadDashboard({ silent: true })
      setSavingState(`${medicationName} logged for today.`)
    } catch (error) {
      setSavingState(error.message)
    } finally {
      setQuickLogReminderId('')
    }
  }

  async function handleDeleteReminder(entry) {
    if (!window.confirm(`Delete reminder "${entry.title}"?`)) {
      return
    }

    setDeletingId(entry.id)
    setSavingState('Deleting reminder...')

    try {
      await fetchJson(`/api/reminders/${entry.id}`, { method: 'DELETE' })
      await loadDashboard({ silent: true })
      setSavingState('Reminder deleted.')
    } catch (error) {
      setSavingState(error.message)
    } finally {
      setDeletingId('')
    }
  }

  async function handleEnableNotifications() {
    if (typeof Notification === 'undefined') {
      setSavingState('Notifications are not supported in this browser.')
      return
    }

    const permission = await Notification.requestPermission()
    setNotificationPermission(permission)
    setSavingState(
      permission === 'granted'
        ? 'Reminder notifications are enabled.'
        : 'Browser notifications are still blocked, so reminders will only show while the app is open.'
    )
  }

  function handleExportBloodPressureCsv() {
    const csv = buildCsv(
      history.bloodPressureLogs.map((entry) => ({
        recordedAt: entry.recordedAt,
        systolic: entry.systolic,
        diastolic: entry.diastolic,
        pulse: entry.pulse,
        notes: entry.notes,
      })),
      ['recordedAt', 'systolic', 'diastolic', 'pulse', 'notes']
    )
    downloadFile(`blood-pressure-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8')
  }

  function handleExportMedicationCsv() {
    const csv = buildCsv(
      medicationLogs.map((entry) => ({
        takenAt: entry.takenAt,
        medicationName: entry.medicationName,
        dosage: entry.dosage,
        notes: entry.notes,
      })),
      ['takenAt', 'medicationName', 'dosage', 'notes']
    )
    downloadFile(`medication-log-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8')
  }

  function handlePrintReport() {
    const reportWindow = window.open('', '_blank', 'width=900,height=1200')

    if (!reportWindow || !dashboard) {
      setSavingState('The report window could not open. Please allow popups for this site.')
      return
    }

    const medicationList = medicationLogs
      .slice(0, 12)
      .map((entry) => `<li>${formatDateTime(entry.takenAt)} - ${entry.medicationName} ${entry.dosage}</li>`)
      .join('')
    const bpList = history.bloodPressureLogs
      .slice(0, 12)
      .map((entry) => `<li>${formatDateTime(entry.recordedAt)} - ${entry.systolic}/${entry.diastolic}, pulse ${entry.pulse}</li>`)
      .join('')
    const foodList = history.foodLogs
      .slice(0, 12)
      .map((entry) => `<li>${formatDateTime(entry.loggedAt)} - ${entry.foodName} (${entry.sodiumMg} mg)</li>`)
      .join('')

    reportWindow.document.write(`
      <html>
        <head>
          <title>Health Tracking Report</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 24px; color: #203030; }
            h1, h2 { margin-bottom: 8px; }
            section { margin-bottom: 24px; }
            ul { padding-left: 20px; }
          </style>
        </head>
        <body>
          <h1>Blood Pressure and Sodium Report</h1>
          <p>Generated ${new Date().toLocaleString()}</p>
          <section>
            <h2>Today</h2>
            <p>Sodium: ${dashboard.today.sodiumTotalMg} / ${dashboard.settings.sodiumGoalMg} mg</p>
            <p>Steps: ${(fitbit.summary?.stepsToday ?? 0).toLocaleString()}</p>
          </section>
          <section><h2>Recent Blood Pressure</h2><ul>${bpList}</ul></section>
          <section><h2>Recent Food Logs</h2><ul>${foodList}</ul></section>
          <section><h2>Medication Logs</h2><ul>${medicationList}</ul></section>
        </body>
      </html>
    `)
    reportWindow.document.close()
    reportWindow.focus()
    reportWindow.print()
  }

  async function handleBackupExport() {
    try {
      const backup = await fetchJson('/api/backup')
      downloadFile(
        `pressure-salt-backup-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(backup, null, 2),
        'application/json;charset=utf-8'
      )
      setSavingState('Backup exported.')
    } catch (error) {
      setSavingState(error.message)
    }
  }

  async function handleBackupImport(event) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    try {
      const parsed = JSON.parse(await file.text())
      await fetchJson('/api/backup/restore', {
        method: 'POST',
        body: JSON.stringify(parsed),
      })
      await loadDashboard({ silent: true })
      setSavingState('Backup restored successfully.')
    } catch (error) {
      setSavingState(error.message || 'Backup restore failed.')
    } finally {
      event.target.value = ''
    }
  }

  async function handleBpSubmit(event) {
    event.preventDefault()
    setSavingState('Saving blood pressure reading...')

    try {
      await fetchJson('/api/blood-pressure', {
        method: 'POST',
        body: JSON.stringify({
          systolic: Number(bpForm.systolic),
          diastolic: Number(bpForm.diastolic),
          pulse: Number(bpForm.pulse),
          notes: bpForm.notes,
          recordedAt: new Date(bpForm.recordedAt).toISOString(),
        }),
      })

      setBpForm({
        ...emptyBpForm,
        recordedAt: getLocalDateTimeValue(),
      })
      await loadDashboard({ silent: true })
      setSavingState('Blood pressure reading saved.')
    } catch (error) {
      setSavingState(error.message)
    }
  }

  async function handleFoodSubmit(event) {
    event.preventDefault()
    setSavingState('Saving food entry...')

    try {
      await fetchJson('/api/food-logs', {
        method: 'POST',
        body: JSON.stringify({
          foodName: foodForm.foodName,
          servingSize: foodForm.servingSize,
          sodiumMg: Number(foodForm.sodiumMg),
          mealType: foodForm.mealType,
          barcode: foodForm.barcode,
          loggedAt: new Date(foodForm.loggedAt).toISOString(),
        }),
      })

      setFoodForm({
        ...emptyFoodForm,
        loggedAt: getLocalDateTimeValue(),
      })
      setLookupState({ loading: false, error: '', message: '' })
      await loadDashboard({ silent: true })
      setSavingState('Food saved to the day log.')
    } catch (error) {
      setSavingState(error.message)
    }
  }

  async function handleImportSubmit(event) {
    event.preventDefault()
    setSavingState('Importing blood pressure readings...')
    setImportResult(null)

    try {
      const result = await fetchJson('/api/import/blood-pressure', {
        method: 'POST',
        body: JSON.stringify({
          rawText: importText,
        }),
      })

      await loadDashboard({ silent: true })
      setImportText('')
      setSavingState('Blood pressure import finished.')
      setImportResult(result)
    } catch (error) {
      setSavingState(error.message)
      setImportResult({
        importedCount: 0,
        duplicateCount: 0,
        skippedCount: 0,
        errors: [error.message],
        importedEntries: [],
      })
    }
  }

  function handleScreenshotSelection(event) {
    const file = event.target.files?.[0] ?? null
    setScreenshotFile(file)
    setScreenshotFileName(file?.name ?? '')
    setScreenshotStatus({
      tone: '',
      message: file ? 'Screenshot selected. Tap Read screenshot to extract the rows.' : '',
    })
  }

  async function handleScreenshotRead() {
    if (!screenshotFile) {
      setScreenshotStatus({
        tone: 'error',
        message: 'Choose a screenshot image first.',
      })
      return
    }

    setScreenshotBusy(true)
    setImportResult(null)
    setScreenshotStatus({
      tone: 'ok',
      message: 'Reading screenshot...',
    })

    try {
      const { recognize } = await import('tesseract.js')
      const result = await recognize(screenshotFile, 'eng', {
        logger: (message) => {
          if (message.status === 'recognizing text') {
            setScreenshotStatus({
              tone: 'ok',
              message: `Reading screenshot... ${Math.round(message.progress * 100)}%`,
            })
          }
        },
      })

      const rows = extractBloodPressureRowsFromScreenshotText(result.data.text)

      if (!rows.length) {
        throw new Error(
          'Could not read any blood pressure rows from that screenshot. Try cropping tighter around the table and upload again.'
        )
      }

      setImportText(createImportTextFromRows(rows))
      setScreenshotStatus({
        tone: 'ok',
        message: `Found ${rows.length} rows. Review them below, then tap Import readings.`,
      })
    } catch (error) {
      setScreenshotStatus({
        tone: 'error',
        message: error.message,
      })
    } finally {
      setScreenshotBusy(false)
    }
  }

  async function handleDeleteBloodPressure(entry) {
    const confirmed = window.confirm(
      `Delete blood pressure reading ${entry.systolic}/${entry.diastolic} from ${formatDateTime(entry.recordedAt)}?`
    )

    if (!confirmed) {
      return
    }

    setDeletingId(entry.id)
    setSavingState('Deleting blood pressure entry...')

    try {
      await fetchJson(`/api/blood-pressure/${entry.id}`, {
        method: 'DELETE',
      })
      await loadDashboard({ silent: true })
      setSavingState('Blood pressure entry deleted.')
    } catch (error) {
      setSavingState(error.message)
    } finally {
      setDeletingId('')
    }
  }

  async function handleDeleteFoodLog(entry) {
    const confirmed = window.confirm(
      `Delete food entry "${entry.foodName}" from ${formatDateTime(entry.loggedAt)}?`
    )

    if (!confirmed) {
      return
    }

    setDeletingId(entry.id)
    setSavingState('Deleting food entry...')

    try {
      await fetchJson(`/api/food-logs/${entry.id}`, {
        method: 'DELETE',
      })
      await loadDashboard({ silent: true })
      setSavingState('Food entry deleted.')
    } catch (error) {
      setSavingState(error.message)
    } finally {
      setDeletingId('')
    }
  }

  function fillFoodFormFromLookup(item) {
    setFoodForm({
      foodName: item.foodName ?? '',
      servingSize: item.servingSize ?? '',
      sodiumMg: item.sodiumMg ? String(item.sodiumMg) : '',
      mealType: 'Scan',
      barcode: item.barcode ?? '',
      loggedAt: getLocalDateTimeValue(),
    })
  }

  if (status.loading) {
    return (
      <main className="app-shell loading-shell">
        <div className="loading-card">
          <p className="eyebrow">Loading</p>
          <h1>Preparing your health tracker...</h1>
          <p>Starting the dashboard, recent logs, and sodium summary.</p>
        </div>
      </main>
    )
  }

  if (status.error) {
    return (
      <main className="app-shell loading-shell">
        <div className="loading-card">
          <p className="eyebrow">Connection Issue</p>
          <h1>The app could not reach the local API.</h1>
          <p>{status.error}</p>
          <button className="button button--solid" type="button" onClick={loadDashboard}>
            Try again
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="app-shell">
      {celebration ? (
        <section className="celebration-banner">
          <div className="celebration-confetti" aria-hidden="true">
            {Array.from({ length: 18 }, (_, index) => (
              <span key={index} className={`confetti-piece confetti-piece--${(index % 6) + 1}`} />
            ))}
          </div>
          <div className="celebration-copy">
            <p className="eyebrow">Goal Celebration</p>
            <h2>Hooray! You did it today.</h2>
            <p>
              You reached {celebration.stepsToday.toLocaleString()} steps and stayed within your{' '}
              {celebration.sodiumGoalMg.toLocaleString()} mg sodium goal at{' '}
              {celebration.sodiumTotalMg.toLocaleString()} mg.
            </p>
          </div>
        </section>
      ) : null}

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Blood Pressure + Sodium Tracker</p>
          <h1>A local test app you can run before deployment.</h1>
          <p className="hero-text">
            This version gives you a real dashboard, daily sodium totals, blood pressure logs,
            a barcode scan flow for packaged foods, and charts that help you compare your habits.
          </p>
          <div className="hero-badges">
            <span>React + Vite</span>
            <span>Express API</span>
            <span>PostgreSQL-ready</span>
            <span>Phone camera scan</span>
          </div>
          <div className="install-strip">
            <button
              className="button button--install"
              type="button"
              onClick={handleInstallClick}
              disabled={isInstalled}
            >
              {isInstalled ? 'Installed on phone' : 'Install on phone'}
            </button>
            <p>
              {installMessage ||
                'After deployment on HTTPS, this can be installed from your phone browser.'}
            </p>
          </div>
        </div>

        <section className="hero-meter">
          <div className="meter-header">
            <span>Daily sodium progress</span>
            <strong>
              {dashboard.today.sodiumTotalMg} / {dashboard.settings.sodiumGoalMg} mg
            </strong>
          </div>
          <div className="meter-track">
            <div
              className={`meter-fill meter-fill--${sodiumTone}`}
              style={{ width: `${Math.min(dashboard.today.sodiumPercent, 100)}%` }}
            />
          </div>
          <p className="meter-note">
            {dashboard.today.sodiumRemainingMg >= 0
              ? `${dashboard.today.sodiumRemainingMg} mg remaining today`
              : `${Math.abs(dashboard.today.sodiumRemainingMg)} mg over goal today`}
          </p>
          <small className="storage-note">
            Storage mode: {dashboard.storageMode === 'postgres' ? 'PostgreSQL' : 'Local test data file'}
          </small>
        </section>
      </section>

      <section className="summary-grid">
        <SummaryCard
          title="Latest BP"
          value={
            dashboard.latestBloodPressure
              ? `${dashboard.latestBloodPressure.systolic}/${dashboard.latestBloodPressure.diastolic}`
              : 'No reading yet'
          }
          helper={
            dashboard.latestBloodPressure
              ? `Pulse ${dashboard.latestBloodPressure.pulse} on ${formatDateTime(dashboard.latestBloodPressure.recordedAt)}`
              : 'Add your first reading below'
          }
          tone="neutral"
        />
        <SummaryCard
          title="Foods Logged Today"
          value={String(dashboard.today.foodCount)}
          helper={`${dashboard.today.scanCount} scanned package${dashboard.today.scanCount === 1 ? '' : 's'}`}
          tone="success"
        />
        <SummaryCard
          title="Weekly Average BP"
          value={`${dashboard.weeklySummary.averageSystolic}/${dashboard.weeklySummary.averageDiastolic}`}
          helper="Average across the last 7 days"
          tone="warning"
        />
        <SummaryCard
          title="Entries This Week"
          value={String(dashboard.weeklySummary.totalEntries)}
          helper="Blood pressure and food logs combined"
          tone="neutral"
        />
      </section>

      <section className="summary-grid summary-grid--badges">
        <SummaryCard
          title="Gold Badges"
          value={String(goalBadges.length)}
          helper="Successful step and sodium goal days saved"
          tone="warning"
        />
        <SummaryCard
          title="Today Steps"
          value={(fitbit.summary?.stepsToday ?? 0).toLocaleString()}
          helper={`Goal is ${CELEBRATION_STEPS_GOAL.toLocaleString()} steps`}
          tone={celebration ? 'success' : 'neutral'}
        />
      </section>

      <section className="content-grid">
        <div className="content-column">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Settings</p>
                <h2>Daily sodium goal</h2>
              </div>
              <p className="panel-copy">
                Set the daily sodium limit you want the dashboard to measure against.
              </p>
            </div>

            <form className="simple-form" onSubmit={handleGoalSubmit}>
              <label htmlFor="goalValue">Sodium goal in milligrams</label>
              <div className="inline-form">
                <input
                  id="goalValue"
                  type="number"
                  min="500"
                  step="50"
                  value={goalValue}
                  onChange={(event) => setGoalValue(event.target.value)}
                />
                <button className="button button--solid" type="submit">
                  Save goal
                </button>
              </div>
            </form>
          </section>

          <FitbitPanel
            fitbit={fitbit}
            busy={fitbitBusy}
            onConnect={handleFitbitConnect}
            onSync={handleFitbitSync}
            onDisconnect={handleFitbitDisconnect}
          />

          <ExportPanel
            onPrintReport={handlePrintReport}
            onExportBloodPressureCsv={handleExportBloodPressureCsv}
            onExportMedicationCsv={handleExportMedicationCsv}
            onBackupExport={handleBackupExport}
            onBackupImport={handleBackupImport}
          />

          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Blood Pressure</p>
                <h2>Add a reading</h2>
              </div>
              <p className="panel-copy">
                Log systolic, diastolic, pulse, and any notes such as stress, medication, or exercise.
              </p>
            </div>

            <form className="form-grid" onSubmit={handleBpSubmit}>
              <label>
                <span>Systolic</span>
                <input
                  type="number"
                  min="50"
                  value={bpForm.systolic}
                  onChange={(event) =>
                    setBpForm((current) => ({ ...current, systolic: event.target.value }))
                  }
                  required
                />
              </label>
              <label>
                <span>Diastolic</span>
                <input
                  type="number"
                  min="30"
                  value={bpForm.diastolic}
                  onChange={(event) =>
                    setBpForm((current) => ({ ...current, diastolic: event.target.value }))
                  }
                  required
                />
              </label>
              <label>
                <span>Pulse</span>
                <input
                  type="number"
                  min="30"
                  value={bpForm.pulse}
                  onChange={(event) =>
                    setBpForm((current) => ({ ...current, pulse: event.target.value }))
                  }
                  required
                />
              </label>
              <label>
                <span>Date and time</span>
                <input
                  type="datetime-local"
                  value={bpForm.recordedAt}
                  onChange={(event) =>
                    setBpForm((current) => ({ ...current, recordedAt: event.target.value }))
                  }
                  required
                />
              </label>
              <label className="full-width">
                <span>Notes</span>
                <textarea
                  rows="3"
                  placeholder="Example: Mild headache, exercised before reading, took medication."
                  value={bpForm.notes}
                  onChange={(event) =>
                    setBpForm((current) => ({ ...current, notes: event.target.value }))
                  }
                />
              </label>
              <button className="button button--solid" type="submit">
                Save reading
              </button>
            </form>
          </section>

          <MedicationPanel
            medicationLogs={medicationLogs}
            medicationForm={medicationForm}
            setMedicationForm={setMedicationForm}
            onSubmit={handleMedicationSubmit}
            onDelete={handleDeleteMedication}
            deletingId={deletingId}
          />

          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Food Log</p>
                <h2>Add food and sodium</h2>
              </div>
              <p className="panel-copy">
                Enter food manually or let the barcode scan pre-fill the nutrition values first.
              </p>
            </div>

            <form className="form-grid" onSubmit={handleFoodSubmit}>
              <label className="full-width">
                <span>Food name</span>
                <input
                  type="text"
                  value={foodForm.foodName}
                  onChange={(event) =>
                    setFoodForm((current) => ({ ...current, foodName: event.target.value }))
                  }
                  required
                />
              </label>
              <label>
                <span>Serving size</span>
                <input
                  type="text"
                  placeholder="1 bowl, 1 can, 2 slices"
                  value={foodForm.servingSize}
                  onChange={(event) =>
                    setFoodForm((current) => ({ ...current, servingSize: event.target.value }))
                  }
                  required
                />
              </label>
              <label>
                <span>Sodium mg</span>
                <input
                  type="number"
                  min="0"
                  value={foodForm.sodiumMg}
                  onChange={(event) =>
                    setFoodForm((current) => ({ ...current, sodiumMg: event.target.value }))
                  }
                  required
                />
              </label>
              <label>
                <span>Meal type</span>
                <select
                  value={foodForm.mealType}
                  onChange={(event) =>
                    setFoodForm((current) => ({ ...current, mealType: event.target.value }))
                  }
                >
                  <option>Meal</option>
                  <option>Snack</option>
                  <option>Drink</option>
                  <option>Scan</option>
                </select>
              </label>
              <label>
                <span>Date and time</span>
                <input
                  type="datetime-local"
                  value={foodForm.loggedAt}
                  onChange={(event) =>
                    setFoodForm((current) => ({ ...current, loggedAt: event.target.value }))
                  }
                  required
                />
              </label>
              <label className="full-width">
                <span>Barcode</span>
                <input
                  type="text"
                  placeholder="Optional if entered manually"
                  value={foodForm.barcode}
                  onChange={(event) =>
                    setFoodForm((current) => ({ ...current, barcode: event.target.value }))
                  }
                />
              </label>
              <button className="button button--solid" type="submit">
                Save food
              </button>
            </form>

            {foodAssessment ? (
              <div className="food-check">
                <div className={`food-check__card food-check__card--${foodAssessment.itemTone}`}>
                  <span className="food-check__label">{foodAssessment.itemLabel}</span>
                  <strong>{foodForm.sodiumMg} mg sodium</strong>
                  <p>{foodAssessment.itemMessage}</p>
                </div>

                <div className={`food-check__card food-check__card--${foodAssessment.goalTone}`}>
                  <span className="food-check__label">Daily goal impact</span>
                  <strong>{foodAssessment.projectedTotal} mg projected today</strong>
                  <p>{foodAssessment.goalMessage}</p>
                </div>
              </div>
            ) : null}
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Safe Import</p>
                <h2>Import blood pressure readings</h2>
              </div>
              <p className="panel-copy">
                Paste CSV, tab-separated, pipe-separated, or semicolon-separated blood pressure rows
                from a report export. This import only adds readings and skips duplicates.
              </p>
            </div>

            <form className="simple-form" onSubmit={handleImportSubmit}>
              <label htmlFor="bpScreenshot">Upload screenshot from your phone</label>
              <div className="screenshot-import">
                <input
                  id="bpScreenshot"
                  type="file"
                  accept="image/*"
                  onChange={handleScreenshotSelection}
                />
                <div className="inline-form">
                  <button
                    className="button button--ghost"
                    type="button"
                    onClick={handleScreenshotRead}
                    disabled={screenshotBusy}
                  >
                    {screenshotBusy ? 'Reading screenshot...' : 'Read screenshot'}
                  </button>
                  {screenshotFileName ? <span className="file-pill">{screenshotFileName}</span> : null}
                </div>
              </div>

              <div className="import-hint">
                Best results come from a clean screenshot cropped close to the blood pressure table.
              </div>

              {screenshotStatus.message ? (
                <p
                  className={`status ${screenshotStatus.tone === 'error' ? 'status--error' : 'status--ok'}`}
                >
                  {screenshotStatus.message}
                </p>
              ) : null}

              <label htmlFor="bpImportText">Paste report rows</label>
              <textarea
                id="bpImportText"
                className="import-textarea"
                rows="7"
                placeholder={importExample}
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
              />

              <div className="import-hint">
                Accepted header names include `date`, `time`, `systolic`, `diastolic`, `pulse`,
                and `notes`.
              </div>

              <div className="inline-form">
                <button className="button button--solid" type="submit">
                  Import readings
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => setImportText(importExample)}
                >
                  Load example
                </button>
              </div>
            </form>

            {importResult ? (
              <div className="import-results">
                <div className="import-stats">
                  <span>{importResult.importedCount} imported</span>
                  <span>{importResult.duplicateCount} duplicates skipped</span>
                  <span>{importResult.skippedCount} total skipped</span>
                </div>

                {importResult.errors?.length ? (
                  <ul className="import-list import-list--error">
                    {importResult.errors.map((error) => (
                      <li key={error}>{error}</li>
                    ))}
                  </ul>
                ) : null}

                {importResult.importedEntries?.length ? (
                  <ul className="import-list">
                    {importResult.importedEntries.map((entry) => (
                      <li key={entry.id}>
                        Imported {entry.systolic}/{entry.diastolic}, pulse {entry.pulse} on{' '}
                        {formatDateTime(entry.recordedAt)}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </section>

          <GoalBadgesPanel goalBadges={goalBadges} />
        </div>

        <div className="content-column">
          <ScannerPanel
            onLookupComplete={fillFoodFormFromLookup}
            lookupState={lookupState}
            setLookupState={setLookupState}
          />

          <RemindersPanel
            reminders={reminders}
            medicationLogs={medicationLogs}
            reminderForm={reminderForm}
            setReminderForm={setReminderForm}
            notificationPermission={notificationPermission}
            onEnableNotifications={handleEnableNotifications}
            onSubmit={handleReminderSubmit}
            onLogTaken={handleReminderTaken}
            quickLogReminderId={quickLogReminderId}
            onDelete={handleDeleteReminder}
            deletingId={deletingId}
          />

          <InsightsPanel insights={insights} />

          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Trends</p>
                <h2>Weekly sodium and blood pressure</h2>
              </div>
              <p className="panel-copy">
                Compare your recent sodium totals with daily average blood pressure.
              </p>
            </div>

            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={dashboard.weeklyTrend}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis yAxisId="left" tickLine={false} axisLine={false} />
                  <YAxis yAxisId="right" orientation="right" tickLine={false} axisLine={false} />
                  <Tooltip />
                  <Legend />
                  <Bar
                    yAxisId="left"
                    dataKey="sodiumTotalMg"
                    name="Sodium (mg)"
                    fill="#c65d36"
                    radius={[10, 10, 0, 0]}
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="averageSystolic"
                    name="Avg systolic"
                    stroke="#0f6c61"
                    strokeWidth={3}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={dashboard.weeklyTrend}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} />
                  <YAxis tickLine={false} axisLine={false} domain={['dataMin - 5', 'dataMax + 5']} />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="averageSystolic"
                    name="Avg systolic"
                    stroke="#0f6c61"
                    strokeWidth={3}
                  />
                  <Line
                    type="monotone"
                    dataKey="averageDiastolic"
                    name="Avg diastolic"
                    stroke="#1c3f61"
                    strokeWidth={3}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Recent Activity</p>
                <h2>Latest logs</h2>
              </div>
              <p className="panel-copy">
                Your newest blood pressure readings and food entries appear here.
              </p>
            </div>

            <div className="list-block">
              <h3>Blood pressure</h3>
              <ul className="activity-list">
                {dashboard.recentBloodPressure.map((entry) => (
                  <li key={entry.id}>
                    <strong>
                      {entry.systolic}/{entry.diastolic} <span>Pulse {entry.pulse}</span>
                    </strong>
                    <small>{formatDateTime(entry.recordedAt)}</small>
                    {entry.notes ? <p>{entry.notes}</p> : null}
                  </li>
                ))}
              </ul>
            </div>

            <div className="list-block">
              <h3>Food + sodium</h3>
              <ul className="activity-list">
                {dashboard.recentFoodLogs.map((entry) => (
                  <li key={entry.id}>
                    <strong>
                      {entry.foodName} <span>{entry.sodiumMg} mg</span>
                    </strong>
                    <small>{`${entry.mealType} | ${entry.servingSize} | ${formatDateTime(entry.loggedAt)}`}</small>
                    {entry.barcode ? <p>Barcode: {entry.barcode}</p> : null}
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Today</p>
                <h2>Current summary</h2>
              </div>
            </div>

            <div className="today-grid">
              <div>
                <span className="today-label">Date</span>
                <strong>{formatDay(dashboard.today.date)}</strong>
              </div>
              <div>
                <span className="today-label">Remaining sodium</span>
                <strong>{dashboard.today.sodiumRemainingMg} mg</strong>
              </div>
              <div>
                <span className="today-label">Blood pressure entries</span>
                <strong>{dashboard.today.bloodPressureCount}</strong>
              </div>
              <div>
                <span className="today-label">Food entries</span>
                <strong>{dashboard.today.foodCount}</strong>
              </div>
            </div>
          </section>
        </div>
      </section>

      <HistoryPanel
        history={history}
        formatDateTime={formatDateTime}
        onDeleteBloodPressure={handleDeleteBloodPressure}
        onDeleteFoodLog={handleDeleteFoodLog}
        deletingId={deletingId}
      />

      {savingState ? <p className="save-message">{savingState}</p> : null}
    </main>
  )
}

export default App
