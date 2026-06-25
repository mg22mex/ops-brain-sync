/**
 * WeeklyReporter — Google Doc section-parsed weekly digest for Slack
 * ==================================================================
 * Reads the target Google Doc for structured meeting sections, extracts
 * "Top 3 Takeaways:" bullets and "Action Items / Ownership:" content,
 * reverse-maps display names back to live Slack user tags, and posts
 * a single combined Block Kit payload to the configured webhook URL.
 *
 * Meetings are delimited by "Recording: Recap for" lines in the document.
 * Dates are extracted from Fathom content using "Month Day, Year" parsing
 * with ISO fallback. The weekly meeting list mirrors Google Calendar exactly;
 * Gmail and the ops doc supply recap bullets by meeting title only.
 * Spanish recaps are translated to English before posting.
 *
 * Runs every Monday (11:00 AM ET) via installWeeklyReportTrigger().
 * The digest covers the Mon–Sun week that just ended.
 *
 * Key protections against Slack HTTP 400 "invalid_blocks":
 *   - Strict chunk isolation (no cross-meeting text bleed)
 *   - Selective mrkdwn escaping (&, <, >) that preserves <@U...> mentions
 *   - Multi-block splitting at 2500-char safety ceiling
 *
 * Script Properties:
 *   SLACK_WEBHOOK_URL      — Incoming webhook URL for Slack workspace
 *   OPS_CALENDAR_ID        — Calendar ID (default: 'primary')
 *   OPS_CALENDAR_DEDICATED — 'true' if OPS_CALENDAR_ID is a team-only calendar
 *   OPS_REPORT_TZ          — Display timezone (default: calendar TZ, e.g. America/Mexico_City)
 *
 * TARGET_DOC_ID in Script Properties (set separately from pipeline config).
 */

// ---------------------------------------------------------------------------
// Global regex constants
// ---------------------------------------------------------------------------

/** Match a YYYY-MM-DD date anywhere in surrounding context. */
var ISO_DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/**
 * Extract the meeting name from a "Recap for ..." line.
 * Accepts straight quotes, curly quotes, or no quotes. Unanchored so it
 * works with Google Doc getText() output.
 *
 * False-positive body-text matches are handled by a later dedup pass
 * (same title + date + time are collapsed) and a max captured length of
 * 100 characters.
 */
