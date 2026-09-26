# Accessible Attention for Excel — Hackathon build

## What we're building

An accessibility layer for spreadsheets. It helps blind and low-vision users **orient** themselves, **explore** data, and **notice** important information (visual or statistical) through speech, audio cues and haptics. Track: *Hearing Hues* (blind and low-vision users).

Core message: **"Screen readers make spreadsheet cells readable. We make visual attention accessible."**

Four actions define the product. Every feature must map to one of them:

1. **ORIENT**: "What am I looking at?" An instant spoken overview when a file opens.
2. **EXPLORE**: "What's here?" Moving across cells announces location, row context, column context and value, e.g. "G17. Italy. Q3 Revenue. €82,400."
3. **NOTICE**: "What deserves attention?" A distinct audio cue (and vibration where supported) on salient cells, plus a "take me to something important" jump.
4. **UNDERSTAND**: "Why?" An on-demand, one-sentence explanation of why a cell was flagged.

The AI is one component, not the product. The **attention engine** (our own deterministic code) decides what is important. The LLM only turns those findings into short sentences.

## MVP (the only thing to build)

Upload .xlsx → overview → explore the grid → attention cue → press "Why?"

### Out of scope (do not build)

Excel replacement, cell editing, spreadsheet chatbot, voice-controlled formulas, chart generation, many statistical tests, native screen-reader plugins, custom haptic hardware, native mobile app, auth, database, multi-user anything.

## Stack

- **Hosting:** Vercel. Static frontend from `public/`, Python API as one serverless function (`api/index.py`, FastAPI).
- **Backend:** Python 3.11+, FastAPI, openpyxl, python-multipart (required for file uploads). **No pandas**: use the `statistics` module, which keeps the function small and cold starts fast.
- **Frontend:** plain HTML/CSS/JS in `public/`, no build step and no framework. Use ES modules.
- **Browser APIs:** Web Speech API (`speechSynthesis`), Web Audio API (earcons), Vibration API (`navigator.vibrate`, Android Chrome only, so always feature-detect).
- **LLM:** Anthropic API through the `anthropic` Python SDK. Read the key from `ANTHROPIC_API_KEY` and the model from `ANTHROPIC_MODEL`. **Every LLM call must have a template fallback** so the demo works offline or without a key.

## Project layout

```
api/
  index.py           # FastAPI app: the single Vercel function
  _lib/              # underscore = not exposed as a route by Vercel
    __init__.py
    extract.py       # openpyxl → SheetModel
    attention.py     # rules → signals per cell
    overview.py      # ORIENT text (template, optional LLM polish)
    explain.py       # UNDERSTAND text (template, optional LLM polish)
    models.py        # pydantic models
public/
  index.html
  app.js             # grid rendering, navigation, state
  voice.js           # speech + aria-live output
  cues.js            # earcons + vibration
  styles.css
  demo/sales_demo.xlsx   # recalculated demo file, served statically
scripts/
  make_demo.py       # builds the demo workbook (run locally, commit the output)
tests/
  test_attention.py
requirements.txt     # fastapi, openpyxl, python-multipart, anthropic
vercel.json
```

`vercel.json` rewrites every `/api/*` path to the one FastAPI function:

```json
{ "rewrites": [{ "source": "/api/(.*)", "destination": "/api/index" }] }
```

## API — stateless (serverless)

Vercel functions don't share memory between requests, so **the server keeps no state**. The browser holds the SheetModel and sends whatever context a call needs.

- `POST /api/upload` (multipart .xlsx, first worksheet only) → `SheetModel` JSON, with signals and the template overview already computed.
- `POST /api/explain` with body `{cell, row_label, col_header, row_values, signals}` → `{text}`
- `POST /api/overview` with the overview facts JSON → `{text}` (LLM polish; the frontend already has the template version and swaps it in only if this returns in time)
- `GET /api/health` → `{ok: true, llm: <key present?>}`

**"Load demo"** fetches `/demo/sales_demo.xlsx` from `public/` and POSTs it to `/api/upload`, so the demo goes through exactly the same pipeline as a real upload.

Vercel limits: request bodies max ~4.5 MB (reject larger files with a spoken message), and keep every LLM call under a 5 s timeout with the template fallback.

### SheetModel

