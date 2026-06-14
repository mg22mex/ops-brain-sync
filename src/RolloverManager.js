/**
 * RolloverManager — Document rollover guard
 *
 * Before appending content, checks the target document's approximate word
 * count.  If it approaches 400,000 words, automatically creates a new
 * monthly continuation document in Google Drive to stay well under
 * NotebookLM's 500,000-word processing limit.
 *
 * Exports:
 *   checkAndRolloverIfNeeded_(docId) — Returns the active doc ID (same or new)
 */

/** Safety margin below NotebookLM's 500k ceiling */
var WORD_LIMIT_WARN = 380000;

/**
 * Check word count of a document.  If it exceeds WORD_LIMIT_WARN, create a
 * new monthly doc and return its ID; otherwise return the original ID.
 *
 * @param {string} currentDocId
 * @returns {string} — The doc ID to append to (same or newly created)
 */
function checkAndRolloverIfNeeded_(currentDocId) {
  try {
    var doc = DocumentApp.openById(currentDocId);
    var body = doc.getBody();
    var text = body.getText();

    var wordCount = estimateWordCount_(text);

    // Still under threshold — keep using the current doc
    if (wordCount < WORD_LIMIT_WARN) {
      console.log(
        '[Rollover] Doc %s is ~%s words — under %s threshold, continuing.',
        currentDocId, wordCount, WORD_LIMIT_WARN
      );
      return currentDocId;
    }

    // Threshold breached — roll over
    console.log(
      '[Rollover] Doc %s has ~%s words — creating monthly continuation.',
      currentDocId, wordCount
    );

    return createMonthlyContinuationDoc_();
  } catch (err) {
    console.error('[Rollover] Error checking doc %s: %s', currentDocId, err.message);
    // On failure, return the original ID so the pipeline doesn't hard-crash
    return currentDocId;
  }
}

/**
 * Rough word count via splitting on whitespace.
 * @param {string} text
 * @returns {number}
 */
function estimateWordCount_(text) {
  if (!text || text.length === 0) return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * Create a new monthly Google Doc in the user's Drive root.
 * Naming convention:  "ops-brain-sync YYYY-MM"
 *
 * @returns {string} — The newly created document's ID
 */
function createMonthlyContinuationDoc_() {
  var now = new Date();
  var year = now.getFullYear();
  var month = String(now.getMonth() + 1).padStart(2, '0');
  var title = 'ops-brain-sync ' + year + '-' + month;

  var newDoc = DocumentApp.create(title);
  var newId = newDoc.getId();

  // Write a header so the doc is immediately identifiable
  var newBody = newDoc.getBody();
  newBody.appendParagraph('# ops-brain-sync \u2014 Monthly Log');
  newBody.appendParagraph('Started: ' + now.toISOString());
  newBody.appendParagraph('');
  newDoc.saveAndClose();

  console.log('[Rollover] Created continuation doc: "%s" (%s)', title, newId);

  // Update the placeholder variable in the project properties
  // so subsequent invocations automatically target the new doc.
  PropertiesService.getScriptProperties()
    .setProperty('TARGET_DOC_ID', newId);

  return newId;
}
