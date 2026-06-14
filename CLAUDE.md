# Google Apps Script Sync Pipeline Engine (ops-brain-sync)

## Project Context
Building a serverless Google Apps Script Web App that acts as a central data staging webhook handler and Gmail processing engine for NotebookLM.

## Tech Stack
- Google Apps Script (JavaScript / V8 Engine)
- Clasp CLI (Google Apps Script CLI tool)

## Hard Development Rules
- Keep scripts highly modular.
- Every incoming webhook payload must be stripped of metadata/JSON noise and formatted into clean Markdown headers/bullets before appending to Google Docs.
- Strictly adhere to the 6-minute execution limit; use time-batching logic for heavy Gmail processing loops.
- Implement an automated rollover check: If a target doc exceeds 400,000 words, create a new monthly document file automatically to prevent hitting NotebookLM's 500k ceiling.

## Build & Deploy Commands
- Initialize Clasp: `clasp login` then `clasp create --type webapp`
- Pull remote code: `clasp pull`
- Push local code: `clasp push`
- Deploy Web App: `clasp deploy`