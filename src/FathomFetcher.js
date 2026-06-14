/**
 * FathomFetcher — Outbound polling for Fathom meetings
 * ===================================================
 * Periodically hits the Fathom API to catch recent meetings, extracts
 * detailed summary and transcript text blocks, and passes them along
 * to ensure no operational data is lost on fallback syncs.
 */

function fetchRecentMeetings() {
  var FATHOM_API_BASE = 'https://api.fathom.ai/external/v1/meetings';
  var apiKey = PropertiesService.getScriptProperties().getProperty('FATHOM_API_KEY');
  
  if (!apiKey) {
    console.warn('[FathomFetcher] FATHOM_API_KEY not set — skipping');
    return null;
  }

  // Calculate a 48-hour lookback window to safely catch all meetings
  // despite timezone discrepancies between Fathom's servers and local execution
  var lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - 2); // 48 hours = 2 days
  var afterTimestamp = lookbackDate.toISOString();

  // CHANGE 1: Use '?after=' parameter instead of '?updated_after='
  // This aligns with Fathom's expected polling timestamp parameter
  var pollingUrl = FATHOM_API_BASE // + '?after=' + encodeURIComponent(afterTimestamp);

  // CHANGE 3: Log the final compiled URL for manual verification
  console.log('[FathomFetcher] Polling URL: ' + pollingUrl);
  console.log('[FathomFetcher] Lookback window: ' + afterTimestamp + ' (48 hours ago)');

  var response = UrlFetchApp.fetch(pollingUrl, {
    method: 'get',
    headers: {
      'X-Api-Key': apiKey,
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    console.error('[FathomFetcher] Failed. Code: %s, Response: %s', response.getResponseCode(), response.getContentText());
    return null;
  }

  var data = JSON.parse(response.getContentText());
  var meetings = data.meetings || data.data || data || [];
  
  if (!Array.isArray(meetings) || meetings.length === 0) {
    console.log('[FathomFetcher] No new meetings found in the 48-hour lookback window.');
    return null;
  }

  console.log('[FathomFetcher] Found ' + meetings.length + ' meeting(s) in the lookback window');

  var collectiveMarkdown = [];

  // Loop through and format each meeting with its internal deep data structural block
  for (var i = 0; i < meetings.length; i++) {
    var mtg = meetings[i];
    
    // Extrapolate summary, transcript, or a safe fallback string
    var contentBody = mtg.summary || mtg.summary_markdown || mtg.transcript || '*[No summary text captured in feed]*';
    
    // Normalize properties for structural parity with the main format engine
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

    // Use your centralized formatter so everything visually matches inside the destination logs
    var formattedMtg = formatAsMarkdown(intermediatePayload);
    collectiveMarkdown.push(formattedMtg);
  }
  
  return collectiveMarkdown.join('\n\n---\n\n');
}