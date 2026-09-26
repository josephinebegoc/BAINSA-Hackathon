# Accessible Attention for Excel — Hackathon build

## What we're building

An accessibility layer for spreadsheets. It helps blind and low-vision users **orient** themselves, **explore** data, and **notice** important information (visual or statistical) through speech, audio cues and haptics. Track: *Hearing Hues* (blind and low-vision users).

Core message: **"Screen readers make spreadsheet cells readable. We make visual attention accessible."**

### The gap we fill

Existing accessibility guidance (Microsoft's included) is addressed to **authors**:
use real headers, add alt text, keep contrast high, never encode meaning in colour
alone, put an overview in A1. All of it assumes the author did the work.

We answer the opposite question:

> **What happens when the spreadsheet wasn't designed accessibly in the first place?**

Someone sends you a workbook where red fill means urgent, bold means important, a
sudden drop is visually obvious and one strange value catches the eye. None of that
is in the text of any cell. A screen reader will read you the numbers and none of
the meaning.

So the product is not data analysis. It is **recovering information that sighted
users perceive through a different channel**, and delivering it *continuously, during
exploration* — without asking the author to redesign anything.

### Convey, don't conclude

**We do not analyse the spreadsheet for the user. We give them everything a sighted
person would take in at a glance, and let them do their own analysing.**

A sighted person perceives before they think: the red cell, the number sitting oddly
among its neighbours, the jagged shape of a row. Then *they* judge what it means. Our
job is to restore the perceiving, not to replace the judging. Three rules follow, and
they are not negotiable:

1. **Report facts, never verdicts.** "61% below Italy's median" — not "this value is
   unusually low". "Falls 45% after four months of rises" — not "this is a worrying
   drop". Give the measurement and let the user draw the conclusion. Never recommend,
   never warn, never editorialise.
2. **Cues are signposts, not filters.** Flagging a cell must never be the only way to
   reach information. Every cell stays explorable, every cell can be described on
   demand, and the user can always ask what is around them. We are not deciding what
   they are allowed to notice — we are making noticing possible.
3. **Anything visible is theirs to have.** If a sighted person could see it —
   formatting, a comment marker, a highlight, an error — the user can ask for it,
   whether or not our rules flagged it.

This is also the answer to "isn't this just AI doing the analysis?" It is not. The
engine points; the user decides.

That phrase, **continuous accessible attention while navigating**, is the
differentiator. Anything that only works as a one-off report is off-message.

### The four cues

The four signal types are four *kinds of information being recovered*, not four
statistics. Keep this vocabulary in the pitch and the UI:

| Cue | Signal `type` | Sounds like | Status |
|---|---|---|---|
| **Author visual cue** | `visual` | "The author highlighted this red." | announced |
| **Statistical cue** | `anomaly` | "61% below Italy's median." | announced |
| **Pattern cue** | `trend` | "Falls 45% after four months of rises." | announced |
| **Functional cue** | `error` | "This cell contains a division-by-zero error." | announced |

All four are announced. The statistical cue is the only one reporting a comparison
we computed rather than something written in the sheet, so its wording stays strictly
factual -- a distance from the median, never "unusually low" -- and it remains
switchable in one place, `find_signals(..., include_statistical=False)`, if that
judgement changes again.

Note the phrasing: each one states what is there, not what to think about it. "This
value is unusually low" would be us doing the analysing.

The first row is the one nobody else does, and it is the reason the product exists.
Give author visual semantics at least as much care as the statistics.

**Do not rename the `type` values.** `visual`/`anomaly`/`trend`/`error` are the wire
format in `models.py` and the fixture; the human names above belong in the interface
and the pitch. Changing the wire values buys nothing and breaks the frontend.

Four actions define the product. Every feature must map to one of them:

1. **ORIENT**: "What am I looking at?" An instant spoken overview when a file opens.
2. **EXPLORE**: "What's here?" Moving across cells announces location, row context, column context and value, e.g. "G17. Italy. Q3 Revenue. €82,400."
3. **NOTICE**: "What deserves attention?" A distinct audio cue (and vibration where supported) on salient cells, plus a "take me to something important" jump.
4. **UNDERSTAND**: "Why?" An on-demand, one-sentence explanation of why a cell was flagged.

The AI is one component, not the product. The **attention engine** (our own deterministic code) decides what is important. The LLM only turns those findings into short sentences.

## MVP (the only thing to build)

Upload .xlsx → overview → explore the grid → attention cue → press "Why?"

### Feature backlog — candidates, not commitments

Ideas worth having on the table, with what each would actually cost us. **Nothing
here starts before the Phase 2 milestone (the whole loop running on the production
URL).** Then pick off the cheap, on-message ones in this order.

| Feature | What it does | Value | Real cost for us |
|---|---|---|---|
| **Next Important** | Jump between salient cells with one key | ★★★★★ | **Already in the MVP.** `attention_order` is built; `N`/`Shift+N` is Josephine's step 2. |
| **Attention Map** | Ranks areas needing attention | ★★★★★ | **Engine side already done** — that is exactly what `attention_order` is. Only a visual/spoken summary is missing. |
| **Visual Semantics Translator** | Turns formatting into meaning and cues | ★★★★★ | **Partly done** (fill, font colour, bold). Deepening it is the highest-value work left: italic, underline, strikethrough, borders, cell comments, conditional formatting. |
| **Author Intent vs AI Insight** | Separates "the author marked this" from "we detected this" | ★★★★★ | **Nearly free.** `Signal.type` already encodes it: `visual` is the author, `anomaly`/`trend` are us, `error` is the file. Costs one grouping in the announcement, and it states the core message out loud. Do this one. |
| **Describe this cell** | On demand, everything a sighted person would see about the current cell — fill, font colour, bold, italic, borders, comment, number format — flagged or not | ★★★★★ | Cheap once extraction captures it, and it is the purest expression of "convey, don't conclude". Strong candidate. |
| **Attention Filters** | User chooses which cues they want to notice | ★★★★ | Cheap. Signals are already typed; needs a toggle in the UI and a filter on `attention_order`. Real agency: the user decides what counts. |
| **Context Radius** | Explains what surrounds the selected cell | ★★★★ | Cheap. Everything needed is already in the `SheetModel` the browser holds. |
| **Audio Heatmap** | Different sounds convey sheet characteristics | ★★★★ | Medium, and entirely Josephine's side. Note it pulls against the one-sound decision above — if we ever build it, it is a separate mode the user turns on, not the default navigation sound. |
| **Change Radar** | Compares two versions of a workbook | ★★★★★ | **Expensive.** Needs two uploads, a diffing pass, and a different API shape. Do not start it before the freeze. |
| **Accessible Mini-Map** | Spatial overview of the workbook's regions | ★★★★★ | **Expensive.** Needs region detection (finding blocks of related cells), which is real new engine work. |

Recommendation if time is short: **Author Intent vs AI Insight**, then **deepen the
Visual Semantics Translator**, then **Attention Filters**. All three are cheap, all
three are on-message, and the first two are the differentiator.

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
{ "rewrites": [{ "source": "/api/(.*)", "destination": "/api/index?__path=$1" }] }
```

**The original path does not survive the rewrite.** Vercel hands the function
`/api/index` no matter what the browser asked for, and sends no header carrying
the real path, so routes declared as `/api/health` return a FastAPI 404. That is
why the rewrite passes the path along as `?__path=` and a small ASGI middleware in
`api/index.py` (`RestoreApiPath`) puts it back before routing. Verified on the live
deployment. Declare routes as the plain URL the browser calls (`/api/health`) and
this stays invisible; don't "simplify" the rewrite back.

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
  "n_rows": 9, "n_cols": 14,
  "header_row": 1, "label_col": 1,
  "col_headers": ["Country", "Jan", "Feb", "...", "Dec", "Growth %"],
  "row_labels": ["France", "Italy", "..."],
  "value_label": "sales",
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
- `value_label`: what the numbers measure ("revenue", "hours"), for announcements like "Italy. May. Sales. €121,000." **Only ever a word the author actually wrote** in the title or a header — never inferred from the data, the number format or the column names' shape. A sheet that never says what its numbers are gets `""`, and the app stays quiet about it rather than guessing.
- Header detection (keep it simple): the first non-empty row where most cells are strings is the header row. The first column with mostly strings below it holds the row labels. Use the sheet title, or cell A1 if it is a lone title, as `title`.
- Capture per cell: value, formatted display (respect the number format where easy, otherwise format numbers sensibly), fill colour (`cell.fill.fgColor.rgb` when `fill_type == "solid"`), font colour, bold, formula, error string (`#DIV/0!`, `#N/A`, `#VALUE!`, `#REF!`, `#NAME?`).
- **Capture the author's full visual vocabulary even before we announce all of it.**
  Italic, underline, strikethrough, borders, cell comments/notes, and conditional
  formatting are all ways an author encodes meaning that a screen reader loses. They
  are cheap to read once the workbook is open and expensive to add later, because
  adding a field means changing the contract and re-coordinating both branches.
  Extract them now; decide what to speak later.
- Treat theme and indexed colours defensively: if the colour can't be resolved, record `"fill": "unknown-non-default"` rather than crash.

## Attention engine (attention.py)

Pure functions with no I/O, fully unit-tested. Four signal types:

| Type | Rule (prototype) | Example detail |
|---|---|---|
| `visual` | non-default solid fill, or red/orange font; bold only if the rest of the row isn't bold; **or a column formatted unlike the rest of its series** | "Author highlighted this cell in red"; "This column is formatted as a percentage while the others show currency" |
| `anomaly` | Within its row series (see below), robust z-score using median/MAD > 3.5 **and** at least 15% away from the row median; distance from the median alone only when the spread is too degenerate for a z-score. Skip series with fewer than 4 numbers. | "43% below Italy's median" |
| `trend` | at least 3 consecutive increases (or decreases) followed by a move in the opposite direction larger than 25% | "Breaks a 4-month upward trend" |
| `error` | cell holds an Excel error value | "Formula error: division by zero" |

- Severity: `error` is always high; `visual` is high; `anomaly`/`trend` are medium, or high if both hit the same cell.
- `attention_order`: sort by severity, then reading order (row, col).
- Name colours in plain words (red, orange, yellow, green, blue, grey) by nearest hue. Never read hex codes aloud.
- **Odd column formatting is an author visual cue.** A revenue column left formatted as a percentage renders as "6,900,000.0%" beside "€112,000": obvious to a sighted reader, silent to a screen reader. The cue goes on the column's **header cell**, once — the oddity belongs to the column, and flagging every cell in it would bury everything else. Neighbouring columns with the same oddity collapse into one cue ("Oct to Dec are formatted as a plain number"). A percentage among currency is `high` because it changes the number you read; a missing currency symbol is `medium`.
- **The 15% floor on the z-score is not optional.** A series with tight noise has a
  tiny MAD, which makes the robust z-score explode on trivial variation: without the
  floor the demo sheet flags an ordinary cell sitting 13% above its row median.
- **A "row series" is the comparable numeric cells only, not every number in the row.**
  Skip columns in other units — percentages, ratios, totals. Comparing a `Growth %`
  of 0.04 against monthly revenues around 80,000 makes every percentage look like an
  extreme anomaly. Easiest test: skip percent-formatted columns.
- Also run the series logic column-wise when the sheet is clearly column-oriented (row labels are time periods). Default is row-wise.

## Overview (overview.py): ORIENT

A template first, built from computed facts:
"{title}. {n_rows} rows of {row label kind} by {n_cols} columns, from {first col header} to {last col header}. Overall, values {rise/fall/stay flat}. I found {k} areas that may deserve your attention: {counts by type}."

Optional LLM polish: send only the facts JSON, ask for 2 sentences maximum and no invented numbers. On any failure, use the template.

## Explanation (explain.py): UNDERSTAND

- Input: one cell plus its signals and row context (neighbouring values).
- Template fallback joins the signal details: "Revenue is 43% below Italy's median and breaks a 4-month upward trend. The author also highlighted this cell in red."
- LLM prompt: facts only, 1–2 sentences, plain spoken English, no markdown, never state a number that isn't in the input. **No judgement words and no recommendations** — not "worrying", "concerning", "should", "problem". Describe what is there; the user decides what it means. If the model editorialises, fall back to the template.
- Cache results in the browser per cell ref (the server is stateless).

## Frontend interaction

### Layout
- Upload button, "Load demo" button, mode toggle, and a visible grid (so sighted judges can follow along).
- The focused cell has a strong visible outline. Flagged cells show a small corner marker by type.

### Modes and commands

A **mode** is a persistent state that changes how movement is narrated. A **command**
is a one-shot utterance that changes nothing. Overview and "describe this cell" are
commands, not modes -- there is nothing to leave.

| Mode | Key | What moving sounds like |
|---|---|---|
| **Explore** (default) | `1` | Full context: row, column, value, and the cue name first when flagged. Includes position in the run -- "month 8 of 12". |
| **Concise** | `2` | The value alone, so twelve months can be crossed quickly. Cues still interrupt. |
| **Trend Scan** | `3` | No speech for ordinary numeric cells. `R` plays the current row as tones, `C` the current column. |

| Command | Key |
|---|---|
| Overview | `O` |
| Why is this flagged | `W` or `?` |
| Describe how this cell looks | `D` |
| Next / previous flagged cell | `Space` / `Shift+Space`, `N` / `Shift+N` |
| Cycle attention filter | `F` |
| Help | `H` |
| Stop speech | `Esc` |

**Never bind `Cmd`+digit or `Ctrl+Space`.** Cmd+1 to Cmd+4 switch browser tabs on a
Mac and the page never receives them; Ctrl+Space belongs to macOS input switching.
Plain digits for modes, `Enter` or `.` if a repeat key is ever needed.

### Attention filters

`F` cycles ALL → AUTHOR → DATA (statistical + pattern) → ERRORS, announcing the
active filter and how many signals it leaves: "Author only. Three signals."

**A filter scopes navigation as well as interruptions.** If someone selects AUTHOR and
presses `Space`, jumping them to a statistical cue makes the filter a lie. It applies
to `attention_order` and to the cues together, or it is not a filter.

### Keyboard (primary)
| Key | Action |
|---|---|
| Arrow keys | move one cell; announce it (EXPLORE) |
| `O` | speak the overview (ORIENT) |
| `N` / `Shift+N` | jump to next / previous important cell (NOTICE) |
| `W` or `?` | explain the current cell (UNDERSTAND) |
| `R` / `C` | read the whole current row / column context -- **as tones in Trend Scan** |
| `D` | describe how the current cell looks |
| `F` | cycle the attention filter |
| `1` / `2` / `3` | Explore / Concise / Trend Scan |
| `Esc` | stop speech |

Put the grid container at `role="application"` with an `aria-label` and a clear instruction, so screen readers in browse mode pass the arrow keys through.

### Pointer and touch exploration
- Hovering, or dragging a finger over the grid, announces the cell under the pointer, throttled to about 150 ms and only when the cell changes.
- This is the "spatial exploration" differentiator: show it in the demo on a phone or trackpad.

### Output: two modes
1. **Self-voicing (default for the demo):** `speechSynthesis`. Always `cancel()` the previous utterance before speaking so speech never queues behind navigation. Speaking rate is adjustable.
2. **Screen-reader mode:** no self-voicing. Write announcements to an `aria-live="polite"` region (use `assertive` only for attention cues) so VoiceOver or NVDA speaks them. This proves the tool works *with* existing assistive tech rather than replacing it.

### Trend Scan (sonify.js): perceiving shape

A row of twelve numbers becomes twelve short tones in about two seconds, so a
listener hears the shape of a year instead of counting twelve figures. No screen
reader does this, and it is the clearest demonstration of the whole idea.

**The contract.** `public/sonify.js` is Margaux's; `app.js` calls it and nothing else
touches it:

```js
// Play one row or column as tones. Returns how long it will take in ms, so speech
// can wait for it the way cues.play() already does.
export function playSeries({ values, label, unit }, { onDone } = {})
export function stop()                 // Escape
export function isSupported()          // false without Web Audio; app.js falls back to Concise
```

- `values` — the numbers in order, `null` for empty cells
- `label` — `"Italy, January to December"`, spoken before the tones
- `unit` — `"€"`, so the spoken scale line reads `€62,000 to €154,000`

**Normalising.** Map the series' own minimum and maximum onto the pitch range, **per
series**: you only ever hear one at a time, chosen by where the cursor is, exactly as
in Explore. (If several are ever played together, they must be normalised across the
whole set instead — otherwise a small row and a large row both span the full range
and sound the same height, which is actively misleading.)

**What makes it sound like information rather than noise:**

- **Logarithmic pitch, not linear Hz.** Human pitch perception is logarithmic; a linear
  mapping makes every high value sound alike. Roughly 220 Hz to 880 Hz, two octaves.
- **Do not snap to a musical scale.** Quantising sounds prettier and can flatten the
  exact cliff you are trying to hear.
- **About 150 ms per note**, so twelve months lands near two seconds — one shape, not a list.
- **Pan left to right** across the series: pitch carries the value, stereo carries position.
- **Speak the scale once, before the tones:** "Italy, January to December. €62,000 to
  €154,000." Pitch is relative, so without this a listener cannot tell €154,000 from €154.
- **Errors get a clearly different sound; empty cells are silent.** Silence reads as a gap.

Pitch-based output does not work for everyone — hearing loss and amusia are both
common — so it is a mode you opt into and Explore always remains.

### Cues (cues.js): NOTICE
- Normal cell: a very short, quiet tick (Web Audio, about 30 ms).
- Flagged cell: **one single attention earcon, the same for all four cue types**, played **before** the speech. Do not give each type its own timbre or pitch.
- The sound says *"something here"*, nothing more. Which kind of cue it is comes from
  the spoken label straight after it, so **the announcement must always name the
  type** — the sound no longer carries that information and there is nowhere else
  for it to come from.
- Why one sound: four earcons mean four things to learn before the tool is usable,
  and telling timbres apart is a harder task than hearing a word. One sound is
  learned instantly and never ambiguous.
- If `navigator.vibrate` exists: flagged cell → `[60, 40, 60]`, error → `[200]`.
- **The cue label comes first, before the cell, never appended.** "Pattern cue. Italy. Aug. Sales. €62,000." — not "Italy. Aug. Sales. €62,000. Pattern cue."
- Why: the listener needs to know something is here *before* the content arrives, so they can decide to stop and attend to it. A label tacked on the end arrives after they have already moved on, and on a fast sweep across the grid it may not arrive at all. Same reason the earcon plays before the speech: signal first, then detail.
- It stays a short label and nothing more. The full reason comes only when the user presses `W`.

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
2. **The contract:** `api/_lib/models.py` (pydantic SheetModel) **and** a hand-written `public/fixtures/sample_sheet.json`: a 9×14 sales sheet in the exact SheetModel shape (header row + 8 countries; label column + 12 months + a `Growth %` column for the `#DIV/0!` to live in), including the four planted signals. This fixture lets everyone build in parallel without waiting for each other.
3. Push. Everyone else clones only after this push.

### Phase 1: Build in parallel (own files only, against the fixture)

**Margaux (backend), in this order:**
1. `extract.py` — load the workbook twice, openpyxl → SheetModel.
2. `attention.py` + `tests/test_attention.py` — the four rules, with the corrected anomaly thresholds above.
3. `POST /api/upload` in `api/index.py`.
4. `overview.py` + `explain.py`, templates first.
5. `/api/explain` and `/api/overview`, then LLM polish last.

Done when: the real demo file produces a SheetModel matching the fixture's shape,
flagging `D5` visual, `F3` anomaly, `G4` trend, `N8` error — and nothing else high.

**Josephine (frontend), in this order:**
1. Grid rendering from the fixture (`?fixture=1` loads `public/fixtures/sample_sheet.json`), focus outline, signal markers by type.
2. Keyboard navigation: arrows announce cell + row label + column header + value; `N`/`Shift+N`, `O`, `W`, `R`/`C`, `Esc`, `H` for help. Calls `voice.announce(text, {priority})` and `cues.play(type)` — stub them until step 3.
3. `voice.js` — self-voicing + aria-live modes, cancel-on-move, speaking rate.
4. `cues.js` — one attention earcon (the same for every cue type) + vibration, earcon *before* speech.
5. The **Start button** that unlocks audio and speaks the overview. Browsers block speech until a real user gesture, so without this the demo is silent.

Done when: the fixture is fully explorable by keyboard, with all four signals
audible and distinguishable, without the API existing at all.

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
**Two people, split down the Python/browser line so the two branches never touch
the same file.**

| Person | Half | Owns |
|---|---|---|
| **Margaux** (repo + Vercel owner) | Backend, data, the attention engine, and Trend Scan | everything under `api/`, plus `tests/`, `scripts/`, `public/demo/`, `public/fixtures/`, `public/sonify.js`, `vercel.json`, `requirements.txt`, `.gitignore` |
| **Josephine** | Browser, interaction and output | everything else under `public/`: `index.html`, `app.js`, `styles.css`, `voice.js`, `cues.js` |
| **Design** (two people) | Visual design | `public/styles.css` and any new CSS files, **on the `design` branch only** |

All of `public/` except `demo/` and `fixtures/` is Josephine's, because `app.js`
calls `voice.announce()` and `cues.play()` on nearly every keystroke — splitting
that seam across two branches means fighting over it all day.

`api/_lib/models.py` and `public/fixtures/sample_sheet.json` are the shared
contract. Only Margaux changes them, and she tells Josephine when she does.

Neither half blocks the other: the fixture is committed, so Josephine builds the
whole interface without waiting for extraction, and Margaux works against the real
demo file without waiting for the interface.

Ask me who I am at the start of a session if you don't know. Only edit files I own unless I explicitly say otherwise. If a change is needed in someone else's file, tell me what to ask them for.

### Design works on the `design` branch

The two designers work on `design`, never on `main`. **Josephine reviews and merges
their work into her half**, because the markup and the CSS are joined at the hip and
she is the one who knows which parts the JS and the screen readers depend on.

Designers: propose markup changes, don't make them. Ask Josephine for the class or
the wrapper you need.

#### Design guardrails — non-negotiable

Every one of these can be broken with no visible symptom. The page looks better and
the product silently stops working for the people it is for.

1. **Never hide the live regions with `display: none` or `visibility: hidden`.**
   `#live-polite` and `#live-assertive` must stay in the accessibility tree or screen
   readers announce nothing at all. Hide them with the clip pattern
   (`position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%)`).
2. **Never write `outline: none`.** The focus ring is how a keyboard user knows where
   they are. Restyle it if you like, but it stays strongly visible and at least 3:1
   against what is next to it.
3. **Colour is never the only clue.** The signal markers carry a letter as well as a
   colour on purpose. Replacing them with coloured dots reintroduces the exact
   problem this product exists to solve.
4. **Do not touch element IDs, ARIA attributes, `role="application"`, or the DOM
   structure `app.js` queries.** It looks elements up by ID; restructuring breaks
   navigation with no error in the console.
5. **Contrast:** 4.5:1 for body text, 3:1 for large text and for the edges of any
   control. Low-vision users are half the people in this track.
6. **Works at 400px wide and at 200% zoom.** The demo runs on a phone.
7. **Respect `prefers-reduced-motion`.** No animation that cannot be turned off.
8. **Nothing may be hover-only.** The grid is driven by keyboard and by touch.

### Each of us works on our own branch

Branches: `Margaux`, `josephine`, and `design` (note the capital M on one and not the others).
`main` must always work.

Do not create a branch whose name starts with an existing branch name — `Margaux`
and `margaux/anything` cannot coexist, because macOS filesystems are
case-insensitive and git stores refs as files and directories. It breaks `git fetch`.

- **When I say "get the latest"** (and always before starting a new task): commit any unsaved work first, then pull `main` into my branch.
- **When I say "save and share"** (or after anything that works): `git add` the relevant files → commit with a short, clear message → pull `main` into my branch → push my branch.
- **When I say "merge mine in"**: check my branch actually runs, pull `main`, merge my branch into `main`, push `main`. Only merge working code — `main` is what gets demoed.
- Pull `main` into my branch every 30–60 minutes even when nothing of mine is ready. Small, frequent merges instead of one painful one at the end.
- If a pull or merge produces a **merge conflict**: stop. Explain in plain words which file conflicts and what each version does, propose a resolution, and wait for my OK before committing it. With the ownership split above, a conflict outside CLAUDE.md means someone edited the other person's file — say so rather than resolving it quietly.

### Never
- `git push --force`, `git reset --hard`, `git rebase`, deleting branches, or rewriting history.
- Committing `.env`, `.env.local`, API keys, `.vercel/`, `__pycache__/` or `.DS_Store`. Make sure `.gitignore` covers these.
- Editing CLAUDE.md without me saying so (it steers everyone's Claude). If I ask you to change it, remind me to tell the team.

## Deployment checklist (before the pitch)

- Production URL loads over HTTPS on a laptop **and** an Android phone. HTTPS plus a phone means vibration works live.
- "Load demo" works on the production URL with the API key removed (the template fallback path).
- Speech works after the first user tap or keypress. Browsers block audio until the user interacts, so show a "Start" button that unlocks audio and speaks the overview.
