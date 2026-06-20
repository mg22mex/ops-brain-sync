/**
 * run_apps_script_ui.js
 * ======================
 * Launches a persistent Chromium session with your local profile to access
 * the Google Apps Script editor UI. Useful for manual verification and
 * quick UI-based edits without re-authenticating.
 *
 * Prerequisites:
 *   1. You must be logged into Google Chrome/Chromium in the profile
 *      at the path indicated by USER_DATA_DIR below.
 *   2. Close ALL Chromium/Chrome windows before running this script
 *      (persistent context will fail if the profile directory is locked).
 *
 * Usage:
 *   node run_apps_script_ui.js
 */

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const USER_DATA_DIR = path.resolve(os.homedir(), '.config/chromium');

const PROJECT_EDITOR_URL =
  'https://script.google.com/home/projects/1EBcHtwWrQP7fZQ0vkwhlXoRbkexVQu3ml0JimC8mhXI4_citeYVq0vLf/edit';

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

console.log('');
console.log('==============================================================');
console.log('  IMPORTANT: Close ALL Chromium/Chrome browser windows first!');
console.log('  The persistent context needs exclusive access to the profile');
console.log('  directory. If another process holds the lock, this will fail.');
console.log('==============================================================');
console.log('');

console.log('[Setup] USER_DATA_DIR: %s', USER_DATA_DIR);
console.log('[Setup] Target URL:    %s', PROJECT_EDITOR_URL);
console.log('');

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

async function main() {
  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: '/usr/bin/chromium', // Directs Playwright to your Linux system install
    channel: 'chrome',                   // Uses system binaries instead of internal download wrappers
    headless: false,
  });

  const page = await browser.newPage();
  await page.goto(PROJECT_EDITOR_URL, { waitUntil: 'networkidle' });

  console.log('[OK] Page loaded — the editor should now be visible.');
  console.log('');

  // -----------------------------------------------------------------------
  // Placeholder: Locate the Code.gs editor pane
  // -----------------------------------------------------------------------
  // The Apps Script editor loads files as Monaco tabs. The active file's
  // content is typically inside a <div> with role="code" or a
  // .monaco-editor container.
  //
  // Example selectors to investigate (use page.$() / page.$$() in dev tools):
  //   - page.waitForSelector('.monaco-editor')
  //   - page.waitForSelector('div[role="code"]')
  //   - page.waitForSelector('.view-lines')
  //
  // Once the editor is focused, you can read or manipulate the content:
  //
  //   const editorPane = await page.waitForSelector('.monaco-editor');
  //   await editorPane.click();  // Focus the editor
  //

  // -----------------------------------------------------------------------
  // Placeholder: Fix SCRIPT_START_TIME fallback logic
  // -----------------------------------------------------------------------
  // Locate the getScriptStartTime_() function and confirm the fallback
  // guard is in place. In the Monaco editor, you can search for text
  // by sending Ctrl+F (Cmd+F on macOS) and typing the function name.
  //
  // Example keyboard navigation:
  //   await page.keyboard.press('Control+f');
  //   await page.keyboard.type('getScriptStartTime_');
  //   await page.keyboard.press('Escape');
  //
  // The function should look like:
  //
  //   function getScriptStartTime_() {
  //     if (SCRIPT_START_TIME === null || typeof SCRIPT_START_TIME === 'undefined') {
  //       SCRIPT_START_TIME = new Date().getTime();
  //       console.log('...');
  //     }
  //     return SCRIPT_START_TIME;
  //   }
  //
  // If the guard is missing, you can type the replacement directly into
  // the editor pane:
  //
  //   const editor = await page.waitForSelector('.view-lines');
  //   await editor.click();
  //   // ... navigate to the right line via keyboard or mouse ...
  //   await page.keyboard.press('Control+s');
  //

  // -----------------------------------------------------------------------
  // Placeholder: Trigger UI save (Ctrl+S)
  // -----------------------------------------------------------------------
  // After making changes in the editor, save by sending the keyboard
  // shortcut. The Apps Script editor autosaves periodically, but an
  // explicit save is safer before closing.
  //
  //   await page.keyboard.press('Control+s');
  //   console.log('[OK] Save triggered.');
  //
  // You can also watch for the "Saving…" / "Saved" toast in the UI:
  //
  //   await page.waitForSelector('span:has-text("Saved")', { timeout: 10000 });
  //   console.log('[OK] Save confirmed.');
  //

  console.log('[Ready] Browser is open. Interact manually, then close the window when done.');
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});