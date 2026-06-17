# Architecture Document — ops-brain-sync

> **Version:** 1.2.0  
> **Runtime:** Google Apps Script (V8 / ES5+)  
> **Deployment Platform:** Clasp CLI → Google Workspace  
> **Canonical Timezone:** America/New_York

---

## Table of Contents

1. [Architecture Philosophy](#1-architecture-philosophy)
2. [Component Architecture](#2-component-architecture)
3. [Data Flow Deep Dive](#3-data-flow-deep-dive)
4. [Module Contracts & Interfaces](#4-module-contracts--interfaces)
5. [State Management & Persistence](#5-state-management--persistence)
6. [Error Handling Strategy](#6-error-handling-strategy)
7. [Execution Boundaries & Throttling](#7-execution-boundaries--throttling)
8. [Security Model](#8-security-model)
9. [Testing & Verification](#9-testing--verification)
10. [Deployment Topology](#10-deployment-topology)

---

## 1. Architecture Philosophy

The system is architected around three governing principles:

### 1.1 Modular Monolith on a Global Namespace

Google Apps Script imposes a **global namespace** across all `.js` / `.gs` files in a project. There is no module system (`import`/`require`), no bundler, and no tree-shaking. Every function defined at file scope is visible to every other file.

We embrace this constraint with a **filesystem-as-module-boundary** convention: each conceptual module lives in its own file under `src/`, prefixed with a JSDoc block declaring its public API. No module calls into the internals of another; all cross-module communication happens through the explicit function signatures declared in `Code.js`.

### 1.2 Fail-Stop for Webhooks, Fail-Soft for Polling

- **Webhook path (`doPost`):** Fail-stop. If any step throws (parse error, doc unavailable, rollover crash), the entire request returns a `500` with the error message. Slack or the upstream sender will retry.
- **Polling path (`runBackgroundSyncs`):** Fail-soft. Each fetcher runs in its own `try/catch` block. A Fathom API outage does not block Triple Whale or Sellerboard data. The orchestrator logs each source's outcome and returns a consolidated summary.

### 1.3 Self-Healing Capacity Boundaries

The system actively prevents itself from exceeding three hard limits:
- **Document word count** (~380K → rollover at 500K ceiling)
- **Execution duration** (6-minute Apps Script hard cap → 4-minute global master clock with inter-fetcher barriers)
- **Payload size** (~15K char truncation + whitespace compression)

---

## 2. Component Architecture

### 2.1 Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      EXECUTION BOUNDARY                              │
│  Apps Script Runtime (V8) — max 6 min, enforced at 4 min globally   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    ENTRY POINTS (Code.js)                     │   │
│  │                                                              │   │
│  │  doGet(e)        doPost(e)         runBackgroundSyncs()      │   │
│  │  ─────────       ─────────         ────────────────────      │   │
│  │  Health-check    Webhook ingress   Scheduled orchestrator     │   │
│  │  JSON response   JSON response     4-min global master clock  │   │
│  │                                   Break-based early exits     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                        │            │          │                     │
│          ┌─────────────┘            │          └──────────────┐     │
│          ▼                         ▼                        ▼      │
│  ┌───────────────┐    ┌───────────────────┐    ┌─────────────────┐ │
│  │ WebhookParser │    │ MarkdownFormatter │    │ FathomFetcher   │ │
│  │ (router)      │───▶│ (transformer)     │    │  ├─process-     │ │
│  │               │    │                   │    │  │ FathomEmails │ │
│  └───────────────┘    └───────────────────┘    │  └─fetchRecent- │ │
│                              │                 │    Meetings     │ │
│                              ▼                 │ TripleWhaleFetch│ │
│  ┌──────────────────────────────────────────┐  │ SellerboardFetch│ │
│  │             DocAppender                   │  │ DriveFileFetch │ │
│  │  appendToDoc(docId, markdown)           │  │ Confirmation-   │ │
│  │  appendSlackToDailyFile(folderId, md)   │  │ Emails (Code.js)│ │
│  └──────────────────────────────────────────┘  └─────────────────┘ │
│                              │                        │             │
│                              ▼                        ▼             │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                  RolloverManager                              │   │
│  │  checkAndRolloverIfNeeded_(docId) → (same | new docId)       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                   PERSISTENCE LAYER                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ Google Doc  │  │ ScriptProps  │  │ Google Drive (rollover)   │  │
│  │ (DocumentApp)│  │ (Properties) │  │ (DocumentApp.create)      │  │
│  └─────────────┘  └──────────────┘  └───────────────────────────┘  │
│  ┌─────────────┐  ┌──────────────┐                                  │
│  │ GmailApp    │  │ LockService  │                                  │
│  │ (label mgmt)│  │ (concurrency)│                                  │
│  └─────────────┘  └──────────────┘                                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Module Dependency Graph

```
Code.js
  ├── src/WebhookParser.js      (called by doPost)
  ├── src/MarkdownFormatter.js   (called by doPost)
  ├── src/DocAppender.js         (called by doPost + runBackgroundSyncs)
  ├── src/RolloverManager.js     (called by doPost + runBackgroundSyncs)
  ├── src/FathomFetcher.js       (called by runBackgroundSyncs)
  ├── src/TripleWhaleFetcher.js  (called by runBackgroundSyncs)
  ├── src/SellerboardFetcher.js  (called by runBackgroundSyncs)
  └── src/DriveFileFetcher.js    (called by runBackgroundSyncs)
```

There are **no circular dependencies**. RolloverManager and DocAppender are leaf modules with zero internal dependencies. All six `src/` modules are pure utility libraries — they export functions consumed by `Code.js`'s three entry points.

---

## 3. Data Flow Deep Dive

### 3.1 Webhook Path (doPost)

```
Incoming HTTP POST
        │
        ▼
  [1] e.postData.contents (raw JSON string)
        │
        ▼
  [2] JSON.parse()
        │
        ├── data.type === "url_verification"
        │      └── return ContentService.createTextOutput(data.challenge)
        │
        └── Normal payload
               │
               ▼
  [3] parsePayload(data)
        │
        ├── data.event && data.team_id        → parseSlackPayload()
        ├── data.event && data.recording      → parseFathomPayload()
        ├── data.event_type && data.data      → parseTripleWhalePayload()
        ├── data.source === "sellerboard"     → parseSellerboardPayload()
        └── otherwise                         → parseGenericPayload()
               │
               ▼
  [4] formatAsMarkdown(parsed)
        │
        ├── Append ### header with ET timestamp
        ├── Append source badge + metadata
        └── Append sanitized content body
               │
               ▼
  [5] checkAndRolloverIfNeeded_(TARGET_DOC_ID)
        │
        ├── DocumentApp.openById(currentDocId)
        ├── estimateWordCount_(body.getText())
        ├── wordCount >= 380000
        │      └── createMonthlyContinuationDoc_()
        └── Return activeDocId
               │
               ▼
  [6] appendToDoc(activeDocId, markdown)
        │
        ├── DocumentApp.openById(docId)
        ├── body.appendParagraph() per line
        ├── Heading styling (HEADING3 / SUBTITLE / NORMAL)
        └── doc.saveAndClose()
               │
               ▼
  [7] 200 { status:"ok", source, docId, elapsed }
```

### 3.2 Data Shape: Through Each Transformation

**Raw Slack payload (excerpt):**
```json
{
  "token": "abc123",
  "team_id": "T05ABC",
  "event": {
    "type": "message",
    "user": "U066ARLFH4K",
    "text": "Hey team — <@U5206HQ00> can you review the NRF numbers?",
    "channel": "C05XYZ",
    "channel_type": "group"
  }
}
```

**After parsePayload → parsed object:**
```json
{
  "source": "slack",
  "content": "Hey team — @Diego Marquez can you review the NRF numbers?",
  "metadata": {
    "user": "Sunny (Sajjad)",
    "channel": "C05XYZ",
    "channelType": "group",
    "threadTimestamp": "1718300000.000100",
    "teamId": "T05ABC",
    "eventType": "message"
  }
}
```

**After formatAsMarkdown:**
```markdown
### ✅ Inbound Webhook  — 2026-06-14 09:15:00 ET

- **Source:** Slack
- **User:** `Sunny (Sajjad)`
- **Channel:** `C05XYZ`
- **Channel Type:** group
- **Event:** message

---
Hey team — @Diego Marquez can you review the NRF numbers?
---
```

**After appendToDoc:** The doc now has three new paragraphs — a `HEADING3` header line, several `NORMAL` metadata lines, a `SUBTITLE` divider, the content, and a closing divider.

### 3.3 Polling Path (runBackgroundSyncs)

The orchestrator runs sequentially, with **inter-fetcher deadline checks** between each module:

```
runBackgroundSyncs()
│
├── LockService.getScriptLock().waitLock(15000) — prevents concurrent runs
│
├── SCRIPT_START_TIME = now()  ← global master clock (GLOBAL_MAX_EXECUTION_MS = 240000)
│
├── [1] DriveFileFetcher.processDriveMatrixSync(folderId, spreadsheetId)
│     ├── callWithRetry_(openById) × N  (exponential backoff, 3 attempts)
│     ├── Parse master spreadsheet → save snapshot to Drive
│     ├── Discover linked files → crawl each (with per-link time guard)
│     └── │
│         ▼ deadline check → skip remaining fetchers if past 4 min
│
├── [2] FathomFetcher.fetchRecentMeetings() — API poll fallback
│     └── │
│         ▼ deadline check
│
├── [3] FathomFetcher.processFathomEmails() — Gmail primary path
│     ├── Search Gmail: subject:"Recap for" -label:Processed-Fathom
│     ├── Per-thread: messages → format → appendToDoc()
│     ├── Mid-message deadline guard (innerLoopAborted flag)
│     ├── Thread label only applied if inner loop completed cleanly
│     └── │
│         ▼ deadline check
│
├── [4] TripleWhaleFetcher.fetchTripleWhalePerformance()
│     └── │
│         ▼ deadline check
│
├── [5] SellerboardFetcher.fetchSellerboardDaily()
│     └── │
│         ▼ deadline check
│
├── [6] Code.js.processConfirmationEmails()
│     └── Gmail search: confirmation/order/reference emails
│         (time-guarded per thread, references global clock)
│
└── LockService.releaseLock()
```

**Deadline behavior:** When `new Date().getTime() - SCRIPT_START_TIME > GLOBAL_MAX_EXECUTION_MS`, the orchestrator logs a message and skips all remaining modules. Within loops, `break` is used instead of `return` so that LockService finally blocks and Gmail label operations execute normally — preserving consistent state.

Each module independently calls `checkAndRolloverIfNeeded_()` before appending, because the document state may change between iterations (e.g., Fathom pushes past the rollover threshold, then Triple Whale would need the new doc).

---

## 4. Module Contracts & Interfaces

### 4.1 WebhookParser

```
parsePayload(data: Object) → { source: String, content: String, metadata: Object }

Source detection order:
  1. data.event && data.team_id         → "slack"
  2. data.event && data.recording       → "fathom"
  3. data.event_type && data.data       → "triplewhale"
  4. data.source === "sellerboard"       → "sellerboard"
  5. otherwise                           → "unknown"
```

**Content sanitization pipeline (`cleanText`):**
1. Remove null bytes (`\0`)
2. Strip non-printing control characters (`\x00-\x08`, `\x0B`, `\x0C`, `\x0E-\x1F`)
3. Normalize line endings (`\r\n` → `\n`, `\r` → `\n`)
4. Trim trailing whitespace per line
5. Collapse 3+ consecutive newlines to exactly 2
6. Trim leading/trailing whitespace

### 4.2 MarkdownFormatter

```
formatAsMarkdown(parsed: Object) → String
  - Timestamp: Utilities.formatDate(new Date(), "America/New_York", "yyyy-MM-dd HH:mm:ss") + " ET"
  - Header: "### ✅ Inbound Webhook — {timestamp}"
  - Metadata: source-specific key/value bullets
  - Divider: "---"
  - Body: multi-line preserved, single-line word-wrapped at 100 chars
  - Closing divider: "---"

Source-specific metadata:
  slack:       User, Channel, Channel Type, Event
  fathom:      Recording, URL, Duration, Recorded
  triplewhale: Event, Shop, Received
  sellerboard: Period, Received
```

### 4.3 DocAppender

```
appendToDoc(docId: String, markdown: String) → void
  - Empty docId → throw
  - Empty markdown → warn and return
  - Open doc → append 2 blank separators → split markdown by \n
  - Per line:
      /^### /      → HEADING3 + BOLD
      /^---$/      → SUBTITLE
      otherwise    → NORMAL
  - saveAndClose()
```

### 4.4 RolloverManager

```
checkAndRolloverIfNeeded_(currentDocId: String) → String
  - Opens doc, reads text, estimates word count
  - < 380K words → return currentDocId
  - >= 380K words → createMonthlyContinuationDoc_() → return newDocId

createMonthlyContinuationDoc_() → String
  - Title: "ops-brain-sync YYYY-MM"
  - Content: "# ops-brain-sync — Monthly Log" + ISO timestamp
  - Persist new ID to ScriptProperties: TARGET_DOC_ID = newId
  - Return new doc ID

estimateWordCount_(text: String) → Number
  - text.trim().split(/\s+/).length
```

### 4.5 FathomFetcher

The FathomFetcher has two distinct paths:

#### Primary Path: Gmail-Based (processFathomEmails)

```
processFathomEmails() → void
  - LockService.getScriptLock().waitLock(30000) — concurrency guard
  - Get or create Gmail label 'Processed-Fathom' (idempotent)
  - Search: subject:"Recap for" -label:Processed-Fathom (max 5 threads)
  - Per thread:
      [Outer guard] Check global clock → break if expired
      Get messages → filter by sender (fathom.video)
      Extract plain body → truncate at 15K chars
      Format as Markdown
      [Inner guard] Check global clock BEFORE appendToDoc()
        → If expired: set innerLoopAborted=true, break
      safeCheckAndRollover_(docId) → appendToDoc()
  - Per thread label:
      innerLoopAborted? → skip (preserve unprocessed messages for next cycle)
      completed?         → thread.addLabel('Processed-Fathom')
  - finally → lock.releaseLock()
```

Key design decisions:
- **Mid-message deadline guard** prevents the `appendToDoc()` call from hanging for minutes when the 4-minute ceiling has already passed
- **`innerLoopAborted` flag** ensures a thread is NOT marked as processed when we broke mid-flight — remaining messages are re-picked on the next cycle
- **Batch size 5** + `-label:Processed-Fathom` exclusion in the Gmail query provides idempotent resume: partially-processed batches are automatically re-processed on the next run

#### Secondary Path: API Polling (fetchRecentMeetings)

```
fetchRecentMeetings() → String | null
  - Read FATHOM_API_KEY from ScriptProperties
  - Read FATHOM_PROCESSED_IDS from ScriptProperties (JSON dict)
  - GET https://api.fathom.video/v1/meetings (Authorization: Bearer {key})
  - Filter meetings: id not in processedIds
  - If none new → return null
  - Persist updated processedIds
  - Build Markdown:
      ### 🎥 Fathom Sync — {timestamp}
      - Source: Fathom (polled)
      - New meetings: N
      ---
      ##### N. {title}
      - URL: {url}
      - Duration: {mins} min
      {summary}
      ---
  - Return Markdown string
```

The API path is a fallback for comprehensive coverage — it catches meetings whose notification email was missed or already deleted.

### 4.6 TripleWhaleFetcher

```
fetchTripleWhalePerformance() → String | null
  - Read TRIPLE_WHALE_API_KEY from ScriptProperties
  - Build 7-day lookback window (startDate = endDate - 7)
  - POST to Triple Whale API with x-api-key header
  - Parse metrics from response
  - If empty metrics → return null
  - Build Markdown:
      ### 📊 Triple Whale Sync — {timestamp}
      - Source: Triple Whale (polled)
      - Period: {start} — {end}
      | Metric | Value |
      |--------|-------|
      | {key} | {value} |
  - Return Markdown string
```

### 4.7 SellerboardFetcher

```
fetchSellerboardDaily() → String | null
  - Read SELLERBOARD_DAILY_LINK from ScriptProperties
  - GET CSV URL (muteHttpExceptions: true)
  - Split CSV by newlines
  - Parse header row via parseCSVLine_()
  - Iterate rows bottom-up; find last non-empty row
  - If no data row → return null
  - Build Markdown:
      ### 📈 Sellerboard Sync — {timestamp}
      - Source: Sellerboard (polled CSV)
      - Columns: N
      | Metric | Value |
      |--------|-------|
      | {header} | {value} |
  - Return Markdown string

parseCSVLine_(line: String) → String[]
  - Simple state-machine: tracks inQuotes boolean
  - Splits on commas outside quotes
  - Returns array of field strings
```

### 4.8 DriveFileFetcher

```
processDriveMatrixSync(folderId: String, spreadsheetId: String) → void
  - callWithRetry_(DriveApp.getFolderById(folderId))   — 3-attempt backoff
  - callWithRetry_(SpreadsheetApp.openById(spreadsheetId)) — 3-attempt backoff
  - parseSpreadsheetLayers_(masterSheet) → Markdown snapshot
  - saveMarkdownSnapshot_(folder, "Drive-Snapshot-*.md", markdown) — retried
  - extractDriveLinksFromSheet_(sheet) → [{id, type}]  (Google Doc / Sheet links)
  - Per discovered link:
      [Time guard] Check global clock → break if expired
      Skip if already processed (processedFileIds dict)
      If spreadsheet → openById (retried) → parse → save snapshot
      If document   → openById (retried) → parse → save snapshot
  - Errors per link: logged, loop continues (fail-soft)

callWithRetry_(fn, label) → *
  - 3 attempts
  - Backoff: 2000ms × attempt (2s, 4s, 6s)
  - Final attempt throws on failure

Exponential backoff is applied to all SpreadsheetApp, DocumentApp, and DriveApp
calls to prevent transient "Service failed" errors from halting the deep crawl.
```

---

## 5. State Management & Persistence

The pipeline uses three persistence mechanisms, each with distinct scope and lifetime characteristics:

### 5.1 Google Docs (DocumentApp)

| Attribute | Value |
|-----------|-------|
| **Purpose** | Final formatted Markdown output consumed by NotebookLM |
| **Access Pattern** | `openById()`, `getBody()`, `appendParagraph()`, `saveAndClose()` |
| **Lifetime** | Persistent — manual deletion required |
| **Rollover** | Automatic at ~380K words via `createMonthlyContinuationDoc_()` |
| **Naming** | `ops-brain-sync YYYY-MM` |

### 5.2 Script Properties (PropertiesService)

| Attribute | Value |
|-----------|-------|
| **Purpose** | Environment config (API keys, doc IDs) + dedup tracking |
| **Key-Value Store** | String → String, scoped to the script |
| **Size Limit** | 500 KB total across all properties |
| **Read Pattern** | `getProperty(key)` at invocation start |
| **Write Pattern** | `setProperty(key, value)` — used for rollover and dedup updates |

**Managed keys:**

| Key | Type | Written By | Read By |
|-----|------|-----------|---------|
| `TARGET_DOC_ID` | Config | RolloverManager (`createMonthlyContinuationDoc_`) | Code.js, RolloverManager |
| `FATHOM_API_KEY` | Secret | Manual setup | FathomFetcher |
| `TRIPLE_WHALE_API_KEY` | Secret | Manual setup | TripleWhaleFetcher |
| `SELLERBOARD_DAILY_LINK` | Secret | Manual setup | SellerboardFetcher |
| `MASTER_SPREADSHEET_ID` | Config | Manual setup | (future) |
| `NOTEBOOK_SOURCE_FOLDER_ID` | Config | Manual setup | (future) |
| `FATHOM_PROCESSED_IDS` | Runtime | FathomFetcher | FathomFetcher |

### 5.3 LockService (Script Lock)

| Attribute | Value |
|-----------|-------|
| **Scope** | Script-wide (prevents concurrent invocations from conflicting) |
| **Timeout** | 30,000 ms |
| **Granularity** | Coarse — one lock for the entire write pipeline |

---

## 6. Error Handling Strategy

### 6.1 Webhook Path (doPost)

```
doPost entry
  → Missing postData.contents         → 400 { error: "Missing postData.contents" }
  → JSON parse failure                → thrown to catch → 500 { error: message }
  → url_verification handshake        → 200 TEXT (not JSON)
  → parsePayload() throws             → thrown to catch → 500 { error: message }
  → formatAsMarkdown() throws         → thrown to catch → 500 { error: message }
  → checkAndRolloverIfNeeded_() fails → logged; returns current docId (graceful)
  → appendToDoc() throws              → thrown to catch → 500 { error: message }
```

The chain is linear and synchronous. Any uncaught exception propagates to the outer `try/catch` which logs the error message and returns `500` with the error in the body. Slack will retry failed deliveries up to 3 times with exponential backoff.

### 6.2 Polling Path (runBackgroundSyncs)

Each fetcher is isolated:
```
TRY   → fetcher function
         ├── API key missing   → warn, return null
         ├── HTTP error        → log status + body, return null
         ├── Parse failure     → throws to catch
         └── Success           → return Markdown

CATCH → log error message, push '{source}:error' to results
```

A single fetcher failure never halts the orchestrator. The `results` array provides a post-run audit trail:
- `fathom:ok` / `fathom:no-new-data` / `fathom:error`
- `triplewhale:ok` / `triplewhale:no-data` / `triplewhale:error`
- `sellerboard:ok` / `sellerboard:no-data` / `sellerboard:error`

### 6.3 Document-Level Errors

| Error | Handler | Behavior |
|-------|---------|----------|
| Doc not found (`openById`) | Throws | Propagates up; caller returns 500 or logs error |
| Lock timeout (30s) | Catch | Logs warning; operation skipped silently |
| Rollover word-count failure | Catch | Logs error; returns original docId (graceful degradation) |
| Empty markdown body | `if (!markdown) return` in `appendToDoc` | Warns and returns without writing |
| Empty doc ID | `if (!docId) throw` in `appendToDoc` | Throws with clear message |

---

## 7. Execution Boundaries & Throttling

### 7.1 Apps Script Quotas

| Resource | Free Tier Limit | ops-brain-sync Impact |
|----------|-----------------|----------------------|
| Triggers total | 20 | 1 (runBackgroundSyncs) |
| Trigger duration | 6 min / execution | ~60–180s typical; 4-min global master clock enforces hard break |
| UrlFetch calls / day | 20,000 | 3–5 per sync run (Fathom API + TW + SB + Gmail searches) |
| UrlFetch timeout | 60s | Default (each fetcher call is < 10s) |
| Document size | 50 MB | ~380K words ≈ ~2.5 MB; rollover preempts cap |
| Gmail search/read | 20,000 quota | ~5–10 per run (Fathom emails + confirmation emails) |
| Script Properties | 500 KB total | ~1 KB used (7 keys) |

### 7.2 Time Budget Allocation

Based on observed execution profiles with the 4-minute global ceiling:

| Operation | Time | Notes |
|-----------|------|-------|
| DriveFileFetcher deep crawl | ~15–60s | Depends on linked file count and size |
| Fathom API poll | ~5–15s | Depends on meeting count and transcript size |
| Fathom Gmail processing | ~10–120s | Per-thread append; worst-case single message can approach the global ceiling |
| Triple Whale API call | ~3–8s | Small JSON payload |
| Sellerboard CSV fetch + parse | ~2–5s | Depends on CSV row count |
| Confirmation email processing | ~5–30s | Per-email append |
| Rollover check | ~1–3s | Opens doc, reads body text |

**Typical total:** 60–240s. The 4-min global ceiling (240,000 ms) provides a 2-minute safety buffer under the 6-min Apps Script hard limit to account for cumulative overhead, retry backoff, and unusually large Fathom transcripts.

### 7.3 Global Master Clock Strategy

The 4-minute ceiling is enforced at three levels:

1. **Inter-fetcher barriers** in `runBackgroundSyncs()` — after each module completes, the orchestrator checks the global clock and skips all remaining modules if exceeded
2. **Outer loop guard** at the top of each thread/iteration in FathomFetcher, DriveFileFetcher, and confirmation email processing
3. **Mid-message guard** inside the Fathom email messages loop — immediately before the `appendToDoc()` call, preventing a single slow write from blocking execution indefinitely

All exits use `break` (not `return`), ensuring LockService finally blocks always release the mutex and Gmail label operations execute before the execution ends.

---

## 8. Security Model

### 8.1 Web App Access

Configured in `appsscript.json`:

```json
{
  "webapp": {
    "access": "ANYONE",
    "executeAs": "USER_DEPLOYING"
  }
}
```

- **`access: ANYONE`** — Any authenticated Google user (or unauthenticated, depending on sharing settings) can POST to the endpoint. In practice, the endpoint URL is unguessable (60+ chars of entropy in the deployment ID).
- **`executeAs: USER_DEPLOYING`** — All API calls (DocumentApp, UrlFetchApp, PropertiesService) execute under the deployer's authority. This means the deployer must have edit access to the target Google Doc and all API keys in Script Properties.

### 8.2 API Key Management

All secrets are stored in **Script Properties**, not in code:
- `FATHOM_API_KEY` — Bearer token for Fathom REST API
- `TRIPLE_WHALE_API_KEY` — API key for Triple Whale
- `SELLERBOARD_DAILY_LINK` — Pre-signed URL (contains an expiring token)

**Never commit secrets to the repository.** The `.clasp.json` and `appsscript.json` files contain no secrets. API keys are set via the Apps Script UI (Project Settings > Script Properties) or programmatically through an authorized clasp session.

### 8.3 Input Sanitization

Every payload entering `doPost` passes through:
1. **JSON.parse** — Rejects malformed payloads with a 400 response
2. **Source routing** — Unrecognized payload shapes go to `parseGenericPayload` rather than crashing
3. **cleanText** — Strips null bytes, control characters, and excessive whitespace
4. **escapeMd** — Escapes Markdown special characters (`*`, `_`, `` ` ``, `~`, `[`, `]`, `(`, `)`, `#`, `!`) in metadata values

---

## 9. Testing & Verification

### 9.1 Manual Verification Commands

```bash
# Health check
curl -s https://script.google.com/macros/s/{DEPLOY_ID}/exec

# Slack url_verification test
curl -s -X POST https://script.google.com/macros/s/{DEPLOY_ID}/exec \
  -H "Content-Type: application/json" \
  -d '{"type": "url_verification", "challenge": "test123"}'

# Fathom webhook simulation
curl -s -X POST https://script.google.com/macros/s/{DEPLOY_ID}/exec \
  -H "Content-Type: application/json" \
  -d '{"event":"recording.completed","recording":{"id":"m123","title":"Test","summary":"Test summary"}}'

# Slack message simulation
curl -s -X POST https://script.google.com/macros/s/{DEPLOY_ID}/exec \
  -H "Content-Type: application/json" \
  -d '{"event":{"type":"message","user":"U066ARLFH4K","text":"Hello from test","channel":"C05XYZ","channel_type":"channel"},"team_id":"T05ABC"}'
```

### 9.2 Trigger Verification

After installing `installBackgroundTrigger()`, verify via:
1. Open the script in the Apps Script editor (`clasp open`)
2. Click the clock icon (Triggers) in the sidebar
3. Confirm `runBackgroundSyncs` appears with schedule: **Every day (9:15–10:15 AM)**

---

## 10. Deployment Topology

### 10.1 Local Workspace

```
ops-brain-sync/
├── .clasp.json              # Clasp project config (scriptId, rootDir)
├── .gitignore               # Ignore node_modules, .clasp.json (if scriptId is sensitive)
├── appsscript.json          # GAS manifest (timezone, runtime, webapp config)
├── package.json             # Node dependencies (clasp)
├── CLAUDE.md                # Project instructions for AI coding assistant
├── README.md                # This file
├── ARCHITECTURE.md          # This document
├── Code.js                  # Entry points: doGet, doPost, runBackgroundSyncs, installBackgroundTrigger, processConfirmationEmails
└── src/
    ├── WebhookParser.js     # Payload router + content extractor
    ├── MarkdownFormatter.js # Markdown transformer with ET timestamps
    ├── DocAppender.js       # Google Doc write operations (with exponential backoff retry)
    ├── RolloverManager.js   # Word-count guard + monthly rollover
    ├── FathomFetcher.js     # Gmail-based Fathom processing + API polling fallback (with global clock guards)
    ├── TripleWhaleFetcher.js# Triple Whale analytics polling
    ├── SellerboardFetcher.js# Sellerboard CSV fetch + parse
    └── DriveFileFetcher.js  # Master Matrix deep crawl + linked file extraction (with retry + time guard)
```

### 10.2 Push/Pull Workflow

```
Local edits → clasp push → Apps Script (remote) → clasp deploy → Web App (live)

                   clasp pull ← Apps Script (remote)
```

- `clasp push --force` uploads all local files, overwriting remote state
- `clasp pull` downloads remote state to local (useful for round-trip verification)
- `clasp deploy` creates a new immutable deployment version with a unique URL
- Each deployment is versioned (`@1`, `@2`, `@3`...) — previous versions continue running until explicitly undeployed

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **SSOT** | Single Source of Truth — the Master Operations & Data Matrix spreadsheet |
| **RAG** | Retrieval-Augmented Generation — NotebookLM's mechanism for grounding LLM responses in user-provided source documents |
| **GAS** | Google Apps Script — the runtime environment |
| **Rollover** | Automatic creation of a new monthly document when word count approaches the 500K ceiling |
| **Dedup** | Deduplication — tracking processed Fathom meeting IDs to avoid re-appending |
| **LockService** | Apps Script mutex for preventing concurrent write conflicts |
| **01010101** | Slack internal base-10 to base-34 encoding used in user/team IDs |

---

## Appendix B: Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-06-14 | Initial release — Slack + Fathom webhooks, Triple Whale + Sellerboard polling, rollover management |
| 1.1.0 | 2026-06-17 | **Global master clock refactor** — Replaced per-module local timers (5 min each) with single `SCRIPT_START_TIME` + `GLOBAL_MAX_EXECUTION_MS = 240000` at `runBackgroundSyncs()` entry; inter-fetcher deadline barriers between each module; all loop guards reference global clock via `break`-based early exits |
| 1.2.0 | 2026-06-17 | **Mid-message deadline guard** — Added `innerLoopAborted` flag and pre-`appendToDoc()` deadline check inside Fathom messages loop; label application skipped on abort to preserve unprocessed messages for next cycle. **DriveFileFetcher** — Added `processDriveMatrixSync()` with `callWithRetry_()` exponential backoff, drive link discovery, and global clock guards. **Fathom email path** — Primary Gmail-based Fathom processing via `processFathomEmails()` with label-based dedup, plus secondary API poll fallback |
