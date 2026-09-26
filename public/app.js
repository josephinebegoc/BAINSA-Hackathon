// app.js: loads a SheetModel, draws the grid, and handles navigation.

import * as voice from "./voice.js";
import * as cues from "./cues.js";
import * as chartView from "./chart.js";

const FIXTURE_URL = "/fixtures/sample_sheet.json"; // offline copy, and ?fixture=1
const DEMO_URL = "/demo/sales_demo.xlsx";
const CHART_DEMO_URL = "/demo/sales_chart_demo.xlsx"; // the same sheet plus a line chart
// Margaux's server waits up to 5 s for the AI, then answers with its template;
// we give it a little longer before using our own local explanation.
const EXPLAIN_TIMEOUT_MS = 6000;
const EXPLAIN_PATIENCE_MS = 800; // say "One moment" if the answer takes longer

// Short letters on the corner badges, so colour is never the only clue.
const SIGNAL_LETTERS = { visual: "V", anomaly: "A", trend: "T", error: "E" };
// The four cues: four kinds of information recovered for the listener.
// The type values are the wire format; these names are for people.
// They are also the short label spoken on a flagged cell: they say what kind
// of cue it is, never what to think of it. W gives the facts.
const SIGNAL_NAMES = {
  visual: "Author visual cue",
  anomaly: "Statistical cue",
  trend: "Pattern cue",
  error: "Functional cue",
};

// Which cue to play when a cell has several signals.
const SIGNAL_PRIORITY = ["error", "visual", "anomaly", "trend"];

// Never read error codes like "#DIV/0!" aloud.
const ERROR_WORDS = {
  "#DIV/0!": "Division by zero",
  "#N/A": "Not available",
  "#VALUE!": "Wrong type of value",
  "#REF!": "Broken reference",
  "#NAME?": "Unknown name",
  "#NUM!": "Invalid number",
  "#NULL!": "Empty intersection",
};

const SITE_NAME = "Glance";

// Said (or shown) as the page opens, before any key has been pressed.
const OPENING =
  "Press any key to start, L to load the demo, K for the chart demo, " +
  "or U to upload your own spreadsheet.";
// Said once the first key, click or tap has turned sound on.
const WELCOME =
  `Welcome to ${SITE_NAME}. Press L to open the demo sheet, K for the chart demo, ` +
  "or U to upload your own spreadsheet. " +
  "Both buttons are also at the top of the page. Press H for help.";
// Keys that still work before a sheet is open.
const KEYS_WITHOUT_SHEET = new Set(["l", "k", "u", "h", "s", "1", "2", "3", "4", "Escape"]);
// Vercel rejects bodies over about 4.5 MB before the server sees them, so we
// check first and say so, rather than failing with no explanation.
const MAX_UPLOAD_BYTES = 4_000_000;

const HELP_TEXT =
  "Arrow keys move one cell. O gives an overview. " +
  "Space or N jumps to the next flagged cell; with Shift, the previous one. " +
  "W explains why a cell was flagged. D describes everything about a cell. " +
  "R reads the whole row, C the whole column. " +
  "1 is Explore mode, 2 is Concise mode, 3 is Piano mode, 4 is Chart mode. " +
  "F changes which cues you hear. " +
  "M adds the current row to your own chart, Shift M the column; then 4 shows it. " +
  "L loads the demo sheet, K the chart demo. U uploads your own spreadsheet. S or Escape stops speaking.";

// Added to the help only when the sheet has a chart.
const CHART_HELP =
  " G explores the chart. In the chart, the left and right arrows move between " +
  "points, and Escape returns to the sheet.";

// ---------- Modes and filters (see CLAUDE.md, "Modes and commands") ----------
// A mode changes how moving is narrated; it stays until changed.
const MODES = {
  explore: { name: "Explore", says: "Explore mode. Full context for every cell." },
  concise: { name: "Concise", says: "Concise mode. Values only; cues still speak." },
  scan: {
    // "Trend Scan" in CLAUDE.md and sonify.js; people see and hear "Piano".
    name: "Piano",
    says:
      "Piano mode. Numbers are silent. R plays the row as notes, C the column. " +
      "Higher values play higher notes.",
  },
  chart: {
    name: "Chart",
    says:
      "Chart mode. The chart replaces the table. Build your own with M on rows or " +
      "Shift M on columns before pressing 4. Move the mouse across it to hear its shape. " +
      "Up and down change row, left and right " +
      "move between points, N goes to the next marked point, C charts the column, " +
      "O repeats this summary, and Escape brings the table back.",
  },
};
// F cycles these. A filter scopes both where N and Space go and which cells chime.
const FILTERS = [
  { name: "All cues", types: ["visual", "anomaly", "trend", "error"] },
  { name: "Author only", types: ["visual"] },
  { name: "Data only", types: ["anomaly", "trend"] },
  { name: "Errors only", types: ["error"] },
];

// Trend Scan's tones come from Margaux's sonify.js. It is loaded on its own, so
// the rest of the app keeps working if that file isn't there yet.
let sonify = null;
import("./sonify.js")
  .then((module) => {
    sonify = module;
    applyScale();
  })
  .catch(() => console.info("[trend scan] sonify.js is not available yet"));

// Hovering announces the cell under the mouse, at most this often.
const HOVER_THROTTLE_MS = 150;

const state = {
  sheet: null,
  cellsByRef: new Map(),
  focus: null, // { row, col }
  explanations: new Map(), // ref → text from /api/explain, for this sheet only
  picks: { kind: null, items: [] }, // your own chart: picked rows or columns
  chart: null, // while exploring a chart: { chart, series, point, status }
  mode: "explore", // see MODES
  filter: 0, // index into FILTERS
};

const gridEl = document.getElementById("grid");
const statusEl = document.getElementById("status");
const titleEl = document.getElementById("sheet-title");
const startBtn = document.getElementById("start");
const chartPanelEl = document.getElementById("chart-panel");

// ---------- Loading ----------

// Load demo: the demo workbook goes through exactly the same pipeline as a real
// upload. If the server can't be reached, the offline copy keeps the demo alive.
async function loadDemo(url = DEMO_URL, name = "sales_demo.xlsx") {
  statusEl.textContent = "Opening the demo workbook…";
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reached = await uploadWorkbook(await res.blob(), name);
    if (reached) return;
  } catch (err) {
    console.error(err);
  }
  if (url !== DEMO_URL) {
    // The offline copy has no chart, so it would not be the chart demo.
    const message = "I couldn't reach the server, so the chart demo can't be opened.";
    statusEl.textContent = message;
    voice.announce(message);
    return;
  }
  await loadFixture("I couldn't reach the server, so this is the offline copy of the demo.");
}

// POST a workbook to /api/upload and show the SheetModel it returns. Errors
// from the server are sentences, so they are spoken as they are.
// Returns false only if the server couldn't be reached at all.
async function uploadWorkbook(file, name) {
  const form = new FormData();
  form.append("file", file, name);
  let res;
  let body;
  try {
    res = await fetch("/api/upload", { method: "POST", body: form });
    body = await res.json();
  } catch (err) {
    console.error("[upload] server unreachable:", err);
    return false;
  }
  if (!res.ok || body.error) {
    const message = body.error || "Sorry, that spreadsheet could not be opened.";
    statusEl.textContent = message;
    voice.announce(message);
    return true;
  }
  showSheet(body);
  return true;
}

// The hand-written sample sheet: for development (?fixture=1) and offline demos.
async function loadFixture(note = "") {
  statusEl.textContent = "Loading the sample sheet…";
  try {
    const res = await fetch(FIXTURE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showSheet(await res.json(), note);
  } catch (err) {
    const message = "Sorry, the sample sheet could not be loaded.";
    statusEl.textContent = message;
    voice.announce(message);
    console.error(err);
  }
}

// note: said before the overview, e.g. that this is the offline copy.
function showSheet(sheet, note = "") {
  state.sheet = sheet;
  state.cellsByRef = new Map(sheet.cells.map((c) => [c.ref, c]));
  state.explanations.clear();
  state.chart = null;
  state.picks = { kind: null, items: [] };
  if (state.mode === "chart") {
    state.mode = "explore"; // a new sheet opens on its table
    gridEl.classList.remove("chart-view");
    showModeLine();
  }
  applyScale();

  titleEl.textContent = sheet.title;
  titleEl.hidden = false;
  const flagged = sheet.attention_order.length;
  document.getElementById("sheet-facts").textContent =
    `${sheet.n_cols} columns · ${sheet.n_rows} rows · ` +
    `${flagged} flagged ${flagged === 1 ? "cell" : "cells"}`;
  statusEl.textContent =
    `${sheet.title} loaded. ${sheet.attention_order.length} cells flagged. ` +
    `Voice: ${voice.getVoiceName()}.`;

  renderGrid();
  renderChartPanel();
  // Start on the first data cell, just below the header and right of the labels.
  setFocus(sheet.header_row + 1, sheet.label_col + 1);
  gridEl.focus();
  if (note) statusEl.textContent += ` ${note}`;
  // ORIENT: an instant spoken overview whenever a sheet opens.
  voice.announce(note ? `${note} ${orientation()}` : orientation());
}

// The overview, then what the user can do next.
function orientation() {
  const overview = state.sheet.overview || `${state.sheet.title}.`;
  const next = state.sheet.attention_order.length
    ? "Press Space to go through the flagged cells, use the arrow keys to explore, or press H for help."
    : "Use the arrow keys to explore, or press H for help.";
  return `${overview} ${next}`;
}

// ---------- Rendering ----------

// 1 → "A", 14 → "N", 27 → "AA"
export function columnLetter(col) {
  let letters = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    col = Math.floor((col - 1) / 26);
  }
  return letters;
}

