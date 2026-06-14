/**
 * SellerboardFetcher — Daily CSV data fetcher for Sellerboard
 *
 * Fetches a CSV file from a configurable daily link (typically a pre-signed
 * S3 URL or similar), parses the tabular data, extracts the latest row
 * (yesterday's finalized numbers), and returns a Markdown-formatted
 * summary table.
 *
 * Exports:
 *   fetchSellerboardDaily() — Returns Markdown string or null
 */

/**
 * Fetch and parse the daily Sellerboard CSV snapshot.
 *
 * @returns {string|null} — Markdown summary, or null on failure / empty
 */
function fetchSellerboardDaily() {
  var csvUrl = PropertiesService.getScriptProperties().getProperty('SELLERBOARD_DAILY_LINK');
  if (!csvUrl) {
    console.warn('[SellerboardFetcher] SELLERBOARD_DAILY_LINK not set in ScriptProperties — skipping');
    return null;
  }

  var response = UrlFetchApp.fetch(csvUrl, {
    muteHttpExceptions: true
  });

  var httpCode = response.getResponseCode();
  if (httpCode < 200 || httpCode >= 300) {
    console.error('[SellerboardFetcher] CSV endpoint returned %s', httpCode);
    return null;
  }

  var csvText = response.getContentText();
  if (!csvText || csvText.length === 0) {
    console.warn('[SellerboardFetcher] Empty CSV response');
    return null;
  }

  // Split into rows
  var rows = csvText.split('\n');
  if (rows.length < 2) {
    console.warn('[SellerboardFetcher] CSV has no data rows (only %d lines)', rows.length);
    return null;
  }

  // Parse header row
  var headers = parseCSVLine_(rows[0]);
  if (headers.length === 0) {
    console.warn('[SellerboardFetcher] CSV has empty header row');
    return null;
  }

  // Find the latest (last non-empty) data row
  var latestRow = null;
  for (var i = rows.length - 1; i >= 1; i--) {
    var trimmed = rows[i].trim();
    if (trimmed.length > 0) {
      latestRow = parseCSVLine_(trimmed);
      if (latestRow.length > 0) break;
    }
  }

  if (!latestRow) {
    console.warn('[SellerboardFetcher] No non-empty data rows found');
    return null;
  }

  // Build Markdown
  var now = new Date();
  var tz = 'America/New_York';
  var timestamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss') + ' ET';

  var lines = [];
  lines.push('### \ud83d\udcc8 Sellerboard Sync \u2014 ' + timestamp);
  lines.push('');
  lines.push('- **Source:** Sellerboard (polled CSV)');
  lines.push('- **Columns:** ' + headers.length);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');

  for (var j = 0; j < headers.length && j < latestRow.length; j++) {
    var metricName = headers[j].trim();
    var metricValue = latestRow[j].trim();
    lines.push('| ' + metricName + ' | ' + metricValue + ' |');
  }

  lines.push('');
  lines.push('---');
  console.log('[SellerboardFetcher] Parsed latest CSV row with %d fields', latestRow.length);
  return lines.join('\n');
}

/**
 * Simple CSV line parser — handles quoted fields.
 * @param {string} line
 * @returns {string[]}
 */
function parseCSVLine_(line) {
  var result = [];
  var current = '';
  var inQuotes = false;

  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
