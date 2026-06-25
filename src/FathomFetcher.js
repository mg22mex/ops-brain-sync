/**
 * FathomFetcher — Gmail-based Fathom notification processing + API polling fallback
 * ==================================================================================
 * Primary path: searches Gmail for Fathom "Recap for" notification emails, processes
 * them in batches with label-based dedup, and writes individual dated Markdown files
 * to the Fathom folder. Falls back to direct API polling for comprehensive coverage.
 *
 * Retention: Permanent (no cleanup cycle needed for Fathom logs).
 */

/**
 * Process Fathom notification emails via Gmail with label-based dedup.
 * Searches for unprocessed Fathom recap emails, extracts content,
 * writes individual files to the Fathom folder, then marks with
 * 'Processed-Fathom' label.
 */
function processFathomEmails() {
  var lock = LockService.getScriptLock();
  var lockHeld = false;

  try {
    lock.waitLock(30000);
    lockHeld = true;
  } catch (e) {
    console.warn('[FathomFetcher] Lock busy — skipping email processing cycle');
    return;
  }

  try {
    var startTime = new Date().getTime();
    var TIME_LIMIT_MS = 300000;
    var BATCH_SIZE = 5;

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

    var query = 'from:fathom (subject:"Recap for" OR subject:"Recap of your meeting") -label:Processed-Fathom';
    var threads = GmailApp.search(query, 0, BATCH_SIZE);
    var elapsedMs = new Date().getTime() - startTime;
    console.log('[FathomFetcher] GmailApp.search returned in %dms, found %d thread(s)', elapsedMs, threads.length);
    if (elapsedMs > TIME_LIMIT_MS) {
      console.warn('[FathomFetcher] TIME LIMIT EXCEEDED after GmailApp.search (%dms)', elapsedMs);
      return;
    }

    if (threads.length === 0) {
      console.log('[FathomFetcher] No unprocessed Fathom recap emails found.');
      return;
    }

    console.log('[FathomFetcher] Found %d unprocessed Fathom thread(s)', threads.length);

    var fathomFolderId = PropertiesService.getScriptProperties().getProperty('FATHOM_FOLDER_ID')
      || DEFAULT_FATHOM_FOLDER_ID;

    var processedCount = 0;
    var threadsChecked = 0;
    var now = new Date();
    var tz = 'America/New_York';
    var dateStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

    for (var t = 0; t < threads.length; t++) {
      var elapsedOuter = new Date().getTime() - startTime;
      if (elapsedOuter > TIME_LIMIT_MS) {
        console.warn('[FathomFetcher] TIME LIMIT EXCEEDED at loop top (%dms / %dms cap) — ' +
          'exiting after %d processed, thread %d/%d',
          elapsedOuter, TIME_LIMIT_MS, processedCount, t + 1, threads.length);
        break;
      }

      var thread = threads[t];
      var messages = thread.getMessages();
      var elapsedGs = new Date().getTime() - startTime;
      if (elapsedGs > TIME_LIMIT_MS) {
        console.warn('[FathomFetcher] TIME LIMIT EXCEEDED after getMessages() (%dms, thread %d/%d)',
          elapsedGs, t + 1, threads.length);
        break;
      }

      for (var m = 0; m < messages.length; m++) {
        if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
          console.log('[FathomFetcher] Time limit reached during message processing — exiting');
          break;
        }

        try {
          var msg = messages[m];

          if (msg.getFrom().indexOf('fathom.video') === -1 &&
              msg.getFrom().indexOf('fathom') === -1) {
            continue;
          }

          // Atomic dedup: skip if this message ID is already in the registry
          var msgId = msg.getId();
          if (isMessageProcessed_(msgId)) {
            console.log('[FathomFetcher] Skipping already-processed message %s: %s', msgId, msg.getSubject());
            continue;
          }

          var bodyContent = msg.getPlainBody();
          var elapsedBody = new Date().getTime() - startTime;
          if (elapsedBody > TIME_LIMIT_MS) {
            console.warn('[FathomFetcher] TIME LIMIT EXCEEDED after getPlainBody() (%dms, thread %d/%d)',
              elapsedBody, t + 1, threads.length);
            break;
          }
          if (!bodyContent || bodyContent.length === 0) continue;

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

          var subject = msg.getSubject() || 'Fathom_Meeting';
          var safeSubject = subject.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 60);
          var fileName = dateStr + '_Fathom_' + safeSubject + '.md';
          createNewDriveFile(fathomFolderId, fileName, markdown);
          markMessageProcessed_(msgId);

          processedCount++;
          console.log('[FathomFetcher] Processed message: %s → %s', msg.getSubject(), fileName);
        } catch (msgErr) {
          console.error('[FathomFetcher] Failed to process message: %s', msgErr.message);
          continue;
        }
      }

      if (new Date().getTime() - startTime > TIME_LIMIT_MS) {
        console.log('[FathomFetcher] Time limit reached — skipping label for remaining threads');
        break;
      }

      try {
        thread.addLabel(label);
      } catch (labelErr) {
        console.warn('[FathomFetcher] Could not apply label to thread: %s', labelErr.message);
      }

      threadsChecked++;
    }

    console.log('[FathomFetcher] Cycle complete. Processed %d message(s) across %d thread(s) (batch cap: %d).',
      processedCount, threadsChecked, BATCH_SIZE);

  } catch (err) {
    console.error('[FathomFetcher] Email processing error: %s', err.message);
  } finally {
    if (lockHeld) {
      lock.releaseLock();
      console.log('[FathomFetcher] Lock released');
    }
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
