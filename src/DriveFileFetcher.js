/**
 * DriveFileFetcher — Automated Deep-Crawling Spreadsheet Engine
 * ====================================================================
 * Parses the Master Matrix, extracts its data, automatically detects
 * linked Google Docs/Sheets within cells, recursively extracts them,
 * and commits clean Markdown snapshots directly to the NotebookLM folder.
 *
 * All Drive / Spreadsheet / Document operations use exponential backoff
 * retry to prevent transient "Service failed" errors from halting the crawl.
 */

var DRIVE_FETCHER_MAX_RETRIES = 3;

/**
 * Execute a callback with exponential backoff retry.
 * Used to wrap SpreadsheetApp, DocumentApp, and DriveApp operations
 * that may fail transiently under concurrent load.
 *
 * @param {Function} fn — Thunk to execute (must return the desired value)
 * @param {string} label — Descriptive label for logging
 * @returns {*} — The return value of fn on success
 */
function callWithRetry_(fn, label) {
  for (var attempt = 1; attempt <= DRIVE_FETCHER_MAX_RETRIES; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (attempt === DRIVE_FETCHER_MAX_RETRIES) {
        console.error('[DriveCrawler] All %d attempts failed for %s: %s',
          DRIVE_FETCHER_MAX_RETRIES, label, err.message);
        throw err;
      }
      var backoffMs = 2000 * attempt;
      console.warn('[DriveCrawler] Attempt %d/%d failed for %s: %s. Retrying in %dms...',
        attempt, DRIVE_FETCHER_MAX_RETRIES, label, err.message, backoffMs);
      Utilities.sleep(backoffMs);
    }
  }
}