```json
{
  "id": "abc123",
  "title": "Sales Performance 2026",
  "n_rows": 9, "n_cols": 13,
  "header_row": 1, "label_col": 1,
  "col_headers": ["Country", "Jan", "Feb", "..."],
  "row_labels": ["France", "Italy", "..."],
  "overview": "This sheet contains monthly revenue for eight countries...",
  "cells": [
    {
      "ref": "G3", "row": 3, "col": 7,
      "value": 82400, "display": "€82,400",
      "row_label": "Italy", "col_header": "Jun",
      "fill": "FFFF0000", "bold": false,
      "formula": null, "error": null,
      "signals": [
        {"type": "visual", "severity": "high", "detail": "Author highlighted this cell in red"}
      ]
    }
  ],
  "attention_order": ["G3", "E5", "..."]
}
```

## Extraction (extract.py)

- Load the workbook **twice**: `data_only=False` to get formulas, `data_only=True` to get cached values and errors.
- **Gotcha:** openpyxl never calculates formulas. A file written by openpyxl has no cached values, so `#DIV/0!` will not appear. The demo file must be recalculated and saved by a spreadsheet app (see Demo data below).
- Header detection (keep it simple): the first non-empty row where most cells are strings is the header row. The first column with mostly strings below it holds the row labels. Use the sheet title, or cell A1 if it is a lone title, as `title`.
- Capture per cell: value, formatted display (respect the number format where easy, otherwise format numbers sensibly), fill colour (`cell.fill.fgColor.rgb` when `fill_type == "solid"`), bold, formula, error string (`#DIV/0!`, `#N/A`, `#VALUE!`, `#REF!`, `#NAME?`).
- Treat theme and indexed colours defensively: if the colour can't be resolved, record `"fill": "unknown-non-default"` rather than crash.

## Attention engine (attention.py)

Pure functions with no I/O, fully unit-tested. Four signal types:

| Type | Rule (prototype) | Example detail |
|---|---|---|
| `visual` | non-default solid fill, or red/orange font; bold only if the rest of the row isn't bold | "Author highlighted this cell in red" |
| `anomaly` | within its row series (numeric cells in the same row), robust z-score using median/MAD > 3.5, **or** more than 40% away from the row median. Skip series with fewer than 4 numbers. | "43% below Italy's median" |
| `trend` | at least 3 consecutive increases (or decreases) followed by a move in the opposite direction larger than 25% | "Breaks a 4-month upward trend" |
| `error` | cell holds an Excel error value | "Formula error: division by zero" |

- Severity: `error` is always high; `visual` is high; `anomaly`/`trend` are medium, or high if both hit the same cell.
- `attention_order`: sort by severity, then reading order (row, col).
- Name colours in plain words (red, orange, yellow, green, blue, grey) by nearest hue. Never read hex codes aloud.
- Also run the series logic column-wise when the sheet is clearly column-oriented (row labels are time periods). Default is row-wise.

## Overview (overview.py): ORIENT

A template first, built from computed facts:
"{title}. {n_rows} rows of {row label kind} by {n_cols} columns, from {first col header} to {last col header}. Overall, values {rise/fall/stay flat}. I found {k} areas that may deserve your attention: {counts by type}."

Optional LLM polish: send only the facts JSON, ask for 2 sentences maximum and no invented numbers. On any failure, use the template.

## Explanation (explain.py): UNDERSTAND

- Input: one cell plus its signals and row context (neighbouring values).
- Template fallback joins the signal details: "Revenue is 43% below Italy's median and breaks a 4-month upward trend. The author also highlighted this cell in red."
- LLM prompt: facts only, 1–2 sentences, plain spoken English, no markdown, never state a number that isn't in the input.
- Cache results in the browser per cell ref (the server is stateless).

## Frontend interaction

### Layout
- Upload button, "Load demo" button, mode toggle, and a visible grid (so sighted judges can follow along).
- The focused cell has a strong visible outline. Flagged cells show a small corner marker by type.

### Keyboard (primary)
| Key | Action |
|---|---|
| Arrow keys | move one cell; announce it (EXPLORE) |
| `O` | speak the overview (ORIENT) |
| `N` / `Shift+N` | jump to next / previous important cell (NOTICE) |
| `W` or `?` | explain the current cell (UNDERSTAND) |
| `R` / `C` | read the whole current row / column header context |
| `Esc` | stop speech |

