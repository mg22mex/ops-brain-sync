/**
 * FileWriter — Modular Drive file writer + retention lifecycle manager
 * =====================================================================
 * Replaces the monolithic DocAppender + RolloverManager with a folder-based
 * file-per-record architecture. Each data source writes individual dated
 * Markdown files to its own dedicated Drive folder. Retention policies
 * are enforced at the end of each sync cycle via cleanupOldFiles().
 *
 * Exports:
 *   createNewDriveFile(folderId, fileName, content) — Write one file
 *   cleanupOldFiles(folderId, maxDays)              — Purge expired files
 *   sanitizeFileName(name)                          — Safe filename helper
 */

var FILE_WRITER_MAX_RETRIES_ = 3;

/**
 * Create (or overwrite) a single Markdown file in the target Drive folder.
 * Uses exponential backoff retry for transient Drive failures.
 *
 * @param {string} folderId  — Google Drive folder ID
 * @param {string} fileName  — Filename including .md extension
 * @param {string} content   — File content (Markdown text)
 * @returns {string} — The created file's ID
 */
function createNewDriveFile(folderId, fileName, content) {
  if (!folderId) throw new Error('createNewDriveFile: folderId is empty');
  if (!fileName) throw new Error('createNewDriveFile: fileName is empty');
  if (!content || content.length === 0) {
    console.warn('[FileWriter] Empty content — skipping %s', fileName);
    return null;
  }

  for (var attempt = 1; attempt <= FILE_WRITER_MAX_RETRIES_; attempt++) {
    try {
      var folder = DriveApp.getFolderById(folderId);
      var safeName = sanitizeFileName(fileName);

      // Remove any existing file with the same name (dedup by filename)
      var existing = folder.getFilesByName(safeName);
      while (existing.hasNext()) {
        existing.next().setTrashed(true);
      }

      var file = folder.createFile(safeName, content, MimeType.PLAIN_TEXT);
      console.log('[FileWriter] Created %s (%d bytes) in folder %s',
        safeName, content.length, folderId);
      return file.getId();

    } catch (err) {
      if (attempt === FILE_WRITER_MAX_RETRIES_) {
        console.error('[FileWriter] All %d attempts failed for %s: %s',
          FILE_WRITER_MAX_RETRIES_, fileName, err.message);
        throw err;
      }
      var backoffMs = 2000 * attempt;
      console.warn('[FileWriter] Attempt %d/%d failed for %s: %s. Retrying in %dms...',
        attempt, FILE_WRITER_MAX_RETRIES_, fileName, err.message, backoffMs);
      Utilities.sleep(backoffMs);
    }
  }
  return null;
}

/**
 * Enforce a time-based retention policy: trashes any files in the folder
 * whose creation date is older than maxDays.
 *
 * Runs a time-guarded loop to stay under the 6-minute execution ceiling.
 *
 * @param {string} folderId — Google Drive folder ID to clean
 * @param {number} maxDays  — Maximum age in days (0 = no cleanup / permanent)
 * @param {number} [timeLimitMs] — Optional loop time cap (default 120000 = 2 min)
 */
function cleanupOldFiles(folderId, maxDays, timeLimitMs) {
  if (!folderId || maxDays <= 0) {
    console.log('[FileWriter] Cleanup skipped (maxDays=%s for folder %s)', maxDays, folderId);
    return;
  }

  timeLimitMs = timeLimitMs || 120000;
  var startTime = new Date().getTime();
  var now = new Date();
  var cutoffMs = now.getTime() - maxDays * 24 * 60 * 60 * 1000;
  var trashed = 0;
  var errors = 0;

  try {
    var folder = DriveApp.getFolderById(folderId);
    var files = folder.getFiles();

    while (files.hasNext()) {
      if (new Date().getTime() - startTime > timeLimitMs) {
        console.log('[FileWriter] Cleanup time limit reached — trashed %d file(s) so far', trashed);
        break;
      }

      try {
        var file = files.next();
        var createdMs = file.getDateCreated().getTime();

        if (createdMs < cutoffMs) {
          file.setTrashed(true);
          trashed++;
          console.log('[FileWriter] Trashed %s (created %s)', file.getName(), file.getDateCreated());
        }
      } catch (fileErr) {
        errors++;
        console.warn('[FileWriter] Error processing file during cleanup: %s', fileErr.message);
      }
    }

  } catch (folderErr) {
    console.error('[FileWriter] Cannot access folder %s for cleanup: %s', folderId, folderErr.message);
    return;
  }

  console.log('[FileWriter] Cleanup complete for folder %s: %d trashed, %d errors',
    folderId, trashed, errors);
}

