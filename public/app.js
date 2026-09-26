// app.js: loads a SheetModel, draws the grid, and handles navigation.

import * as voice from "./voice.js";
import * as cues from "./cues.js";

const FIXTURE_URL = "/fixtures/sample_sheet.json"; // offline copy, and ?fixture=1
const DEMO_URL = "/demo/sales_demo.xlsx";
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

const HELP_TEXT =
  "Arrow keys move one cell. O gives an overview. " +
  "Space goes to the first flagged cell. " +
  "N jumps to the next flagged cell, Shift N to the previous one. " +
  "W explains why a cell was flagged. D describes everything about a cell. " +
  "R reads the whole row, C the whole column. Escape stops speaking.";

// Hovering announces the cell under the mouse, at most this often.
const HOVER_THROTTLE_MS = 150;

const state = {
  sheet: null,
  cellsByRef: new Map(),
  focus: null, // { row, col }
  explanations: new Map(), // ref → text from /api/explain, for this sheet only
};

const gridEl = document.getElementById("grid");
const statusEl = document.getElementById("status");
const titleEl = document.getElementById("sheet-title");
const startBtn = document.getElementById("start");

// ---------- Loading ----------

// Load demo: the demo workbook goes through exactly the same pipeline as a real
// upload. If the server can't be reached, the offline copy keeps the demo alive.
async function loadDemo() {
  statusEl.textContent = "Opening the demo workbook…";
  try {
    const res = await fetch(DEMO_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reached = await uploadWorkbook(await res.blob(), "sales_demo.xlsx");
    if (reached) return;
  } catch (err) {
    console.error(err);
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

  titleEl.textContent = sheet.title;
  titleEl.hidden = false;
  statusEl.textContent =
    `${sheet.title} loaded. ${sheet.attention_order.length} cells flagged. ` +
    `Voice: ${voice.getVoiceName()}.`;

  renderGrid();
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
    ? "Press Space to go to the first flagged cell, use the arrow keys to explore, or press H for help."
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
  td.scrollIntoView({ block: "nearest", inline: "nearest" });

  state.focus = { row, col };
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
  const types = (cell?.signals || []).map((s) => s.type);
  return SIGNAL_PRIORITY.find((t) => types.includes(t)) || null;
}

// "Author visual cue. D5. Spain's sales in March are €63,400. Highlighted red."
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
  }

  const looks = formattingWords(row, col, cell);
  if (looks.length) parts.push(sentenceCase(looks.join(", ")));

  const types = [...new Set((cell?.signals || []).map((s) => s.type))];
  const cueNames = types.map((t) => SIGNAL_NAMES[t] || t);
  return [...cueNames, ...parts].join(". ") + ".";
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
function announceFocus(prefix = "") {
  const { row, col } = state.focus;
  const type = topSignal(cellAt(row, col));
  const soundMs = cues.play(type || "tick");
  voice.announce(prefix + describeCell(row, col), {
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
  const order = state.sheet.attention_order;
  if (!order.length) {
    voice.announce("Nothing in this sheet was flagged.");
    return;
  }
  const here = columnLetter(state.focus.col) + state.focus.row;
  let i = order.indexOf(here);
  // Not on a flagged cell: N goes to the first, Shift+N to the last.
  if (i === -1) i = step > 0 ? -1 : 0;
  goToFlagged((i + step + order.length) % order.length);
}

// Space: straight to the first flagged cell.
function jumpToFirstFlagged() {
  if (!state.sheet.attention_order.length) {
    voice.announce("Nothing in this sheet was flagged.");
    return;
  }
  goToFlagged(0);
}

function goToFlagged(i) {
  const order = state.sheet.attention_order;
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
  const { row, col } = state.focus;
  const cell = cellAt(row, col);
  if (!cell?.signals.length) {
    voice.announce("No cues on this cell. Press D to describe it.");
    return;
  }
  const ref = cell.ref;
  if (state.explanations.has(ref)) {
    voice.announce(state.explanations.get(ref));
    return;
  }

  const patience = setTimeout(() => voice.announce("One moment."), EXPLAIN_PATIENCE_MS);
  const fromServer = await fetchExplanation(cell, row, col);
  clearTimeout(patience);
  if (fromServer) state.explanations.set(ref, fromServer);

  // Don't talk over a cell the user has already moved on from.
  if (state.focus.row !== row || state.focus.col !== col) return;
  voice.announce(fromServer || localExplanation(cell, row, col));
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
        row_label: cell.row_label || rowLabel(row),
        col_header: cell.col_header || colHeader(col),
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
  const where = [cell.row_label || rowLabel(row), spokenHeader(cell.col_header || colHeader(col))]
    .filter(Boolean)
    .join(", ");
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

// ---------- Events ----------

const KEY_ACTIONS = {
  ArrowUp: () => move(-1, 0),
  ArrowDown: () => move(1, 0),
  ArrowLeft: () => move(0, -1),
  ArrowRight: () => move(0, 1),
  " ": jumpToFirstFlagged,
  n: (event) => jumpToFlagged(event.shiftKey ? -1 : 1),
  o: speakOverview,
  w: explainFocus,
  "?": explainFocus,
  d: describeFocus,
  r: readRow,
  c: readColumn,
  h: () => voice.announce(HELP_TEXT),
  Escape: () => voice.stop(),
};

gridEl.addEventListener("keydown", (event) => {
  // Leave browser shortcuts like Cmd+R alone.
  if (!state.sheet || event.ctrlKey || event.metaKey || event.altKey) return;
  cues.unlock();
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const action = KEY_ACTIONS[key];
  if (!action) return;
  event.preventDefault();
  action(event);
});

gridEl.addEventListener("click", (event) => {
  const td = event.target.closest("td[data-row]");
  if (!td || !state.sheet) return;
  cues.unlock();
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
  setFocus(row, col);
  announceFocus();
}

// Start: the click that lets the browser play sound and speech. It opens the
// demo sheet (unless one is already showing) and speaks its overview.
startBtn.addEventListener("click", () => {
  cues.unlock();
  startBtn.hidden = true;
  if (state.sheet) {
    gridEl.focus();
    voice.announce(orientation());
    return;
  }
  // Speaking inside the click is what unlocks speech on iPhones and iPads.
  voice.announce("Opening the demo workbook.");
  loadDemo();
});

document.getElementById("load-demo").addEventListener("click", () => {
  cues.unlock(); // this click is what lets the browser play sound later
  startBtn.hidden = true; // sound is unlocked now, so Start has done its job
  loadDemo();
});

// Test switches until the visible controls exist (Phase 3):
// ?sr=1 uses screen-reader mode, ?rate=1.5 sets the speaking rate,
// ?voice=Ava picks a voice by name (the console lists them).
const params = new URLSearchParams(location.search);
if (params.has("sr")) voice.setMode("sr");
if (params.has("rate")) voice.setRate(Number(params.get("rate")));
if (params.has("voice")) voice.setVoice(params.get("voice"));

if (params.has("fixture")) {
  loadFixture();
}