var RECAP_TITLE_RE = /Recap for\s*["\u201C]?([^"\u201D\n]{1,100})["\u201D]?/i;

/** Fathom alternate subject: "Recap of your meeting with …" (title is in body). */
var RECAP_OF_MEETING_SUBJECT_RE = /Recap of your meeting/i;

/** "Meeting Purpose" section in Fathom basic/premium emails. */
var MEETING_PURPOSE_HEADER_RE = /Meeting\s*Purpose\s*:?\s*/i;

/**
 * "Key Takeaways" (Fathom English), "Puntos clave" (Fathom Spanish),
 * or "Top 3 Takeaways" (legacy).  Fathom format uses inline
 * dash-separated items in a paragraph; we match mid-line since there
 * is no line break before the header.
 */
var TOP3_HEADER_RE = /Key\s*Takeaways|Puntos\s*clave|Top\s*3\s*Takeaways/i;

/**
 * "Action Items / Ownership:" and "Topics" section marker.
 */
var ACTION_ITEMS_HEADER_RE = /Action\s*Items\s*\/\s*Ownership|Topics\s*:|Temas\s*:/i;

/** Bullet-prefixed lines (•, -, *). */
var BULLET_RE = /^[\s]*[\u2022\-*][\s]+/;

/** Default display timezone — overridden by OPS_REPORT_TZ or calendar TZ. */
var REPORT_TZ_DEFAULT_ = 'America/Mexico_City';

/**
 * When reading a shared/personal calendar (not dedicated), only include
 * events whose title matches one of these patterns.
 */
var OPS_MEETING_TITLE_PATTERNS = [
  /weekly kick-?off/i,
  /marco\/rick weekly/i,
  /^marco\/rick$/i,
  /product plan review/i,
  /marco\/rick product review/i,
  /bi-?weekly weatherman/i,
  /color talk/i,
  /bi-?weekly meeting.*weatherman/i
];

/** Skip personal blocks, holidays, and non-meeting calendar entries. */
var OPS_EVENT_EXCLUDE_PATTERNS = [
  /^ooo\b/i,
  /out of office/i,
  /focus time/i,
  /^lunch\b/i,
  /^break\b/i,
  /commute/i,
  /birthday/i,
  /holiday/i,
  /blocked/i,
  /do not book/i,
  /no meeting/i
];

/**
 * Fathom recording titles that refer to the same meeting as a calendar event.
 * Each inner array is one equivalence group (any pattern matching both sides = match).
 */
var TITLE_ALIAS_GROUPS = [
  [/product plan review/i, /marco\/rick product review/i],
  [/bi-?weekly weatherman\s*[-–]\s*meta\s*&\s*google/i, /weatherman.*meta.*google/i],
  [/bi-?weekly meeting\s*[-–]\s*weatherman\/nfi/i, /weatherman\/nfi/i]
];

/** Map of month names to two-digit month numbers for "Month Day, Year" parsing. */
var MONTH_NAMES_ = {
  'january': '01', 'february': '02', 'march': '03', 'april': '04',
  'may': '05', 'june': '06', 'july': '07', 'august': '08',
  'september': '09', 'october': '10', 'november': '11', 'december': '12'
};

/** Match "Month Day, Year" format (e.g., "June 12, 2026"). */
var MONTH_DAY_YEAR_RE = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/i;

/** Safety ceiling per Slack section block — well under the ~3000 hard cap. */
var SLACK_MAX_BLOCK_TEXT = 2500;

/**
 * Slack messages have an implicit ~50 block limit.  We cap at 45 to leave
 * room for the header, dividers, and context footer.
 */
var MAX_PAYLOAD_BLOCKS = 45;

// =========================================================================
// Main entry point
// =========================================================================

function postWeeklyReport() {
  var webhookUrl = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  var runStart = Date.now();

  try {
    postWeeklyReport_(webhookUrl, runStart);
  } catch (e) {
    console.error('[WeeklyReporter] Fatal error: %s\n%s', e.message, e.stack || '');
    if (webhookUrl) {
      postSlackAlert_(webhookUrl, ':warning: Weekly report crashed before posting: ' + e.message);
    }
  }
}

/**
 * Internal weekly report runner (wrapped by postWeeklyReport for error surfacing).
 *
 * @param {string|null} webhookUrl
 * @param {number} runStart — Date.now() at entry
 */
function postWeeklyReport_(webhookUrl, runStart) {
  var docId = PropertiesService.getScriptProperties().getProperty('TARGET_DOC_ID');

  if (!docId) {
    console.error('[WeeklyReporter] No TARGET_DOC_ID found — aborting.');
    return;
  }

  var doc;
  try {
    doc = DocumentApp.openById(docId);
  } catch (e) {
    console.error('[WeeklyReporter] Cannot open document %s: %s', docId, e.message);
    if (webhookUrl) postSlackAlert_(webhookUrl, ':warning: Weekly report: cannot open target doc.');
    return;
  }

  if (!webhookUrl) {
    console.error('[WeeklyReporter] SLACK_WEBHOOK_URL not set — aborting.');
    return;
  }

  console.log('[WeeklyReporter] Starting digest run…');
  var bodyText = doc.getBody().getText();

  var weekRange = getWeekRange_();
  var calendarEvents = fetchCalendarMeetings_(weekRange);
  var gmailRecaps = fetchGmailRecaps_(weekRange);
  var docRecaps = parseMeetings_(bodyText);
  var meetings = buildWeeklyMeetingList_(weekRange, calendarEvents, docRecaps, gmailRecaps, runStart);

  for (var mi = 0; mi < meetings.length; mi++) {
    if (meetings[mi].takeaways.length === 0) {
      console.warn('[WeeklyReporter] No recap matched: %s (%s) — Gmail pool had %d',
        meetings[mi].title, meetings[mi].date, gmailRecaps.length);
    }
  }

  if (meetings.length === 0) {
    console.log('[WeeklyReporter] No calendar meetings found for this week.');
    postSlackAlert_(webhookUrl, ':warning: Weekly report: no ops meetings on calendar this week.');
    return;
  }

  var payload = buildCombinedPayload_(meetings, weekRange);
  validateBlocks_(payload.blocks);

  var response = UrlFetchApp.fetch(webhookUrl, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var statusCode = response.getResponseCode();
  if (statusCode >= 200 && statusCode < 300) {
    console.log('[WeeklyReporter] Posted digest — %d meeting(s), HTTP %d, %dms',
      meetings.length, statusCode, Date.now() - runStart);
  } else {
    console.warn('[WeeklyReporter] Slack returned HTTP %d: %s',
      statusCode, response.getContentText());
    postSlackAlert_(webhookUrl,
      ':warning: Weekly report built but Slack rejected it (HTTP ' + statusCode + ').');
  }
}

/** Post a simple one-line alert to the Slack webhook (errors / empty weeks). */
function postSlackAlert_(webhookUrl, text) {
  try {
    UrlFetchApp.fetch(webhookUrl, {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify({ text: text }),
      muteHttpExceptions: true
    });
  } catch (e) {
    console.error('[WeeklyReporter] Could not post Slack alert: %s', e.message);
  }
}

// =========================================================================
// Parsing — strict chunk isolation via Recap-for line boundaries
// =========================================================================

/**
 * Split the full document body into meeting chunks using "Recording: Recap for"
 * lines as natural delimiters.  Each meeting block is STRICTLY bounded
 * between its own recap line and the next recap line — no sliding window
 * bleed from adjacent meetings.
 *
 * @param {string} bodyText
 * @returns {Array.<{title: string, date: string, time: string,
 *                    takeaways: string[], actionItems: string}>}
 */
function parseMeetings_(bodyText) {
  var lines = bodyText.split('\n');
  var results = [];

  // 1. Collect line indices of every "Recording: Recap for" match
  var recapIndices = [];
  for (var i = 0; i < lines.length; i++) {
    if (RECAP_TITLE_RE.test(lines[i])) {
      recapIndices.push(i);
    }
  }

  if (recapIndices.length === 0) {
    console.log('[WeeklyReporter] No "Recap for" lines found in document.');
    return results;
  }

  // 2. Process each meeting — strictly bounded chunks
  for (var r = 0; r < recapIndices.length; r++) {
    var recapLine = recapIndices[r];
    var chunkEnd = (r + 1 < recapIndices.length) ? recapIndices[r + 1] : lines.length;

    // ---- Strict meeting chunk (NO context bleed) ----
    // This slice is the authoritative meeting content: from the current
    // recap line up to (but not including) the next recap line or EOF.
    var meetingLines = lines.slice(recapLine, chunkEnd);
    var meetingChunk = meetingLines.join('\n');

    // ---- Date-context chunk (up to 8 preceding lines for ISO date) ----
    // The date lives on a preceding separator/header line outside the
    // strict chunk, so we need a wider scan for it ONLY — never used
    // for content extraction.
    var contextStart = Math.max(0, recapLine - 8);
    var contextLines = lines.slice(contextStart, chunkEnd);
    var contextChunk = contextLines.join('\n');

    // --- Extract meeting name from the strict chunk ---
    var titleMatch = meetingChunk.match(RECAP_TITLE_RE);
    if (!titleMatch) continue;

    var beforeText = lines.slice(contextStart, recapLine).join('\n');
    var parsed = parseRecapChunk_(meetingChunk, beforeText);
    if (parsed) results.push(parsed);
  }

  console.log('[WeeklyReporter] Parsed %d meeting(s) from %d recap lines',
    results.length, recapIndices.length);
  return results;
}

/**
 * Parse a Fathom recap chunk (doc or Gmail body) into structured fields.
 *
 * @param {string} chunk — Text containing "Recap for …" and takeaways
 * @param {string} [beforeText] — Preceding lines for date context (doc only)
 * @param {string} [fallbackDate] — YYYY-MM-DD if body has no meeting date
 * @returns {Object|null}
 */
function parseRecapChunk_(chunk, beforeText, fallbackDate) {
  var titleMatch = chunk.match(RECAP_TITLE_RE);
  if (!titleMatch) return null;

  var title = titleMatch[1].trim();
  beforeText = beforeText || '';
  var contextChunk = beforeText ? beforeText + '\n' + chunk : chunk;

  var dateStr = '';
  if (fallbackDate) {
    dateStr = extractFathomMeetingDate_(chunk) || fallbackDate;
  } else {
    dateStr = extractDateFromChunk_(chunk, contextChunk, beforeText);
  }
  if (!dateStr && fallbackDate) dateStr = fallbackDate;

  var displayTime = extractTime_(chunk);
  var takeaways = extractTop3_(chunk);
  if (takeaways.length === 0 && fallbackDate) {
    takeaways = ensureFathomRecapTakeaways_([chunk, chunk.replace(/^Recap for[^\n]*\n/, '')]);
  }
  takeaways = takeaways.map(cleanTakeawayItem_).map(ensureEnglish_);
  var rawActionItems = ensureEnglish_(extractActionItems_(chunk));

  return finalizeRecapFields_(title, dateStr, displayTime, takeaways, rawActionItems);
}

/** Escape and resolve Slack mentions on parsed recap fields. */
function finalizeRecapFields_(title, dateStr, displayTime, takeaways, rawActionItems) {
  var cleanedAction = decodeHtmlEntities_(rawActionItems);
  var escapedActionItems = escapeSlackMarkdown_(cleanedAction);
  var resolvedActionItems = resolveSlackMentions_(escapedActionItems);
  var escapedTakeaways = takeaways.map(function(tk) {
    return escapeSlackMarkdown_(decodeHtmlEntities_(tk));
  });

  return {
    title: title,
    rawTitle: title,
    date: dateStr,
    time: displayTime,
    takeaways: escapedTakeaways,
    actionItems: resolvedActionItems
  };
}

// ---------------------------------------------------------------------------
// Section extractors (operate on strict, non-bleeding chunks)
// ---------------------------------------------------------------------------

/**
 * Extract the scheduled meeting time from Fathom content.
 * Ignores webhook ingestion timestamps (24h HH:MM without AM/PM).
 *
 * @param {string} chunk
 * @returns {string} Normalized time like "11:45 AM", or empty string
 */
function extractTime_(chunk) {
  // "June 17, 2026 at 11:45 AM"
  var atMatch = chunk.match(
    /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\s+at\s+(\d{1,2}:\d{2}\s*(?:AM|PM))/i
  );
  if (atMatch) return normalizeTimeDisplay_(atMatch[1]);

  // First explicit AM/PM time in the chunk (scheduled meeting, not webhook stamp)
  var ampmMatch = chunk.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i);
  if (ampmMatch) return normalizeTimeDisplay_(ampmMatch[1]);

  return '';
}

/** Normalize "11:45 am" → "11:45 AM". */
function normalizeTimeDisplay_(timeStr) {
  if (!timeStr) return '';
  return timeStr.replace(/\s*(am|pm)\s*$/i, function(_, meridiem) {
    return ' ' + meridiem.toUpperCase();
  }).trim();
}

/**
 * Convert a display time to minutes-since-midnight for sorting.
 * Times without AM/PM sort after all explicit times on the same day.
 *
 * @param {string} timeStr
 * @returns {number}
 */
function timeToMinutes_(timeStr) {
  if (!timeStr) return 9999;
  var match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return 9999;
  var hours = parseInt(match[1], 10);
  var mins = parseInt(match[2], 10);
  var meridiem = (match[3] || '').toUpperCase();
  if (meridiem === 'PM' && hours !== 12) hours += 12;
  if (meridiem === 'AM' && hours === 12) hours = 0;
  return hours * 60 + mins;
}

/** Sort meetings by date ascending, then time ascending. */
function compareMeetingsChronologically_(a, b) {
  var dateCmp = (a.date || '').localeCompare(b.date || '');
  if (dateCmp !== 0) return dateCmp;
  return timeToMinutes_(a.time || '') - timeToMinutes_(b.time || '');
}

// =========================================================================
// Google Calendar — fetch scheduled ops meetings for the reporting week
// =========================================================================

/**
 * Resolve display/query timezone: OPS_REPORT_TZ → calendar TZ → default.
 *
 * @param {GoogleAppsScript.Calendar.Calendar|null} [calendar]
 * @returns {string}
 */
function getReportTz_(calendar) {
  var prop = PropertiesService.getScriptProperties().getProperty('OPS_REPORT_TZ');
  if (prop) return prop;
  if (calendar) {
    try {
      var calTz = calendar.getTimeZone();
      if (calTz) return calTz;
    } catch (e) { /* fall through */ }
  }
  try {
    var scriptTz = Session.getScriptTimeZone();
    if (scriptTz) return scriptTz;
  } catch (e2) { /* fall through */ }
  return REPORT_TZ_DEFAULT_;
}

/** Short label for footer timestamp (e.g. America/Mexico_City → CST). */
function tzAbbrev_(tz) {
  if (!tz) return '';
  if (tz.indexOf('Mexico') !== -1 || tz === 'America/Regina') return 'CST';
  if (tz === 'America/New_York' || tz === 'America/Detroit') return 'ET';
  if (tz === 'America/Chicago') return 'CT';
  if (tz === 'America/Denver') return 'MT';
  if (tz === 'America/Los_Angeles') return 'PT';
  var parts = tz.split('/');
  return parts.length > 1 ? parts[1].replace(/_/g, ' ') : tz;
}

/**
 * Fetch timed ops meetings from Google Calendar for the reporting week.
 * Bi-weekly instances appear automatically when scheduled that week.
 *
 * @param {{ start: Date, end: Date }} weekRange
 * @returns {Array.<{title: string, date: string, time: string, startMs: number, eventId: string}>}
 */
function fetchCalendarMeetings_(weekRange) {
  var props = PropertiesService.getScriptProperties();
  var calendarId = props.getProperty('OPS_CALENDAR_ID') || 'primary';
  var dedicated = props.getProperty('OPS_CALENDAR_DEDICATED') === 'true';

  var calendar;
  try {
    calendar = CalendarApp.getCalendarById(calendarId);
  } catch (e) {
    console.warn('[WeeklyReporter] Calendar "%s" not found — trying default: %s',
      calendarId, e.message);
    calendar = CalendarApp.getDefaultCalendar();
  }

  if (!calendar) {
    console.error('[WeeklyReporter] No accessible Google Calendar found.');
    return [];
  }

  var queryEnd = new Date(weekRange.end);
  var tz = getReportTz_(calendar);

  var events = calendar.getEvents(weekRange.start, queryEnd);
  var results = [];
  var seenTitleDate = {};

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.isAllDayEvent()) continue;

    var guestStatus = ev.getMyStatus();
    if (guestStatus === CalendarApp.GuestStatus.NO) continue;

    var title = ev.getTitle().trim();
    if (!title || isExcludedCalendarEvent_(title)) continue;
    if (!dedicated && !matchesOpsMeetingPattern_(title)) continue;

    var start = ev.getStartTime();
    var durationMin = (ev.getEndTime().getTime() - start.getTime()) / 60000;
    if (durationMin < 10) continue;

    var dateStr = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
    if (!isDateInRange_(dateStr, weekRange)) continue;

    var dedupeKey = normalizeMeetingTitle_(title) + '|' + dateStr;
    if (seenTitleDate[dedupeKey]) continue;
    seenTitleDate[dedupeKey] = true;

    results.push({
      title: title,
      date: dateStr,
      time: Utilities.formatDate(start, tz, 'h:mm a'),
      startMs: start.getTime(),
      eventId: ev.getId()
    });
  }

  results.sort(function(a, b) { return a.startMs - b.startMs; });
  console.log('[WeeklyReporter] Calendar: %d ops meeting(s) in week (%s, dedicated=%s)',
    results.length, calendar.getName(), dedicated);
  return results;
}

