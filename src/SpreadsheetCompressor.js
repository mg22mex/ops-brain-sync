/**
 * SpreadsheetCompressor — Dynamic size-based sheet compression for NotebookLM
 * ========================================================================
 * Scans the master operations matrix and all linked spreadsheets, checks
 * each file's actual Drive size, and auto-compresses anything exceeding
 * MAX_SIZE_MB into a compact .md snapshot in the NotebookLM source folder.
 *
 * Files under the threshold are skipped — NotebookLM can ingest those raw.
 *
 * Entry point: processCompressionTargets() — called from runSheetCompressionSync()
 */

var MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB threshold
var COMPRESSOR_MAX_RETRIES = 3;
var COMPRESSOR_TARGET_FOLDER_ID = '1xyKFTE1a5kCAhVE8baSGOcchAthPNLrB';

// ID format validation regexes — reject malformed IDs before API calls
var SHEET_ID_REGEX_ = /^[a-zA-Z0-9-_]{20,}$/;
var DOC_ID_REGEX_ = /^[a-zA-Z0-9-_]{20,}$/;

/**
 * Dynamically discover spreadsheets from the master matrix, check their
 * Drive file size, and compress anything over MAX_SIZE_BYTES into a
 * compact Markdown snapshot in the NotebookLM folder.
 */
function processCompressionTargets() {
  var startTime = new Date().getTime();
  var TIME_LIMIT_MS = 300000; // 5-minute ceiling — stay under GAS 6-min limit

  try {
    var notebookFolderId = COMPRESSOR_TARGET_FOLDER_ID;
    if (!notebookFolderId) {
      console.error('[SheetCompressor] NOTEBOOK_SOURCE_FOLDER_ID not set — cannot save snapshots');
      return;
    }

    // 1. Get the master spreadsheet
    var masterId = tryGetValidSpreadsheetId();
    if (!masterId) {
      console.error('[SheetCompressor] Master spreadsheet unavailable — aborting');
      return;
    }

    // 2. Build a deduplicated list of spreadsheet IDs to check
    var spreadsheetIds = collectSpreadsheetIds_(masterId, startTime, TIME_LIMIT_MS);
    if (spreadsheetIds.length === 0) {
      console.log('[SheetCompressor] No spreadsheets found to evaluate');
      return;
    }

    console.log('[SheetCompressor] Evaluating %d spreadsheet(s) for compression', spreadsheetIds.length);

    // 3. Check size & compress each one
    var compressed = 0;
    var skipped = 0;
    var failed = 0;

    for (var i = 0; i < spreadsheetIds.length; i++) {
      if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
        console.log('[SheetCompressor] Time limit reached — evaluated %d/%d spreadsheets',
          compressed + skipped + failed, spreadsheetIds.length);
        break;
      }

      var sid = spreadsheetIds[i];
      var evalResult = evaluateAndCompress_(sid, notebookFolderId);
      if (evalResult === 'compressed') compressed++;
      else if (evalResult === 'skipped') skipped++;
      else if (evalResult === 'failed') failed++;
    }

    console.log('[SheetCompressor] Complete: %d compressed, %d skipped (under %dMB), %d failed',
      compressed, skipped, MAX_SIZE_BYTES / (1024 * 1024), failed);

    // 4. Scan columns D/E/F across all sheets for Google Doc URLs
    var docUrls = collectDocUrls_(masterId, startTime, TIME_LIMIT_MS);
    if (docUrls.length > 0) {
      console.log('[SheetCompressor] Found %d Google Doc(s) to convert', docUrls.length);
      for (var d = 0; d < docUrls.length; d++) {
        if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
          console.log('[SheetCompressor] Time limit reached — converted %d/%d docs', d, docUrls.length);
          break;
        }
        crawlAndConvertDocToMarkdown_(docUrls[d].url, docUrls[d].docId, notebookFolderId);
      }
    } else {
      console.log('[SheetCompressor] No Google Doc URLs found in columns D/E/F');
    }
  } catch (err) {
    console.error('[SheetCompressor] Fatal error in compression cycle: %s', err.message);
    notifyAdmin_('[SheetCompressor] Fatal crash', err);
  }
}

/**
 * Collect all spreadsheet IDs to evaluate: the master matrix itself plus
 * any linked spreadsheet IDs found in its cell contents.
 *
 * @param {string} masterId
 * @param {number} startTime
 * @param {number} timeLimitMs
 * @returns {string[]} — Deduplicated array of spreadsheet IDs
 */
