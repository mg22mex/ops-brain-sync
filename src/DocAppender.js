/**
 * DocAppender — Google Document append operations
 *
 * Opens a target Google Doc by ID and appends pre-formatted Markdown text
 * to the end of its body.  Provides a thin wrapper around
 * DocumentApp.Body operations with clean error boundaries.
 */

/**
 * Append a Markdown-formatted string to the end of a Google Doc body.
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

  var doc = DocumentApp.openById(docId);
  var body = doc.getBody();

  // Insert a blank separator line before the new block
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
      // Horizontal rules — render as a thin heading for visual clarity
      paragraph.setHeading(DocumentApp.ParagraphHeading.SUBTITLE);
    } else {
      paragraph.setHeading(DocumentApp.ParagraphHeading.NORMAL);
    }
  }

  doc.saveAndClose();
  console.log('[DocAppender] Appended %d lines to doc %s', lines.length, docId);
}