/** @param {string} title */
function isExcludedCalendarEvent_(title) {
  var t = title.trim();
  for (var i = 0; i < OPS_EVENT_EXCLUDE_PATTERNS.length; i++) {
    if (OPS_EVENT_EXCLUDE_PATTERNS[i].test(t)) return true;
  }
  return false;
}

/** @param {string} title */
function matchesOpsMeetingPattern_(title) {
  var t = normalizeMeetingTitle_(title);
  for (var i = 0; i < OPS_MEETING_TITLE_PATTERNS.length; i++) {
    if (OPS_MEETING_TITLE_PATTERNS[i].test(t)) return true;
  }
  return false;
}

/** Lowercase, collapse whitespace, strip parenthetical suffixes like "(Zoom)". */
function normalizeMeetingTitle_(title) {
  return String(title)
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// =========================================================================
// Gmail — Fathom recap discovery for the reporting week
// =========================================================================

/**
 * Search Gmail for Fathom recap emails within the reporting week.
 * Supports both subject formats:
 *   - Recap for "Meeting Name"
 *   - Recap of your meeting with … (title in body)
 *
 * @param {{ start: Date, end: Date }} weekRange
 * @returns {Array}
 */
function fetchGmailRecaps_(weekRange) {
  var bounds = gmailWeekQueryBounds_(weekRange);
  var query = '(from:fathom.video OR from:no-reply@fathom.video) subject:recap ' +
    'after:' + bounds.after + ' before:' + bounds.before;

  var threads = safeGmailSearch_(query, 50);
  var results = [];
  var seen = {};

  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var parsed = parseFathomGmailMessage_(messages[m], weekRange);
      if (!parsed) continue;

      var dedupeKey = parsed.rawTitle + '|' + parsed.date;
      if (seen[dedupeKey]) continue;
      seen[dedupeKey] = true;

      parsed.startMs = meetingStartMs_(parsed.date, parsed.time);
      results.push(parsed);
    }
  }

  console.log('[WeeklyReporter] Gmail: %d recap(s) from %d threads — [%s]',
    results.length, threads.length,
    results.map(function(r) { return r.rawTitle + '@' + r.date; }).join('; '));
  return results;
}

/**
 * Gmail search with error logging (bad queries must not abort the whole report).
 *
 * @param {string} query
 * @param {number} [maxResults]
 * @returns {GoogleAppsScript.Gmail.GmailThread[]}
 */
function safeGmailSearch_(query, maxResults) {
  try {
    return GmailApp.search(query, 0, maxResults || 10);
  } catch (e) {
    console.warn('[WeeklyReporter] Gmail search failed: %s | query: %s', e.message, query);
    return [];
  }
}

