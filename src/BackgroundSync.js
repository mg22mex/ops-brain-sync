/**
 * BackgroundSync — split time-driven jobs (replaces monolithic runBackgroundSyncs)
 * ================================================================================
 * Each job stays under the 6-minute Apps Script limit. Run installBackgroundTriggers()
 * once after deploy to register schedules and remove the legacy combined trigger.
 *
 * All background jobs now write individual dated Markdown files to per-source
 * Drive folders instead of appending to a single master doc. Retention policies
 * are enforced via cleanupOldFiles() at the end of each cycle.
 *
 * Schedules (America/New_York where applicable):
 *   runFathomEmailSync        — every 15 minutes  → Fathom folder (permanent)
 *   runConfirmationEmailSync  — every 1 hour      → Confirmations folder (3-day retention)
 *   runMetricsSync            — every 6 hours     → Metrics folder (14-day retention)
 *   runDriveMatrixSyncJob     — daily at 2:00 AM
 */

var BACKGROUND_SYNC_HANDLERS_ = [
  'runBackgroundSyncs',
  'runFathomEmailSync',
  'runMetricsSync',
  'runDriveMatrixSyncJob',
  'runConfirmationEmailSync',
  'runSheetCompressionSync'
];

var CONFIRMATION_EMAIL_LABEL_ = 'Processed-Confirmation';

/**
 * Register split background triggers. Run once from the Apps Script editor.
 * Removes legacy runBackgroundSyncs and any prior split triggers first.
 */
function installBackgroundTriggers() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    var handler = existing[i].getHandlerFunction();
    if (BACKGROUND_SYNC_HANDLERS_.indexOf(handler) !== -1) {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  ScriptApp.newTrigger('runFathomEmailSync')
    .timeBased()
    .everyMinutes(15)
    .create();

  ScriptApp.newTrigger('runConfirmationEmailSync')
    .timeBased()
    .everyHours(1)
    .create();

  ScriptApp.newTrigger('runMetricsSync')
    .timeBased()
    .everyHours(6)
    .create();

  ScriptApp.newTrigger('runDriveMatrixSyncJob')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .inTimezone('America/New_York')
    .create();

  ScriptApp.newTrigger('runSheetCompressionSync')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .inTimezone('America/New_York')
    .create();

  console.log('[BackgroundSync] Installed triggers: Fathom email (15m), confirmations (1h), ' +
    'metrics (6h), drive matrix (daily 2 AM ET), sheet compression (daily 3 AM ET). ' +
    'Legacy runBackgroundSyncs removed.');
}

/** @deprecated Use split triggers via installBackgroundTriggers(). */
function runBackgroundSyncs() {
  console.warn('[BackgroundSync] runBackgroundSyncs is deprecated and does nothing. ' +
    'Run installBackgroundTriggers() once to register split jobs.');
}

/** Fathom recap emails → Fathom folder (Gmail primary path; no API poll). */
function runFathomEmailSync() {
  console.log('[BackgroundSync] Fathom email sync starting');
  try {
    processFathomEmails();
  } catch (e) {
    console.error('[BackgroundSync] Fathom email sync failed: %s', e.message);
  }
}

/** Triple Whale + Sellerboard snapshots → Metrics folder (14-day retention). */
function runMetricsSync() {
  console.log('[BackgroundSync] Metrics sync starting');
  var metricsFolderId = PropertiesService.getScriptProperties().getProperty('METRICS_FOLDER_ID')
    || DEFAULT_METRICS_FOLDER_ID;

  var now = new Date();
  var tz = 'America/New_York';
  var dateStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  try {
    var twMarkdown = fetchTripleWhalePerformance();
    if (twMarkdown) {
      createNewDriveFile(metricsFolderId, dateStr + '_TripleWhale_Report.md', twMarkdown);
    }
  } catch (e) {
    console.error('[BackgroundSync] Triple Whale sync failed: %s', e.message);
  }

  try {
    var sbMarkdown = fetchSellerboardDaily();
    if (sbMarkdown) {
      createNewDriveFile(metricsFolderId, dateStr + '_Sellerboard_Report.md', sbMarkdown);
    }
  } catch (e) {
    console.error('[BackgroundSync] Sellerboard sync failed: %s', e.message);
  }

  // Enforce 14-day retention for metrics folder
  cleanupOldFiles(metricsFolderId, 14);
}