/**
 * Sanitize a filename for Drive compatibility: replace special characters,
 * collapse whitespace, and ensure .md extension.
 *
 * @param {string} name — Raw filename
 * @returns {string} — Safe filename ending in .md
 */
function sanitizeFileName(name) {
  if (!name) return 'unnamed.md';

  var safe = String(name)
    .replace(/[<>:"\/\\|?*]/g, '_')   // Replace Drive-unsafe chars
    .replace(/\s+/g, ' ')             // Collapse whitespace
    .replace(/\.{2,}/g, '.')          // Collapse dots
    .trim();

  // Truncate absurdly long filenames (Drive limit is ~200 chars)
  if (safe.length > 180) {
    safe = safe.substring(0, 177) + '...';
  }

  // Ensure .md extension
  if (safe.indexOf('.md') !== safe.length - 3) {
    // Check if it ends in .md (case-insensitive)
    if (!/\.md$/i.test(safe)) {
      safe += '.md';
    }
  }

  return safe || 'unnamed.md';
}

/**
 * ============================================================================
 * Message ID Registry — Atomic processing dedup via Script Properties
 * ============================================================================
 * Maintains a FIFO list of processed Gmail message IDs to prevent duplicate
 * file creation across cycles. Uses comma-separated values stored under
 * 'ProcessedMessageIDs' key. Capped at MSG_REGISTRY_MAX_ entries to stay
 * well within the 9KB Script Properties value limit (~6KB at 300 entries).
 */
var MSG_REGISTRY_KEY_ = 'ProcessedMessageIDs';
var MSG_REGISTRY_MAX_ = 500;

/**
 * Check if a Gmail message ID has already been processed.
 * @param {string} messageId — Gmail message.getId() value
 * @returns {boolean}
 */
function isMessageProcessed_(messageId) {
  if (!messageId) return false;
  var raw = PropertiesService.getScriptProperties().getProperty(MSG_REGISTRY_KEY_);
  if (!raw) return false;
  var ids = raw.split(',');
  return ids.indexOf(messageId) !== -1;
}

/**
 * Mark a Gmail message ID as processed. Appends to the FIFO list and
 * truncates oldest entries if over MSG_REGISTRY_MAX_.
 * @param {string} messageId — Gmail message.getId() value
 */
function markMessageProcessed_(messageId) {
  if (!messageId) return;
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(MSG_REGISTRY_KEY_) || '';
  var ids = raw ? raw.split(',') : [];

  // Guard against duplicate entries (shouldn't happen with check-before-call,
  // but protects against concurrent trigger races)
  if (ids.indexOf(messageId) !== -1) return;

  ids.push(messageId);

  // FIFO truncation: keep only the last MSG_REGISTRY_MAX_
  if (ids.length > MSG_REGISTRY_MAX_) {
    ids = ids.slice(ids.length - MSG_REGISTRY_MAX_);
  }

  props.setProperty(MSG_REGISTRY_KEY_, ids.join(','));
  console.log('[FileWriter] Registry now has %d message ID(s)', ids.length);
}

/**
 * Clear the entire message ID registry. Useful for manual reset via editor.
 */
function resetMessageRegistry() {
  PropertiesService.getScriptProperties().deleteProperty(MSG_REGISTRY_KEY_);
  console.log('[FileWriter] Message ID registry cleared');
}
