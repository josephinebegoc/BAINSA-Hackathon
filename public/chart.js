// chart.js: draws the chart the backend extracted, so sighted viewers can see
// what is being read aloud. Visual only: the panel is aria-hidden, because the
// listener already gets the same chart, point by point, through speech.
//
// Plain SVG, no library. One line chart, one series: the demo cut.
// Colour is never the only clue: the active point also gets a bigger ring, a
// guide line and a text label, and chart cue points are squares, not circles.

const SVG = "http://www.w3.org/2000/svg";
const W = 720;
const H = 320;
const M = { top: 56, right: 28, bottom: 58, left: 88 };

const INK = "#1a1a1a";
const LINE = "#1f5fbf";
const GRID = "#d0d0d0";
const ACTIVE = "#b8005c";
// Extra lines on a chart you build: a different colour AND dash for each, so
// colour is never the only difference.
const LINE_STYLES = [
  { stroke: LINE, dash: "" },
  { stroke: "#1b7f3b", dash: "9 5" },
  { stroke: "#8a4b00", dash: "2 5" },
  { stroke: "#5b2a86", dash: "12 4 2 4" },
];

let view = null; // { svg, marks, points: [{ x, y, data }] }

function el(tag, attrs = {}, text = "") {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

// A round top for the value axis and a step that gives about five gridlines.
function scale(values) {
  const hi = Math.max(...values, 0);
  const lo = Math.min(...values, 0);
  const rough = (hi - lo) / 5 || 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough);
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

// Axis labels in the series' own units: "€150,000" when the points read "€154,000".
function unitLabel(sample) {
  const prefix = (sample || "").match(/^[^\d-]*/)?.[0] || "";
  return (n) => `${prefix}${n.toLocaleString("en-GB")}`;
}

export function clear(container) {
  container.replaceChildren();
  view = null;
}

// chart: one entry of sheet.charts, or a chart built in Chart mode (several lines).
// cues: the point indexes that are cues, as one Set (first line) or one Set per line.
export function render(container, chart, cues = new Set()) {
  clear(container);
  const lines = chart.series.filter((s) => s.points?.length);
  const cueSets = Array.isArray(cues) ? cues : [cues];
  const points = lines[0]?.points || [];
  const numbers = lines.flatMap((l) => l.points).filter((p) => p.value !== null).map((p) => p.value);
  if (!numbers.length) return;

  const { lo, hi, step } = scale(numbers);
  const label = unitLabel(points.find((p) => p.value !== null)?.display);
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const xAt = (i) => M.left + (points.length > 1 ? (i * plotW) / (points.length - 1) : plotW / 2);
  const yAt = (v) => M.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: "100%",
    style: "max-width: 760px; display: block; margin-top: 16px; background: #fff; border: 1px solid #767676;",
    "font-family": "system-ui, sans-serif",
    role: "img",
  });

  svg.appendChild(el("text", { x: W / 2, y: 26, "text-anchor": "middle", "font-size": 18,
    "font-weight": 700, fill: INK }, chart.title || "Untitled chart"));
  svg.appendChild(el("text", { x: W / 2, y: 44, "text-anchor": "middle", "font-size": 12,
    fill: "#444" }, "Squares mark chart cues"));

  // Value axis: gridlines and labels.
  for (let v = lo; v <= hi + step / 2; v += step) {
    const y = yAt(v);
    svg.appendChild(el("line", { x1: M.left, x2: W - M.right, y1: y, y2: y, stroke: GRID }));
    svg.appendChild(el("text", { x: M.left - 8, y: y + 4, "text-anchor": "end", "font-size": 12,
      fill: INK }, label(v)));
  }
  if (chart.y_title) {
    svg.appendChild(el("text", { x: 16, y: M.top + plotH / 2, "text-anchor": "middle",
      "font-size": 13, fill: INK, transform: `rotate(-90 16 ${M.top + plotH / 2})` }, chart.y_title));
  }

  // Category axis.
  svg.appendChild(el("line", { x1: M.left, x2: W - M.right, y1: M.top + plotH, y2: M.top + plotH,
    stroke: INK }));
  // Busy charts (a list of hundreds of orders) label every few points only.
  const every = Math.max(1, Math.ceil(points.length / 12));
  points.forEach((p, i) => {
    if (i % every && i !== points.length - 1) return;
    const text = String(p.category);
    svg.appendChild(el("text", { x: xAt(i), y: M.top + plotH + 18, "text-anchor": "middle",
      "font-size": 12, fill: INK }, text.length > 10 ? `${text.slice(0, 9)}…` : text));
  });
  if (chart.x_title) {
    svg.appendChild(el("text", { x: M.left + plotW / 2, y: H - 10, "text-anchor": "middle",
      "font-size": 13, fill: INK }, chart.x_title));
  }

  // Each line, broken wherever a point has no value; cue points are squares.
  const placedBySeries = lines.map((line, n) => {
    const style = LINE_STYLES[n % LINE_STYLES.length];
    let d = "";
    let pen = false;
    line.points.forEach((p, i) => {
      if (p.value === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xAt(i)},${yAt(p.value)} `;
      pen = true;
    });
    svg.appendChild(el("path", { d, fill: "none", stroke: style.stroke, "stroke-width": 3,
      "stroke-linejoin": "round", "stroke-dasharray": style.dash }));
    const placed = line.points.map((p, i) => ({ x: xAt(i), y: p.value === null ? null : yAt(p.value), data: p }));
    const marked = cueSets[n] || new Set();
    const small = line.points.length > 40; // hundreds of points: no circles, cues only
    placed.forEach(({ x, y }, i) => {
      if (y === null) return;
      if (marked.has(i)) {
        svg.appendChild(el("rect", { x: x - 6, y: y - 6, width: 12, height: 12, fill: "#fff",
          stroke: style.stroke, "stroke-width": 3 }));
      } else if (!small) {
        svg.appendChild(el("circle", { cx: x, cy: y, r: 5, fill: "#fff", stroke: style.stroke,
          "stroke-width": 2.5 }));
      }
    });
    return placed;
  });

  // A legend when there is more than one line: a sample of each line's style.
  if (lines.length > 1) {
    lines.forEach((line, n) => {
      const style = LINE_STYLES[n % LINE_STYLES.length];
      const x = M.left + n * 150;
      svg.appendChild(el("line", { x1: x, x2: x + 28, y1: M.top - 6, y2: M.top - 6,
        stroke: style.stroke, "stroke-width": 3, "stroke-dasharray": style.dash }));
      svg.appendChild(el("text", { x: x + 34, y: M.top - 2, "font-size": 12, fill: INK },
        line.name || `Line ${n + 1}`));
    });
  }

  // The highlight layer sits on top and is redrawn on every move.
  const marks = el("g");
  svg.appendChild(marks);

  container.appendChild(svg);
  view = { svg, marks, series: placedBySeries, points: placedBySeries[0], bottom: M.top + plotH };
}

// Highlight one point (the one being spoken) on a line, or none (null).
export function highlight(index, series = 0) {
  if (!view) return;
  view.marks.replaceChildren();
  const line = view.series?.[series] || view.points;
  const spot = index === null || index === undefined ? null : line[index];
  view.svg.dataset.active = spot ? String(index) : "";
  if (!spot || spot.y === null) return;

  const { x, y, data } = spot;
  view.marks.appendChild(el("line", { x1: x, x2: x, y1: y, y2: view.bottom, stroke: ACTIVE,
    "stroke-width": 2, "stroke-dasharray": "5 4" }));
  view.marks.appendChild(el("circle", { cx: x, cy: y, r: 12, fill: "none", stroke: ACTIVE,
    "stroke-width": 4 }));
  view.marks.appendChild(el("circle", { cx: x, cy: y, r: 5, fill: ACTIVE }));

  // Label above the point, or below it when the point is near the top.
  const text = `${data.category}: ${data.display}`;
  const width = text.length * 7.6 + 16;
  const left = Math.min(Math.max(x - width / 2, 4), W - width - 4);
  const top = y - 44 < 4 ? y + 20 : y - 44;
  view.marks.appendChild(el("rect", { x: left, y: top, width, height: 24, rx: 4, fill: "#fff",
    stroke: ACTIVE, "stroke-width": 2 }));
  view.marks.appendChild(el("text", { x: left + width / 2, y: top + 17, "text-anchor": "middle",
    "font-size": 14, "font-weight": 700, fill: INK }, text));
}

// The point nearest the pointer, left to right, for sweeping the chart with a
// mouse or a finger. Gaps (no value) are skipped. null when nothing is drawn.
export function pointAt(clientX) {
  if (!view) return null;
  const box = view.svg.getBoundingClientRect();
  if (!box.width) return null;
  const x = ((clientX - box.left) / box.width) * W;
  let best = null;
  let distance = Infinity;
  (view.series?.[0] || view.points).forEach((point, i) => {
    if (point.y === null) return;
    const d = Math.abs(point.x - x);
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
}
