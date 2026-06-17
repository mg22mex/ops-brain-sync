/**
 * FathomFetcher — Gmail-based Fathom notification processing + API polling fallback
 * ==================================================================================
 * Primary path: searches Gmail for Fathom "Recap for" notification emails, processes
 * them in batches with label-based dedup, and appends formatted content to the
 * target document. Falls back to direct API polling for comprehensive coverage.
 */

/**
 * Process Fathom notification emails via Gmail with label-based dedup.
 * Searches for unprocessed Fathom recap emails, extracts content,
 * appends to the target doc, then marks with 'Processed-Fathom' label.
 */
function processFathomEmails() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    console.warn('[FathomFetcher] Lock busy — skipping email processing cycle');
    return;
  }

  try {
    // Ensure the tracking label exists (idempotent — create only if missing)
    var label;
    try {
      label = GmailApp.getUserLabelByName('Processed-Fathom');
      if (!label) {
        label = GmailApp.createLabel('Processed-Fathom');
      }
    } catch (labelErr) {
      console.warn('[FathomFetcher] Could not get/create label: %s', labelErr.message);
      return;
    }

    // Search for unprocessed Fathom recap threads, max 10 per execution
    var query = 'subject:"Recap for" -label:Processed-Fathom';
    var threads = GmailApp.search(query, 0, 10);

    if (threads.length === 0) {
      console.log('[FathomFetcher] No unprocessed Fathom recap emails found.');
      return;
    }

    console.log('[FathomFetcher] Found %d unprocessed Fathom thread(s)', threads.length);

    var targetDocId = PropertiesService.getScriptProperties().getProperty('TARGET_DOC_ID');
    if (!targetDocId) {
      console.error('[FathomFetcher] TARGET_DOC_ID not set — cannot append');
      return;
    }

    var processedCount = 0;

    for (var t = 0; t < threads.length; t++) {
      var thread = threads[t];
      var messages = thread.getMessages();

      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];

        // Confirm the message is actually from Fathom
        if (msg.getFrom().indexOf('fathom.video') === -1 &&
            msg.getFrom().indexOf('fathom') === -1) {
          continue;
        }

        var bodyContent = msg.getPlainBody();
        if (!bodyContent || bodyContent.length === 0) continue;

        // Truncate oversized transcripts to stay within document bloat guard
        if (bodyContent.length > 15000) {
          bodyContent = bodyContent.substring(0, 15000) +
            '\n\n...[Transcript truncated for size safety]...';
        }

        var payload = {
          source: 'fathom',
          content: bodyContent,
          metadata: { title: msg.getSubject() }
        };
        var markdown = formatAsMarkdown(payload);

        try {
          var docId = safeCheckAndRollover_(targetDocId);
          appendToDoc(docId, markdown);
          processedCount++;
          console.log('[FathomFetcher] Processed message: %s', msg.getSubject());
        } catch (appendErr) {
          console.error('[FathomFetcher] Failed to append message "%s": %s',
            msg.getSubject(), appendErr.message);
          // Skip this message but continue with others
          continue;
        }
      }

      // Apply the Processed-Fathom label to the entire thread
      try {
        thread.addLabel(label);
      } catch (labelErr) {
        console.warn('[FathomFetcher] Could not apply label to thread: %s', labelErr.message);
      }
    }

    console.log('[FathomFetcher] Cycle complete. Processed %d message(s) from %d thread(s).',
      processedCount, threads.length);

  } catch (err) {
    console.error('[FathomFetcher] Email processing error: %s', err.message);
  } finally {
    lock.releaseLock();
  }
}

/**
 * API polling fallback — fetches recent meetings directly from Fathom API.
 * Used as a secondary path to catch anything the email-based approach misses.
 *
 * @returns {string|null} — Joined Markdown string, or null on failure/empty
 */
function fetchRecentMeetings() {
  var FATHOM_API_BASE = 'https://api.fathom.ai/external/v1/meetings';
  var apiKey = PropertiesService.getScriptProperties().getProperty('FATHOM_API_KEY');

  if (!apiKey) {
    console.warn('[FathomFetcher] FATHOM_API_KEY not set — skipping API poll');
    return null;
  }

  // 48-hour lookback window
  var lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - 2);
  var afterTimestamp = lookbackDate.toISOString();
  var pollingUrl = FATHOM_API_BASE + '?after=' + encodeURIComponent(afterTimestamp);

  console.log('[FathomFetcher] API polling URL: %s', pollingUrl);

  try {
    var response = UrlFetchApp.fetch(pollingUrl, {
      method: 'get',
      headers: {
        'X-Api-Key': apiKey,
        'Accept': 'application/json'
      },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() !== 200) {
      console.error('[FathomFetcher] API returned %s', response.getResponseCode());
      return null;
    }

    var data = JSON.parse(response.getContentText());
    var meetings = data.meetings || data.data || data || [];

    if (!Array.isArray(meetings) || meetings.length === 0) {
      console.log('[FathomFetcher] No meetings in lookback window');
      return null;
    }

    console.log('[FathomFetcher] Found %d meeting(s) via API', meetings.length);

    var collectiveMarkdown = [];
    for (var i = 0; i < meetings.length; i++) {
      var mtg = meetings[i];
      var contentBody = mtg.summary || mtg.summary_markdown || mtg.transcript || '*[No summary]*';

      if (contentBody.length > 15000) {
        contentBody = contentBody.substring(0, 15000) +
          '\n\n...[Transcript truncated for size safety]...';
      }

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
      collectiveMarkdown.push(formatAsMarkdown(intermediatePayload));
    }

    return collectiveMarkdown.join('\n\n---\n\n');

  } catch (urlErr) {
    console.error('[FathomFetcher] API fetch error: %s', urlErr.message);
    return null;
  }
}
