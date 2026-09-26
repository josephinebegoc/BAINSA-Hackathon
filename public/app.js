// app.js: loads a SheetModel, draws the grid, and handles navigation.

import * as voice from "./voice.js";
import * as cues from "./cues.js";

const FIXTURE_URL = "/fixtures/sample_sheet.json";

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
  "N jumps to the next flagged cell, Shift N to the previous one. " +
  "W explains why a cell was flagged. " +
  "R reads the whole row, C the whole column. Escape stops speaking.";

const state = {
  sheet: null,
  cellsByRef: new Map(),
  focus: null, // { row, col }
};

const gridEl = document.getElementById("grid");
const statusEl = document.getElementById("status");
const titleEl = document.getElementById("sheet-title");

// ---------- Loading ----------

async function loadFixture() {
  statusEl.textContent = "Loading the sample sheet…";
  try {
    const res = await fetch(FIXTURE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showSheet(await res.json());
  } catch (err) {
    statusEl.textContent = "Sorry, the sample sheet could not be loaded.";
    console.error(err);
  }
}

function showSheet(sheet) {
  state.sheet = sheet;
  state.cellsByRef = new Map(sheet.cells.map((c) => [c.ref, c]));

  titleEl.textContent = sheet.title;
  titleEl.hidden = false;
  statusEl.textContent = `${sheet.title} loaded. ${sheet.attention_order.length} cells flagged.`;

  renderGrid();
  // Start on the first data cell, just below the header and right of the labels.
  setFocus(sheet.header_row + 1, sheet.label_col + 1);
  gridEl.focus();
  voice.announce(
    `${sheet.title} loaded. Press O for an overview, N for flagged cells, or H for help.`
  );
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

// "F3. Italy. May. €31,000. Statistical cue."
function describeCell(row, col) {
  const cell = cellAt(row, col);
  const parts = [columnLetter(col) + row];

  if (row === state.sheet.header_row) {
    parts.push("Column header", spokenValue(cell));
  } else if (col === state.sheet.label_col) {
    parts.push("Row label", spokenValue(cell));
  } else {
    const label = cell?.row_label || rowLabel(row);
    const header = cell?.col_header || colHeader(col);
    if (label) parts.push(label);
    if (header) parts.push(header);
    parts.push(spokenValue(cell));
  }

  const types = [...new Set((cell?.signals || []).map((s) => s.type))];
  parts.push(...types.map((t) => SIGNAL_NAMES[t] || t));
  return parts.join(". ") + ".";
}

// Cue first, then speech. Flagged cells interrupt politely-queued output.
function announceFocus(prefix = "") {
  const { row, col } = state.focus;
  const type = topSignal(cellAt(row, col));
  cues.play(type || "tick");
  voice.announce(prefix + describeCell(row, col), {
    priority: type ? "assertive" : "polite",
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
  i = (i + step + order.length) % order.length;

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
function explainFocus() {
  const { row, col } = state.focus;
  const cell = cellAt(row, col);
  if (!cell?.signals.length) {
    voice.announce("No cues on this cell.");
    return;
  }
  const where = [cell.row_label || rowLabel(row), cell.col_header || colHeader(col)]
    .filter(Boolean)
    .join(", ");
  const reasons = cell.signals.map((s) => s.detail).join(". ");
  voice.announce(`${where}. ${reasons}.`);
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
    parts.push(header ? `${header}, ${spokenValue(cell)}` : spokenValue(cell));
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
    parts.push(label ? `${label}, ${spokenValue(cell)}` : spokenValue(cell));
  }
  const header = colHeader(col) || `Column ${columnLetter(col)}`;
  const empty = parts.every((p) => p.endsWith("blank"));
  voice.announce(empty ? `${header}. Empty column.` : `${header}. ${parts.join(". ")}.`);
}

// ---------- Events ----------

const KEY_ACTIONS = {
  ArrowUp: () => move(-1, 0),
  ArrowDown: () => move(1, 0),
  ArrowLeft: () => move(0, -1),
  ArrowRight: () => move(0, 1),
  n: (event) => jumpToFlagged(event.shiftKey ? -1 : 1),
  o: speakOverview,
  w: explainFocus,
  "?": explainFocus,
  r: readRow,
  c: readColumn,
  h: () => voice.announce(HELP_TEXT),
  Escape: () => voice.stop(),
};

gridEl.addEventListener("keydown", (event) => {
  // Leave browser shortcuts like Cmd+R alone.
  if (!state.sheet || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const action = KEY_ACTIONS[key];
  if (!action) return;
  event.preventDefault();
  action(event);
});

gridEl.addEventListener("click", (event) => {
  const td = event.target.closest("td[data-row]");
  if (!td || !state.sheet) return;
  setFocus(Number(td.dataset.row), Number(td.dataset.col));
  gridEl.focus();
  announceFocus();
});

document.getElementById("load-demo").addEventListener("click", () => {
  // Phase 2 switches this to /demo/sales_demo.xlsx → /api/upload.
  loadFixture();
});

if (new URLSearchParams(location.search).has("fixture")) {
  loadFixture();
}