function cellAt(row, col) {
  return state.cellsByRef.get(columnLetter(col) + row) || null;
}

function renderGrid() {
  const { n_rows, n_cols } = state.sheet;
  const table = document.createElement("table");

  // Excel-style column letters, so "D5" can be matched to the screen.
  const headRow = table.createTHead().insertRow();
  headRow.appendChild(document.createElement("th"));
  for (let col = 1; col <= n_cols; col++) {
    const th = document.createElement("th");
    th.textContent = columnLetter(col);
    headRow.appendChild(th);
  }

  const body = table.createTBody();
  for (let row = 1; row <= n_rows; row++) {
    const tr = body.insertRow();
    const rowNum = document.createElement("th");
    rowNum.textContent = row;
    tr.appendChild(rowNum);
    for (let col = 1; col <= n_cols; col++) {
      tr.appendChild(renderCell(row, col));
    }
  }

  gridEl.replaceChildren(table);
}

function renderCell(row, col) {
  const td = document.createElement("td");
  const cell = cellAt(row, col);
  td.dataset.row = row;
  td.dataset.col = col;

  const text = document.createElement("span");
  text.className = "value";
  text.textContent = cell ? cell.display ?? "" : "";
  td.appendChild(text);

  if (row === state.sheet.header_row) td.classList.add("header");
  if (col === state.sheet.label_col) td.classList.add("label");
  if (!cell) return td;

  if (cell.bold) td.classList.add("bold");
  if (typeof cell.value === "number") td.classList.add("number");
  if (cell.error) td.classList.add("error");
  applyFill(td, cell.fill);
  applyFontColor(td, cell.font_color);

  const types = [...new Set(cell.signals.map((s) => s.type))];
  if (types.length) {
    td.classList.add("flagged");
    const markers = document.createElement("span");
    markers.className = "markers";
    markers.setAttribute("aria-hidden", "true");
    for (const type of types) {
      const badge = document.createElement("span");
      badge.className = `marker marker-${type}`;
      badge.textContent = SIGNAL_LETTERS[type] || "?";
      badge.title = SIGNAL_NAMES[type] || type;
      markers.appendChild(badge);
    }
    td.appendChild(markers);
  }
  return td;
}

// Fills arrive as ARGB hex ("FFFF0000") or "unknown-non-default".
function applyFill(td, fill) {
  if (!fill) return;
  if (fill === "unknown-non-default") {
    td.classList.add("fill-unknown");
    return;
  }
  const hex = fill.slice(-6);
  if (!/^[0-9a-f]{6}$/i.test(hex)) return;
  td.style.backgroundColor = `#${hex}`;
  // Keep text readable on dark fills.
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  if (0.299 * r + 0.587 * g + 0.114 * b < 140) td.classList.add("dark-fill");
}

// Show the author's text colour too: it can carry meaning (e.g. red = bad).
function applyFontColor(td, color) {
  const hex = color?.slice(-6);
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return;
  td.style.color = `#${hex}`;
}

// ---------- Focus ----------

function setFocus(row, col) {
  const { n_rows, n_cols } = state.sheet;
  row = Math.min(Math.max(row, 1), n_rows);
  col = Math.min(Math.max(col, 1), n_cols);

  gridEl.querySelector("td.focused")?.classList.remove("focused");
  const td = gridEl.querySelector(`td[data-row="${row}"][data-col="${col}"]`);
  td.classList.add("focused");
  // In the chart view the table is hidden: scrolling to it would only jump the page.
  if (!gridEl.classList.contains("chart-view")) td.scrollIntoView({ block: "nearest", inline: "nearest" });

  state.focus = { row, col };
  // Moving around the sheet: no chart point is being spoken any more.
  if (!state.chart) chartView.highlight(null);
  showCurrentCell(row, col);
}

// Short names for the Current cell panel, in the same order as the letters.
const SOURCE_NAMES = { visual: "Author", anomaly: "Anomaly", trend: "Pattern", error: "Error" };

// The Current cell panel under the grid, for sighted viewers following along.
function showCurrentCell(row, col) {
  const cell = cellAt(row, col);
  const ref = columnLetter(col) + row;
  const value = cell?.display || "Blank";
  const inBody = row !== state.sheet.header_row && col !== state.sheet.label_col;
  const parts = inBody
    ? [rowLabel(row), colHeader(col), state.sheet.value_label, value]
    : [value];
  document.getElementById("current-cell-text").textContent =
    `${ref} · ${parts.filter(Boolean).join(" · ")}`;

  const list = document.getElementById("current-cell-cues");
  list.replaceChildren(
    ...(cell?.signals || []).map((signal) => {
      const li = document.createElement("li");
      const badge = document.createElement("span");
      badge.className = `marker marker-${signal.type}`;
      badge.textContent = SIGNAL_LETTERS[signal.type] || "?";
      const source = document.createElement("strong");
      source.textContent = (SOURCE_NAMES[signal.type] || signal.type).toUpperCase();
      li.append(badge, " ", source, ` ${signal.detail}`);
      return li;
    })
  );
}

