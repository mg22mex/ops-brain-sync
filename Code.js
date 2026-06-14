/**
 * ops-brain-sync — Google Apps Script Web App
 */

// 1. Raw configuration fallbacks
var DEFAULT_MASTER_SPREADSHEET_ID = '1d6ljzCm_JW6KT6yR0-GMii6cwZqcGG0UwZKZT9UNWCY';
var DEFAULT_TARGET_DOC_ID = '10miHbalFoWzkwmGV9oHVU-CDWl8dXLZz4o2tby6lzcM';
var DEFAULT_NOTEBOOK_SOURCE_FOLDER_ID = '1xyKFtE1a5kCAHve8bASGOcchAthPNLrB';

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
    var sheet = SpreadsheetApp.openById(sanitized);
    return sanitized;
  } catch (e) {
    throw new Error('Cannot access spreadsheet. Please run fixSpreadsheetId() function');
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
    var targetDocId = PropertiesService.getScriptProperties().getProperty('TARGET_DOC_ID') || DEFAULT_TARGET_DOC_ID;
    var notebookFolderId = PropertiesService.getScriptProperties().getProperty('NOTEBOOK_SOURCE_FOLDER_ID') || DEFAULT_NOTEBOOK_SOURCE_FOLDER_ID;
    
    var activeDocId = safeCheckAndRollover_(targetDocId);
    
    if (parsed.source === 'slack') {
      appendSlackToDailyFile(notebookFolderId, markdown);
    } else {
      appendToDoc(activeDocId, markdown);
    }
    return jsonResponse(200, { status: 'ok' });
  } catch (err) {
    return jsonResponse(500, { error: err.message });
  }
}

// 3. Background Sync Engine with Concurrency Safeguard Lock
function runBackgroundSyncs() {
  var executionLock = LockService.getScriptLock();
  try {
    // Wait up to 15 seconds for any running background sync to clear out completely
    executionLock.waitLock(15000);
  } catch (lockError) {
    console.warn('[Background Engine] An instance is already actively executing. Exiting this cycle to prevent overlaps.');
    return;
  }

  console.log('[Background] ========== STARTING SYNC ==========');
  
  var masterSpreadsheetId = getValidSpreadsheetId();
  var targetDocId = PropertiesService.getScriptProperties().getProperty('TARGET_DOC_ID') || DEFAULT_TARGET_DOC_ID;
  var notebookFolderId = PropertiesService.getScriptProperties().getProperty('NOTEBOOK_SOURCE_FOLDER_ID') || DEFAULT_NOTEBOOK_SOURCE_FOLDER_ID;

  // Master Matrix Sync
  try { 
    processDriveMatrixSync(notebookFolderId, masterSpreadsheetId); 
  } catch (err) { 
    console.error('Drive Sync error: ' + err.message); 
  }
  
  // Fathom Polling Sync
  try {
    var fathomMarkdown = fetchRecentMeetings();
    if (fathomMarkdown) {
      var activeDocId = safeCheckAndRollover_(targetDocId);
      appendToDoc(activeDocId, fathomMarkdown);
    }
  } catch (err) { 
    console.error('Fathom Sync error: ' + err.message); 
  }

  // Email Monitor For Fathom
  try {
    processFathomEmails();
  } catch (err) { 
    console.error('Fathom Email Monitor error: ' + err.message); 
  }

  // Triple Whale Sync
  try {
    var twMarkdown = fetchTripleWhalePerformance();
    if (twMarkdown) {
      var activeDocId = safeCheckAndRollover_(targetDocId);
      appendToDoc(activeDocId, twMarkdown);
    }
  } catch (err) { 
    console.error('TW Sync error: ' + err.message); 
  }

  // Sellerboard Sync
  try {
    var sbMarkdown = fetchSellerboardDaily();
    if (sbMarkdown) {
      var activeDocId = safeCheckAndRollover_(targetDocId);
      appendToDoc(activeDocId, sbMarkdown);
    }
  } catch (err) { 
    console.error('SB Sync error: ' + err.message); 
  }
  
  // Operational Confirmations Email Sync
  try {
    processConfirmationEmails();
  } catch (err) { 
    console.error('Confirmation Email Sync error: ' + err.message); 
  }
  
  console.log('[Background] ========== SYNC COMPLETE ==========');
  executionLock.releaseLock();
}

/**
 * Robust Self-Healing Rollover Safety Engine
 */
function safeCheckAndRollover_(currentDocId) {
  try {
    return checkAndRolloverIfNeeded_(currentDocId);
  } catch (err) {
    console.warn('[Rollover Safety] Document is inaccessible or corrupt. Forcing emergency rollover execution...');
    try {
      var currentDoc = DocumentApp.openById(currentDocId);
      var name = currentDoc.getName() + ' - Archive Fallback ' + new Date().toLocaleDateString();
      var newDoc = DocumentApp.create(name);
      var newId = newDoc.getId();
      
      PropertiesService.getScriptProperties().setProperty('TARGET_DOC_ID', newId);
      console.log('[Rollover Safety] Emergency recovery successful. New Target Active Document ID: ' + newId);
      return newId;
    } catch (emergencyErr) {
      console.error('[Rollover Safety] Total lock environment reached. Falling back to base configurations: ' + emergencyErr.message);
      return currentDocId;
    }
  }
}

