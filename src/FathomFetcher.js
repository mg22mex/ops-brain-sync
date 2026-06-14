/**
 * FathomFetcher — Outbound polling for Fathom meetings
 *
 * Polls the Fathom REST API for completed meetings, deduplicates against
 * previously processed meeting IDs (stored in ScriptProperties), and
 * returns a Markdown-formatted summary ready for doc append.
 *
 * Exports:
 *   fetchRecentMeetings() — Returns Markdown string or null
 */

var FATHOM_API_BASE = 'https://api.fathom.video/v1/meetings';

/**
 * Fetch recent meetings from Fathom, filtering out already-processed IDs.
 *
 * @returns {string|null} — Markdown block, or null if nothing new
 */
function fetchRecentMeetings() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('FATHOM_API_KEY');
  if (!apiKey) {
    console.warn('[FathomFetcher] FATHOM_API_KEY not set in ScriptProperties — skipping');
    return null;
  }

  var processedJson = PropertiesService.getScriptProperties().getProperty('FATHOM_PROCESSED_IDS');
  var processedIds = {};
  if (processedJson) {
    try { processedIds = JSON.parse(processedJson); } catch (e) { /* reset below */ }
  }
  if (typeof processedIds !== 'object' || processedIds === null) {
    processedIds = {};
  }

  var response = UrlFetchApp.fetch(FATHOM_API_BASE, {
    headers: {
      Authorization: 'Bearer ' + apiKey,
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  });

  var httpCode = response.getResponseCode();
  if (httpCode < 200 || httpCode >= 300) {
    console.error('[FathomFetcher] API returned %s: %s', httpCode, response.getContentText());
    return null;
  }

  var data = JSON.parse(response.getContentText());
  var meetings = data.meetings || data.data || [];
  if (!Array.isArray(meetings)) {
    meetings = [];
  }

  var newMeetings = [];
  for (var i = 0; i < meetings.length; i++) {
    var m = meetings[i];
    var id = m.id || m.meeting_id || '';
    if (id && !processedIds[id]) {
      newMeetings.push(m);
      processedIds[id] = true;
    }
  }

  if (newMeetings.length === 0) {
    console.log('[FathomFetcher] No new meetings to process');
    return null;
  }

  // Persist updated processed IDs
  PropertiesService.getScriptProperties().setProperty('FATHOM_PROCESSED_IDS', JSON.stringify(processedIds));

  // Build Markdown
  var lines = [];
  var now = new Date();
  var tz = 'America/New_York';
  var timestamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss') + ' ET';
  lines.push('### \uD83C\uDFA5 Fathom Sync \u2014 ' + timestamp);
  lines.push('');
  lines.push('- **Source:** Fathom (polled)');
  lines.push('- **New meetings:** ' + newMeetings.length);
  lines.push('');

  for (var j = 0; j < newMeetings.length; j++) {
    var meeting = newMeetings[j];
    var title = meeting.title || meeting.name || 'Untitled';
    var summary = meeting.summary || '';
    var url = meeting.url || '';
    var duration = meeting.duration || 0;
    var mins = Math.round(duration / 60);

    lines.push('---');
    lines.push('');
    lines.push('##### ' + (j + 1) + '. ' + title);
    if (url) lines.push('- **URL:** ' + url);
    if (mins > 0) lines.push('- **Duration:** ' + mins + ' min');
    if (summary) {
      lines.push('');
      lines.push(summary);
    }
    lines.push('');
  }

  lines.push('---');
  console.log('[FathomFetcher] Processed %d new meeting(s)', newMeetings.length);
  return lines.join('\n');
}