// ---------- What we say (EXPLORE) ----------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_PATTERN =
  /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?(?:[\s\-'/]+(\d{2,4}))?$/i;

// If a header names a moment in time, say it in full: "Nov" → "November",
// "Jan 2026" → "January 2026", "q3" → "Q3". Otherwise return null.
function timePhrase(text) {
  const t = (text || "").trim();
  const month = t.match(MONTH_PATTERN);
  if (month) {
    const name = MONTHS.find((m) => m.toLowerCase().startsWith(month[1].slice(0, 3).toLowerCase()));
    return month[2] ? `${name} ${month[2]}` : name;
  }
  if (/^(q[1-4]|h[12])(\s+\d{4})?$/i.test(t)) return t.toUpperCase();
  if (/^(19|20)\d{2}$/.test(t)) return t;
  return null;
}

// Headers as spoken: month names in full, everything else as written.
function spokenHeader(text) {
  return timePhrase(text) || text;
}

// "France" → "France's", "Netherlands" → "Netherlands'"
function possessive(name) {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

// "revenue is", "sales are"
function verbFor(noun) {
  return /[^s]s$/i.test(noun.trim()) ? "are" : "is";
}

// Row and column context as one phrase, using only words the sheet contains:
//   "France in November: €82,400"            (column is a time)
//   "France's revenue in November is €82,400" (if the backend names the values)
//   "Belgium's Growth % is 5.3%"              (column is not a time)
//   "Revenue in January is €80,000"           (rows are times: column-oriented)
function contextPhrase(label, header, cell) {
  const value = spokenValue(cell);
  const labelTime = timePhrase(label);
  const headerTime = timePhrase(header);
  // What the numbers are, e.g. "revenue". Not in the contract yet: ask Margaux.
  const measure = state.sheet.value_label;

  let subject = label || header || "";
  let noun = null; // the word "is"/"are" agrees with; none means use a colon
  if (label && headerTime && !labelTime) {
    subject = measure ? `${possessive(label)} ${measure} in ${headerTime}` : `${label} in ${headerTime}`;
    noun = measure || null;
  } else if (header && labelTime && !headerTime) {
    subject = `${header} in ${labelTime}`;
    noun = header;
  } else if (label && header) {
    subject = `${possessive(label)} ${spokenHeader(header)}`;
    noun = header;
  }

  if (!subject) return value;
  if (cell?.error) {
    return `${subject} has an error: ${value.charAt(0).toLowerCase()}${value.slice(1)}`;
  }
  return noun ? `${subject} ${verbFor(noun)} ${value}` : `${subject}: ${value}`;
}

function rowLabel(row) {
  return cellAt(row, state.sheet.label_col)?.display || "";
}

function colHeader(col) {
  return cellAt(state.sheet.header_row, col)?.display || "";
}

function spokenValue(cell) {
  if (!cell) return "blank";
  if (cell.error) return ERROR_WORDS[cell.error] || "Error";
  return cell.display === "" ? "blank" : cell.display;
}

// The most important signal type on a cell, or null.
function topSignal(cell) {
  const types = visibleSignals(cell).map((s) => s.type);
  return SIGNAL_PRIORITY.find((t) => types.includes(t)) || null;
}

// "Author visual cue: Author highlighted this cell in red. D5. Spain's sales in
// March are €63,400."
// The cue name comes first, so the listener knows what kind of cell this is
// before hearing its value.
function describeCell(row, col) {
  const cell = cellAt(row, col);
  const parts = [columnLetter(col) + row];

  if (row === state.sheet.header_row) {
    parts.push("Column header", cell?.error ? spokenValue(cell) : spokenHeader(spokenValue(cell)));
  } else if (col === state.sheet.label_col) {
    parts.push("Row label", spokenValue(cell));
  } else {
    const label = cell?.row_label || rowLabel(row);
    const header = cell?.col_header || colHeader(col);
    parts.push(contextPhrase(label, header, cell));
    const position = runPosition(row, col);
    if (position) parts.push(position);
  }

  const signals = visibleSignals(cell);
  let looks = formattingWords(row, col, cell);
  // The author's cue already says "highlighted in red": don't say it twice.
  if (signals.some((s) => s.type === "visual" && /highlight/i.test(s.detail))) {
    looks = looks.filter((w) => !w.startsWith("highlighted"));
  }
  if (looks.length) parts.push(sentenceCase(looks.join(", ")));

  const { cueFacts, stored } = cueSentences(row, col, cell);
  if (stored) parts.push(stored);
  return [...cueFacts, ...parts].join(". ") + ".";
}

// Concise mode: the value alone. Cues still speak first.
function describeConcise(row, col) {
  const cell = cellAt(row, col);
  const value =
    row === state.sheet.header_row && !cell?.error
      ? spokenHeader(spokenValue(cell))
      : spokenValue(cell);
  const { cueFacts, stored } = cueSentences(row, col, cell);
  return [...cueFacts, value, ...(stored ? [stored] : [])].join(". ") + ".";
}

// The cue sentences for a cell under the current filter, plus the stored
// number when a format alert needs it.
function cueSentences(row, col, cell) {
  const cueFacts = visibleSignals(cell).map((s) => cueWithFact(s, cell));
  const mismatch = visibleMismatch(row, col);
  if (mismatch) cueFacts.push(mismatch.alert);
  return { cueFacts, stored: mismatch?.stored || null };
}

// "Month 8 of 12": where a cell sits in the sheet's main series.
function runPosition(row, col) {
  const series = state.sheet.series_cols || [];
  const i = series.indexOf(col);
  if (i === -1 || row === state.sheet.header_row) return null;
  return `${sentenceCase(runWord())} ${i + 1} of ${series.length}`;
}

function runWord() {
  const headers = (state.sheet.series_cols || []).map((c) => (colHeader(c) || "").trim());
  if (!headers.length) return "column";
  if (headers.every((h) => MONTH_PATTERN.test(h))) return "month";
  if (headers.every((h) => /^q[1-4]\b/i.test(h))) return "quarter";
  if (headers.every((h) => /^(19|20)\d{2}$/.test(h))) return "year";
  return "column";
}

// ---------- Filters ----------

function visibleSignals(cell) {
  const types = FILTERS[state.filter].types;
  return (cell?.signals || []).filter((s) => types.includes(s.type));
}

// Format alerts are about how the author laid the sheet out, so they belong
// with the author's cues.
function visibleMismatch(row, col) {
  return FILTERS[state.filter].types.includes("visual") ? formatMismatch(row, col) : null;
}

// attention_order, keeping only cells with a cue the current filter lets through.
function flaggedOrder() {
  return state.sheet.attention_order.filter(
    (ref) => visibleSignals(state.cellsByRef.get(ref)).length
  );
}

function cycleFilter() {
  setFilter((state.filter + 1) % FILTERS.length);
}

// F cycles; the Attention buttons pick one directly.
function setFilter(index) {
  state.filter = index;
  showModeLine();
  const count = (state.sheet.attention_items?.length ? attentionItems() : flaggedOrder()).length;
  const signals = count === 0 ? "No signals" : count === 1 ? "1 signal" : `${count} signals`;
  voice.announce(`${FILTERS[state.filter].name}. ${signals}.`);
}

// ---------- Modes ----------

function setMode(mode) {
  if (state.mode === "chart" && mode !== "chart") closeChartView();
  if (mode === "scan" && !sonify?.isSupported?.()) {
    // The contract: without Trend Scan, fall back to Concise.
    state.mode = "concise";
    showModeLine();
    voice.announce("Piano mode isn't available yet, so I'll use Concise mode. Values only; cues still speak.");
    return;
  }
  state.mode = mode;
  showModeLine();
  if (mode === "chart" && state.sheet) {
    const which = state.picks.items.length ? "picked"
      : state.focus.row === state.sheet.header_row ? "column" : "row";
    openChartView(which, "Chart mode. ");
    return;
  }
  voice.announce(MODES[mode].says);
}

// Visible for sighted viewers following along.
function showModeLine() {
  document.getElementById("mode-line").textContent =
    `Mode: ${MODES[state.mode].name} · Filter: ${FILTERS[state.filter].name}`;
  // Keep the on-screen buttons in step, whether a key or a click changed them.
  for (const button of document.querySelectorAll("button.mode")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === state.mode));
  }
  for (const button of document.querySelectorAll("button.filter")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.filter) === state.filter));
  }
}

// ---------- Chart mode: draw a row or column and describe it ----------
// R / C in Chart mode build a line chart from the grid itself, draw it with
// chart.js and speak what a sighted reader would take from it. Its marked points
// are the cells the attention engine already flagged, so the chart and the grid
// always agree. Facts only: start and end, highest and lowest, and the marks.

// The chart view: the chart is drawn inside the grid area in place of the table,
// so keyboard focus (and the screen reader's application mode) never moves.
function openChartView(which, prefix = "") {
  const built = which === "picked" ? pickedChart()
    : which === "row" ? rowChart(chartRow()) : columnChart(chartCol());
  if (!built) {
    voice.announce(`${prefix}There aren't enough numbers in this ${which === "picked" ? "chart" : which} to draw it.`);
    return;
  }
  const { chart, markedBySeries } = built;
  chartPanelEl.hidden = true; // the workbook's own chart panel steps aside
  gridEl.classList.add("chart-view");
  chartView.render(chartHost(), chart, markedBySeries);
  const points = chart.series[0].points;
  const here = columnLetter(state.focus.col) + state.focus.row;
  openChart(chart, 0, Math.max(points.findIndex((p) => p.ref === here), 0));
  Object.assign(state.chart, { which, markedBySeries });
  lastHoverPoint = null;
  state.chart.speakingSummary = true;
  voice.announce(prefix + chartFacts(chart, markedBySeries));
}

// Back to the table. The grid focus is where the chart last was.
function closeChartView() {
  gridEl.classList.remove("chart-view");
  gridEl.querySelector(".grid-chart")?.remove();
  if (state.chart) {
    statusEl.textContent = state.chart.status;
    state.chart = null;
  }
  renderChartPanel(); // the workbook's own chart, if it has one, comes back
}

function chartHost() {
  let host = gridEl.querySelector(".grid-chart");
  if (!host) {
    host = document.createElement("div");
    host.className = "grid-chart";
    host.addEventListener("pointermove", onChartPointer);
    host.addEventListener("pointerdown", onChartPointer);
    gridEl.appendChild(host);
  }
  return host;
}

// ---------- Hearing the chart's shape ----------
// Like Piano mode: each point plays a note, higher values higher, and the note
// moves from left to right across the chart. Sweeping the chart with the mouse or
// a finger lets a listener hear where it is high and where it is low.

chartPanelEl.addEventListener("pointermove", onChartPointer);
chartPanelEl.addEventListener("pointerdown", onChartPointer);

const CHART_NOTE_MS = 120;
const CHART_PAUSE_MS = 400; // rest this long on a point and it is spoken
let lastHoverPoint = null;
let chartPauseTimer = null;

// Both charts can be swept: the one that replaces the table in Chart mode, and
// the workbook's own chart shown under the table (sweeping it starts exploring it,
// so the arrow keys and W work on it too).
function onChartPointer(event) {
  let chart;
  if (event.currentTarget === chartPanelEl) {
    if (inChartView() || !hasChart()) return;
    chart = state.sheet.charts[0];
  } else {
    if (!inChartView()) return;
    chart = state.chart.chart;
  }
  const i = chartView.pointAt(event.clientX);
  if (i === null || (i === lastHoverPoint && state.chart?.chart === chart)) return;
  lastHoverPoint = i;
  if (state.chart?.chart !== chart) openChart(chart, 0, i);
  state.chart.point = i;
  focusPoint();
  // While the chart's summary is being read, the notes play underneath it rather
  // than cutting it off; once it has finished, sweeping speaks points as usual.
  if (!summaryPlaying()) voice.stop();
  playPointNote(i);
  clearTimeout(chartPauseTimer);
  chartPauseTimer = setTimeout(() => {
    if (summaryPlaying()) return;
    if (state.chart?.chart === chart && state.chart.point === i) announcePoint("", false);
  }, CHART_PAUSE_MS);
}

function summaryPlaying() {
  return Boolean(state.chart?.speakingSummary) && voice.isSpeaking();
}

// The note for one point: on the sheet-wide Piano scale when sonify.js has one,
// so a value sounds the same in both modes; else on this chart's own range.
function playPointNote(i) {
  const points = state.chart.chart.series[state.chart.series || 0].points;
  const value = points[i]?.value;
  if (value === null || value === undefined) return 0; // a gap stays silent
  let freq;
  let gain = 0.2;
  if (sonify?.hasScale?.()) {
    freq = sonify.frequencyFor(value);
    gain = sonify.gainFor?.(freq) ?? gain;
  } else {
    const values = points.map((p) => p.value).filter((v) => v !== null);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    freq = 220 * 4 ** (hi > lo ? (value - lo) / (hi - lo) : 0.5); // two octaves
  }
  const pan = points.length > 1 ? -0.8 + (1.6 * i) / (points.length - 1) : 0;
  return cues.note(freq, { pan, gain, ms: CHART_NOTE_MS });
}