/** Strip Gmail-search metacharacters from a meeting title keyword string. */
function gmailKeywordize_(title) {
  return String(title)
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Gmail `after:` / `before:` strings for a reporting week. */
function gmailWeekQueryBounds_(weekRange) {
  var queryEnd = new Date(weekRange.end);
  queryEnd.setDate(queryEnd.getDate() + 1);
  return {
    after: Utilities.formatDate(weekRange.start, getReportTz_(), 'yyyy/MM/dd'),
    before: Utilities.formatDate(queryEnd, getReportTz_(), 'yyyy/MM/dd')
  };
}

/**
 * Parse one Fathom Gmail message into a recap object.
 *
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg
 * @param {{ start: Date, end: Date }} weekRange
 * @returns {Object|null}
 */
function parseFathomGmailMessage_(msg, weekRange) {
  try {
    if (msg.getFrom().toLowerCase().indexOf('fathom') === -1) return null;

    var subject = msg.getSubject() || '';
    if (!/recap/i.test(subject)) return null;

    var plain = msg.getPlainBody() || '';
    var html = msg.getBody() || '';
    var stripped = html ? stripHtml_(html) : '';
    var bodies = [];
    if (stripped) bodies.push(stripped);
    if (plain && bodies.indexOf(plain) === -1) bodies.push(plain);
    if (bodies.length === 0) return null;

    var body = bodies[0];
    for (var b = 1; b < bodies.length; b++) {
      if (scoreFathomBodyQuality_(bodies[b]) > scoreFathomBodyQuality_(body)) {
        body = bodies[b];
      }
    }

    var meetingTitle = null;
    for (b = 0; b < bodies.length; b++) {
      meetingTitle = extractFathomMeetingTitle_(subject, bodies[b]);
      if (meetingTitle) {
        body = bodies[b];
        break;
      }
    }
    if (!meetingTitle) return null;

    var msgDate = Utilities.formatDate(msg.getDate(), getReportTz_(), 'yyyy-MM-dd');
    var chunk = 'Recap for "' + meetingTitle + '"\n' + body;
    var parsed = parseRecapChunk_(chunk, '', msgDate);
    if (!parsed) return null;

    if (!parsed.date) parsed.date = msgDate;
    if (!isDateInRange_(parsed.date, weekRange) && !isDateInRange_(msgDate, weekRange)) {
      return null;
    }

    if (parsed.takeaways.length === 0) {
      var raw = ensureFathomRecapTakeaways_(bodies.concat([chunk]));
      parsed.takeaways = raw.map(cleanTakeawayItem_).map(ensureEnglish_).map(function(t) {
        return escapeSlackMarkdown_(decodeHtmlEntities_(t));
      });
    }

    if (parsed.takeaways.length === 0 && !parsed.actionItems) return null;

    return parsed;
  } catch (e) {
    console.warn('[WeeklyReporter] Skipped Gmail message (%s): %s', msg.getSubject(), e.message);
    return null;
  }
}

/**
 * Targeted Gmail search for one calendar meeting (fallback when bulk pool misses).
 *
 * @param {string} calendarTitle
 * @param {string} eventDate — YYYY-MM-DD
 * @param {{ start: Date, end: Date }} weekRange
 * @returns {{ takeaways: string[], actionItems: string }|null}
 */
function fetchGmailRecapDirectForEvent_(calendarTitle, eventDate, weekRange) {
  var bounds = gmailWeekQueryBounds_(weekRange);
  var keywords = gmailKeywordize_(calendarTitle);
  var query = '(from:fathom.video OR from:no-reply@fathom.video) subject:recap ' +
    keywords + ' after:' + bounds.after + ' before:' + bounds.before;

  var threads = safeGmailSearch_(query, 5);
  for (var t = 0; t < threads.length; t++) {
    var messages = threads[t].getMessages();
    for (var m = 0; m < messages.length; m++) {
      var parsed = parseFathomGmailMessage_(messages[m], weekRange);
      if (!parsed) continue;
      if (!fathomRecapMatchesEvent_(calendarTitle, eventDate, parsed, messages[m])) continue;
      return {
        takeaways: parsed.takeaways,
        actionItems: parsed.actionItems
      };
    }
  }
  return null;
}

/**
 * Resolve meeting title from a Fathom email subject + body.
 *
 * @param {string} subject
 * @param {string} body
 * @returns {string|null}
 */
function extractFathomMeetingTitle_(subject, body) {
  var subjectMatch = subject.match(RECAP_TITLE_RE);
  if (subjectMatch) return subjectMatch[1].trim();

  if (!RECAP_OF_MEETING_SUBJECT_RE.test(subject)) return null;

  var guestFromSubject = '';
  var guestMatch = subject.match(/Recap of your meeting with\s+(.+)$/i);
  if (guestMatch) guestFromSubject = guestMatch[1].replace(/\*\*/g, '').trim();

  var lines = body.split('\n');

  // Pass 1: known ops meeting title anywhere in the body (most reliable).
  for (var j = 0; j < lines.length; j++) {
    var opsLine = lines[j].replace(/\*\*/g, '').trim();
    if (opsLine.length >= 3 && opsLine.length <= 120 && matchesOpsMeetingPattern_(opsLine)) {
      return opsLine;
    }
  }

  // Pass 2: line immediately above "June 17, 2026 • 25 mins" (skip guest-name rows).
  for (var i = 0; i < Math.min(lines.length, 50); i++) {
    var line = lines[i].replace(/\*\*/g, '').trim();
    if (!line || line.length > 120 || isFathomBoilerplateLine_(line)) continue;
    if (guestFromSubject && line.toLowerCase() === guestFromSubject.toLowerCase()) continue;

    var nextLine = (i + 1 < lines.length) ? lines[i + 1].replace(/\*\*/g, '').trim() : '';
    if (MONTH_DAY_YEAR_RE.test(nextLine) || /\d+\s*mins?/i.test(nextLine)) {
      return line;
    }
  }

  return null;
}

/** Skip Fathom email boilerplate / section headers when hunting for the title line. */
function isFathomBoilerplateLine_(line) {
  return /^notice something/i.test(line) ||
    /^upgrade to premium/i.test(line) ||
    /^view meeting/i.test(line) ||
    /^https?:\/\//i.test(line) ||
    MEETING_PURPOSE_HEADER_RE.test(line) ||
    TOP3_HEADER_RE.test(line) ||
    ACTION_ITEMS_HEADER_RE.test(line);
}

/**
 * True when a parsed Gmail recap belongs to a calendar event (title + date).
 *
 * @param {string} calendarTitle
 * @param {string} eventDate
 * @param {Object} parsed
 * @param {GoogleAppsScript.Gmail.GmailMessage} [msg]
 * @returns {boolean}
 */
function fathomRecapMatchesEvent_(calendarTitle, eventDate, parsed, msg) {
  if (titlesMatch_(calendarTitle, parsed.rawTitle)) {
    return recapDateMatchesEvent_(eventDate, parsed.date, calendarTitle, parsed.rawTitle);
  }

  // Body/subject may contain the real meeting title when Fathom used guest name.
  if (msg) {
    var subject = msg.getSubject() || '';
    var bodySnippet = (msg.getPlainBody() || '').substring(0, 4000);
    var normCal = normalizeMeetingTitle_(calendarTitle);
    if (normalizeMeetingTitle_(bodySnippet).indexOf(normCal) !== -1) {
      return recapDateMatchesEvent_(eventDate, parsed.date, calendarTitle, parsed.rawTitle);
    }
    if (normalizeMeetingTitle_(subject).indexOf(normCal) !== -1) {
      return recapDateMatchesEvent_(eventDate, parsed.date, calendarTitle, parsed.rawTitle);
    }
  }

  return false;
}

/** Date gate for recap ↔ calendar slot matching. */
function recapDateMatchesEvent_(eventDate, recapDate, calendarTitle, recapTitle) {
  if (!eventDate || !recapDate) return true;
  var diffDays = daysBetweenIso_(recapDate, eventDate);
  if (diffDays <= 1) return true;
  return normalizeMeetingTitle_(calendarTitle) === normalizeMeetingTitle_(recapTitle);
}

// =========================================================================
// Weekly meeting list — calendar schedule + Gmail/doc recap content
// =========================================================================

/**
 * Build the digest from calendar events only (matches what you see on the
 * calendar). Gmail and doc recaps supply bullets — they never add extra
 * meeting rows.
 *
 * @param {{ start: Date, end: Date }} weekRange
 * @param {Array} calendarEvents
 * @param {Array} docRecaps
 * @param {Array} gmailRecaps
 * @returns {Array}
 */
function buildWeeklyMeetingList_(weekRange, calendarEvents, docRecaps, gmailRecaps, runStart) {
  var usedDoc = {};
  var usedGmail = {};
  var meetings = [];
  runStart = runStart || Date.now();

  for (var i = 0; i < calendarEvents.length; i++) {
    var ev = calendarEvents[i];
    var content = pickRecapContent_(ev.title, ev.date, docRecaps, gmailRecaps, usedDoc, usedGmail);

    if (content.takeaways.length === 0 && !content.actionItems &&
        Date.now() - runStart < 240000) {
      try {
        var direct = fetchGmailRecapDirectForEvent_(ev.title, ev.date, weekRange);
        if (direct) content = direct;
      } catch (e) {
        console.warn('[WeeklyReporter] Direct Gmail lookup failed for "%s": %s',
          ev.title, e.message);
      }
    }

    meetings.push({
      title: ev.title,
      date: ev.date,
      time: ev.time,
      startMs: ev.startMs,
      takeaways: content.takeaways,
      actionItems: content.actionItems
    });
  }

  meetings.sort(function(a, b) {
    return (a.startMs || 0) - (b.startMs || 0);
  });

  return meetings;
}

/**
 * Attach recap bullets to a calendar meeting by title, preferring the recap
 * whose date matches the calendar slot (avoids cross-week title collisions).
 *
 * @returns {{ takeaways: string[], actionItems: string }}
 */
function pickRecapContent_(title, eventDate, docRecaps, gmailRecaps, usedDoc, usedGmail) {
  var empty = { takeaways: [], actionItems: '' };
  var best = null;
  var bestScore = 0;
  var bestUsedMap = null;
  var bestIdx = -1;

  function scoreRecap_(recap, source) {
    if (!titlesMatch_(title, recap.rawTitle)) return 0;
    if (recap.takeaways.length === 0 && !recap.actionItems) return 0;

    var exactTitle = normalizeMeetingTitle_(title) === normalizeMeetingTitle_(recap.rawTitle);
    if (eventDate && recap.date && !recapDateMatchesEvent_(eventDate, recap.date, title, recap.rawTitle)) {
      return 0;
    }

    var score = 10 + recap.takeaways.length;
    if (source === 'gmail') score += 4;
    else if (source === 'doc') score += 1;

    if (eventDate && recap.date) {
      var dayDiff = daysBetweenIso_(recap.date, eventDate);
      if (dayDiff === 0) score += 25;
      else if (dayDiff === 1) score += 8;
      else if (dayDiff > 1) score -= 5;
    }
    if (exactTitle) score += 5;
    return score;
  }

  var d;
  for (d = 0; d < gmailRecaps.length; d++) {
    if (usedGmail[d]) continue;
    var gs = scoreRecap_(gmailRecaps[d], 'gmail');
    if (gs > bestScore) {
      bestScore = gs;
      best = gmailRecaps[d];
      bestUsedMap = usedGmail;
      bestIdx = d;
    }
  }

  for (d = 0; d < docRecaps.length; d++) {
    if (usedDoc[d]) continue;
    var ds = scoreRecap_(docRecaps[d], 'doc');
    if (ds > bestScore) {
      bestScore = ds;
      best = docRecaps[d];
      bestUsedMap = usedDoc;
      bestIdx = d;
    }
  }

  if (best && bestScore > 0) {
    bestUsedMap[bestIdx] = true;
    return {
      takeaways: best.takeaways,
      actionItems: best.actionItems
    };
  }

  return empty;
}

/** Absolute day difference between two YYYY-MM-DD strings. */
function daysBetweenIso_(a, b) {
  if (!a || !b) return 99;
  var ms = Math.abs(new Date(a + 'T12:00:00').getTime() - new Date(b + 'T12:00:00').getTime());
  return Math.round(ms / 86400000);
}

/** Milliseconds since epoch for sorting (date required, time optional). */
function meetingStartMs_(dateStr, timeStr) {
  if (!dateStr) return 0;
  var h = 12;
  var min = 0;
  if (timeStr) {
    var mins = timeToMinutes_(timeStr);
    if (mins < 9999) {
      h = Math.floor(mins / 60);
      min = mins % 60;
    }
  }
  var d = new Date(dateStr + 'T' + ('0' + h).slice(-2) + ':' + ('0' + min).slice(-2) + ':00');
  return d.getTime();
}

/**
 * True when a calendar event title and Fathom recording title refer to
 * the same meeting (direct match, substring, or alias group).
 */
function titlesMatch_(calendarTitle, fathomTitle) {
  var c = normalizeMeetingTitle_(calendarTitle);
  var f = normalizeMeetingTitle_(fathomTitle);
  if (!c || !f) return false;
  if (c === f) return true;

  if (isMarcoRickWeeklyTitle_(c) !== isMarcoRickWeeklyTitle_(f)) return false;
  if (isMarcoRickDailyTitle_(c) && isMarcoRickExtendedTitle_(f)) return false;
  if (isMarcoRickDailyTitle_(f) && isMarcoRickExtendedTitle_(c)) return false;
  if (isBiWeeklyMetaGoogleTitle_(c) !== isBiWeeklyMetaGoogleTitle_(f)) return false;
  if (isBiWeeklyNfiTitle_(c) !== isBiWeeklyNfiTitle_(f)) return false;

  for (var g = 0; g < TITLE_ALIAS_GROUPS.length; g++) {
    var group = TITLE_ALIAS_GROUPS[g];
    var cHit = false;
    var fHit = false;
    for (var p = 0; p < group.length; p++) {
      if (group[p].test(c)) cHit = true;
      if (group[p].test(f)) fHit = true;
    }
    if (cHit && fHit) return true;
  }

  return false;
}

/** @param {string} normalizedTitle */
function isMarcoRickWeeklyTitle_(normalizedTitle) {
  return /marco\/rick weekly/.test(normalizedTitle);
}

/** Daily standup — exact "Marco/Rick" only, not Product Review / Weekly. */
function isMarcoRickDailyTitle_(normalizedTitle) {
  return normalizedTitle === 'marco/rick';
}

/** Longer Marco/Rick variants (Product Review, Weekly, etc.). */
function isMarcoRickExtendedTitle_(normalizedTitle) {
  return /marco\/rick/.test(normalizedTitle) && normalizedTitle !== 'marco/rick';
}

function isBiWeeklyMetaGoogleTitle_(normalizedTitle) {
  return /bi.weekly weatherman.*meta.*google/.test(normalizedTitle.replace(/-/g, ' '));
}

function isBiWeeklyNfiTitle_(normalizedTitle) {
  return /bi.weekly meeting.*weatherman\/nfi|weatherman\/nfi/.test(normalizedTitle.replace(/-/g, ' '));
}

/**
 * Prefer HTML-stripped body when plain text omits Fathom takeaways.
 *
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg
 * @returns {string}
 */
function getFathomEmailBody_(msg) {
  var plain = msg.getPlainBody() || '';
  var html = msg.getBody() || '';
  var stripped = html ? stripHtml_(html) : '';

  if (!stripped && !plain) return '';
  if (!stripped) return plain;
  if (!plain) return stripped;

  var plainScore = scoreFathomBodyQuality_(plain);
  var htmlScore = scoreFathomBodyQuality_(stripped);
  return htmlScore >= plainScore ? stripped : plain;
}

/** Rank body text by how much recap content we can extract from it. */
function scoreFathomBodyQuality_(text) {
  if (!text) return 0;
  return extractTakeawayLineBullets_(text).length * 10 +
    (TOP3_HEADER_RE.test(text) ? 3 : 0) +
    (MEETING_PURPOSE_HEADER_RE.test(text) ? 1 : 0);
}

/** @param {string} html */
function stripHtml_(html) {
  var text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<strong[^>]*>/gi, '**')
    .replace(/<\/strong>/gi, '**')
    .replace(/<b[^>]*>/gi, '**')
    .replace(/<\/b>/gi, '**')
    .replace(/<li[^>]*>/gi, '\n\u2022 ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return decodeHtmlEntities_(text);
}

/**
 * Decode HTML entities from Fathom email HTML or plain text (&quot; &#39; etc.).
 *
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities_(text) {
  if (!text) return text;
  return text
    .replace(/&#x([0-9a-f]+);/gi, function(_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    })
    .replace(/&#(\d+);/g, function(_, dec) {
      return String.fromCharCode(parseInt(dec, 10));
    })
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** Strip trailing inline "Topics:" / "Temas:" bleed from a takeaway item. */
function cleanTakeawayItem_(item) {
  return item.replace(/\s*(?:Topics|Temas)\s*:.*$/i, '').trim();
}

/**
 * Translate non-English recap text to English via LanguageApp.
 * Skips text that already looks English to conserve quota.
 *
 * @param {string} text
 * @returns {string}
 */
function ensureEnglish_(text) {
  if (!text || text.length < 4) return text;
  if (isLikelyEnglish_(text)) return text;
  try {
    return LanguageApp.translate(text, '', 'en');
  } catch (e) {
    console.warn('[WeeklyReporter] Translation failed — using original: %s', e.message);
    return text;
  }
}

/** Heuristic: detect Spanish or other non-English recap text. */
function isLikelyEnglish_(text) {
  if (/[áéíóúñ¿¡]/i.test(text)) return false;
  if (/\b(pedido|producto|calendario|pr[oó]ximo|reuni[oó]n|an[aá]lisis|fabricaci[oó]n)\b/i.test(text)) {
    return false;
  }
  return true;
}

/**
 * Extract takeaways from a Fathom-format meeting chunk.
 *
 * Fathom uses inline paragraph format:
 *   Meeting Purpose <text>. Key Takeaways - Item 1 text. - Item 2 text.
 *   - Item 3 text. Topics <more text>.
 *
 * We find the header (Key Takeaways / Puntos clave / Top 3 Takeaways),
 * capture everything after it until a section boundary, and split on
 * the " - " separator to obtain individual items.
 */
function extractTop3_(chunk) {
  var match = chunk.match(TOP3_HEADER_RE);
  if (!match) return [];

  var lineBullets = extractTakeawayLineBullets_(chunk);
  if (lineBullets.length > 0) return lineBullets.slice(0, 6);

  // Everything after the header keyword (inline dash-separated doc format)
  var after = chunk.substring(match.index + match[0].length);
  after = after.replace(/^[\s\-,;:.]+/, '');

  var stop = after.search(/\n\s*(?:Topics|Temas|Action\s+Items|Next\s+Steps|Pr[oó]ximos)\s*:/i);
  if (stop !== -1) after = after.substring(0, stop);

  var items = after.split(/\s+-\s+/).map(function(item) {
    return item.replace(/\s+/g, ' ').trim();
  }).filter(function(item) {
    return item.length > 3;
  });

  // Inline doc format only — multiline email/Topics text splits falsely on " - "
  if (items.length > 0 && after.indexOf('\n') < 0) {
    return items.slice(0, 6);
  }

  // Last resort: Meeting Purpose sentence as a single takeaway
  var purposeMatch = chunk.match(MEETING_PURPOSE_HEADER_RE);
  if (purposeMatch) {
    var afterPurpose = chunk.substring(purposeMatch.index + purposeMatch[0].length);
    var purposeStop = afterPurpose.search(/\n\s*(?:Key\s*Takeaways|Topics|Action)/i);
    if (purposeStop !== -1) afterPurpose = afterPurpose.substring(0, purposeStop);
    var purposeText = afterPurpose.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (purposeText.length > 10) return [purposeText];
  }

  return [];
}

/**
 * Try multiple body variants and fallback sections to extract recap bullets.
 *
 * @param {string[]} sources — chunk / plain / HTML-stripped bodies
 * @returns {string[]}
 */
function ensureFathomRecapTakeaways_(sources) {
  var s;
  for (s = 0; s < sources.length; s++) {
    if (!sources[s]) continue;
    var fromTop3 = extractTop3_(sources[s]);
    if (fromTop3.length > 0) return fromTop3;
  }

  for (s = 0; s < sources.length; s++) {
    if (!sources[s]) continue;
    var fromTopics = extractTopicsTakeaways_(sources[s]);
    if (fromTopics.length > 0) return fromTopics;
  }

  for (s = 0; s < sources.length; s++) {
    if (!sources[s]) continue;
    var purpose = extractMeetingPurposeTakeaway_(sources[s]);
    if (purpose) return [purpose];
  }

  return [];
}

/** First few substantive lines under a Fathom "Topics:" section. */
function extractTopicsTakeaways_(chunk) {
  var lines = chunk.split('\n');
  var inTopics = false;
  var items = [];

  for (var i = 0; i < lines.length; i++) {
    if (/^\s*Topics\s*:/i.test(lines[i])) {
      inTopics = true;
      var inline = lines[i].replace(/^\s*Topics\s*:\s*/i, '').trim();
      if (inline.length > 15) items.push(inline);
      continue;
    }
    if (!inTopics) continue;
    if (/^\s*(?:Key Takeaways|Meeting Purpose|Action Items)/i.test(lines[i])) break;

    if (BULLET_RE.test(lines[i]) || /^\s*\*\s+\*\*/.test(lines[i])) {
      var bullet = lines[i].replace(BULLET_RE, '').replace(/^\s*\*\s+/, '').replace(/\*\*/g, '').trim();
      if (bullet.length > 10) items.push(bullet);
      continue;
    }

    var boldLead = lines[i].match(/^\s*\*\*([^*]+)\*\*[:\s]*(.*)$/);
    if (boldLead) {
      var boldItem = (boldLead[1].trim() + (boldLead[2] ? ': ' + boldLead[2].trim() : ''))
        .replace(/\*\*/g, '').trim();
      if (boldItem.length > 10) items.push(boldItem);
      continue;
    }

    var plain = lines[i].replace(/\*\*/g, '').trim();
    if (plain.length > 20 && !/^https?:\/\//i.test(plain)) {
      items.push(plain);
    }
    if (items.length >= 6) break;
  }

  return items.slice(0, 6);
}

/** @param {string} chunk @returns {string|null} */
function extractMeetingPurposeTakeaway_(chunk) {
  var purposeMatch = chunk.match(MEETING_PURPOSE_HEADER_RE);
  if (!purposeMatch) return null;
  var afterPurpose = chunk.substring(purposeMatch.index + purposeMatch[0].length);
  var purposeStop = afterPurpose.search(/\n\s*(?:Key\s*Takeaways|Topics|Action)/i);
  if (purposeStop !== -1) afterPurpose = afterPurpose.substring(0, purposeStop);
  var purposeText = afterPurpose.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  return purposeText.length > 10 ? purposeText : null;
}

/** Line-based Key Takeaways bullets (* / • / -), common in Fathom emails. */
function extractTakeawayLineBullets_(chunk) {
  var lines = chunk.split('\n');
  var inSection = false;
  var bulletItems = [];

  for (var i = 0; i < lines.length; i++) {
    if (TOP3_HEADER_RE.test(lines[i])) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (ACTION_ITEMS_HEADER_RE.test(lines[i])) break;
    if (/^\s*(?:Topics|Temas)\s*:?\s*$/i.test(lines[i].trim())) break;
    if (/upgrade to premium/i.test(lines[i])) break;

    if (BULLET_RE.test(lines[i]) || /^\s*\*\s+\*\*/.test(lines[i])) {
      var item = lines[i]
        .replace(BULLET_RE, '')
        .replace(/^\s*\*\s+/, '')
        .replace(/\*\*/g, '')
        .trim();
      if (item.length > 3) bulletItems.push(item);
      continue;
    }

    var boldLead = lines[i].match(/^\s*\*\*([^*]+)\*\*[:\s]*(.*)$/);
    if (boldLead) {
      var boldItem = (boldLead[1].trim() + (boldLead[2] ? ': ' + boldLead[2].trim() : ''))
        .replace(/\*\*/g, '')
        .trim();
      if (boldItem.length > 3) bulletItems.push(boldItem);
      continue;
    }

    // Plain-text lines from HTML-stripped content — require title-case / bullet start
    var plainLine = lines[i].replace(/\*\*/g, '').trim();
    if (plainLine.length > 25 &&
        /^[A-Z*\u2022\-]/.test(plainLine) &&
        !/^(key takeaways|meeting purpose|topics|action items|temas|notice|upgrade|view meeting)/i.test(plainLine) &&
        !/^https?:\/\//i.test(plainLine)) {
      bulletItems.push(plainLine);
    }
  }

  return bulletItems;
}

/**
 * Extract action items / topics from a Fathom-format meeting chunk.
 * Fathom meetings may have a "Topics:" section after the takeaways.
 */
function extractActionItems_(chunk) {
  var match = chunk.match(ACTION_ITEMS_HEADER_RE);
  if (!match) return '';

  // Everything after the section header
  var after = chunk.substring(match.index + match[0].length);
  after = after.replace(/^[\s\-]+/, '');

  // Stop at next section or double newline
  var stop = after.search(/\n\s*(?:Key\s+Takeaways|Puntos\s+clave|Meeting\s+Purpose|Propósito)\s*:/i);
  if (stop === -1) stop = after.search(/\n\s*\n/);
  if (stop !== -1) after = after.substring(0, stop);

  // Split on " - " for individual items
  var lines = after.split(/\s+-\s+/).map(function(item) {
    return item.replace(/\s+/g, ' ').trim();
  }).filter(function(item) {
    return item.length > 3;
  });

  return lines.join('\n');
}

// =========================================================================
// Date extraction — parses real meeting dates from Fathom content
// =========================================================================

/**
 * Extract a YYYY-MM-DD date string from a meeting's Fathom content.
 *
 * Priority order:
 *   1. ISO date (YYYY-MM-DD) found within the meeting chunk itself
 *   2. "Month Day, Year" format within the meeting chunk (e.g., "June 12, 2026")
 *   3. "Month Day, Year" in the wider context chunk (before/around the meeting)
 *   4. ISO date in the wider context chunk (legacy fallback)
 *   5. Empty string if nothing found
 *
 * @param {string} meetingChunk — Strictly bounded meeting content
 * @param {string} contextChunk — Wider content around the meeting
 * @param {string} beforeText   — Lines preceding the recap line
 * @returns {string} ISO date string (YYYY-MM-DD) or empty string
 */
function extractDateFromChunk_(meetingChunk, contextChunk, beforeText) {
  // Priority 1: "Month Day, Year" format within meeting chunk
  // Fathom places the real meeting date inline (e.g. "June 12, 2026") —
  // this is the most authoritative source.
  var mdyMatch = meetingChunk.match(MONTH_DAY_YEAR_RE);
  if (mdyMatch) {
    var month = MONTH_NAMES_[mdyMatch[1].toLowerCase()] || '01';
    var day = ('0' + mdyMatch[2]).slice(-2);
    return mdyMatch[3] + '-' + month + '-' + day;
  }

  // Priority 2: ISO date within the meeting chunk itself
  var isoMatch = meetingChunk.match(ISO_DATE_RE);
  if (isoMatch) return isoMatch[1];

  // Priority 3: "Month Day, Year" in context chunk (wider scan)
  var contextMdy = contextChunk.match(MONTH_DAY_YEAR_RE);
  if (contextMdy) {
    var cMonth = MONTH_NAMES_[contextMdy[1].toLowerCase()] || '01';
    var cDay = ('0' + contextMdy[2]).slice(-2);
    return contextMdy[3] + '-' + cMonth + '-' + cDay;
  }

  // Priority 4: ISO date in context (legacy fallback)
  var contextIso = contextChunk.match(ISO_DATE_RE);
  if (contextIso) return contextIso[1];

  return '';
}

/**
 * Extract meeting date from Fathom email header block (title + "June 17, 2026 • 31 mins").
 *
 * @param {string} chunk
 * @returns {string} YYYY-MM-DD or empty
 */
function extractFathomMeetingDate_(chunk) {
  var lines = chunk.split('\n');
  for (var i = 0; i < Math.min(lines.length, 35); i++) {
    var mdy = lines[i].match(MONTH_DAY_YEAR_RE);
    if (!mdy) continue;
    if (/\d+\s*mins?/i.test(lines[i]) || lines[i].length < 60) {
      return mdyToIso_(mdy);
    }
    if (i > 0 && lines[i - 1].length > 3 && lines[i - 1].length < 120 &&
        !MONTH_DAY_YEAR_RE.test(lines[i - 1])) {
      return mdyToIso_(mdy);
    }
  }
  return '';
}

/** @param {RegExpMatchArray} mdyMatch */
function mdyToIso_(mdyMatch) {
  var month = MONTH_NAMES_[mdyMatch[1].toLowerCase()] || '01';
  var day = ('0' + mdyMatch[2]).slice(-2);
  return mdyMatch[3] + '-' + month + '-' + day;
}

// =========================================================================
// Week range helpers — Mon-Sun boundaries
// =========================================================================

/**
 * Compute the reporting week's Monday 00:00 through Sunday 23:59 (ET).
 * Designed for the Monday-morning trigger: always returns the Mon–Sun week
 * that just ended. Manual mid-week runs use the current in-progress week.
 *
 * @returns {{ start: Date, end: Date }}
 */
function getWeekRange_() {
  var tz = getReportTz_();
  var now = new Date();
  var dayOfWeek = parseInt(Utilities.formatDate(now, tz, 'u'), 10); // 1=Mon … 7=Sun
  var daysSinceMonday = dayOfWeek - 1;

  var monday = new Date(now);
  monday.setDate(now.getDate() - daysSinceMonday);
  monday.setHours(0, 0, 0, 0);

  // Monday trigger → report the week that just finished
  if (dayOfWeek === 1) {
    monday.setDate(monday.getDate() - 7);
  }

  var sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 0);

  return { start: monday, end: sunday };
}

