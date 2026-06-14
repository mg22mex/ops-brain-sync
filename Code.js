/**
 * ops-brain-sync — Google Apps Script Web App
 * ============================================
 * Serverless webhook receiver for Slack & Fathom, plus scheduled background
 * syncs for Fathom, Triple Whale, and Sellerboard.  Forwards cleaned
 * Markdown into Google Docs with automatic monthly rollover.
 *
 * Entry-point functions:  doGet(e), doPost(e), runBackgroundSyncs()
 */

// ──────────────────────────────────────────────
// Configuration  (override via Script Properties)
// ──────────────────────────────────────────────

var TARGET_DOC_ID = PropertiesService.getScriptProperties()
  .getProperty('TARGET_DOC_ID') || 'YOUR_TARGET_GOOGLE_DOC_ID';

// ──────────────────────────────────────────────
// doGet — Health-check endpoint
// ──────────────────────────────────────────────

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: 'ok',
      service: 'ops-brain-sync',
      timestamp: new Date().toISOString()
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ──────────────────────────────────────────────
// doPost — Primary webhook ingress
// ──────────────────────────────────────────────

function doPost(e) {
  var start = new Date();

  try {
    // 1. Parse raw payload
    var raw = e.postData.contents;
    if (!raw) {
      return jsonResponse(400, { status: 'error', message: 'Missing postData.contents' });
    }

    var data = JSON.parse(raw);

    // 2. Slack Events API url_verification handshake
    if (data.type === 'url_verification') {
      console.log('[doPost] Responding to Slack url_verification challenge');
      return ContentService
        .createTextOutput(data.challenge)
        .setMimeType(ContentService.MimeType.TEXT);
    }

    // 3. Route & extract
    var parsed = parsePayload(data);

    // 4. Format as Markdown
    var markdown = formatAsMarkdown(parsed);

    // 5. Check rollover before appending
    var activeDocId = checkAndRolloverIfNeeded_(TARGET_DOC_ID);
    if (activeDocId !== TARGET_DOC_ID) {
      TARGET_DOC_ID = activeDocId;
    }

    // 6. Append to Google Doc
    appendToDoc(activeDocId, markdown);

    var elapsed = (new Date() - start) + 'ms';
    console.log('[doPost] Finished in %s — payload from "%s"', elapsed, parsed.source);

    return jsonResponse(200, {
      status: 'ok',
      source: parsed.source,
      docId: activeDocId,
      elapsed: elapsed
    });

  } catch (err) {
    console.error('[doPost] Unhandled error: %s', err.message);
    return jsonResponse(500, {
      status: 'error',
      message: err.message
    });
  }
}

// ──────────────────────────────────────────────
// runBackgroundSyncs — Scheduled trigger for all
//                      polling-based data sources
// ──────────────────────────────────────────────

function runBackgroundSyncs() {
  var start = new Date();
  var results = [];

  // 1. Fathom — fetch recent meetings
  try {
    var fathomMarkdown = fetchRecentMeetings();
    if (fathomMarkdown) {
      var activeDocId = checkAndRolloverIfNeeded_(TARGET_DOC_ID);
      if (activeDocId !== TARGET_DOC_ID) TARGET_DOC_ID = activeDocId;
      appendToDoc(activeDocId, fathomMarkdown);
      results.push('fathom:ok');
    } else {
      results.push('fathom:no-new-data');
    }
  } catch (err) {
    console.error('[Background] Fathom error: %s', err.message);
    results.push('fathom:error');
  }

  // 2. Triple Whale — fetch store performance
  try {
    var twMarkdown = fetchTripleWhalePerformance();
    if (twMarkdown) {
      var activeDocId = checkAndRolloverIfNeeded_(TARGET_DOC_ID);
      if (activeDocId !== TARGET_DOC_ID) TARGET_DOC_ID = activeDocId;
      appendToDoc(activeDocId, twMarkdown);
      results.push('triplewhale:ok');
    } else {
      results.push('triplewhale:no-data');
    }
  } catch (err) {
    console.error('[Background] Triple Whale error: %s', err.message);
    results.push('triplewhale:error');
  }

  // 3. Sellerboard — fetch daily CSV snapshot
  try {
    var sbMarkdown = fetchSellerboardDaily();
    if (sbMarkdown) {
      var activeDocId = checkAndRolloverIfNeeded_(TARGET_DOC_ID);
      if (activeDocId !== TARGET_DOC_ID) TARGET_DOC_ID = activeDocId;
      appendToDoc(activeDocId, sbMarkdown);
      results.push('sellerboard:ok');
    } else {
      results.push('sellerboard:no-data');
    }
  } catch (err) {
    console.error('[Background] Sellerboard error: %s', err.message);
    results.push('sellerboard:error');
  }

  var elapsed = (new Date() - start) + 'ms';
  console.log('[Background] runBackgroundSyncs completed in %s — %s', elapsed, results.join(', '));
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function jsonResponse(httpCode, body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

// ──────────────────────────────────────────────
// installBackgroundTrigger — One-shot setup
// Run this ONCE from the Apps Script editor to
// install the daily time-driven trigger.
// ──────────────────────────────────────────────

function installBackgroundTrigger() {
  // Remove any existing triggers for runBackgroundSyncs to avoid duplicates
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runBackgroundSyncs') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create new daily trigger at 9 AM America/New_York
  ScriptApp.newTrigger('runBackgroundSyncs')
    .timeBased()
    .atHour(9)
    .nearMinute(15)
    .inTimezone('America/New_York')
    .everyDays(1)
    .create();

  console.log('[Setup] Daily trigger installed for runBackgroundSyncs (09:15 ET)');
}
