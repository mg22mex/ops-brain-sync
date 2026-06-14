/**
 * WebhookParser — Payload router and content extractor
 *
 * Detects the webhook source (Slack, Fathom, Triple Whale, Sellerboard)
 * from the JSON shape, extracts the meaningful message content, and
 * discards system metadata noise.
 */

/**
 * Route an incoming JSON payload to the correct parser.
 * @param {Object} data — Parsed JSON from postData.contents
 * @returns {{ source: string, content: string, metadata: Object }}
 */
function parsePayload(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid payload: expected a JSON object');
  }

  // Slack Events API — shaped by 'event' + 'team_id'
  if (data.event && data.team_id) {
    return parseSlackPayload(data);
  }

  // Fathom — shaped by 'event' + 'recording' keys
  if (data.event && data.recording) {
    return parseFathomPayload(data);
  }

  // Triple Whale — shaped by 'event_type' (e.g. "shop.daily") + 'data' + 'shop'
  if (data.event_type && data.data) {
    return parseTripleWhalePayload(data);
  }

  // Sellerboard — shaped by 'source' === 'sellerboard' or event name
  if (data.source === 'sellerboard' || data.event === 'sellerboard_daily') {
    return parseSellerboardPayload(data);
  }

  // Generic fallback — extract whatever top-level text we can find
  return parseGenericPayload(data);
}

/**
 * Parse a Slack Events API payload.
 * @param {Object} data
 * @returns {{ source: string, content: string, metadata: Object }}
 */
function parseSlackPayload(data) {
  var event = data.event || {};
  var text = event.text || '';
  var user = event.user || 'unknown';
  var channel = event.channel || 'unknown';
  var threadTs = event.thread_ts || event.ts || '';
  var channelType = event.channel_type || 'unknown';

  return {
    source: 'slack',
    content: cleanText(text),
    metadata: {
      user: user,
      channel: channel,
      channelType: channelType,
      threadTimestamp: threadTs,
      teamId: data.team_id || '',
      eventType: event.type || 'unknown'
    }
  };
}

/**
 * Parse a Fathom webhook payload (recording.completed, etc.).
 * @param {Object} data
 * @returns {{ source: string, content: string, metadata: Object }}
 */
function parseFathomPayload(data) {
  var recording = data.recording || {};
  var title = recording.title || 'Untitled Recording';
  var summary = recording.summary || '';
  var transcript = recording.transcript || '';
  var url = recording.url || '';
  var duration = recording.duration || 0;
  var recordedAt = recording.date || recording.recorded_at || '';

  // Prefer summary; fall back to a truncated transcript
  var content = summary || transcript;
  if (!content) {
    content = '[No transcript or summary available]';
  }

  return {
    source: 'fathom',
    content: cleanText(content),
    metadata: {
      title: title,
      url: url,
      durationSec: duration,
      recordedAt: recordedAt
    }
  };
}

/**
 * Parse a Triple Whale webhook payload (shop.daily, ad.spend, etc.).
 * @param {Object} data
 * @returns {{ source: string, content: string, metadata: Object }}
 */
function parseTripleWhalePayload(data) {
  var eventType = data.event_type || 'unknown';
  var shop = data.shop || data.shop_domain || 'unknown';
  var payload = data.data || {};

  // Flatten the nested data object into readable key: value lines
  var contentLines = [];
  for (var key in payload) {
    if (payload.hasOwnProperty(key)) {
      contentLines.push(key + ': ' + String(payload[key]));
    }
  }
  var content = contentLines.length > 0
    ? contentLines.join('\n')
    : JSON.stringify(payload);

  return {
    source: 'triplewhale',
    content: cleanText(content),
    metadata: {
      eventType: eventType,
      shop: shop,
      receivedAt: new Date().toISOString()
    }
  };
}

/**
 * Parse a Sellerboard notification payload.
 * @param {Object} data
 * @returns {{ source: string, content: string, metadata: Object }}
 */
function parseSellerboardPayload(data) {
  var message = data.message || data.text || '';
  var period = data.period || data.date || '';
  var metrics = data.metrics || {};

  var contentLines = [];
  contentLines.push('Period: ' + period);
  if (message) contentLines.push('Message: ' + message);
  for (var key in metrics) {
    if (metrics.hasOwnProperty(key)) {
      contentLines.push(key + ': ' + String(metrics[key]));
    }
  }
  var content = contentLines.length > 0
    ? contentLines.join('\n')
    : JSON.stringify(data);

  return {
    source: 'sellerboard',
    content: cleanText(content),
    metadata: {
      period: period,
      receivedAt: new Date().toISOString()
    }
  };
}

/**
 * Generic fallback parser — extracts top-level text, message, or body fields.
 * @param {Object} data
 * @returns {{ source: string, content: string, metadata: Object }}
 */
function parseGenericPayload(data) {
  var content = data.text || data.message || data.body || data.content || JSON.stringify(data);
  return {
    source: 'unknown',
    content: cleanText(String(content)),
    metadata: {}
  };
}

/**
 * Strip excess whitespace, null bytes, and control characters from raw text.
 * @param {string} raw
 * @returns {string}
 */
function cleanText(raw) {
  return String(raw)
    .replace(/\0/g, '')           // Remove null bytes
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // Strip non-printing controls
    .replace(/\r\n/g, '\n')       // Normalize line endings
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')     // Trim trailing whitespace per line
    .replace(/\n{3,}/g, '\n\n')   // Collapse excessive blank lines
    .trim();
}