/**
 * Install (or refresh) the recurring Monday 11:00 AM ET time-based trigger.
 * Run once manually after deploy — Apps Script → select installWeeklyReportTrigger → Run.
 */
function installWeeklyReportTrigger() {
  var handler = 'postWeeklyReport';
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  ScriptApp.newTrigger(handler)
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(11)
    .inTimezone('America/New_York')
    .create();

  console.log('[WeeklyReporter] Monday 11:00 AM ET trigger installed for %s', handler);
}

/**
 * One-time setup helper — logs every calendar the script can read.
 * Run from the Apps Script editor, then set OPS_CALENDAR_ID to the
 * desired calendar's ID in Script Properties.
 */
function listAccessibleCalendars() {
  var calendars = CalendarApp.getAllCalendars();
  for (var i = 0; i < calendars.length; i++) {
    var cal = calendars[i];
    console.log('%s  →  %s', cal.getName(), cal.getId());
  }
  console.log('[WeeklyReporter] Set OPS_CALENDAR_ID to one of the IDs above.');
}

/**
 * Check if an ISO date string falls within a given week range.
 * @param {string} dateStr — YYYY-MM-DD
 * @param {{ start: Date, end: Date }} range
 * @returns {boolean}
 */
function isDateInRange_(dateStr, range) {
  if (!dateStr) return false;
  // Use noon to avoid timezone boundary issues
  var d = new Date(dateStr + 'T12:00:00');
  return d >= range.start && d <= range.end;
}