// The row to chart: the focused one, or the first data row from a header.
function chartRow() {
  return state.focus.row === state.sheet.header_row ? state.sheet.header_row + 1 : state.focus.row;
}

// The column to chart: the focused one, or the first of the main series.
function chartCol() {
  const cols = chartColumns();
  return cols.includes(state.focus.col) ? state.focus.col : cols[0];
}

// Up / Down in the chart view: the previous or next row (or column) as a chart.
function stepChart(step) {
  if (state.chart.chart.picked) return stepLine(step);
  if (state.chart.which === "row") {
    const row = chartRow() + step;
    if (row <= state.sheet.header_row || row > state.sheet.n_rows) {
      voice.announce(step < 0 ? "First row." : "Last row.");
      return;
    }
    setFocus(row, state.focus.col);
    openChartView("row");
  } else {
    const cols = chartColumns();
    const next = cols[cols.indexOf(chartCol()) + step];
    if (next === undefined) {
      voice.announce(step < 0 ? "First column." : "Last column.");
      return;
    }
    setFocus(state.focus.row, next);
    openChartView("column");
  }
}

// Up / Down on a chart you built: the previous or next line.
function stepLine(step) {
  const lines = state.chart.chart.series;
  const s = state.chart.series + step;
  if (s < 0 || s >= lines.length) {
    voice.announce(step < 0 ? "First line." : "Last line.");
    return;
  }
  state.chart.series = s;
  state.chart.point = Math.min(state.chart.point, lines[s].points.length - 1);
  focusPoint();
  const facts = lineFacts(lines[s], state.chart.markedBySeries[s], true);
  state.chart.speakingSummary = true;
  voice.announce(`Line ${s + 1} of ${lines.length}. ${facts.join(". ")}.`);
}

// ---------- Building your own chart (M / Shift+M) ----------

// M adds the current row to your chart (Shift+M the column); again removes it.
function togglePick(kind) {
  const index = kind === "row" ? state.focus.row : state.focus.col;
  const line = kind === "row" ? rowLine(index) : columnLine(index);
  if (!line || line.points.filter((p) => p.value !== null).length < 2) {
    voice.announce(`This ${kind} doesn't have enough numbers to chart.`);
    return;
  }
  let note = "";
  if (state.picks.kind && state.picks.kind !== kind) {
    clearPicks();
    note = `Started a new chart of ${kind}s. `;
  }
  state.picks.kind = kind;
  const at = state.picks.items.indexOf(index);
  const added = at === -1;
  if (added) state.picks.items.push(index);
  else state.picks.items.splice(at, 1);
  markPick(kind, index, added);

  const names = state.picks.items.map((i) => (kind === "row" ? rowLine(i) : columnLine(i)).name);
  const now = names.length
    ? `Your chart: ${listed(names)}. Press 4 to see it.`
    : "Your chart is empty.";
  voice.announce(`${note}${line.name} ${added ? "added" : "removed"}. ${now}`);
}

// A visible outline on the picked row's label or the picked column's header.
function markPick(kind, index, on) {
  const row = kind === "row" ? index : state.sheet.header_row;
  const col = kind === "row" ? state.sheet.label_col : index;
  gridEl.querySelector(`td[data-row="${row}"][data-col="${col}"]`)?.classList.toggle("picked", on);
}

function clearPicks() {
  for (const i of state.picks.items) markPick(state.picks.kind, i, false);
  state.picks = { kind: null, items: [] };
}

// N / Shift+N in the chart view: the chart's marked points, wrapping round.
function nextMarkedPoint(step) {
  const marked = [...state.chart.markedBySeries[state.chart.series]].sort((a, b) => a - b);
  if (!marked.length) {
    voice.announce("No marked points on this line.");
    return;
  }
  const here = state.chart.point;
  const ahead = step > 0 ? marked.find((i) => i > here) : [...marked].reverse().find((i) => i < here);
  state.chart.point = ahead ?? (step > 0 ? marked[0] : marked[marked.length - 1]);
  focusPoint();
  const at = marked.indexOf(state.chart.point) + 1;
  announcePoint(`${at} of ${marked.length}. `);
}

function inChartView() {
  return state.mode === "chart" && Boolean(state.chart?.chart?.drawn);
}

// The comparable columns of one row, left to right.
function rowChart(row) {
  const line = rowLine(row);
  if (!line) return null;
  const measure = state.sheet.value_label;
  return finishChart(`drawn-row-${row}`, measure ? `${line.name}: ${measure}` : line.name, [line]);
}

// One row as a line: the comparable columns, left to right.
function rowLine(row) {
  if (row === state.sheet.header_row) return null;
  const points = chartColumns().map((col) => chartPoint(cellAt(row, col), colHeader(col)));
  return { name: rowLabel(row) || `Row ${row}`, points };
}

// One column as a line: top to bottom, labelled by the rows.
function columnLine(col) {
  if (col === state.sheet.label_col) return null;
  const points = [];
  for (let row = state.sheet.header_row + 1; row <= state.sheet.n_rows; row++) {
    points.push(chartPoint(cellAt(row, col), rowLabel(row) || `Row ${row}`));
  }
  return { name: spokenHeader(colHeader(col)) || `Column ${columnLetter(col)}`, points };
}

// One column, top to bottom, labelled by the rows.
function columnChart(col) {
  const line = columnLine(col);
  return line ? finishChart(`drawn-col-${col}`, line.name, [line]) : null;
}

// The chart the listener built with M / Shift+M: all picked rows, or all picked
// columns, as lines on one chart.
function pickedChart() {
  const { kind, items } = state.picks;
  const lines = items.map((i) => (kind === "row" ? rowLine(i) : columnLine(i))).filter(Boolean);
  const names = lines.map((l) => l.name);
  const measure = kind === "row" ? state.sheet.value_label : "";
  const title = listed(names) + (measure ? `: ${measure}` : "");
  return finishChart("drawn-picked", title, lines, { picked: true });
}

// The sheet's main series (the engine's series_cols), else every numeric column.
function chartColumns() {
  if (state.sheet.series_cols?.length) return state.sheet.series_cols;
  const cols = [];
  for (let col = 1; col <= state.sheet.n_cols; col++) {
    if (col === state.sheet.label_col) continue;
    const cell = cellAt(state.sheet.header_row + 1, col);
    if (typeof cell?.value === "number") cols.push(col);
  }
  return cols;
}

function chartPoint(cell, category) {
  return {
    category: category || "",
    value: typeof cell?.value === "number" ? cell.value : null,
    display: cell?.display || "",
    ref: cell?.ref || null,
  };
}

// lines: [{ name, points }]. Lines with fewer than two numbers are left out.
// markedBySeries: for each line, the points whose cell has a cue.
function finishChart(id, title, lines, extra = {}) {
  const usable = lines.filter((l) => l.points.filter((p) => p.value !== null).length >= 2);
  if (!usable.length) return null;
  const markedBySeries = usable.map((line) => {
    const marked = new Set();
    line.points.forEach((p, i) => {
      const cell = p.ref && state.cellsByRef.get(p.ref);
      if (cell && pointCues(cell).length) marked.add(i);
    });
    return marked;
  });
  const chart = { id, kind: "line", title, drawn: true, series: usable, ...extra };
  return { chart, markedBySeries };
}

// "Italy", "Italy and Germany", "Italy, France and Germany"
function listed(names) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// The cue sentences for a chart point's source cell, under the current filter.
function pointCues(cell) {
  return cueSentences(cell.row, cell.col, cell).cueFacts;
}

// "Line chart of Italy: sales, January to December. Starts at €100,000 in
// January and ends at €89,000 in December, down 11%. Highest …"
// The chart's own summary, from the engine's measurements only (no AI): per line
// its start and end (or, for lists that aren't a time series, its highest,
// lowest and typical value), then how the lines compare, then marked points.
function chartFacts(chart, markedBySeries) {
  const lines = chart.series;
  const first = lines[0].points;
  const say = (p) => spokenHeader(p.category);
  const parts = [
    `Line chart of ${chart.title}, ${say(first[0])} to ${say(first[first.length - 1])}` +
      (lines.length > 1 ? `. ${lines.length} lines` : ""),
  ];
  lines.forEach((line, s) => parts.push(...lineFacts(line, markedBySeries[s], lines.length > 1)));
  if (lines.length > 1) parts.push(...compareLines(lines));
  const moves = lines.length > 1
    ? "Up and down switch line, left and right move between points"
    : "Left and right move between points";
  parts.push(`${moves}. Escape returns to the sheet`);
  return parts.join(". ") + ".";
}

