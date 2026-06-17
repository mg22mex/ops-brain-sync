/**
 * DocAppender — Google Document & File append operations with retry-backoff
 *
 * Opens a target Google Doc by ID and appends pre-formatted Markdown text
 * to the end of its body. Also manages isolated daily Markdown files
 * inside the NotebookLM source folder for high-volume chat streams.
 *
 * All document write operations use exponential backoff retry to handle
 * "Service Documents failed" concurrency errors gracefully.
 */

/** Maximum retry attempts for document write operations */
var DOC_APPENDER_MAX_RETRIES = 3;

/**
 * Append a Markdown-formatted string to the end of a Google Doc body.
 * Retries with exponential backoff on failure.
 *
 * @param {string} docId      — The target document's ID
 * @param {string} markdown   — Pre-formatted Markdown text to append
 */
function appendToDoc(docId, markdown) {
  if (!docId || docId.length === 0) {
    throw new Error('appendToDoc: docId is empty');
  }
  if (!markdown || markdown.length === 0) {
    console.warn('[DocAppender] Empty markdown — skipping append');
    return;
  }

  for (var attempt = 1; attempt <= DOC_APPENDER_MAX_RETRIES; attempt++) {
    try {
      var doc = DocumentApp.openById(docId);
      var body = doc.getBody();

      // Insert blank separator lines before the new block
      body.appendParagraph('');
      body.appendParagraph('');

      // Split into lines and append each as a paragraph
      var lines = markdown.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var paragraph = body.appendParagraph(line);

        // Apply header styling for lines that start with ###
        if (/^### /.test(line)) {
          paragraph.setHeading(DocumentApp.ParagraphHeading.HEADING3);
          paragraph.setAttributes({
            [DocumentApp.Attribute.BOLD]: true
          });
        } else if (/^---$/.test(line)) {
          // Horizontal rules — render as a subtitle style for separation
          paragraph.setHeading(DocumentApp.ParagraphHeading.SUBTITLE);
        } else {
          paragraph.setHeading(DocumentApp.ParagraphHeading.NORMAL);
        }
      }

      doc.saveAndClose();
      console.log('[DocAppender] Appended %d lines to doc %s (attempt %d)',
        lines.length, docId, attempt);
      return; // Success — exit

    } catch (err) {
      if (attempt === DOC_APPENDER_MAX_RETRIES) {
        console.error('[DocAppender] All %d attempts failed for doc %s: %s',
          DOC_APPENDER_MAX_RETRIES, docId, err.message);
        throw err; // Hard failure after exhausting retries
      }

      var backoffMs = 2000 * attempt;
      console.warn('[DocAppender] Attempt %d/%d failed for doc %s: %s. Retrying in %dms...',
        attempt, DOC_APPENDER_MAX_RETRIES, docId, err.message, backoffMs);
      Utilities.sleep(backoffMs);
    }
  }
}

/**
 * Append a Slack message block to a single running daily log file
 * inside the dedicated NotebookLM source folder.
 * Retries with exponential backoff on Drive/file access failure.
 *
 * @param {string} folderId   — The NotebookLM source folder ID
 * @param {string} markdown   — Pre-formatted Markdown message entry
 */
function appendSlackToDailyFile(folderId, markdown) {
  if (!folderId || folderId.length === 0) {
    throw new Error('appendSlackToDailyFile: folderId is empty');
  }
  if (!markdown || markdown.length === 0) return;

  for (var attempt = 1; attempt <= DOC_APPENDER_MAX_RETRIES; attempt++) {
    try {
      var folder = DriveApp.getFolderById(folderId);
      var dateString = Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd');
      var fileName = 'Slack-Log-' + dateString + '.md';

      var file;
      var files = folder.getFilesByName(fileName);

      if (files.hasNext()) {
        // File exists for today, grab it
        file = files.next();
        var existingContent = file.getBlob().getDataAsString();
        // Append the new message entry to the existing contents
        var updatedContent = existingContent + '\n\n' + markdown;
        file.setContent(updatedContent);
      } else {
        // Create a fresh file with a clean Markdown structure for NotebookLM
        var initialContent = '# Slack Communication Transcript — ' + dateString + '\n\n' + markdown;
        file = folder.createFile(fileName, initialContent, MimeType.PLAIN_TEXT);
      }

      console.log('[DocAppender] Successfully pushed Slack message to %s (attempt %d)',
        fileName, attempt);
      return; // Success — exit

    } catch (err) {
      if (attempt === DOC_APPENDER_MAX_RETRIES) {
        console.error('[DocAppender] All %d attempts failed for daily file: %s',
          DOC_APPENDER_MAX_RETRIES, err.message);
        throw err; // Hard failure after exhausting retries
      }

      var backoffMs = 2000 * attempt;
      console.warn('[DocAppender] Attempt %d/%d failed for daily file: %s. Retrying in %dms...',
        attempt, DOC_APPENDER_MAX_RETRIES, err.message, backoffMs);
      Utilities.sleep(backoffMs);
    }
  }
}
