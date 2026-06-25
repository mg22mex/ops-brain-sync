/**
 * TripleWhaleFetcher — Outbound polling for e-commerce performance
 * ====================================================================
 * Periodically pulls conversion, spend, and blended revenue data from 
 * Triple Whale, flattens the response payload dynamically, and formats 
 * it into a structured Markdown table for NotebookLM context.
 */

function fetchTripleWhalePerformance() {
  var TRIPLE_WHALE_API_BASE = 'https://api.triplewhale.com/api/v2';
  var apiKey = PropertiesService.getScriptProperties().getProperty('TRIPLE_WHALE_API_KEY');
  var shopDomain = '4a3474-24.myshopify.com';

  if (!apiKey) {
    console.warn('[TripleWhaleFetcher] TRIPLE_WHALE_API_KEY not set — skipping');
    return null;
  }

  var now = new Date();
  var tz = 'America/New_York';
  var endDate = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  var startStr = Utilities.formatDate(startDate, tz, 'yyyy-MM-dd');

  var url = TRIPLE_WHALE_API_BASE + '/summary-page/get-data';

  // Core payload payload matching the Triple Whale API v2 schema requirements
  var payload = {
    "shopDomain": shopDomain,
    "period": {
      "start": startStr,
      "end": endDate
    }
  };

  var response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (netErr) {
    console.error('[TripleWhaleFetcher] Network error fetching API: %s', netErr.message);
    return null;
  }

  var httpCode = response.getResponseCode();
  if (httpCode !== 200) {
    console.error('[TripleWhaleFetcher] API returned %s: %s', httpCode, response.getContentText());
    return null;
  }

  var responseData;
  try {
    responseData = JSON.parse(response.getContentText());
  } catch (parseErr) {
    console.error('[TripleWhaleFetcher] Invalid JSON response: %s', parseErr.message);
    return null;
  }
  
  // Dynamically flatten the response object to find all data fields
  var flatMetrics = {};
  flattenObject_(responseData, '', flatMetrics);

  var lines = [
    '### 📊 Triple Whale Sync', 
    '', 
    '- **Shop Domain:** `' + shopDomain + '`',
    '- **Report Range:** ' + startStr + ' to ' + endDate,
    '',
    '| Metric / Property Path | Value |', 
    '|------------------------|-------|'
  ];
  
  var count = 0;
  for (var key in flatMetrics) {
    if (flatMetrics.hasOwnProperty(key)) {
      // Exclude echo variables to keep the document clean for the AI context
      if (key.indexOf('shopDomain') !== -1 || key.indexOf('period') !== -1) continue;
      
      lines.push('| ' + key + ' | ' + flatMetrics[key] + ' |');
      count++;
    }
  }

  if (count === 0) {
    console.warn('[TripleWhaleFetcher] 200 OK but no displayable metrics were extracted.');
    return null;
  }

  return lines.join('\n');
}

/**
 * Utility helper to recursively flatten nested API JSON structures
 * @private
 */
function flattenObject_(obj, prefix, result) {
  result = result || {};
  prefix = prefix || '';

  for (var key in obj) {
    if (!obj.hasOwnProperty(key)) continue;

    var propName = prefix ? prefix + '.' + key : key;
    
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      flattenObject_(obj[key], propName, result);
    } else if (Array.isArray(obj[key])) {
      result[propName] = obj[key].join(', ');
    } else {
      result[propName] = String(obj[key]);
    }
  }
}