/**
 * FathomFetcher — Outbound polling for Fathom meetings
 */
function fetchRecentMeetings() {
  var FATHOM_API_BASE = 'https://api.fathom.ai/external/v1/meetings';
  var apiKey = PropertiesService.getScriptProperties().getProperty('FATHOM_API_KEY');
  
  if (!apiKey) {
    console.warn('[FathomFetcher] FATHOM_API_KEY not set — skipping');
    return null;
  }

  var pollingUrl = FATHOM_API_BASE; 
  
  try {
    var response = UrlFetchApp.fetch(pollingUrl, {
      method: 'get',
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      console.error('[FathomFetcher] Failed. Code: %s', response.getResponseCode());
      return null;
    }

    var data = JSON.parse(response.getContentText());
    var meetings = data.meetings || data.data || data || [];
    if (!Array.isArray(meetings) || meetings.length === 0) return null;

    var collectiveMarkdown = [];
    for (var i = 0; i < meetings.length; i++) {
      var mtg = meetings[i];
      var contentBody = mtg.summary || mtg.summary_markdown || mtg.transcript || '*[No text]*';
      
      if (contentBody.length > 15000) {
        contentBody = contentBody.substring(0, 15000) + '\n\n...[Transcript truncated for size validation limit]...';
      }

      var intermediatePayload = {
        source: 'fathom',
        content: contentBody,
        metadata: {
          title: mtg.title || mtg.name || 'Untitled Operational Call',
          url: mtg.url || '',
          durationSec: mtg.duration || 0,
          recordedAt: mtg.date || mtg.recorded_at || new Date().toISOString()
        }
      };
      collectiveMarkdown.push(formatAsMarkdown(intermediatePayload));
    }
    return collectiveMarkdown.join('\n\n---\n\n');
  } catch (urlErr) {
    return null;
  }
}

// 4. Email Monitor for Fathom
function processFathomEmails() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); 
  } catch (e) {
    console.warn('[FathomMonitor] File lock busy. Postponing window cycle.');
    return;
  }

  try {
    var threads = GmailApp.search('subject:"Recap for"', 0, 5); 
    var targetDocId = PropertiesService.getScriptProperties().getProperty('TARGET_DOC_ID') || DEFAULT_TARGET_DOC_ID;
    
    for (var i = 0; i < threads.length; i++) {
      var messages = threads[i].getMessages();
      for (var j = 0; j < messages.length; j++) {
        var msg = messages[j];
        
        if (msg.getFrom().indexOf('fathom.video') !== -1) {
          var bodyContent = msg.getPlainBody();
          
          if (bodyContent.length > 15000) {
            bodyContent = bodyContent.substring(0, 15000) + '\n\n...[Text transcript split for size safety constraints]...';
          }

          var payload = { 'source': 'fathom', 'content': bodyContent, 'metadata': { 'title': msg.getSubject() } };
          var markdown = formatAsMarkdown(payload);
          
          try {
            var docId = safeCheckAndRollover_(targetDocId);
            appendToDoc(docId, markdown);
            msg.markRead(); 
          } catch (err) {
            Utilities.sleep(5000);
            try {
              var retryDocId = safeCheckAndRollover_(targetDocId);
              appendToDoc(retryDocId, markdown);
              msg.markRead();
            } catch (retryErr) {
              console.error('[FathomMonitor] Skipping item block: ' + retryErr.message);
            }
          }
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
}

// 5. General Confirmation and Reference Monitor
function processConfirmationEmails() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return;
  }

  try {
    var searchQuery = 'subject:(confirmation OR order OR reference OR "nrf" OR "color reference")';
    var threads = GmailApp.search(searchQuery, 0, 10); 
    var targetDocId = PropertiesService.getScriptProperties().getProperty('TARGET_DOC_ID') || DEFAULT_TARGET_DOC_ID;
    
    for (var i = 0; i < threads.length; i++) {
      var messages = threads[i].getMessages();
      var msg = messages[messages.length - 1]; 
      
      var payload = { 
        'source': 'gmail_confirmation', 
        'content': msg.getPlainBody(), 
        'metadata': { 'title': msg.getSubject() } 
      };
      var markdown = formatAsMarkdown(payload);
      
      try {
        var docId = safeCheckAndRollover_(targetDocId);
        appendToDoc(docId, markdown);
      } catch (err) {
        Utilities.sleep(3000);
        try {
          var retryDocId = safeCheckAndRollover_(targetDocId);
          appendToDoc(retryDocId, markdown);
        } catch (retryErr) {}
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse(httpCode, body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}