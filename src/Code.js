/**
 * ops-brain-sync — Google Apps Script Web App
 *
 * Entry points: doGet / doPost (webhooks). Background jobs live in BackgroundSync.js
 * (run installBackgroundTriggers once after deploy).
 *
 * All pipeline data now routes to individual Drive files in per-source folders.
 * See FileWriter.js for the write + retention lifecycle layer.
 */

// 1. Raw configuration fallbacks
var DEFAULT_MASTER_SPREADSHEET_ID = '1d6ljzCm_JW6KT6yR0-GMii6cwZqcGG0UwZKZT9UNWCY';
var DEFAULT_NOTEBOOK_SOURCE_FOLDER_ID = '1PBUHSJvqg3yNHH1gaJn0nhYcG0SLvoBE';

// Folder targets for the file-per-record architecture (set Script Properties to override)
var DEFAULT_FATHOM_FOLDER_ID = '1PBUHSJvqg3yNHH1gaJn0nhYcG0SLvoBE';
var DEFAULT_METRICS_FOLDER_ID = '1PBUHSJvqg3yNHH1gaJn0nhYcG0SLvoBE';
var DEFAULT_CONFIRMATIONS_FOLDER_ID = '1PBUHSJvqg3yNHH1gaJn0nhYcG0SLvoBE';

// 2. Self-healing sanitization
function sanitizeSpreadsheetId(id) {
  if (!id || typeof id !== 'string') return id;
  var corrected = id;
  var changes = [];
  if (corrected.substring(0, 10) === '1d6ljzCm_J') {
    corrected = '1d6ljzCm_j' + corrected.substring(10);
    changes.push('Fixed uppercase J to lowercase j');
  }
  if (corrected.endsWith('ZT9UNWCY')) {
    corrected = corrected.substring(0, corrected.length - 8) + 'zT9uNWCY';
    changes.push('Fixed case in trailing characters');
  }
  var correctPattern = /^1d6ljzCm_[jJ]W6KT6yR0-GMii6cwZqcGG0UwZKzT9uNWCY$/i;
  if (correctPattern.test(corrected)) {
    corrected = '1d6ljzCm_jW6KT6yR0-GMii6cwZqcGG0UwZKzT9uNWCY';
    changes.push('Applied canonical case pattern');
  }
  if (changes.length > 0) {
    console.log('[Sanitization] Fixed ' + changes.length + ' issue(s): ' + changes.join(', '));
  }
  return corrected;
}

function getValidSpreadsheetId() {
  var rawId = PropertiesService.getScriptProperties().getProperty('MASTER_SPREADSHEET_ID') || DEFAULT_MASTER_SPREADSHEET_ID;
  var sanitized = sanitizeSpreadsheetId(rawId);
  try {
    SpreadsheetApp.openById(sanitized);
    return sanitized;
  } catch (e) {
    throw new Error('Cannot access spreadsheet. Check MASTER_SPREADSHEET_ID in Script Properties.');
  }
}

/** Safe variant for background jobs — logs and returns null instead of throwing. */
function tryGetValidSpreadsheetId() {
  try {
    return getValidSpreadsheetId();
  } catch (e) {
    console.error('[Config] Spreadsheet unavailable: %s', e.message);
    return null;
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Helper function to translate alphanumeric Slack IDs into human-readable display names
 */
function cleanSlackUserMentions(text) {
  if (!text) return text;

  var slackUserMap = {
    'U066ARLFH4K':  'Sunny (Sajjad)',
    'U4Y0JPMD4':    'Rick Reichmuth',
    'U5206HQ00':    'Diego Marquez',
    'U08F1V0FPDY':  'Allyse C',
    'UQC0FDA2Z':    'Stifany Ong',
    'U04PH549Z3N':  'Paula Bacolod',
    'U08E1C77J77':  'Arqam',
    'U03SW53P95E':  'Mollie Cutillo',
    'U0AMTGG4XRD':  'Marco Gastelum'
  };

  var cleanedText = text;

  Object.keys(slackUserMap).forEach(function(userId) {
    var regex = new RegExp('<@' + userId + '(?:\\|[^>]*)?>', 'g');
    cleanedText = cleanedText.replace(regex, slackUserMap[userId]);
  });

  return cleanedText;
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.type === 'url_verification') return ContentService.createTextOutput(data.challenge);

    var parsed = parsePayload(data);

    if (parsed.source === 'slack' && parsed.content) {
      parsed.content = cleanSlackUserMentions(parsed.content);
    }

    var markdown = formatAsMarkdown(parsed);
    var notebookFolderId = PropertiesService.getScriptProperties().getProperty('NOTEBOOK_SOURCE_FOLDER_ID') || DEFAULT_NOTEBOOK_SOURCE_FOLDER_ID;

    // Route webhook data to the appropriate folder
    var folderId = notebookFolderId;
    if (parsed.source === 'fathom') {
      folderId = PropertiesService.getScriptProperties().getProperty('FATHOM_FOLDER_ID') || DEFAULT_FATHOM_FOLDER_ID;
    }

    var now = new Date();
    var tz = 'America/New_York';
    var dateStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    var safeSource = (parsed.source || 'webhook').replace(/[^a-zA-Z0-9]/g, '_');
    var fileName = dateStr + '_' + safeSource + '_Webhook.md';

    createNewDriveFile(folderId, fileName, markdown);

    return jsonResponse(200, { status: 'ok' });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
}

function jsonResponse(httpCode, body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function clearSyncCache() {
  var properties = PropertiesService.getScriptProperties();
  properties.deleteProperty('LAST_PROCESSED_ROW');
  properties.deleteProperty('SYNCED_ROWS_CACHE');
  console.log("Sync history successfully reset. Ready for a clean run!");
}

function breakTheLock() {
  var lock = LockService.getScriptLock();
  lock.releaseLock();
  console.log("Success: The zombie script lock has been cleared!");
}

function forceReleaseLock() {
  var lock = LockService.getScriptLock();
  lock.releaseLock();
  console.log('[LockManager] Lock forcefully released successfully.');
}

function triggerPermissionCheck() { DriveApp.getRootFolder(); }