function collectSpreadsheetIds_(masterId, startTime, timeLimitMs) {
  var idMap = {};
  idMap[masterId] = true;

  try {
    var ss = SpreadsheetApp.openById(masterId);
    var sheets = ss.getSheets();
    var sheetRegex = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;

    for (var s = 0; s < sheets.length; s++) {
      if (new Date().getTime() - startTime > timeLimitMs) break;

      var values = sheets[s].getDataRange().getValues();
      for (var r = 0; r < values.length; r++) {
        for (var c = 0; c < values[r].length; c++) {
          var cellValue = String(values[r][c]);
          var match = cellValue.match(sheetRegex);
          if (match && !idMap[match[1]]) {
            idMap[match[1]] = true;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[SheetCompressor] Error scanning master matrix for linked sheets: %s', err.message);
  }

  return Object.keys(idMap);
}

/**
 * Collect Google Doc URLs from columns D (USA), E (UK), F (CAN) across
 * all sheets in the master matrix. Returns clean extractable doc IDs
 * for crawlAndConvertDocToMarkdown_().
 *
 * Non-Google URLs (Canva, etc.) are silently skipped with a
 * debug log — they never halt execution.
 *
 * @param {string} masterId — Master spreadsheet ID
 * @param {number} startTime
 * @param {number} timeLimitMs
 * @returns {Array.<{url: string, docId: string}>}
 */
function collectDocUrls_(masterId, startTime, timeLimitMs) {
  var docUrls = [];
  var docRegex = /docs\.google\.com\/document\/d\/([a-zA-Z0-9-_]+)/;

  try {
    var ss = SpreadsheetApp.openById(masterId);
    var sheets = ss.getSheets();
    var DATA_START_ROW = 4;

    for (var s = 0; s < sheets.length; s++) {
      if (new Date().getTime() - startTime > timeLimitMs) break;

      var lastRow = sheets[s].getLastRow();
      if (lastRow < DATA_START_ROW) continue;

      var numRows = lastRow - DATA_START_ROW + 1;
      // Columns D=4, E=5, F=6
      var range = sheets[s].getRange(DATA_START_ROW, 4, numRows, 3);
      var values = range.getValues();

      for (var r = 0; r < values.length; r++) {
        for (var c = 0; c < 3; c++) {
          var cellValue = String(values[r][c]);
          var match = cellValue.match(docRegex);
          if (match) {
            docUrls.push({
              url: 'https://docs.google.com/document/d/' + match[1] + '/edit',
              docId: match[1]
            });
          } else if (cellValue.indexOf('://') !== -1 &&
                     cellValue.indexOf('docs.google.com') === -1) {
            console.log('[SheetCompressor] Skipping non-Google link at col %s row %d',
              String.fromCharCode(68 + c), r + DATA_START_ROW);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[SheetCompressor] Error scanning for doc URLs: %s', err.message);
  }

  return docUrls;
}

/**
 * For a single spreadsheet ID: check Drive file size. If over threshold,
 * compress it; otherwise skip.
 *
 * @param {string} sid — Spreadsheet ID
 * @param {string} folderId — Destination folder for compressed .md files
 * @returns {string} — 'compressed', 'skipped', or 'failed'
 */
function evaluateAndCompress_(sid, folderId) {
  var sizeBytes = 0;
  var ssName = sid;

  // Strict input validation: reject malformed IDs before API calls
  if (!SHEET_ID_REGEX_.test(sid)) {
    console.warn('[SheetCompressor] Invalid spreadsheet ID format — skipping: %s', sid);
    return 'failed';
  }

  try {
    // Check the Drive file size
    var driveFile = DriveApp.getFileById(sid);
    sizeBytes = driveFile.getSize();
    ssName = driveFile.getName();

    if (sizeBytes <= MAX_SIZE_BYTES) {
      console.log('[SheetCompressor] %s is %d bytes (under %dMB) — skipping',
        ssName, sizeBytes, MAX_SIZE_BYTES / (1024 * 1024));
      return 'skipped';
    }

    console.log('[SheetCompressor] %s is %d bytes (over %dMB) — compressing',
      ssName, sizeBytes, MAX_SIZE_BYTES / (1024 * 1024));

  } catch (sizeErr) {
    console.warn('[SheetCompressor] Cannot access file %s for size check: %s', sid, sizeErr.message);
    return 'failed';
  }

  // Compress
  try {
    var ss = SpreadsheetApp.openById(sid);
    var safeName = ssName.replace(/[^a-zA-Z0-9-_]/g, '');
    var fileName = 'Compressed-' + safeName + '.md';

    // Compress each tab individually, join into one snapshot
    var sheets = ss.getSheets();
    var allMarkdown = [];

    for (var i = 0; i < sheets.length; i++) {
      var md = compressSheetToMarkdown_(sheets[i], {
        maxCellLength: 200,
        maxRows: 500,
        skipEmptyRows: true,
        sourceName: ssName
      });
      allMarkdown.push(md);
    }

    var snapshot = allMarkdown.join('\n\n');
    saveCompressedSnapshot_(folderId, fileName, snapshot);
    return 'compressed';

  } catch (compressErr) {
    console.error('[SheetCompressor] Failed to compress %s: %s', ssName, compressErr.message);
    return 'failed';
  }
}

/**
 * Compress a single sheet's active data range into a compact Markdown table.
 *
 * Compression strategy:
 *   1. Skip rows where every cell is empty (blank/whitespace/null)
 *   2. Truncate individual cell values to maxCellLength
 *   3. Cap total data rows at maxRows (header + separator always included)
 *   4. Format dates as YYYY-MM-DD to reduce verbosity
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {{maxCellLength: number, maxRows: number, skipEmptyRows: boolean, sourceName: string}} opts
 * @returns {string} — Compact Markdown table
 */
function compressSheetToMarkdown_(sheet, opts) {
  opts = opts || {};
  var maxCellLength = opts.maxCellLength || 200;
  var maxRows = opts.maxRows || 500;
  var skipEmpty = opts.skipEmptyRows !== false;
  var sourceName = opts.sourceName || '';

  var data = sheet.getDataRange().getValues();
  if (data.length < 1) {
    return '*[Empty sheet: ' + sheet.getName() + ']*\n';
  }

  var lines = [];
  var now = new Date();
  var tz = 'America/New_York';

  // Header with metadata
  lines.push('### ' + sheet.getName() + '');
  lines.push('');
  if (sourceName) lines.push('- **Source:** `' + sourceName + '`');
  lines.push('- **Sheet:** `' + sheet.getName() + '`');
  lines.push('- **Rows scanned:** ' + data.length + ' → filtered');
  lines.push('- **Synced:** ' + Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss') + ' ET');
  lines.push('');

  // Header row
  var headers = data[0].map(function(cell) {
    return escapeMd(truncateCell_(cell, maxCellLength));
  });
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('| ' + headers.map(function() { return '---'; }).join(' | ') + ' |');

  // Data rows with compression
  var rowCount = 0;
  for (var r = 1; r < data.length && rowCount < maxRows; r++) {
    try {
      var row = data[r];

      // Skip empty rows
      if (skipEmpty && row.every(function(cell) {
        return cell === null || cell === undefined || cell === '' || String(cell).trim() === '';
      })) {
        continue;
      }

      var cleanRow = row.map(function(cell) {
        return escapeMd(truncateCell_(cell, maxCellLength));
      });

      lines.push('| ' + cleanRow.join(' | ') + ' |');
      rowCount++;
    } catch (rowErr) {
      console.warn('[SheetCompressor] Skipped corrupt row %d in "%s": %s',
        r + 1, sheet.getName(), rowErr.message);
      continue;
    }
  }

  if (rowCount === 0) {
    lines.push('| *No data rows after filtering* |');
  }

  lines.push('');
  lines.push('---');

  console.log('[SheetCompressor] Compressed "%s" → %d rows (filtered from %d)',
    sheet.getName(), rowCount, data.length - 1);

  return lines.join('\n');
}

/**
 * Truncate a cell value to maxLength characters.
 * Formats Date objects as YYYY-MM-DD, converts nulls to empty string.
 *
 * @param {*} cell — Raw cell value from getValues()
 * @param {number} maxLen
 * @returns {string}
 */
function truncateCell_(cell, maxLen) {
  var str;
  if (cell instanceof Date) {
    str = Utilities.formatDate(cell, 'America/New_York', 'yyyy-MM-dd');
  } else if (cell === null || cell === undefined) {
    return '';
  } else {
    str = String(cell);
  }

  str = str.replace(/\n/g, ' ').trim();
  if (str.length > maxLen) {
    str = str.substring(0, maxLen - 3) + '...';
  }
  return str;
}

/**
 * Save a compressed Markdown snapshot to a Drive folder with retry.
 * Replaces any existing file with the same name.
 *
 * @param {string} folderId
 * @param {string} fileName
 * @param {string} content
 */
function saveCompressedSnapshot_(folderId, fileName, content) {
  for (var attempt = 1; attempt <= COMPRESSOR_MAX_RETRIES; attempt++) {
    try {
      var folder = DriveApp.getFolderById(folderId);

      // Remove any existing file with the same name
      var existing = folder.getFilesByName(fileName);
      while (existing.hasNext()) {
        existing.next().setTrashed(true);
      }

      folder.createFile(fileName, content, MimeType.PLAIN_TEXT);
      console.log('[SheetCompressor] Saved %s (%d bytes)', fileName, content.length);
      return;

    } catch (err) {
      if (attempt === COMPRESSOR_MAX_RETRIES) {
        console.error('[SheetCompressor] All %d attempts failed to save %s: %s',
          COMPRESSOR_MAX_RETRIES, fileName, err.message);
        throw err;
      }
      var backoffMs = 2000 * attempt;
      console.warn('[SheetCompressor] Attempt %d/%d to save %s failed: %s. Retrying in %dms...',
        attempt, COMPRESSOR_MAX_RETRIES, fileName, err.message, backoffMs);
      Utilities.sleep(backoffMs);
    }
  }
}

/**
 * Open a Google Doc by ID, parse its structural elements (headings H1-H3,
 * body paragraphs, list items) into clean Markdown prose, and save to the
 * target folder with overwrite protection via saveCompressedSnapshot_().
 *
 * Skips non-paragraph/list elements (tables, images, drawings) silently.
 * Non-Google URLs in the matrix are handled by collectDocUrls_() — this
 * function only receives valid Google Doc links.
 *
 * @param {string} url      — Full Google Doc URL (used for logging only)
 * @param {string} docId    — Google Doc file ID from Drive
 * @param {string} folderId — Destination Drive folder ID
 */
function crawlAndConvertDocToMarkdown_(url, docId, folderId) {
  // Strict input validation: reject malformed doc IDs before DocumentApp API call
  if (!DOC_ID_REGEX_.test(docId)) {
    console.warn('[SheetCompressor] Invalid doc ID format — skipping: %s', url);
    return;
  }

  try {
    var doc = DocumentApp.openById(docId);
    var docName = doc.getName();
    var body = doc.getBody();
    var numElements = body.getNumChildren();

    var now = new Date();
    var tz = 'America/New_York';
    var dateStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

    var lines = [];
    lines.push('# ' + docName);
    lines.push('');
    lines.push('> Synced: ' + dateStr + ' ET · Source: `' + docId + '`');
    lines.push('');
    lines.push('---');
    lines.push('');

    for (var i = 0; i < numElements; i++) {
      var element = body.getChild(i);
      var type = element.getType();

      if (type === DocumentApp.ElementType.PARAGRAPH) {
        var text = element.getText().trim();
        if (text === '') {
          lines.push('');
          continue;
        }

        var heading = element.getHeading();
        if (heading === DocumentApp.ParagraphHeading.HEADING1) {
          lines.push('## ' + text);
          lines.push('');
        } else if (heading === DocumentApp.ParagraphHeading.HEADING2) {
          lines.push('### ' + text);
          lines.push('');
        } else if (heading === DocumentApp.ParagraphHeading.HEADING3) {
          lines.push('#### ' + text);
          lines.push('');
        } else {
          lines.push(text);
          lines.push('');
        }

      } else if (type === DocumentApp.ElementType.LIST_ITEM) {
        var itemText = element.getText().trim();
        if (itemText) {
          lines.push('- ' + itemText);
          // Blank line after last list item in a sequence
          if (i + 1 >= numElements ||
              body.getChild(i + 1).getType() !== DocumentApp.ElementType.LIST_ITEM) {
            lines.push('');
          }
        }
      }
      // All other element types (tables, images, drawings, etc.) are silently skipped
    }

    var markdownText = lines.join('\n');
    var safeName = docName.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 80);
    var fileName = safeName + '_compiled.md';
    saveCompressedSnapshot_(folderId, fileName, markdownText);

    console.log('[SheetCompressor] Doc snapshot created: %s → %s (%d bytes)',
      docName, fileName, markdownText.length);

  } catch (err) {
    console.error('[SheetCompressor] Failed to process doc %s: %s', url, err.message);
  }
}

/**
 * Send a proactive admin alert via email when a fatal error occurs.
 * Uses ADMIN_EMAIL Script Property if set, otherwise falls back to
 * the active user's email. Silently exits if neither is available.
 *
 * @param {string} subject — Short alert label
 * @param {Error} err — The error object (used for stack trace)
 */
function notifyAdmin_(subject, err) {
  try {
    var email = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL')
      || Session.getActiveUser().getEmail();
    if (!email) return;

    var stack = err.stack || err.message || '(no stack trace)';
    var body = [
      '## ' + subject,
      '',
      '**Time:** ' + new Date().toISOString(),
      '**Error:** ' + (err.message || '(no message)'),
      '',
      '**Stack trace:**',
      '```',
      stack,
      '```',
      '',
      'Trigger cycle will retry on next scheduled interval.'
    ].join('\n');

    MailApp.sendEmail({
      to: email,
      subject: '[ops-brain-sync] ' + subject,
      htmlBody: body.replace(/\n/g, '<br>')
    });

    console.log('[SheetCompressor] Admin alert sent to %s', email);
  } catch (mailErr) {
    console.warn('[SheetCompressor] Failed to send admin alert: %s', mailErr.message);
  }
}
