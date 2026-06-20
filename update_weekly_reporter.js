/**
 * update_weekly_reporter.js
 * ==========================================
 * Automatically injects the high-level 3-bullet point summarization
 * and clean Slack layout blocks logic into src/WeeklyReporter.js.
 */

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const USER_DATA_DIR = path.resolve(os.homedir(), '.config/chromium');
const PROJECT_EDITOR_URL = 'https://script.google.com/home/projects/1EBcHtwWrQP7fZQ0vkwhlXoRbkexVQu3ml0JimC8mhXI4_citeYVq0vLf/edit';

async function main() {
  console.log('[Setup] Launching system Chromium...');
  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: '/usr/bin/chromium',
    channel: 'chrome',
    headless: false,
  });

  const page = await browser.newPage();
  console.log('[Navigation] Opening Apps Script project...');
  await page.goto(PROJECT_EDITOR_URL, { waitUntil: 'networkidle' });

  // 1. Navigate to the src/WeeklyReporter.js file in the sidebar
  console.log('[Editor] Locating src/WeeklyReporter.js...');
  const fileTab = await page.waitForSelector('div[role="treeitem"]:has-text("src/WeeklyReporter.js")');
  await fileTab.click();
  await page.waitForTimeout(1000); // Allow Monaco editor to swap buffers

  // 2. Select all text inside the editor window to prepare for the update
  console.log('[Editor] Overwriting file with clean 3-bullet block layout engine...');
  const editorArea = await page.waitForSelector('.monaco-editor');
  await editorArea.click();
  
  // Select all current messy parsing text and wipe it
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  // 3. Instead of keyboard.type(), we inject the code instantly into the window context to avoid dropping characters
  console.log('[Editor] Injecting clean 3-bullet block layout engine instantly...');
  
  const upgradedCode = `// src/WeeklyReporter.js
function runWeeklyReporterPipeline() {
  const docId = PropertiesService.getScriptProperties().getProperty('MASTER_TARGET_DOC_ID') || '10miHbalFoWzkwmGV9oHVU-CDW18dXLZz4o2tby6lzcM';
  const doc = DocumentApp.openById(docId);
  const text = doc.getBody().getText();
  
  // Normalized spaces here to match the document layout perfectly
  const rawMeetings = text.split('### :white_check_mark: Inbound Webhook');
  const processedMeetings = [];
  
  // High-level extraction logic to get clean datasets
  for (let i = 1; i < rawMeetings.length; i++) {
    const rawChunk = rawMeetings[i];
    if (!rawChunk.includes('Recording:')) continue;
    
    const titleMatch = rawChunk.match(/Recap for "([^"]+)"/);
    const dateMatch = rawChunk.match(/(\\d{4}-\\d{2}-\\d{2})/);
    if (!titleMatch) continue;
    
    const title = titleMatch[1];
    const date = dateMatch ? dateMatch[1] : 'Recent Meeting';
    
    const bulletPool = rawChunk.split('\\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('•') || line.startsWith('-'))
      .map(line => line.replace(/^[•\\-\\s]+/, ''));
      
    const bullet1 = bulletPool[0] || 'Review system commitments log.';
    const bullet2 = bulletPool[1] || 'Coordinate next steps with operational leads.';
    const bullet3 = bulletPool[2] || 'Check project channels for timeline updates.';
    
    let ownershipText = 'Review general workflow milestones.';
    if (rawChunk.includes('Next Steps') || rawChunk.includes('Próximos pasos')) {
      const parts = rawChunk.split(/(?:Next Steps|Próximos pasos)/i);
      ownershipText = parts[1].split('###')[0].trim().substring(0, 250) + '...';
    }
    
    processedMeetings.push({ title, date, bullet1, bullet2, bullet3, ownership: ownershipText });
  }
  
  if (processedMeetings.length === 0) {
    console.log('No recent meetings available to summarize.');
    return;
  }
  
  const slackPayload = formatSlackPayload(processedMeetings);
  sendSlackNotification(slackPayload);
}

function formatSlackPayload(meetings) {
  let blocks = [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "📋 System Digest: Commitments & Action Items", "emoji": true }
    },
    { "type": "divider" }
  ];

  meetings.forEach(meeting => {
    blocks.push(
      {
        "type": "section",
        "text": { "type": "mrkdwn", "text": "*▶️ Meeting: " + meeting.title + "*\\n📅 *Date:* " + meeting.date }
      },
      {
        "type": "section",
        "text": { "type": "mrkdwn", "text": "*Top 3 Takeaways:*\\n• " + meeting.bullet1 + "\\n• " + meeting.bullet2 + "\\n• " + meeting.bullet3 }
      },
      {
        "type": "section",
        "text": { "type": "mrkdwn", "text": "👤 *Action Items / Ownership:*\\n" + meeting.ownership }
      },
      { "type": "divider" }
    );
  });

  return { "blocks": blocks };
}

function sendSlackNotification(payload) {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL') || "YOUR_SLACK_WEBHOOK_URL_HERE";
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload)
  };
  UrlFetchApp.fetch(webhookUrl, options);
  console.log('[OK] Clean digest posted.');
}`;

  // Execute an internal page script to overwrite the editor session value directly
  await page.evaluate((code) => {
    const editor = window.monaco.editor.getModels()[0];
    if (editor) {
      editor.setValue(code);
    } else {
      document.querySelector('.monaco-editor').innerText = code;
    }
  }, upgradedCode);
  
  await page.waitForTimeout(500);

  // 4. Force Save
  console.log('[Editor] Saving clean code layout...');
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(2000);

  console.log('[Ready] Code injected successfully. Closing browser.');
  await browser.close();
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});