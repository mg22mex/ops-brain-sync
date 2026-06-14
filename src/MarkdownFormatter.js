/**
 * MarkdownFormatter — Text-to-Markdown converter
 *
 * Takes raw extracted content and metadata, strips residual noise,
 * and produces clean Markdown with structured headers, bullets, and
 * an explicit timestamp in America/New_York timezone.
 */

/**
 * Build a Markdown block from parsed payload data.
 * @param {{ source: string, content: string, metadata: Object }} parsed
 * @returns {string} — Formatted Markdown string ready for doc append
 */
function formatAsMarkdown(parsed) {
  var lines = [];
  var now = new Date();
  var tz = 'America/New_York';
  var timestamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm:ss') + ' ET';

  // --- Section header ---
  lines.push('### \u2705 Inbound Webhook  \u2014 ' + timestamp);
  lines.push('');

  // --- Source badge ---
  var sourceLabel = parsed.source.charAt(0).toUpperCase() + parsed.source.slice(1);
  lines.push('- **Source:** ' + sourceLabel);
  lines.push('');

  // --- Metadata block (source-specific) ---
  appendMetadata(lines, parsed.source, parsed.metadata);
  lines.push('');

  // --- The cleaned content ---
  lines.push('---');
  lines.push('');
  lines.push(formatContentBody(parsed.content));
  lines.push('');
  lines.push('---');

  return lines.join('\n');
}

/**
 * Append source-specific metadata lines.
 * @param {string[]} lines
 * @param {string} source
 * @param {Object} meta
 */
function appendMetadata(lines, source, meta) {
  switch (source) {
    case 'slack':
      lines.push('- **User:** `' + escapeMd(meta.user) + '`');
      lines.push('- **Channel:** `' + escapeMd(meta.channel) + '`');
      if (meta.channelType) lines.push('- **Channel Type:** ' + meta.channelType);
      if (meta.eventType) lines.push('- **Event:** ' + meta.eventType);
      break;

    case 'fathom':
      lines.push('- **Recording:** ' + escapeMd(meta.title));
      if (meta.url) lines.push('- **URL:** ' + meta.url);
      if (meta.durationSec) {
        var mins = Math.round(meta.durationSec / 60);
        lines.push('- **Duration:** ' + mins + ' min');
      }
      if (meta.recordedAt) lines.push('- **Recorded:** ' + meta.recordedAt);
      break;

    case 'triplewhale':
      lines.push('- **Event:** ' + escapeMd(meta.eventType));
      lines.push('- **Shop:** ' + escapeMd(meta.shop));
      if (meta.receivedAt) lines.push('- **Received:** ' + meta.receivedAt);
      break;

    case 'sellerboard':
      if (meta.period) lines.push('- **Period:** ' + escapeMd(meta.period));
      if (meta.receivedAt) lines.push('- **Received:** ' + meta.receivedAt);
      break;

    default:
      // Unknown source — dump metadata keys inline if any exist
      for (var key in meta) {
        if (meta.hasOwnProperty(key)) {
          lines.push('- **' + key + ':** ' + escapeMd(String(meta[key])));
        }
      }
      break;
  }
}

/**
 * Format the body text: detect if it's already structured (has line breaks,
 * bullet-like markers) or is a single paragraph.
 * @param {string} content
 * @returns {string}
 */
function formatContentBody(content) {
  if (!content || content.length === 0) {
    return '*[Empty content]*';
  }

  // If multi-line or contains list-like syntax, preserve structure
  if (content.indexOf('\n') !== -1 || /^[\s]*[-*\d]/.test(content)) {
    return content;
  }

  // Single paragraph — wrap at ~100 chars by inserting line breaks
  return wordWrap(content, 100);
}

/**
 * Rough word-wrapping for long single-line text.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function wordWrap(text, maxLen) {
  var result = [];
  var words = text.split(' ');
  var line = '';

  for (var i = 0; i < words.length; i++) {
    if ((line + ' ' + words[i]).length > maxLen && line.length > 0) {
      result.push(line);
      line = words[i];
    } else if (line.length === 0) {
      line = words[i];
    } else {
      line += ' ' + words[i];
    }
  }
  if (line.length > 0) result.push(line);
  return result.join('\n');
}

/**
 * Escape Markdown special characters in user-supplied strings to prevent
 * accidental formatting corruption.
 * @param {string} str
 * @returns {string}
 */
function escapeMd(str) {
  return String(str).replace(/([*_`~\[\]()#!])/g, '\\$1');
}
