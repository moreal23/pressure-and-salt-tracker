# Blood Pressure + Sodium Tracker Test App

This folder is a real local test app you can run with `npm run dev` before deployment.

## What It Does

- Tracks blood pressure readings with systolic, diastolic, pulse, notes, and timestamps
- Imports pasted blood pressure report rows safely, with duplicate skipping
- Reads blood pressure screenshots with OCR and loads the extracted rows into the safe import box
- Tracks sodium intake with daily totals and a goal meter
- Lets you scan or paste food barcodes and look up sodium data
- Shows weekly charts for sodium and blood pressure trends
- Includes a full history view for blood pressure and food entries
- Includes a medication tracker with dosage, notes, and time taken
- Includes daily reminders for medicine or check-ins while the app is open
- Lets you tap a medication reminder to mark it taken and save a daily medication log
- Automatically clears medication logs from prior weeks so each new week starts fresh
- Includes trend insights across sodium, blood pressure, Fitbit steps, and medication logs
- Can print a doctor-friendly report or export blood pressure and medication logs to CSV for Excel
- Can export a full backup file and restore the app from that backup later
- Includes PWA files so it can be installed on supported phones after deployment
- Includes a Fitbit OAuth integration panel for steps, heart rate, sleep, and weight
- Uses PostgreSQL when configured, with a local JSON data file fallback for quick testing
- Includes a Cloudflare Workers + D1 deployment path for one public website URL

## Folder Layout

- `client/` React + Vite frontend
- `server/` Express API
- `database/schema.sql` PostgreSQL schema
- `.env.example` sample environment variables

## Run It

1. Open a terminal in this folder
2. Run `npm install` if needed
3. Run `npm run dev`
4. Open the local website address shown in the terminal, usually `http://localhost:5173`

The API runs on `http://localhost:4000`.

## GitHub And Hosting

This project is prepared for GitHub plus Render hosting:

- `.gitignore` excludes local-only files and secrets
- `render.yaml` defines a single Node web service
- the Express server serves the built React app in production

It is also prepared for Cloudflare Workers:

- `wrangler.jsonc` defines the Worker, static asset routing, and D1 binding
- `cloudflare/worker.js` handles the production API routes
- `migrations/0001_initial.sql` creates the D1 tables

For Render deployment, the health check path is:

- `/api/health`

## PWA Notes

- The app now includes a web manifest, service worker, and phone icons
- Install prompts usually appear on `localhost` for testing or after deployment over `https://`
- On iPhone, you may need to use Safari and choose Add to Home Screen

## PostgreSQL

If you want PostgreSQL right away:

1. Create a PostgreSQL database
2. Put your connection string into `DATABASE_URL`
3. Restart `npm run dev`

If no PostgreSQL connection is available, the app still works using:

- `server/data/dev-data.json`

That fallback is only for local testing. It helps you use the app immediately before deployment.

## Fitbit Setup

1. Create a Fitbit developer app
2. Put your Fitbit client id and secret into `.env`
3. Set the callback URL to `http://localhost:4000/api/fitbit/callback` for local testing
4. Restart `npm run dev`

Once configured, the app can connect to Fitbit, auto-sync when the app opens, and refresh while the app stays open.

## Export, Backup, And Reminders

- `Print or Save PDF` opens a doctor-friendly report with recent blood pressure, food, and medication entries
- `Export BP CSV` and `Export Medication CSV` create Excel-friendly files
- `Export Full Backup` downloads a full JSON snapshot of your settings and data
- `Restore Backup` loads one of those JSON files back into the app
- Fitbit backup exports keep your synced summary but do not include Fitbit access tokens
- Reminder notifications appear while the app is open and browser notifications are allowed

## Cloudflare Workers Setup

1. Run `npm install`
2. Run `npm run cf:build`
3. Sign into Cloudflare with `npx wrangler login`
4. Create the D1 database with `npx wrangler d1 create pressure-and-salt-tracker`
5. Copy the returned database id into `wrangler.jsonc`
6. Apply the schema with `npm run cf:d1:migrate:remote`
7. Deploy with `npm run cf:deploy`

For a local Cloudflare-style preview after setup:

- `npm run cf:dev`

Important:

- `npm run dev` still uses the local Node + Vite setup
- the Cloudflare Worker uses D1 instead of the local JSON file
- for deployed Fitbit support, set `FRONTEND_URL` and Fitbit secrets in Cloudflare before connecting

## Notes

- The barcode lookup uses Open Food Facts when possible and falls back to sample items for testing
- The blood pressure import accepts pasted CSV, tab-separated, pipe-separated, or semicolon-separated rows
- This app is for tracking and organization, not medical advice
