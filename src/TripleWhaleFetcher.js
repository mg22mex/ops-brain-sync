/**
 * TripleWhaleFetcher — Outbound polling for Triple Whale analytics
 *
 * Polls the Triple Whale API for store performance data (daily revenue,
 * ad spend, ROAS, etc.) and returns a Markdown-formatted summary.
 *
 * Exports:
 *   fetchTripleWhalePerformance() — Returns Markdown string or null
 */

var TRIPLE_WHALE_API_BASE = 'https://api.triplewhale.com/api/v1';

/**
 * Fetch store performance data from Triple Whale.
 *
 * @returns {string|null} — Markdown block, or null on failure / empty
 */
function fetchTripleWhalePerformance() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('TRIPLE_WHALE_API_KEY');
  if (!apiKey) {
    console.warn('[TripleWhaleFetcher] TRIPLE_WHALE_API_KEY not set in ScriptProperties — skipping');
    return null;
  }

  // Build date range: yesterday
  var now = new Date();
  var tz = 'America/New_York';
  var endDate = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  var startStr = Utilities.formatDate(startDate, tz, 'yyyy-MM-dd');

  var url = TRIPLE_WHALE_API_BASE + '/analytics/dashboard?'
    + 'start_date=' + startStr + '&end_date=' + endDate;

  var response = UrlFetchApp.fetch(url, {
    headers: {
      'X-API-KEY': apiKey,
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });

  var httpCode = response.getResponseCode();
  if (httpCode < 200 || httpCode >= 300) {
    console.error('[TripleWhaleFetcher] API returned %s: %s', httpCode, response.getContentText());
    return null;
  }

  var data = JSON.parse(response.getContentText());
  var metrics = data.metrics || data.data || {};

  // Check for meaningful data
  var keys = Object.keys(metrics);
  if (keys.length === 0) {
    console.log('[TripleWhaleFetcher] No performance data returned');
    return null;
  }

  // Build Markdown
  var lines = [];
  var timestamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss') + ' ET';
  lines.push('### \ud83d\udcca Triple Whale Sync \u2014 ' + timestamp);
  lines.push('');
  lines.push('- **Source:** Triple Whale (polled)');
  lines.push('- **Period:** ' + startStr + ' \u2014 ' + endDate);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');

  for (var i = 0; i < keys.length; i++) {
    var val = metrics[keys[i]];
    var display = typeof val === 'object' ? JSON.stringify(val) : String(val);
    lines.push('| ' + keys[i] + ' | ' + display + ' |');
  }

  lines.push('');
  lines.push('---');
  console.log('[TripleWhaleFetcher] Fetched %d metric(s)', keys.length);
  return lines.join('\n');
}
