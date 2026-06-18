/**
 * WeeklyReporter — Document-to-Slack reporting system
 * ===================================================
 * Reads the target Google Doc for "Next Steps -" sections,
 * resolves Slack user IDs to display names using the central
 * team roster (from Code.js), and posts formatted Slack
 * Block Kit messages to a configured webhook URL.
 *
 * Script Property required:
 *   SLACK_WEBHOOK_URL — Incoming webhook URL for Slack workspace
 *
 * Falls back to DEFAULT_TARGET_DOC_ID from Code.js if no
 * TARGET_DOC_ID is set in Script Properties.
 */

var NEXT_STEPS_HEADER_RE = /^#{1,3}\s+Next Steps\s*-\s*(.+)/i;
var SECTION_BOUNDARY_RE = /^#{1,3}\s+|^---\s*$/;

/**
 * Max Slack block payload size — Slack soft limit is ~3000 chars
 * per block text field. We stay well under.
 */
var SLACK_MAX_BLOCK_TEXT = 2800;

/**
 * Entry point: find all "Next Steps -" blocks in the target doc
 * and post each as a separate Slack message.
 *
 * Intended to be called from a time-driven trigger or run manually.
 */
function postWeeklyReport() {
  // --- Resolve target document ---
  var docId = PropertiesService.getScriptProperties().getProperty('TARGET_DOC_ID')
    || (typeof DEFAULT_TARGET_DOC_ID !== 'undefined' ? DEFAULT_TARGET_DOC_ID : null);

  if (!docId) {
    console.error('[WeeklyReporter] No TARGET_DOC_ID found — aborting.');
    return;
  }

  // --- Open doc and read body text ---
  var doc;
  try {
    doc = DocumentApp.openById(docId);
  } catch (e) {
    console.error('[WeeklyReporter] Cannot open document %s: %s', docId, e.message);
    return;
  }

  var bodyText = doc.getBody().getText();

  // --- Parse "Next Steps -" blocks ---
  var blocks = parseNextStepsBlocks_(bodyText);

  if (blocks.length === 0) {
    console.log('[WeeklyReporter] No "Next Steps -" sections found in document.');
    return;
  }

  // --- Resolve webhook URL ---
  var webhookUrl = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!webhookUrl) {
    console.error('[WeeklyReporter] SLACK_WEBHOOK_URL not set in Script Properties — aborting.');
    return;
  }

  // --- Post each block to Slack ---
  var posted = 0;
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];

    // Resolve Slack user IDs in header and content
    var resolvedHeader = cleanSlackUserMentions(block.header);
    var resolvedContent = cleanSlackUserMentions(block.content);

    var slackPayload = buildSlackBlocks_(resolvedHeader, resolvedContent);

    try {
      var response = UrlFetchApp.fetch(webhookUrl, {
        method: 'POST',
        contentType: 'application/json',
        payload: JSON.stringify(slackPayload),
        muteHttpExceptions: true
      });

      var statusCode = response.getResponseCode();
      if (statusCode >= 200 && statusCode < 300) {
        console.log('[WeeklyReporter] Posted "%s" — HTTP %d', resolvedHeader, statusCode);
        posted++;
      } else {
        console.warn('[WeeklyReporter] Slack returned HTTP %d for "%s": %s',
          statusCode, resolvedHeader, response.getContentText());
      }
    } catch (e) {
      console.error('[WeeklyReporter] Failed to post "%s": %s', resolvedHeader, e.message);
    }
  }

  console.log('[WeeklyReporter] Done — %d / %d "Next Steps -" sections posted to Slack.', posted, blocks.length);
}

/**
 * Parse the document body text and extract blocks under "Next Steps -" headers.
 *
 * A block starts at a line matching NEXT_STEPS_HEADER_RE and continues
 * until the next Markdown heading (###) or section separator (---).
 *
 * @param {string} bodyText — Full document body text
 * @returns {Array.<{header: string, content: string, lines: string[]}>}
 */
function parseNextStepsBlocks_(bodyText) {
  var rawLines = bodyText.split('\n');
  var results = [];
  var currentHeader = null;
  var currentLines = [];

  for (var i = 0; i < rawLines.length; i++) {
    var line = rawLines[i];
    var headerMatch = line.match(NEXT_STEPS_HEADER_RE);

    if (headerMatch) {
      // Save previous block if one was being collected
      if (currentHeader !== null && currentLines.length > 0) {
        results.push({
          header: currentHeader,
          content: currentLines.join('\n').replace(/^\s+|\s+$/g, ''),
          lines: currentLines.slice()
        });
      }

      // Start new block
      currentHeader = headerMatch[1].replace(/^\s+|\s+$/g, '');
      currentLines = [];
    } else if (currentHeader !== null) {
      // Check if we hit a section boundary (new heading or divider)
      if (SECTION_BOUNDARY_RE.test(line) && currentLines.length > 0) {
        // Check if next non-empty line is a Next Steps header
        var nextNonEmpty = findNextNonEmpty_(rawLines, i + 1);
        if (nextNonEmpty !== null && NEXT_STEPS_HEADER_RE.test(rawLines[nextNonEmpty])) {
          // End current block — the boundary belongs to the next section
          results.push({
            header: currentHeader,
            content: currentLines.join('\n').replace(/^\s+|\s+$/g, ''),
            lines: currentLines.slice()
          });
          currentHeader = null;
          currentLines = [];
        }
        // Otherwise keep collecting (boundary is within the block content)
        // Only skip pure separator lines
        if (/^---\s*$/.test(line)) {
          // Skip pure divider lines within block
          continue;
        }
        currentLines.push(line);
      } else {
        currentLines.push(line);
      }
    }
  }

  // Flush last block
  if (currentHeader !== null && currentLines.length > 0) {
    results.push({
      header: currentHeader,
      content: currentLines.join('\n').replace(/^\s+|\s+$/g, ''),
      lines: currentLines.slice()
    });
  }

  return results;
}

/**
 * Find the next non-empty line index starting from `fromIndex`.
 * @param {string[]} lines
 * @param {number} fromIndex
 * @returns {number|null}
 */
function findNextNonEmpty_(lines, fromIndex) {
  for (var j = fromIndex; j < lines.length; j++) {
    if (lines[j].replace(/^\s+|\s+$/g, '') !== '') {
      return j;
    }
  }
  return null;
}

/**
 * Build a Slack Block Kit payload for a single "Next Steps -" section.
 *
 * @param {string} header — The section title (e.g. "Marco Gastelum")
 * @param {string} content — The body text of the section
 * @returns {{ blocks: Object[] }}
 */
function buildSlackBlocks_(header, content) {
  var slackBlocks = [];

  // --- Header block ---
  slackBlocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: ':memo: Next Steps - ' + header,
      emoji: true
    }
  });

  // --- Content section ---
  // Slack mrkdwn has a ~3000 char limit per text field; truncate if needed
  var displayText = content;
  if (displayText.length > SLACK_MAX_BLOCK_TEXT) {
    displayText = displayText.substring(0, SLACK_MAX_BLOCK_TEXT - 3) + '...';
  }

  if (displayText.replace(/^\s+|\s+$/g, '').length > 0) {
    slackBlocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: displayText
      }
    });
  }

  // --- Context footer with timestamp ---
  var now = new Date();
  var tz = 'America/New_York';
  var timestamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm') + ' ET';
  slackBlocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: ':calendar: Extracted from ops-brain-sync doc \u2022 ' + timestamp
      }
    ]
  });

  return { blocks: slackBlocks };
}