Put the grid container at `role="application"` with an `aria-label` and a clear instruction, so screen readers in browse mode pass the arrow keys through.

### Pointer and touch exploration
- Hovering, or dragging a finger over the grid, announces the cell under the pointer, throttled to about 150 ms and only when the cell changes.
- This is the "spatial exploration" differentiator: show it in the demo on a phone or trackpad.

### Output: two modes
1. **Self-voicing (default for the demo):** `speechSynthesis`. Always `cancel()` the previous utterance before speaking so speech never queues behind navigation. Speaking rate is adjustable.
2. **Screen-reader mode:** no self-voicing. Write announcements to an `aria-live="polite"` region (use `assertive` only for attention cues) so VoiceOver or NVDA speaks them. This proves the tool works *with* existing assistive tech rather than replacing it.

### Cues (cues.js): NOTICE
- Normal cell: a very short, quiet tick (Web Audio, about 30 ms).
- Flagged cell: a distinct "buzz" earcon played **before** the speech, with a different timbre or pitch per type (visual, anomaly, trend, error). Keep all four easy to tell apart.
- If `navigator.vibrate` exists: flagged cell → `[60, 40, 60]`, error → `[200]`.
- The announcement for a flagged cell appends a short label only: "Italy. May revenue. €31,000. Unusual value." The full reason comes only when the user presses `W`.

## Demo data (scripts/make_demo.py, run locally only)

Monthly revenue, 8 European countries × 12 months, with an upward drift and some noise. Plant exactly four moments:

1. **Visual:** one ordinary value filled red (e.g. Spain, March).
2. **Anomaly:** one extreme value with no formatting (e.g. Italy, May = €31,000 when neighbours are around €80,000).
3. **Trend reversal:** Germany: 100 → 110 → 120 → 135 → 145 → 80 (in thousands) across consecutive months.
4. **Formula error:** a "Growth %" column where one row divides by an empty or zero cell → `#DIV/0!`.

Generate with openpyxl, then **recalculate and save with LibreOffice headless** so cached values and errors exist:

```
soffice --headless --convert-to xlsx --outdir build/recalc build/sales_demo_raw.xlsx
```

Copy the recalculated file to `public/demo/sales_demo.xlsx` and commit it. LibreOffice is never needed on Vercel. Margaux's Mac has no LibreOffice or Homebrew, so the default route is manual: she opens the raw file in Excel (or uploads it to Google Sheets and downloads it as .xlsx), which stores the calculated values. If LibreOffice isn't available locally, tell me and I'll open the file in Excel and save it once by hand. Verify with a test that the recalculated file contains the `#DIV/0!` value and all four signals are detected.

## Build plan (team of four, keep `main` working at every step)

### Phase 0: Skeleton + contract (Margaux only, before anyone else codes)
1. Skeleton: `api/index.py` with `/api/health`, `vercel.json`, `requirements.txt`, `.gitignore`, `public/index.html` saying hello. Deploy to Vercel and confirm `/api/health` works on the live URL.
2. **The contract:** `api/_lib/models.py` (pydantic SheetModel) **and** a hand-written `public/fixtures/sample_sheet.json`: a small 8×12 sales sheet in the exact SheetModel shape, including the four planted signals. This fixture lets everyone build in parallel without waiting for each other.
3. Push. Everyone else clones only after this push.

### Phase 1: Build in parallel (each person, own files only, against the fixture)
- **Engine:** `extract.py` + `attention.py` + tests. Done when: the real demo file produces a SheetModel matching the fixture's shape, with all four signals detected and nothing else flagged high.
- **Screen:** grid rendering from the fixture (`?fixture=1` loads `public/fixtures/sample_sheet.json`), keyboard navigation, focus outline, signal markers, `N`/`Shift+N`, keyboard help (`H`). Calls `voice.announce(text, {priority})` and `cues.play(type)`; stub these if they're not ready yet.
- **Voice:** `voice.js` (self-voicing + aria-live modes, cancel-on-move, speaking rate), `cues.js` (four distinct earcons + vibration), then `overview.py` + `explain.py` with templates first and LLM polish second.
- **Margaux:** `make_demo.py` (recalculated demo file in `public/demo/`), `/api/upload`, `/api/explain`, `/api/overview` in `api/index.py`, env vars on Vercel.

