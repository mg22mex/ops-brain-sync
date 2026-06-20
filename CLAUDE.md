# Google Apps Script Sync Pipeline Engine (ops-brain-sync)

## Project Context
Building a serverless Google Apps Script Web App that acts as a central data staging webhook handler and Gmail processing engine for NotebookLM.

## Tech Stack
- Google Apps Script (JavaScript / V8 Engine)
- Clasp CLI (Google Apps Script CLI tool)

## Hard Development Rules
- Keep scripts highly modular.
- Every incoming webhook payload must be stripped of metadata/JSON noise and formatted into clean Markdown headers/bullets before appending to Google Docs.
- Strictly adhere to the 6-minute execution limit; use time-batching logic for heavy Gmail processing loops.
- Implement an automated rollover check: If a target doc exceeds 400,000 words, create a new monthly document file automatically to prevent hitting NotebookLM's 500k ceiling.
- **Never** pack multiple heavy jobs into one trigger handler — each background job gets its own function and schedule (`BackgroundSync.js`).

## Module Map

| File | Role |
|------|------|
| `Code.js` | Web app entry (`doGet`, `doPost`), shared config, rollover helper, Slack mention cleanup |
| `BackgroundSync.js` | Split time-driven jobs + `installBackgroundTriggers()` |
| `WebhookParser.js` | Route and sanitize inbound webhook payloads |
| `MarkdownFormatter.js` | Payload → Markdown |
| `DocAppender.js` | Append to Google Doc with retry backoff |
| `RolloverManager.js` | Word-count guard + monthly doc rollover |
| `FathomFetcher.js` | Fathom recap Gmail → doc (`Processed-Fathom` label) |
| `TripleWhaleFetcher.js` | Triple Whale metrics → doc |
| `SellerboardFetcher.js` | Sellerboard CSV → doc |
| `DriveFileFetcher.js` | Master matrix deep crawl → NotebookLM folder |
| `WeeklyReporter.js` | Monday Slack digest + `installWeeklyReportTrigger()` |

## Background Jobs (split triggers)

Run **`installBackgroundTriggers()`** once from `BackgroundSync.gs` after each deploy. This removes the legacy `runBackgroundSyncs` trigger and registers:

| Handler | Schedule | Work |
|---------|----------|------|
| `runFathomEmailSync` | Every 15 min | `processFathomEmails()` — Gmail primary path |
| `runConfirmationEmailSync` | Every 1 hour | Ops confirmation emails → doc (`Processed-Confirmation` label) |
| `runMetricsSync` | Every 6 hours | Triple Whale + Sellerboard → doc |
| `runDriveMatrixSyncJob` | Daily 2:00 AM ET | `processDriveMatrixSync()` — heavy crawl |

`runBackgroundSyncs()` is **deprecated** (no-op + log warning). Delete any leftover trigger manually if needed.

### Weekly Slack digest

Run **`installWeeklyReportTrigger()`** once from `WeeklyReporter.gs` → Monday **11:00 AM ET** → `postWeeklyReport`.

### Concurrency

- Gmail jobs (`runFathomEmailSync`, `runConfirmationEmailSync`) share one `LockService` script lock (30s wait). Overlapping runs skip with `Lock busy — skipping cycle`.
- Metrics and Drive jobs run independently; doc writes use `appendToDoc` retry backoff on transient Docs errors.
- Manual editor runs and scheduled triggers can overlap — safe; skipped cycles retry on the next interval.

## Build & Deploy Commands
- Initialize Clasp: `clasp login` then `clasp create --type webapp`
- Pull remote code: `clasp pull`
- Push local code: `clasp push`
- Deploy Web App: `clasp deploy`
- After push: run `installBackgroundTriggers()` (and `installWeeklyReportTrigger()` if not already set) in the Apps Script editor

## Key Script Properties

| Property | Purpose |
|----------|---------|
| `TARGET_DOC_ID` | Primary Google Doc for Markdown output |
| `MASTER_SPREADSHEET_ID` | Master Operations & Data Matrix |
| `NOTEBOOK_SOURCE_FOLDER_ID` | NotebookLM source folder |
| `FATHOM_API_KEY` | Optional Fathom API (Gmail is primary) |
| `TRIPLE_WHALE_API_KEY` | Triple Whale metrics |
| `SELLERBOARD_DAILY_LINK` | Sellerboard CSV URL |
| `SLACK_WEBHOOK_URL` | Weekly digest Slack webhook |
| `OPS_CALENDAR_ID` | Calendar for weekly meeting list |
| `OPS_REPORT_TZ` | Report timezone (defaults to `America/New_York`) |