/** Master matrix deep crawl → NotebookLM source folder (heavy; runs off-hours). */
function runDriveMatrixSyncJob() {
  console.log('[BackgroundSync] Drive matrix sync starting');
  var spreadsheetId = tryGetValidSpreadsheetId();
  if (!spreadsheetId) {
    return;
  }

  var notebookFolderId = PropertiesService.getScriptProperties().getProperty('NOTEBOOK_SOURCE_FOLDER_ID')
    || DEFAULT_NOTEBOOK_SOURCE_FOLDER_ID;

  try {
    processDriveMatrixSync(notebookFolderId, spreadsheetId);
  } catch (e) {
    console.error('[BackgroundSync] Drive matrix sync failed: %s', e.message);
  }
}

/** Ops confirmation / order reference emails → Confirmations folder (3-day retention). */
function runConfirmationEmailSync() {
  console.log('[BackgroundSync] Confirmation email sync starting');
  try {
    processConfirmationEmails_();
  } catch (e) {
    console.error('[BackgroundSync] Confirmation email sync failed: %s', e.message);
  }
}

/**
 * Compress configured heavy spreadsheets → compact .md snapshots
 * to prevent "file too large" errors in NotebookLM.
 * Configure via SHEET_COMPRESSION_TARGETS Script Property.
 */
function runSheetCompressionSync() {
  console.log('[BackgroundSync] Sheet compression sync starting');
  try {
    processCompressionTargets();
  } catch (e) {
    console.error('[BackgroundSync] Sheet compression sync failed: %s', e.message);
  }
}

/**
 * Gmail monitor for operational confirmations with Processed-Confirmation dedup.
 * Writes each thread as an individual dated file to the Confirmations folder.
 * Retention: 3 days (enforced at the end of each cycle).
 */