// =========================================================================
// Selective Slack mrkdwn escaping
// =========================================================================

/**
 * Escape Slack mrkdwn meta-characters (&, <, >) so they don't trigger
 * "invalid_blocks" rejections.  Call this BEFORE resolving display-name
 * mentions — the resolver subsequently inserts raw <@U...> tags that must
 * NOT be entity-encoded.
 *
 * Order matters:
 *   1. &  →  &amp;   (always first so it doesn't re-encode)
 *   2. <  →  &lt;
 *   3. >  →  &gt;
 *
 * @param {string} text
 * @returns {string}
 */
function escapeSlackMarkdown_(text) {
  if (!text) return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// =========================================================================
// Slack mention resolution (display name → <@ID>)
// =========================================================================

function buildReverseSlackMap_() {
  var map = {};

  // IMPORTANT: keep in sync with the canonical slackUserMap in Code.js
  var forward = {
    'U066ARLFH4K':  'Sunny (Sajjad)',
    'U4Y0JPMD4':    'Rick Reichmuth',
    'U5206HQ00':    'Diego Marquez',
    'U08F1V0FPDY':  'Allyse C',
    'UQC0FDA2Z':    'Stifany Ong',
    'U04PH549Z3N':  'Paula Bacolod',
    'U08E1C77J77':  'Arqam',
    'U03SW53P95E':  'Mollie Cutillo',
    'U0AMTGG4XRD':  'Marco Gastelum'
  };

  Object.keys(forward).forEach(function(id) {
    map[forward[id].toLowerCase()] = id;
  });

  return map;
}

function resolveSlackMentions_(text) {
  if (!text) return text;

  var reverseMap = buildReverseSlackMap_();
  var resolved = text;

  // Longest-first to prevent partial substring matches
  var keys = Object.keys(reverseMap).sort(function(a, b) {
    return b.length - a.length;
  });

  for (var k = 0; k < keys.length; k++) {
    var displayName = keys[k];
    var userId = reverseMap[displayName];
    var escaped = displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var regex = new RegExp(escaped, 'gi');
    resolved = resolved.replace(regex, '<@' + userId + '>');
  }

  return resolved;
}

// =========================================================================
// Meeting display helpers
// =========================================================================

/**
 * Format a meeting date/time line for Slack, e.g.
 * "📅 Wed, Jun 17, 2026  |  ⏰ 11:45 AM"
 *
 * @param {string} dateStr — YYYY-MM-DD
 * @param {string} timeStr — e.g. "11:45 AM"
 * @returns {string}
 */
function formatMeetingDateTimeLine_(dateStr, timeStr) {
  var tz = getReportTz_();
  var dateLabel = 'N/A';

  if (dateStr) {
    var d = new Date(dateStr + 'T12:00:00');
    dateLabel = Utilities.formatDate(d, tz, 'EEE, MMM dd, yyyy');
  }

  var line = '\uD83D\uDCC5 *Date:* ' + dateLabel;
  var displayTime = timeStr;
  return line + (displayTime ? '  |  \u23F0 *Time:* ' + displayTime : '');
}

/**
 * Format date/time using the meeting's effective (scheduled) time.
 *
 * @param {{ date: string, time: string, canonicalTitle: string }} meeting
 * @returns {string}
 */
function formatMeetingDateTimeLineForMeeting_(meeting) {
  return formatMeetingDateTimeLine_(meeting.date, meeting.time);
}

/**
 * Build exactly 3 recap bullets per meeting.
 * Uses Key Takeaways first; fills remaining slots from action items.
 *
 * @param {{ takeaways: string[], actionItems: string }} meeting
 * @returns {string[]}
 */
function buildMeetingBullets_(meeting) {
  var bullets = meeting.takeaways.slice();

  if (bullets.length < 3 && meeting.actionItems) {
    var actions = meeting.actionItems.split('\n').filter(function(l) {
      return l.length > 0;
    });
    for (var i = 0; i < actions.length && bullets.length < 3; i++) {
      bullets.push(actions[i]);
    }
  }

  if (bullets.length === 0) {
    return ['_No Fathom recap found for this meeting._'];
  }

  while (bullets.length < 3) {
    bullets.push('\u2014');
  }

  return bullets.slice(0, 3);
}

// =========================================================================
// Slack Block Kit payload builder (multi-block splitting)
// =========================================================================

/**
 * Build a single combined Slack Block Kit payload.
 *
 * Each meeting's takeaways and action items are automatically split
 * across multiple section blocks when they exceed SLACK_MAX_BLOCK_TEXT
 * characters. Emojis and formatting are preserved intact.
 *
 * @param {Array} meetings
 * @param {{ start: Date, end: Date }} weekRange
 * @returns {{ blocks: Object[] }}
 */
function buildCombinedPayload_(meetings, weekRange) {
  var blocks = [];

  // --- Week label for header ---
  var tz = getReportTz_();
  var weekLabel = Utilities.formatDate(weekRange.start, tz, 'MMM dd')
    + '\u2013' + Utilities.formatDate(weekRange.end, tz, 'MMM dd');

  // --- Header ---
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: ':memo: Weekly Commitments \u2022 Week of ' + weekLabel,
      emoji: true
    }
  });
  blocks.push({ type: 'divider' });

  if (meetings.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':warning: No meetings found on Calendar or in Gmail for this week.'
      }
    });
  }

  // --- Per-meeting blocks (capped at MAX_PAYLOAD_BLOCKS) ---
  for (var i = 0; i < meetings.length; i++) {
    var m = meetings[i];

    // Stop early if we're within 3 blocks of the cap (need room for divider +
    // context footer)
    if (blocks.length >= MAX_PAYLOAD_BLOCKS - 3) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':info: ' + (meetings.length - i) + ' more meeting(s) omitted — payload block limit reached.'
        }
      });
      break;
    }

    // Meeting title + formatted date/time (calendar order is enforced upstream)
    var dateTime = formatMeetingDateTimeLineForMeeting_(m);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '\uD83D\uDD38 *Meeting: ' + m.title + '*\n' + dateTime
      }
    });

    // Exactly 3 recap bullets — takeaways first, action items fill gaps
    var bullets = buildMeetingBullets_(m);
    var bulletBlocks = buildTextBlocks_(
      '*Recap:*',
      '*Recap (continued):*',
      bullets,
      function() { return '\u2022 '; }
    );
    blocks = blocks.concat(bulletBlocks);

    // Divider between meetings
    blocks.push({ type: 'divider' });
  }

  // --- Context footer ---
  var now = new Date();
  var tz = getReportTz_();
  var timestamp = Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm') + ' ' + tzAbbrev_(tz);
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: ':calendar: Google Calendar + Gmail recaps \u2022 ' + timestamp
    }]
  });

  return {
    blocks: blocks,
    text: 'Weekly Commitments & Action Items Digest — ' + meetings.length + ' meeting(s)'
  };
}

