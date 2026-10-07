---
name: feature-dev-workflow
description: Mandatory workflow whenever asked to develop a new feature or fix a bug in this repo. Run npm run lint after every code change; lint is the only verification (no smoke tests of any kind, no e2e/browser testing), and finish with a commit-message summary of all changes.
---

# Feature Development / Bug-Fix Workflow

Apply this workflow for **every** request to develop a feature or fix a bug in this repository.

## Rules

1. **Lint after every code change**
   - After each file edit (or small batch of related edits), run:
     ```bash
     npm run lint
     ```
   - Do not proceed to the next change until the output is clean.
   - If lint reports errors: fix them immediately, re-run `npm run lint`, and only move on once it passes.
   - Never leave a known lint violation behind, and never skip the lint step to save time.

2. **No smoke tests of any kind — lint is the only verification**
   - `npm run lint` is the **sole** verification gate for this workflow. Do not perform any other form of verification.
   - Do **not** run the app, launch servers/clients, exercise the UI, or interact with a running build to "check it works".
   - Do **not** write or run throwaway/scratch scripts, one-off test harnesses, or ad-hoc smoke checks.
   - Do **not** spin up browser-based end-to-end tests (no Playwright, Puppeteer, or manual browser sessions).
   - If a change is clean per lint, it is done — do not add extra verification to "be safe".

3. **Finish with a commit-message summary**
   - When the whole task is done (all changes made and lint passing), present a commit-message-style summary of the work:
     - **Title**: a short, imperative summary of the change (e.g. `Add portal cooldown indicator`).
     - **Body**: a detailed description of exactly what was changed — which files, which functions/sections, and why — so the summary can be used verbatim as a commit message.

## Example summary format

```
Fix portal cooldown desync between clients

- client/portals.js: reset cooldown timer on server snapshot to prevent
  stale cooldowns after reconnection
- shared/constants.js: add PORTAL_COOLDOWN_MS shared constant
- npm run lint passes clean
```