function processConfirmationEmails_() {
  var lock = LockService.getScriptLock();
  var lockHeld = false;

  try {
    lock.waitLock(30000);
    lockHeld = true;
  } catch (e) {
    console.warn('[ConfirmationEmails] Lock busy — skipping cycle');
    return;
  }

  try {
    var label = ensureGmailLabel_(CONFIRMATION_EMAIL_LABEL_);
    if (!label) {
      return;
    }

    var startTime = new Date().getTime();
    var TIME_LIMIT_MS = 270000;
    var BATCH_SIZE = 5;
    var searchQuery = 'subject:(confirmation OR order OR reference OR "nrf" OR "color reference") ' +
      '-label:' + CONFIRMATION_EMAIL_LABEL_;
    var threads = GmailApp.search(searchQuery, 0, BATCH_SIZE);
    var confirmationsFolderId = PropertiesService.getScriptProperties().getProperty('CONFIRMATIONS_FOLDER_ID')
      || DEFAULT_CONFIRMATIONS_FOLDER_ID;

    var elapsedSearch = new Date().getTime() - startTime;
    console.log('[ConfirmationEmails] GmailApp.search returned in %dms, found %d thread(s)',
      elapsedSearch, threads.length);
    if (elapsedSearch > TIME_LIMIT_MS) {
      console.warn('[ConfirmationEmails] TIME LIMIT EXCEEDED after GmailApp.search (%dms)', elapsedSearch);
      return;
    }

    if (threads.length === 0) {
      console.log('[ConfirmationEmails] No unprocessed confirmation threads.');
      return;
    }

    console.log('[ConfirmationEmails] Processing %d thread(s) (batch cap: %d)',
      threads.length, BATCH_SIZE);

    var processedCount = 0;
    var now = new Date();
    var tz = 'America/New_York';
    var dateStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

    for (var i = 0; i < threads.length; i++) {
      var elapsedTop = new Date().getTime() - startTime;
      if (elapsedTop > TIME_LIMIT_MS) {
        console.warn('[ConfirmationEmails] TIME LIMIT EXCEEDED at loop top (%dms / %dms cap) — ' +
          'stopping after %d thread(s)',
          elapsedTop, TIME_LIMIT_MS, i);
        break;
      }

      var thread = threads[i];
      var written = false;

      try {
        var messages = thread.getMessages();
        var elapsedMsgs = new Date().getTime() - startTime;

        if (elapsedMsgs > TIME_LIMIT_MS) {
          console.warn('[ConfirmationEmails] TIME LIMIT EXCEEDED after getMessages() (%dms, thread %d/%d)',
            elapsedMsgs, i + 1, threads.length);
          break;
        }

        var msg = messages[messages.length - 1];

        // Atomic dedup: skip if this message ID is already in the registry
        var msgId = msg.getId();
        if (isMessageProcessed_(msgId)) {
          console.log('[ConfirmationEmails] Skipping already-processed message %s: %s', msgId, msg.getSubject());
          continue;
        }

        var body = msg.getPlainBody();
        var elapsedBody = new Date().getTime() - startTime;
        if (elapsedBody > TIME_LIMIT_MS) {
          console.warn('[ConfirmationEmails] TIME LIMIT EXCEEDED after getPlainBody() (%dms, thread %d/%d)',
            elapsedBody, i + 1, threads.length);
          break;
        }
        if (!body) {
          continue;
        }

        var payload = {
          source: 'gmail_confirmation',
          content: body,
          metadata: { title: msg.getSubject() }
        };
        var markdown = formatAsMarkdown(payload);

        // Build a unique filename from date + sanitized subject
        var subject = msg.getSubject() || 'confirmation';
        var safeSubject = subject.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 60);
        var fileName = dateStr + '_Confirmation_' + safeSubject + '.md';

        try {
          createNewDriveFile(confirmationsFolderId, fileName, markdown);
          markMessageProcessed_(msgId);
          written = true;
        } catch (writeErr) {
          console.error('[ConfirmationEmails] Write failed for "%s": %s',
            msg.getSubject(), writeErr.message);
        }
      } catch (msgErr) {
        console.error('[ConfirmationEmails] Failed to process thread "%s": %s',
          thread.getFirstMessageSubject(), msgErr.message);
      }

      if (written) {
        try {
          thread.addLabel(label);
          processedCount++;
        } catch (labelErr) {
          console.warn('[ConfirmationEmails] Could not label thread: %s', labelErr.message);
        }
      }
    }

    console.log('[ConfirmationEmails] Cycle complete. Processed %d thread(s) (batch cap: %d).',
      processedCount, BATCH_SIZE);

  } catch (err) {
    console.error('[ConfirmationEmails] Processing error: %s', err.message);
  } finally {
    if (lockHeld) {
      lock.releaseLock();
      console.log('[ConfirmationEmails] Lock released');
    }
  }

  // Enforce 3-day retention (runs outside the lock to avoid holding it during Drive calls)
  var confirmationsFolderId = PropertiesService.getScriptProperties().getProperty('CONFIRMATIONS_FOLDER_ID')
    || DEFAULT_CONFIRMATIONS_FOLDER_ID;
  cleanupOldFiles(confirmationsFolderId, 3);
}

/**
 * @param {string} name
 * @returns {GoogleAppsScript.Gmail.GmailLabel|null}
 */
function ensureGmailLabel_(name) {
  try {
    var label = GmailApp.getUserLabelByName(name);
    if (!label) {
      label = GmailApp.createLabel(name);
    }
    return label;
  } catch (e) {
    console.error('[BackgroundSync] Could not get/create label "%s": %s', name, e.message);
    return null;
  }
}

function triggerPermissionCheck() { DriveApp.getRootFolder(); }