/**
 * Distribute an array of content lines across one or more Slack section
 * blocks, keeping each block's `text` field under SLACK_MAX_BLOCK_TEXT
 * characters.  The first block gets `firstHeader`; overflow blocks are
 * prefixed with `contHeader`.
 *
 * Each individual line is also capped so that even a single long line
 * combined with `contHeader` stays under the Slack 3000-char hard limit.
 *
 * @param {string}   firstHeader — Header for the first block
 * @param {string}   contHeader  — Header for continuation blocks
 * @param {string[]} lines       — Content lines to distribute
 * @param {function|null} [prefixFn] — Called per-line to prepend a prefix
 *                                     (e.g. returns '• ' for bullets)
 * @returns {Object[]} Array of Slack section block objects
 */
function buildTextBlocks_(firstHeader, contHeader, lines, prefixFn) {
  if (!lines || lines.length === 0) return [];

  var blocks = [];
  var currentText = firstHeader;

  // Hard cap per line so contHeader + '\n' + line always fits in 3000.
  var lineHardCap = SLACK_MAX_BLOCK_TEXT - contHeader.length - 5; // -5 for '\n...'

  for (var i = 0; i < lines.length; i++) {
    var prefix = prefixFn ? prefixFn(lines[i]) : '';
    var line = prefix + lines[i];

    // Truncate absurdly long single lines to prevent Slack 3000-char rejection
    if (line.length > lineHardCap) {
      line = line.substring(0, Math.max(lineHardCap, 0)) + '...';
    }

    // +1 accounts for the '\n' separator
    if (currentText.length + 1 + line.length > SLACK_MAX_BLOCK_TEXT) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: currentText }
      });
      currentText = contHeader + '\n' + line;
    } else {
      currentText += '\n' + line;
    }
  }

  if (currentText.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: currentText }
    });
  }

  return blocks;
}