function lineFacts(line, marked, named) {
  const valued = line.points.filter((p) => p.value !== null);
  const say = (p) => spokenHeader(p.category);
  const timeline = Boolean(timePhrase(valued[0].category));
  const at = timeline ? "in" : "for";
  const high = valued.reduce((a, b) => (b.value > a.value ? b : a));
  const low = valued.reduce((a, b) => (b.value < a.value ? b : a));
  const lead = named ? `${line.name}: ` : "";
  const facts = [];
  if (timeline) {
    const a = valued[0];
    const z = valued[valued.length - 1];
    facts.push(`${lead}starts at ${a.display} ${at} ${say(a)} and ends at ${z.display} ${at} ${say(z)}${change(a.value, z.value)}`);
    facts.push(`Highest ${high.display} ${at} ${say(high)}. Lowest ${low.display} ${at} ${say(low)}`);
  } else {
    // A list (orders, people, countries): start and end mean nothing here.
    const middle = [...valued].sort((x, y) => x.value - y.value)[Math.floor(valued.length / 2)];
    facts.push(`${lead}${valued.length} values. Highest ${high.display} ${at} ${say(high)}. ` +
      `Lowest ${low.display} ${at} ${say(low)}. Typical value ${middle.display}`);
  }
  facts[0] = sentenceCase(facts[0]);

  // Neighbouring points with the same cue are said once: "October to December: …".
  const groups = [];
  for (const i of [...marked].sort((x, y) => x - y)) {
    const text = pointCues(state.cellsByRef.get(line.points[i].ref)).join(". ");
    const last = groups[groups.length - 1];
    if (last && last.text === text && last.to === i - 1) last.to = i;
    else groups.push({ from: i, to: i, text });
  }
  const marks = groups.map(({ from, to, text }) =>
    `${say(line.points[from])}${to > from ? ` to ${say(line.points[to])}` : ""}: ${text}`);
  if (marks.length) {
    const count = marked.size === 1 ? "1 marked point" : `${marked.size} marked points`;
    const more = marks.length > 5 ? `, and ${marks.length - 5} more` : "";
    facts.push(`${count}. ${marks.slice(0, 5).join(". ")}${more}`);
  }
  return facts;
}

// How the lines compare: who is highest at the start and at the end, and the
// highest point of all. Measured, never judged.
function compareLines(lines) {
  const say = (p) => spokenHeader(p.category);
  const facts = [];
  const count = lines[0].points.length;
  const ends = [0, count - 1].filter((i, n, all) => all.indexOf(i) === n);
  for (const i of ends) {
    const here = lines
      .map((l) => ({ name: l.name, point: l.points[i] }))
      .filter((x) => x.point && x.point.value !== null)
      .sort((a, b) => b.point.value - a.point.value);
    if (here.length < 2) continue;
    const [top, next] = here;
    const gap = top.point.value - next.point.value;
    const unit = (top.point.display.match(/^[^\d-]*/) || [""])[0];
    const where = timePhrase(top.point.category) ? "In" : "For";
    facts.push(`${where} ${say(top.point)}, ${top.name} is highest at ${top.point.display}, ` +
      `${unit}${Math.round(gap).toLocaleString("en-US")} above ${next.name}`);
  }
  let best = null;
  for (const l of lines) {
    for (const p of l.points) {
      if (p.value !== null && (!best || p.value > best.point.value)) best = { name: l.name, point: p };
    }
  }
  if (best) {
    const where = timePhrase(best.point.category) ? "in" : "for";
    facts.push(`Highest point of all: ${best.name}, ${best.point.display} ${where} ${say(best.point)}`);
  }
  return facts;
}

// ", up 40%" / ", down 11%" / ", about the same"
function change(first, last) {
  if (!first) return "";
  const pct = Math.round((100 * (last - first)) / Math.abs(first));
  if (pct === 0) return ", about the same";
  return `, ${pct > 0 ? "up" : "down"} ${Math.abs(pct)}%`;
}

// A point on a drawn chart: its cues first (with the chime), then where and what.
// The point's note comes first (its height); a marked point then chimes.
function announceDrawnPoint(prefix, line, data, withNote = true) {
  state.chart.speakingSummary = false;
  const cell = data.ref && state.cellsByRef.get(data.ref);
  const found = cell ? pointCues(cell) : [];
  const who = state.chart.chart.series.length > 1 ? `${line.name}. ` : "";
  const said = `${who}${spokenHeader(data.category)}. ${data.display || "blank"}.`;
  const noteMs = withNote ? playPointNote(state.chart.point) : 0;
  let soundMs = noteMs;
  if (found.length) {
    const type = topSignal(cell) || "visual";
    setTimeout(() => cues.play(type), noteMs);
    soundMs = noteMs + cues.length(type);
  } else if (!noteMs) {
    soundMs = cues.play("tick");
  }
  voice.announce(prefix + (found.length ? `${found.join(". ")}. ${said}` : said), {
    priority: found.length ? "assertive" : "polite",
    delay: soundMs,
  });
}

// ---------- Trend Scan ----------

// Once per sheet: every number in the main series fixes the pitch scale, so rows
// can be compared by ear.
function applyScale() {
  if (!sonify || !state.sheet) return;
  const values = [];
  for (let row = state.sheet.header_row + 1; row <= state.sheet.n_rows; row++) {
    for (const col of state.sheet.series_cols || []) {
      const value = cellAt(row, col)?.value;
      if (typeof value === "number") values.push(value);
    }
  }
  sonify.setScale(values);
}

// R / C in Trend Scan: the current row or column as tones. Where there is no
// series to play (a header row, a column outside the series), read it instead.
function playTones(which) {
  const { row, col } = state.focus;
  const { header_row, n_rows } = state.sheet;
  const series = state.sheet.series_cols || [];
  const number = (cell) => (typeof cell?.value === "number" ? cell.value : null);
  let values;
  let label;

  if (which === "row") {
    if (row === header_row || !series.length) return readRow();
    values = series.map((c) => number(cellAt(row, c)));
    label =
      `${rowLabel(row) || `Row ${row}`}, ` +
      `${spokenHeader(colHeader(series[0]))} to ${spokenHeader(colHeader(series[series.length - 1]))}`;
  } else {
    if (!series.includes(col)) return readColumn();
    const rows = [];
    for (let r = header_row + 1; r <= n_rows; r++) rows.push(r);
    values = rows.map((r) => number(cellAt(r, col)));
    label = `${spokenHeader(colHeader(col))}, ${rowLabel(rows[0])} to ${rowLabel(rows[rows.length - 1])}`;
  }
  voice.stop(); // the tones and their spoken scale line come from sonify.js
  sonify.playSeries({ values, label, unit: seriesUnit() });
}

// "€" when the series is shown in a currency, so the scale line says "€62,000".
function seriesUnit() {
  for (const col of state.sheet.series_cols || []) {
    const symbol = cellAt(state.sheet.header_row + 1, col)?.display?.match(/[€$£¥]/)?.[0];
    if (symbol) return symbol;
  }
  return "";
}

// "Pattern cue: Falls 60% after 6 months of rises". The engine's detail is a
// fact, not a verdict, so it can be said straight away; W adds more context.
// An error cell already says its error ("has an error: division by zero"),
// so its cue is just the name.
function cueWithFact(signal, cell) {
  const name = SIGNAL_NAMES[signal.type] || signal.type;
  const fact = (signal.detail || "").trim().replace(/\.$/, "");
  if (!fact || (signal.type === "error" && cell?.error)) return name;
  return `${name}: ${fact}`;
}

// ---------- Number formats that don't match their row ----------
// September formatted as a percentage among months shown in euros reads as
// "6,900,000.0%". A sighted reader would spot that the column looks different;
// we say so on every cell of it, as facts. Only the columns Margaux's engine
// names as comparable (series_cols) are compared, so a growth ratio is never
// measured against sales. No series_cols, no alert: we don't guess.

const FORMAT_WORDS = { percent: "a percentage", currency: "currency", plain: "a plain number" };
const CURRENCY_WORDS = { "€": "euros", "$": "dollars", "£": "pounds", "¥": "yen" };

// "percent", "currency" or "plain" for a numeric cell; null otherwise.
function formatKind(cell) {
  if (typeof cell?.value !== "number") return null;
  const format = cell.number_format || "General";
  if (format.includes("%")) return "percent";
  if (/[€$£¥]|\[\$/.test(format)) return "currency";
  return "plain";
}

// { alert, stored } when this cell's format differs from most of its row, or null.
function formatMismatch(row, col) {
  const series = state.sheet.series_cols || [];
  if (row === state.sheet.header_row || !series.includes(col)) return null;
  const cell = cellAt(row, col);
  const kind = formatKind(cell);
  if (!kind) return null;

  const others = series.filter((c) => c !== col).map((c) => cellAt(row, c)).filter(formatKind);
  const counts = {};
  for (const other of others) counts[formatKind(other)] = (counts[formatKind(other)] || 0) + 1;
  const [usual, howMany] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  // Only when most of the row clearly agrees on something else.
  if (!usual || usual === kind || howMany <= others.length / 2) return null;

  const example = others.find((other) => formatKind(other) === usual);
  const symbol = example.display.match(/[€$£¥]/)?.[0];
  const theirs = usual === "currency" ? CURRENCY_WORDS[symbol] || "currency" : FORMAT_WORDS[usual];
  // The stored number only adds something when the format hides it (6,900,000.0%).
  const stored = cell.value.toLocaleString("en-US");
  return {
    alert: `Format differs from the rest of the row: shown as ${FORMAT_WORDS[kind]} while the others show ${theirs}`,
    stored: cell.display === stored ? null : `The number stored is ${stored}`,
  };
}

// ---------- What it looks like (the author's visual vocabulary) ----------

// Nearest plain colour word for an ARGB hex. Never read hex codes aloud.
function colourName(argb) {
  const hex = (argb || "").slice(-6);
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const spread = max - min;
  if (spread < 0.12) return light < 0.2 ? "black" : light > 0.85 ? "white" : "grey";

  let hue;
  if (max === r) hue = (((g - b) / spread + 6) % 6) * 60;
  else if (max === g) hue = ((b - r) / spread + 2) * 60;
  else hue = ((r - g) / spread + 4) * 60;
  if (hue < 15 || hue >= 345) return "red";
  if (hue < 45) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 165) return "green";
  if (hue < 255) return "blue";
  if (hue < 290) return "purple";
  return "pink";
}