### Phase 2: Integration (first end-to-end run)
- Screen switches "Load demo" from the fixture to `/demo/sales_demo.xlsx` → `/api/upload`.
- `W` calls `/api/explain`; the overview is spoken on Start and on `O`.
- **Milestone:** the whole ORIENT → EXPLORE → NOTICE → UNDERSTAND loop works once on the **production URL**, even if it's ugly. Nothing new starts until this works.

### Phase 3: Polish + extras (priority order; stop wherever time runs out)
1. Pointer and touch exploration (Screen).
2. Screen-reader mode toggle, tested with VoiceOver (Voice).
3. Uploading any .xlsx, with graceful spoken errors (Engine + Margaux).
4. Visible legend, speaking-rate slider (Screen).
5. Optional: `manifest.json` + icons for adding it to a phone home screen. No service worker.

### Phase 4: Freeze
- Code freeze before the pitch: after that, only bug fixes, each announced to the team.
- Rehearse the demo on the production URL, on a laptop and an Android phone.
- Record a backup screen video of the full demo in case the wifi fails.

## Working rules for Claude Code

- Before writing code, restate the plan for the current step in 3–5 bullets, then build it.
- After each step, run the tests and tell me exactly how to try it (URL plus which keys to press).
- Prefer small, readable modules over clever abstractions. This will be explained to judges.
- Never let a missing API key, network failure or odd spreadsheet crash the demo. Degrade to templates and spoken error messages.
- Don't add dependencies beyond the stack above without asking.
- Local dev: `vercel dev`, then open `http://localhost:3000`. It serves `public/` and the Python function together, exactly as in production.
- Deploy: `vercel` for a preview URL, `vercel --prod` for the demo URL. Set `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` in the Vercel project's environment variables, never in the repo.
- Keep all Python app code inside `api/` (under `api/_lib/`) so it's bundled with the function.

## Team workflow (git): we are git beginners

Four of us work on this repo at the same time, each with our own Claude Code. **You (Claude) handle all git for us.** After each git action, say what you did in one plain sentence.

### Who owns what
| Role | Person | Owns |
|---|---|---|
| Glue (repo + Vercel owner) | Margaux | `api/index.py`, `api/_lib/models.py`, `vercel.json`, `requirements.txt`, `.gitignore`, `scripts/make_demo.py`, `public/demo/`, `public/fixtures/` |
| Engine | _Name_ | `api/_lib/extract.py`, `api/_lib/attention.py`, `tests/` |
| Screen | _Name_ | `public/index.html`, `public/app.js`, `public/styles.css` |
| Voice | _Name_ | `public/voice.js`, `public/cues.js`, `api/_lib/overview.py`, `api/_lib/explain.py` |

`models.py` and the fixture are the shared contract. Only Margaux changes them, and she tells everyone when she does.

Ask me who I am at the start of a session if you don't know. Only edit files I own unless I explicitly say otherwise. If a change is needed in someone else's file, tell me what to ask them for.

### Everyone works on `main`, in small steps
- **When I say "get the latest"** (and always before starting a new task): commit any unsaved work first, then `git pull`.
- **When I say "save and share"** (or after anything that works): `git add` the relevant files → commit with a short, clear message → `git pull` → `git push`.
- If `git pull` produces a **merge conflict**: stop. Explain in plain words which file conflicts and what each version does, propose a resolution, and wait for my OK before committing it.
- Save and share roughly every 30–60 minutes. Small pushes avoid big conflicts.

### Never
- `git push --force`, `git reset --hard`, `git rebase`, deleting branches, or rewriting history.
- Committing `.env`, `.env.local`, API keys, `.vercel/`, `__pycache__/` or `.DS_Store`. Make sure `.gitignore` covers these.
- Editing CLAUDE.md without me saying so (it steers everyone's Claude). If I ask you to change it, remind me to tell the team.

## Deployment checklist (before the pitch)

- Production URL loads over HTTPS on a laptop **and** an Android phone. HTTPS plus a phone means vibration works live.
- "Load demo" works on the production URL with the API key removed (the template fallback path).
- Speech works after the first user tap or keypress. Browsers block audio until the user interacts, so show a "Start" button that unlocks audio and speaks the overview.