// =========================================================================
// Pre-flight payload validation
// =========================================================================

/**
 * Validate all blocks in a payload against Slack's hard limits before
 * sending.  If any block exceeds limits, its text is truncated in place.
 * Logs warnings so the cause can be investigated.
 *
 * Section mrkdwn text limit: 3000 chars
 * Header plain_text limit:   150 chars
 *
 * @param {Object[]} blocks — The blocks array to validate in place.
 */
function validateBlocks_(blocks) {
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    if (!block.text) continue;

    if (block.text.type === 'mrkdwn' && block.text.text.length > 3000) {
      console.warn('[WeeklyReporter] Block %d mrkdwn text is %d chars — truncating',
        i, block.text.text.length);
      block.text.text = block.text.text.substring(0, 2997) + '...';
    }

    if (block.text.type === 'plain_text' && block.text.text.length > 150) {
      console.warn('[WeeklyReporter] Block %d plain_text is %d chars — truncating',
        i, block.text.text.length);
      block.text.text = block.text.text.substring(0, 147) + '...';
    }
  }
}

/**
 * Diagnostic — run from Apps Script editor to inspect Gmail recap parsing.
 * Logs every Fathom email found for the current reporting week.
 */
function debugWeeklyGmailRecaps() {
  var weekRange = getWeekRange_();
  var bounds = gmailWeekQueryBounds_(weekRange);
  console.log('[debug] Week %s – %s | query after:%s before:%s',
    Utilities.formatDate(weekRange.start, getReportTz_(), 'yyyy-MM-dd'),
    Utilities.formatDate(weekRange.end, getReportTz_(), 'yyyy-MM-dd'),
    bounds.after, bounds.before);

  var recaps = fetchGmailRecaps_(weekRange);
  for (var i = 0; i < recaps.length; i++) {
    var r = recaps[i];
    console.log('[debug] %d. "%s" date=%s takeaways=%d',
      i + 1, r.rawTitle, r.date, r.takeaways.length);
    for (var t = 0; t < Math.min(r.takeaways.length, 3); t++) {
      console.log('       • %s', r.takeaways[t].substring(0, 120));
    }
  }

  var calendarEvents = fetchCalendarMeetings_(weekRange);
  for (var c = 0; c < calendarEvents.length; c++) {
    var ev = calendarEvents[c];
    var hit = null;
    for (var g = 0; g < recaps.length; g++) {
      if (titlesMatch_(ev.title, recaps[g].rawTitle)) {
        hit = recaps[g];
        break;
      }
    }
    console.log('[debug] Calendar: "%s" (%s) → gmail %s',
      ev.title, ev.date,
      hit ? ('"' + hit.rawTitle + '" ' + hit.takeaways.length + ' bullets') : 'MISS');
  }
}