// What a sighted person would notice about a cell, in short words.
// everything=false (navigation): only what stands out at a glance. Bold headers
// and labels, borders and conditional formatting are too common to repeat on
// every cell. everything=true (the D key): all of it.
function formattingWords(row, col, cell, { everything = false } = {}) {
  if (!cell) return [];
  const words = [];
  const structural = row === state.sheet.header_row || col === state.sheet.label_col;

  if (cell.fill) {
    const colour = cell.fill === "unknown-non-default" ? null : colourName(cell.fill);
    words.push(colour ? `highlighted ${colour}` : "highlighted");
  }
  // Excel often stores ordinary black text as a theme colour, which reaches us
  // as "unknown-non-default"; only a colour we can actually name is announced.
  const text = colourName(cell.font_color);
  if (text && text !== "black") words.push(`${text} text`);
  if (cell.bold && (everything || !structural)) words.push("bold");
  if (cell.italic) words.push("italic");
  if (cell.underline) words.push("underlined");
  if (cell.strike) words.push("crossed out");
  if (everything) {
    if (cell.bordered) words.push("has a border");
    if (cell.conditional) words.push("has conditional formatting");
  } else if (cell.comment) {
    words.push("has a note");
  }
  return words;
}

function sentenceCase(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// "=(M8-L8)/L8" → "M8 minus L8 divided by L8"
function spokenFormula(formula) {
  return formula
    .replace(/^=/, "")
    .replace(/:/g, " to ")
    .replace(/\//g, " divided by ")
    .replace(/\*/g, " times ")
    .replace(/\+/g, " plus ")
    .replace(/(?<=[\w)])\s*-/g, " minus ")
    .replace(/[(),]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The cue's sound plays first; speech waits until it has finished.
// Flagged cells interrupt politely-queued output.
// suffix: said after the cell, e.g. what the chart also marks at this cell.
function announceFocus(prefix = "", suffix = "") {
  const { row, col } = state.focus;
  const cell = cellAt(row, col);
  // A format mismatch gets the same "something here" chime as a flagged cell.
  const type = topSignal(cell) || (visibleMismatch(row, col) ? "visual" : null);
  const soundMs = cues.play(type || "tick");

  // Trend Scan: ordinary numbers are silent; the tick is enough to feel movement.
  const isDataNumber =
    typeof cell?.value === "number" &&
    row !== state.sheet.header_row &&
    col !== state.sheet.label_col;
  if (state.mode === "scan" && !type && isDataNumber) {
    voice.stop();
    return;
  }

  const full = state.mode === "explore" || state.mode === "chart";
  const text = full ? describeCell(row, col) : describeConcise(row, col);
  voice.announce(prefix + text + suffix, {
    priority: type ? "assertive" : "polite",
    delay: soundMs,
  });
}

// ---------- Actions ----------

function move(dRow, dCol) {
  const row = state.focus.row + dRow;
  const col = state.focus.col + dCol;
  const { n_rows, n_cols } = state.sheet;
  if (row < 1 || row > n_rows || col < 1 || col > n_cols) {
    voice.announce("Edge of sheet.");
    return;
  }
  setFocus(row, col);
  announceFocus();
}

// NOTICE: step through attention_order, wrapping around at either end.
function jumpToFlagged(step) {
  const order = flaggedOrder();
  if (!order.length) {
    voice.announce(
      state.filter === 0
        ? "Nothing in this sheet was flagged."
        : `Nothing flagged with the filter ${FILTERS[state.filter].name}. Press F to change it.`
    );
    return;
  }
  const here = columnLetter(state.focus.col) + state.focus.row;
  let i = order.indexOf(here);
  // Not on a flagged cell: N goes to the first, Shift+N to the last.
  if (i === -1) i = step > 0 ? -1 : 0;
  goToFlagged(order, (i + step + order.length) % order.length);
}

function goToFlagged(order, i) {
  const cell = state.cellsByRef.get(order[i]);
  if (!cell) return;
  setFocus(cell.row, cell.col);
  announceFocus(`${i + 1} of ${order.length}. `);
}

// ORIENT
function speakOverview() {
  voice.announce(state.sheet.overview || `${state.sheet.title}. No overview available.`);
}

// UNDERSTAND. Phase 2 asks /api/explain first and keeps this as the fallback.
// Asks /api/explain; on any failure uses localExplanation(). Answers are kept
// per cell for this sheet, since the server remembers nothing.
async function explainFocus() {
  if (state.chart) return explainPoint();
  return explainCell();
}

async function explainCell() {
  const { row, col } = state.focus;
  const cell = cellAt(row, col);
  if (!cell?.signals.length) {
    voice.announce("No cues on this cell. Press D to describe it.");
    return;
  }
  const ref = cell.ref;
  // What the chart also says here, when a chart point shares this cell's stop.
  const chartNote = chartNoteFor(ref);
  if (state.explanations.has(ref)) {
    voice.announce(withNote(state.explanations.get(ref), chartNote));
    return;
  }

  const patience = setTimeout(() => voice.announce("One moment."), EXPLAIN_PATIENCE_MS);
  const fromServer = await fetchExplanation(cell, row, col);
  clearTimeout(patience);
  if (fromServer) state.explanations.set(ref, fromServer);

  // Don't talk over a cell the user has already moved on from.
  if (state.focus.row !== row || state.focus.col !== col) return;
  voice.announce(withNote(fromServer || localExplanation(cell, row, col), chartNote));
}

function withNote(text, note) {
  return note ? `${text} ${note}` : text;
}

async function fetchExplanation(cell, row, col) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPLAIN_TIMEOUT_MS);
  try {
    const res = await fetch("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cell,
        ...context(cell, row, col),
        row_values: rowValues(row),
        signals: cell.signals,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return body.text?.trim() || null;
  } catch (err) {
    console.warn("[explain] using the local explanation:", err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The row label and column header around a cell. A header cell has no row
// label (the cell at the start of the header row is a heading, e.g. "Country"),
// and a label cell has no column header.
function context(cell, row, col) {
  const inHeaderRow = row === state.sheet.header_row;
  const inLabelCol = col === state.sheet.label_col;
  return {
    row_label: inHeaderRow ? null : cell.row_label || rowLabel(row) || null,
    col_header: inLabelCol ? null : cell.col_header || colHeader(col) || null,
  };
}

// The row's values, left to right, without its label: context for /api/explain.
function rowValues(row) {
  const values = [];
  for (let col = 1; col <= state.sheet.n_cols; col++) {
    if (col !== state.sheet.label_col) values.push(cellAt(row, col)?.value ?? null);
  }
  return values;
}

// Offline fallback: the engine's own facts, joined.
function localExplanation(cell, row, col) {
  const { row_label, col_header } = context(cell, row, col);
  const where = [row_label, spokenHeader(col_header)].filter(Boolean).join(", ");
  const reasons = cell.signals.map((s) => s.detail).join(". ");
  return `${where}. ${reasons}.`;
}

// D: everything a sighted person could see about this cell, flagged or not.
// "Anything visible is theirs to have."
function describeFocus() {
  const { row, col } = state.focus;
  const cell = cellAt(row, col);
  const out = [`${columnLetter(col)}${row}`];

  if (!cell || (cell.display === "" && !cell.error)) out.push("Empty");
  else if (cell.error) out.push(`Shows an error: ${spokenValue(cell).toLowerCase()}`);
  else out.push(`Shows ${cell.display}`);

  if (cell?.formula) out.push(`Calculated by the formula ${spokenFormula(cell.formula)}`);

  const mismatch = formatMismatch(row, col);
  if (mismatch) out.push(...[mismatch.alert, mismatch.stored].filter(Boolean));

  const looks = formattingWords(row, col, cell, { everything: true });
  out.push(looks.length ? `Formatting: ${looks.join(", ")}` : "No special formatting");

  if (cell?.comment) out.push(`Note: ${cell.comment}`);

  const types = [...new Set((cell?.signals || []).map((s) => s.type))];
  if (types.length) {
    out.push(`Cues: ${types.map((t) => SIGNAL_NAMES[t].toLowerCase()).join(", ")}. Press W for why`);
  }
  voice.announce(out.join(". ") + ".");
}

// R: "Italy. Jan, €80,000. Feb, €81,200. …"
function readRow() {
  const { row } = state.focus;
  const { n_cols, label_col, header_row } = state.sheet;
  const parts = [];
  for (let col = 1; col <= n_cols; col++) {
    const cell = cellAt(row, col);
    if (col === label_col) continue;
    const header = row === header_row ? "" : colHeader(col);
    parts.push(header ? `${spokenHeader(header)}, ${spokenValue(cell)}` : spokenValue(cell));
  }
  const label = rowLabel(row) || `Row ${row}`;
  const empty = parts.every((p) => p.endsWith("blank"));
  voice.announce(empty ? `${label}. Empty row.` : `${label}. ${parts.join(". ")}.`);
}

// C: "May. France, €79,500. Italy, €31,000. …"
function readColumn() {
  const { col } = state.focus;
  const { n_rows, label_col, header_row } = state.sheet;
  const parts = [];
  for (let row = 1; row <= n_rows; row++) {
    const cell = cellAt(row, col);
    if (row === header_row) continue;
    const label = col === label_col ? "" : rowLabel(row);
    parts.push(label ? `${spokenHeader(label)}, ${spokenValue(cell)}` : spokenValue(cell));
  }
  const header = spokenHeader(colHeader(col)) || `Column ${columnLetter(col)}`;
  const empty = parts.every((p) => p.endsWith("blank"));
  voice.announce(empty ? `${header}. Empty column.` : `${header}. ${parts.join(". ")}.`);
}

// ---------- Charts (EXPLORE, NOTICE, UNDERSTAND) ----------
//
// The backend sends one line chart in sheet.charts, and sheet.attention_items:
// the N order across cells and chart points, one stop per place. A sheet without
// chart events has no attention_items, and everything below stays out of the way.

const CHART_WORDS = { line: "Line chart" };

function hasChart() {
  return Boolean(state.sheet?.charts?.length);
}

// attention_items (cells and chart points in one N order), keeping only the
// stops the current filter lets through. Chart events are pattern cues, so they
// count as "trend": Author only skips them, Data only keeps them.
function attentionItems() {
  const types = FILTERS[state.filter].types;
  return (state.sheet?.attention_items || []).filter((item) => {
    if (item.kind === "chart") return types.includes("trend");
    const cellCue = visibleSignals(state.cellsByRef.get(item.ref)).length > 0;
    return cellCue || (item.events?.length > 0 && types.includes("trend"));
  });
}

function nextSignal(step) {
  if (attentionItems().length) jumpToItem(step);
  else jumpToFlagged(step);
}

function currentPoint() {
  const { chart, series, point } = state.chart;
  return { line: chart.series[series], data: chart.series[series].points[point] };
}

// The N stop at this chart point, if any (a chart stop, or a cell stop it joined).
function itemAtPoint() {
  const { chart, series, point } = state.chart;
  return attentionItems().find(
    (it) => it.chart === chart.id && it.series === series && it.point === point
  );
}

// "Lowest point, largest fall." from ["Lowest point: August", "Largest fall: August"]
function chartLabels(item) {
  return sentenceCase(item.labels.map((l) => l.split(":")[0].toLowerCase()).join(", ")) + ".";
}

// For W on a cell: what a chart point sharing this cell's stop adds.
function chartNoteFor(ref) {
  const item = attentionItems().find((it) => it.kind === "cell" && it.ref === ref);
  return item?.events.length ? item.explanation : "";
}

// Keep the grid's focus on the point's source cell, and the drawn chart's
// highlight on the point itself, so sighted viewers can follow.
function focusPoint() {
  const cell = state.cellsByRef.get(currentPoint().data.ref);
  if (cell) setFocus(cell.row, cell.col);
  chartView.highlight(state.chart.point, state.chart.series);
}

// The drawn chart: shown only when the sheet has one, hidden and empty otherwise.
function renderChartPanel() {
  if (!hasChart()) {
    chartView.clear(chartPanelEl);
    chartPanelEl.hidden = true;
    return;
  }
  const chart = state.sheet.charts[0];
  const cuePoints = new Set(
    attentionItems().filter((it) => it.chart === chart.id && it.series === 0).map((it) => it.point)
  );
  chartView.render(chartPanelEl, chart, cuePoints);
  chartPanelEl.hidden = false;
}

// "Chart. Pattern cue. Italy. August. €62,000. Lowest point, largest fall."
function announcePoint(prefix = "", withNote = true) {
  const { line, data } = currentPoint();
  if (state.chart.chart.drawn) return announceDrawnPoint(prefix, line, data, withNote);
  const item = itemAtPoint();
  const name = line.name || state.chart.chart.title || "Line";
  const said = `${name}. ${spokenHeader(data.category)}. ${data.display || "blank"}.`;
  // The chart's cues are pattern cues: the same single sound as every other cue.
  const soundMs = cues.play(item ? "trend" : "tick");
  const text = item ? `${prefix}Chart. Pattern cue. ${said} ${chartLabels(item)}` : prefix + said;
  voice.announce(text, { priority: item ? "assertive" : "polite", delay: soundMs });
}

function openChart(chart, series, point) {
  if (!state.chart) {
    state.chart = { status: statusEl.textContent };
  }
  Object.assign(state.chart, { chart, series, point });
  statusEl.textContent =
    `Exploring the chart ${chart.title || ""}. ` +
    "Left and right move between points. Escape returns to the sheet.";
  focusPoint();
}

// G: into the chart, starting at the point under the grid focus if there is one.
function enterChart() {
  if (!hasChart()) return;
  const chart = state.sheet.charts[0];
  const points = chart.series[0].points;
  const here = columnLetter(state.focus.col) + state.focus.row;
  const start = Math.max(points.findIndex((p) => p.ref === here), 0);
  openChart(chart, 0, start);

  const names = chart.series.map((s) => s.name).filter(Boolean);
  const intro = [
    CHART_WORDS[chart.kind] || "Chart",
    chart.title || "Untitled",
    names.length ? `Series: ${names.join(", ")}` : "",
    `${spokenHeader(points[0].category)} to ${spokenHeader(points[points.length - 1].category)}`,
  ].filter(Boolean).join(". ");
  announcePoint(`${intro}. `);
}

function movePoint(step) {
  const { line } = currentPoint();
  const point = state.chart.point + step;
  if (point < 0 || point >= line.points.length) {
    voice.announce(step < 0 ? "Start of chart." : "End of chart.");
    return;
  }
  state.chart.point = point;
  focusPoint();
  announcePoint();
}

// Escape (announce) or a click on the grid (silent): back to the spreadsheet.
function leaveChart(announce) {
  if (!state.chart) return;
  statusEl.textContent = state.chart.status;
  state.chart = null;
  chartView.highlight(null); // the chart stays visible, with no active point
  if (announce) {
    voice.stop();
    voice.announce(`Back to the sheet. ${columnLetter(state.focus.col)}${state.focus.row}.`);
  }
}

function chartHint() {
  voice.announce("Left and right move between points. Escape returns to the sheet.");
}

// W in the chart: the prepared explanation. At a point that shares a flagged
// cell's stop, the cell's own explanation comes first, then the chart's.
function explainPoint() {
  // A chart drawn in Chart mode: its points are the grid's own cells.
  if (state.chart.chart.drawn) return explainCell();
  const item = itemAtPoint();
  if (!item) {
    voice.announce("No cues at this point.");
    return;
  }
  if (item.kind === "cell") return explainCell();
  voice.announce(item.explanation);
}

// N / Shift+N through attention_items, wrapping at either end, like jumpToFlagged.
function jumpToItem(step) {
  const items = attentionItems();
  let i = currentItemIndex();
  // Not on a stop: N goes to the first, Shift+N to the last.
  if (i === -1) i = step > 0 ? -1 : 0;
  goToItem((i + step + items.length) % items.length);
}

function currentItemIndex() {
  const items = attentionItems();
  if (state.chart) {
    const item = itemAtPoint();
    return item ? items.indexOf(item) : -1;
  }
  const here = columnLetter(state.focus.col) + state.focus.row;
  return items.findIndex((it) => it.kind === "cell" && it.ref === here);
}

function goToItem(i) {
  const items = attentionItems();
  const item = items[i];
  const prefix = `${i + 1} of ${items.length}. `;
  if (item.kind === "chart") {
    const chart = state.sheet.charts.find((c) => c.id === item.chart);
    if (!chart) return;
    openChart(chart, item.series, item.point);
    announcePoint(prefix);
    return;
  }
  leaveChart(false);
  const cell = state.cellsByRef.get(item.ref);
  if (!cell) return;
  setFocus(cell.row, cell.col);
  // A cell stop the chart also marks (August): show that point on the chart too.
  if (item.events.length) chartView.highlight(item.point);
  const alsoChart = item.events.length ? ` Also on the chart: ${chartLabels(item).toLowerCase()}` : "";
  announceFocus(prefix, alsoChart);
}

// ---------- Events ----------

// Chart keys only take over while a chart is open (arrows, Escape) or when the
// sheet has chart events (N, Space). Otherwise every key does what it always did.
const KEY_ACTIONS = {
  ArrowUp: () => (inChartView() ? stepChart(-1) : state.chart ? chartHint() : move(-1, 0)),
  ArrowDown: () => (inChartView() ? stepChart(1) : state.chart ? chartHint() : move(1, 0)),
  ArrowLeft: () => (state.chart ? movePoint(-1) : move(0, -1)),
  ArrowRight: () => (state.chart ? movePoint(1) : move(0, 1)),
  " ": (event) => (inChartView() ? nextMarkedPoint : nextSignal)(event.shiftKey ? -1 : 1),
  n: (event) => (inChartView() ? nextMarkedPoint : nextSignal)(event.shiftKey ? -1 : 1),
  g: () => (inChartView()
    ? voice.announce("Press Escape to bring the table back, then G for the workbook's own chart.")
    : enterChart()),
  1: () => setMode("explore"),
  2: () => setMode("concise"),
  3: () => setMode("scan"),
  4: () => setMode("chart"),
  f: cycleFilter,
  // In the chart view, O is the chart's own summary.
  o: () => {
    if (!inChartView()) return speakOverview();
    state.chart.speakingSummary = true;
    voice.announce(chartFacts(state.chart.chart, state.chart.markedBySeries));
  },
  m: (event) => (inChartView()
    ? voice.announce("Press Escape to go back to the table, then M to change your chart.")
    : togglePick(event.shiftKey ? "column" : "row")),
  w: explainFocus,
  "?": explainFocus,
  d: describeFocus,
  l: () => startLoadingDemo(),
  k: () => startLoadingChartDemo(),
  u: () => chooseFile(),
  r: () => (state.mode === "scan" ? playTones("row") : state.mode === "chart" ? openChartView("row") : readRow()),
  c: () => (state.mode === "scan" ? playTones("column") : state.mode === "chart" ? openChartView("column") : readColumn()),
  h: () => voice.announce(hasChart() ? HELP_TEXT + CHART_HELP : HELP_TEXT),
  s: stopSpeaking,
  // In a chart, Escape first returns to the sheet; otherwise it stops speaking.
  // Escape: out of the chart view back to the table, out of a workbook chart,
  // or else stop speaking.
  Escape: () => {
    if (state.mode === "chart") {
      setMode("explore");
      voice.announce(`Back to the table. Explore mode. ${columnLetter(state.focus.col)}${state.focus.row}.`);
    } else if (state.chart) leaveChart(true);
    else stopSpeaking();
  },
};

// S, Escape or the Stop speaking button: silence the voice and any tones.
function stopSpeaking() {
  voice.stop();
  sonify?.stop?.();
}

gridEl.addEventListener("keydown", (event) => {
  // Leave browser shortcuts like Cmd+R alone.
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  cues.unlock();
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const action = KEY_ACTIONS[key];
  if (!action) return;
  if (key === "g" && !hasChart()) return; // a sheet without a chart: G does nothing, as before
  event.preventDefault();
  if (!state.sheet && !KEYS_WITHOUT_SHEET.has(key)) {
    voice.announce("No sheet is open yet. Press L to load the demo.");
    return;
  }
  action(event);
});

gridEl.addEventListener("click", (event) => {
  const td = event.target.closest("td[data-row]");
  if (!td || !state.sheet) return;
  cues.unlock();
  leaveChart(false); // clicking a cell means exploring the sheet again
  setFocus(Number(td.dataset.row), Number(td.dataset.col));
  gridEl.focus();
  announceFocus();
});

// Hovering with a mouse announces the cell under the pointer (EXPLORE), and a
// flagged cell plays its cue first (NOTICE). Throttled, and silent until the
// pointer reaches a different cell. Touch comes later.
let hoverTd = null;
let hoverTimer = null;

gridEl.addEventListener("pointermove", (event) => {
  if (!state.sheet || event.pointerType === "touch") return;
  hoverTd = event.target.closest("td[data-row]");
  if (!hoverTimer) hoverTimer = setTimeout(announceHover, HOVER_THROTTLE_MS);
});

function announceHover() {
  hoverTimer = null;
  if (!hoverTd) return;
  const row = Number(hoverTd.dataset.row);
  const col = Number(hoverTd.dataset.col);
  if (row === state.focus.row && col === state.focus.col) return;
  leaveChart(false); // pointing at another cell means exploring the sheet again
  setFocus(row, col);
  announceFocus();
}

// Start: the click that lets the browser play sound and speech. It opens the
// demo sheet (unless one is already showing) and speaks its overview.
startBtn.addEventListener("click", () => {
  if (startBtn.hidden) return; // a key press and its click can both arrive
  cues.unlock();
  startBtn.hidden = true;
  document.title = SITE_NAME;
  gridEl.focus();
  // Speaking inside the click is what unlocks speech on iPhones and iPads.
  // With ?fixture=1 a sheet is already showing, so give its overview instead.
  voice.announce(state.sheet ? orientation() : WELCOME);
});

// Before starting, any key starts: a blind user can't find a button they can't
// see, and pressing a key is the natural first thing to do. Keys held with
// Ctrl, Option or Cmd are left alone, so screen-reader commands (VoiceOver uses
// Ctrl+Option) can explore the page first. Escape doesn't count as a user
// gesture in browsers, so it can't unlock sound anyway.
const NOT_A_START = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Escape", "Tab"]);
document.addEventListener(
  "keydown",
  (event) => {
    if (startBtn.hidden || event.ctrlKey || event.metaKey || event.altKey) return;
    if (NOT_A_START.has(event.key)) return;
    event.preventDefault(); // this key only starts; it doesn't also act on the grid
    event.stopPropagation();
    // L goes straight to the demo; any other key starts with the welcome.
    const key = event.key.toLowerCase();
    if (key === "l") startLoadingDemo();
    else if (key === "k") startLoadingChartDemo();
    else if (key === "u") chooseFile();
    else startBtn.click();
  },
  { capture: true }
);

// L, or the Load demo button: open the demo sheet again.
function startLoadingDemo() {
  cues.unlock(); // this click is what lets the browser play sound later
  startBtn.hidden = true; // sound is unlocked now, so Start has done its job
  document.title = SITE_NAME;
  voice.announce("Opening the demo workbook.");
  loadDemo();
}

document.getElementById("load-demo").addEventListener("click", startLoadingDemo);

// ---------- On-screen controls ----------
// Each button does exactly what its key does on the grid, then hands focus
// back to the grid so the keys keep working.

for (const button of document.querySelectorAll("button.mode")) {
  button.addEventListener("click", () => {
    setMode(button.dataset.mode);
    // Focus back to the grid area, without scrolling the chart under the mouse.
    gridEl.focus({ preventScroll: true });
  });
}

for (const button of document.querySelectorAll("button.filter")) {
  button.addEventListener("click", () => {
    setFilter(Number(button.dataset.filter));
    gridEl.focus();
  });
}

document.getElementById("stop-speaking").addEventListener("click", () => {
  stopSpeaking();
  gridEl.focus(); // back to the grid, so the arrow keys keep working
});

// K, or the Load chart demo button: the same sheet plus a line chart.
function startLoadingChartDemo() {
  cues.unlock();
  startBtn.hidden = true;
  document.title = SITE_NAME;
  voice.announce("Opening the chart demo.");
  loadDemo(CHART_DEMO_URL, "sales_chart_demo.xlsx");
}

document.getElementById("load-chart-demo").addEventListener("click", startLoadingChartDemo);

document.getElementById("next-signal").addEventListener("click", () => {
  cues.unlock();
  gridEl.focus();
  if (!state.sheet) {
    voice.announce("No sheet is open yet. Press L to load the demo.");
    return;
  }
  nextSignal(1);
});

// ---------- Upload your own spreadsheet ----------

const fileInput = document.getElementById("file-input");

// U, or the Upload button: open the browser's file picker.
function chooseFile() {
  cues.unlock();
  startBtn.hidden = true;
  document.title = SITE_NAME;
  voice.announce("Choose an Excel file.");
  fileInput.value = ""; // so choosing the same file again still counts
  fileInput.click();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) uploadOwnFile(file);
});
// Closing the picker without choosing (supported in recent browsers).
fileInput.addEventListener("cancel", () => voice.announce("No file chosen."));

async function uploadOwnFile(file) {
  // Checked here too so the answer is instant and doesn't depend on the network.
  if (!/\.(xlsx|xlsm)$/i.test(file.name)) {
    sayProblem("That file is not an Excel workbook. Please choose an .xlsx file.");
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    const megabytes = Math.round(file.size / 1_000_000);
    sayProblem(`That file is ${megabytes} megabytes, which is too large. The limit is about 4 megabytes.`);
    return;
  }
  const name = file.name.replace(/\.(xlsx|xlsm)$/i, "");
  statusEl.textContent = `Opening ${name}…`;
  voice.announce(`Opening ${name}.`);
  const reached = await uploadWorkbook(file, file.name);
  // Unlike the demo, there is no offline copy of the user's own file.
  if (!reached) sayProblem("I couldn't reach the server, so I can't open your file right now. Please try again.");
}

function sayProblem(message) {
  statusEl.textContent = message;
  voice.announce(message);
}

// Test switches until the visible controls exist (Phase 3):
// ?sr=1 uses screen-reader mode, ?rate=1.5 sets the speaking rate,
// ?voice=Ava picks a voice by name (the console lists them).
showModeLine();

const params = new URLSearchParams(location.search);
if (params.has("sr")) voice.setMode("sr");
if (params.has("rate")) voice.setRate(Number(params.get("rate")));
if (params.has("voice")) voice.setVoice(params.get("voice"));

if (params.has("fixture")) {
  loadFixture();
}

// Tell the user how to begin, every way the browser allows before the first
// key or tap (after that, sound is unlocked and the welcome takes over):
// 1. Focus Start, so a screen reader reads its label. The HTML autofocus
//    attribute is ignored in some cases, e.g. a page opened from another app.
// 2. A screen-reader alert shortly after load. Live regions are only read when
//    they change after the page has loaded, hence the delay.
// 3. Try plain speech too. Most browsers block it until the first key press
//    and it then fails silently; the big text on the Start screen says the same.
if (!startBtn.hidden) {
  startBtn.focus();
  setTimeout(() => {
    if (!startBtn.hidden) document.getElementById("live-assertive").textContent = OPENING;
  }, 1000);
  if (voice.getMode() === "self") voice.announce(OPENING);
}
