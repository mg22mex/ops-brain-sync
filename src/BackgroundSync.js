/**
 * BackgroundSync — split time-driven jobs (replaces monolithic runBackgroundSyncs)
 * ================================================================================
 * Each job stays under the 6-minute Apps Script limit. Run installBackgroundTriggers()
 * once after deploy to register schedules and remove the legacy combined trigger.
 *
 * Schedules (America/New_York where applicable):
 *   runFathomEmailSync        — every 15 minutes
 *   runConfirmationEmailSync  — every 1 hour
 *   runMetricsSync            — every 6 hours (Triple Whale + Sellerboard)
 *   runDriveMatrixSyncJob     — daily at 2:00 AM
 */

var BACKGROUND_SYNC_HANDLERS_ = [
  'runBackgroundSyncs',
  'runFathomEmailSync',
  'runMetricsSync',
  'runDriveMatrixSyncJob',
  'runConfirmationEmailSync'
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

  console.log('[BackgroundSync] Installed triggers: Fathom email (15m), confirmations (1h), ' +
    'metrics (6h), drive matrix (daily 2 AM ET). Legacy runBackgroundSyncs removed.');
}

/** @deprecated Use split triggers via installBackgroundTriggers(). */
function runBackgroundSyncs() {
  console.warn('[BackgroundSync] runBackgroundSyncs is deprecated and does nothing. ' +
    'Run installBackgroundTriggers() once to register split jobs.');
}

/** Fathom recap emails → target doc (Gmail primary path; no API poll). */
function runFathomEmailSync() {
  console.log('[BackgroundSync] Fathom email sync starting');
  try {
    processFathomEmails();
  } catch (e) {
    console.error('[BackgroundSync] Fathom email sync failed: %s', e.message);
  }
}

/** Triple Whale + Sellerboard snapshots → target doc. */
function runMetricsSync() {
  console.log('[BackgroundSync] Metrics sync starting');
  var targetDocId = PropertiesService.getScriptProperties().getProperty('TARGET_DOC_ID')
    || DEFAULT_TARGET_DOC_ID;

  try {
    var twMarkdown = fetchTripleWhalePerformance();
    if (twMarkdown) {
      appendToDoc(safeCheckAndRollover_(targetDocId), twMarkdown);
    }
  } catch (e) {
    console.error('[BackgroundSync] Triple Whale sync failed: %s', e.message);
  }

  try {
    var sbMarkdown = fetchSellerboardDaily();
    if (sbMarkdown) {
      appendToDoc(safeCheckAndRollover_(targetDocId), sbMarkdown);
    }
  } catch (e) {
    console.error('[BackgroundSync] Sellerboard sync failed: %s', e.message);
  }
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

/** Ops confirmation / order reference emails → target doc (label dedup). */
function runConfirmationEmailSync() {
  console.log('[BackgroundSync] Confirmation email sync starting');
  try {
    processConfirmationEmails_();
  } catch (e) {
    console.error('[BackgroundSync] Confirmation email sync failed: %s', e.message);
  }
}

/**
 * Gmail monitor for operational confirmations with Processed-Confirmation dedup.
 */
function processConfirmationEmails_() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
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
    var targetDocId = PropertiesService.getScriptProperties().getProperty('TARGET_DOC_ID')
      || DEFAULT_TARGET_DOC_ID;

    if (threads.length === 0) {
      console.log('[ConfirmationEmails] No unprocessed confirmation threads.');
      return;
    }

    console.log('[ConfirmationEmails] Processing %d thread(s)', threads.length);

    for (var i = 0; i < threads.length; i++) {
      if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
        console.log('[ConfirmationEmails] Time limit — stopping after %d thread(s)', i);
        break;
      }

      var thread = threads[i];
      var messages = thread.getMessages();
      var msg = messages[messages.length - 1];
      var body = msg.getPlainBody();
      if (!body) {
        continue;
      }

      var payload = {
        source: 'gmail_confirmation',
        content: body,
        metadata: { title: msg.getSubject() }
      };
      var markdown = formatAsMarkdown(payload);
      var appended = false;

      try {
        appendToDoc(safeCheckAndRollover_(targetDocId), markdown);
        appended = true;
      } catch (err) {
        Utilities.sleep(3000);
        try {
          appendToDoc(safeCheckAndRollover_(targetDocId), markdown);
          appended = true;
        } catch (retryErr) {
          console.error('[ConfirmationEmails] Append failed for "%s": %s',
            msg.getSubject(), retryErr.message);
        }
      }

      if (appended) {
        try {
          thread.addLabel(label);
        } catch (labelErr) {
          console.warn('[ConfirmationEmails] Could not label thread: %s', labelErr.message);
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
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