function processDriveMatrixSync(folderId, spreadsheetId) {
    if (!folderId || !spreadsheetId) throw new Error('DriveFileFetcher: Missing arguments');

    try {
      var destinationFolder = callWithRetry_(function() {
        return DriveApp.getFolderById(folderId);
      }, 'getFolderById(' + folderId + ')');

      var masterSpreadsheet = callWithRetry_(function() {
        return SpreadsheetApp.openById(spreadsheetId);
      }, 'SpreadsheetApp.openById()');

      // Track discovered file URLs to prevent infinite loops or double processing
      var processedFileIds = {};
      processedFileIds[spreadsheetId] = true;

      // 1. Process and save the core Master Matrix
      var masterMarkdown = parseSpreadsheetLayers_(masterSpreadsheet, processedFileIds);
      saveMarkdownSnapshot_(destinationFolder, 'Drive-Snapshot-Product-Development.md', masterMarkdown);

      // 2. Discover and crawl any linked companion files found in the matrix cells
      var discoveredLinks = extractDriveLinksFromSheet_(masterSpreadsheet);
      console.log('[DriveCrawler] Discovered %d potential companion links to sync.', discoveredLinks.length);

      for (var i = 0; i < discoveredLinks.length; i++) {
        // Global master clock guard — exit before the 4-minute platform ceiling
        if (new Date().getTime() - SCRIPT_START_TIME > GLOBAL_MAX_EXECUTION_MS) {
          console.log('[DriveCrawler] Global deadline reached (%dms) — exiting early after %d of %d links.',
            GLOBAL_MAX_EXECUTION_MS, i, discoveredLinks.length);
          break;
        }

        var linkedId = discoveredLinks[i].id;
        var type = discoveredLinks[i].type;

        if (processedFileIds[linkedId]) continue; // Skip if already processed
        processedFileIds[linkedId] = true;

        try {
          if (type === 'spreadsheet') {
            var linkedSheet = callWithRetry_(function() {
              return SpreadsheetApp.openById(linkedId);
            }, 'SpreadsheetApp.openById(' + linkedId + ')');
            var sheetName = 'Linked-Sheet-' + linkedSheet.getName().replace(/[^a-zA-Z0-9-_]/g, '') + '.md';
            var sheetMd = parseSpreadsheetLayers_(linkedSheet, {});
            saveMarkdownSnapshot_(destinationFolder, sheetName, sheetMd);
          }
          else if (type === 'document') {
            var linkedDoc = callWithRetry_(function() {
              return DocumentApp.openById(linkedId);
            }, 'DocumentApp.openById(' + linkedId + ')');
            var docName = 'Linked-Doc-' + linkedDoc.getName().replace(/[^a-zA-Z0-9-_]/g, '') + '.md';
            var docMd = parseDocumentLayers_(linkedDoc);
            saveMarkdownSnapshot_(destinationFolder, docName, docMd);
          }
        } catch (childErr) {
          // Log individual file errors but keep the loop running so other files still sync
          console.warn('[DriveCrawler] Bypassed file ID %s due to access or parsing error: %s', linkedId, childErr.message);
        }
      }

      console.log('[DriveCrawler] Dynamic background deep crawl successfully complete.');

    } catch (err) {
      console.error('[DriveCrawler] Critical execution failure: %s', err.message);
      throw err;
    }
  }
  
  /**
   * Scans all cells in the spreadsheet to gather internal Google Drive links.
   * @private
   */
  function extractDriveLinksFromSheet_(ss) {
    var sheets = ss.getSheets();
    var links = [];
    
    // Regex matchers for extracting Google Sheet or Doc IDs from URLs
    var sheetRegex = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
    var docRegex = /docs\.google\.com\/document\/d\/([a-zA-Z0-9-_]+)/;
  
    sheets.forEach(function(sheet) {
      var values = sheet.getDataRange().getValues();
      for (var r = 0; r < values.length; r++) {
        for (var c = 0; c < values[r].length; c++) {
          var cellValue = String(values[r][c]);
          
          var sheetMatch = cellValue.match(sheetRegex);
          if (sheetMatch) {
            links.push({ id: sheetMatch[1], type: 'spreadsheet' });
            continue;
          }
          
          var docMatch = cellValue.match(docRegex);
          if (docMatch) {
            links.push({ id: docMatch[1], type: 'document' });
          }
        }
      }
    });
    return links;
  }
  
  /**
   * Parses open tabs within a spreadsheet object into a unified Markdown block.
   * @private
   */
  function parseSpreadsheetLayers_(ss, processedMap) {
    var sheets = ss.getSheets();
    var markdown = '# 📅 Data Matrix Snapshot: ' + ss.getName() + '\n\n';
    markdown += 'Synced on: ' + Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd HH:mm:ss') + ' ET\n\n';
  
    sheets.forEach(function(sheet) {
      var data = sheet.getDataRange().getValues();
      if (data.length <= 1) return; 
  
      markdown += '## 📑 Tab: ' + sheet.getName() + '\n\n';
      
      data.forEach(function(row, index) {
        var cleanRow = row.map(function(cell) {
          if (cell instanceof Date) return Utilities.formatDate(cell, 'America/New_York', 'yyyy-MM-dd');
          if (cell === null || cell === undefined || cell === '') return '—';
          return String(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
        });
  
        markdown += '| ' + cleanRow.join(' | ') + ' |\n';
        if (index === 0) {
          var separator = row.map(function() { return '---'; });
          markdown += '| ' + separator.join(' | ') + ' |\n';
        }
      });
      markdown += '\n';
    });
    return markdown;
  }
  
  /**
   * Extracts raw Google Document copy into a clean structural Markdown file.
   * @private
   */
  function parseDocumentLayers_(doc) {
    var body = doc.getBody();
    var markdown = '# 📄 Document Context Snapshot: ' + doc.getName() + '\n\n';
    markdown += 'Parsed text content:\n\n';
    markdown += body.getText();
    return markdown;
  }
  
  /**
   * Safely saves the compiled file string, over-writing obsolete versions.
   * Uses exponential backoff retry to handle transient Drive failures.
   * @private
   */
  function saveMarkdownSnapshot_(folder, fileName, content) {
    callWithRetry_(function() {
      var existingFiles = folder.getFilesByName(fileName);
      while (existingFiles.hasNext()) {
        existingFiles.next().setTrashed(true);
      }
      folder.createFile(fileName, content, MimeType.PLAIN_TEXT);
      console.log('[DriveCrawler] Synced snapshot instance: %s', fileName);
    }, 'saveMarkdownSnapshot_(' + fileName + ')');
  }