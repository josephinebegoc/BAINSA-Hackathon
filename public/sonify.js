// sonify.js: Trend Scan. A row of numbers played as tones, so a listener hears the
// shape of a year instead of counting twelve figures.
//
// The whole sheet shares one pitch scale, fixed by setScale() when a workbook opens.
// That is the point: play Italy, then play Germany, and the second genuinely sounds
// higher if it is larger. Scaling each row to its own range would stretch every row
// across the same two octaves and make a small country sound exactly like a big one.
//
// This module makes no speech. app.js announces describe(series) first, then calls
// playSeries() — voice belongs to voice.js and timing belongs to the caller.

const AudioCtx = window.AudioContext || window.webkitAudioContext;

const LOW_HZ = 220; // two octaves: wide enough to hear differences, never shrill
const HIGH_HZ = 880;
const NOTE_MS = 150; // twelve months lands near two seconds: one shape, not a list
const ERROR_HZ = 110; // a rough low buzz, clearly not part of the melody

let ctx = null;
let scale = null; // { low, high } in the sheet's own units
let scheduled = []; // live nodes, so stop() can cut them off

export function isSupported() {
  return Boolean(AudioCtx);
}

// Browsers block sound until a click or key press, so call this from those handlers.
export function unlock() {
  if (!AudioCtx) return;
  if (!ctx) ctx = new AudioCtx();
  if (ctx.state === "suspended") ctx.resume();
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * fraction;
  const below = Math.floor(at);
  const above = Math.ceil(at);
  if (below === above) return sorted[below];
  return sorted[below] + (sorted[above] - sorted[below]) * (at - below);
}

// Call once per sheet, with every value from the columns SheetModel.series_cols names.
// The 5th and 95th percentiles rather than the outright minimum and maximum: one
// extreme value (the demo file has a 390,000 among figures near 130,000) would
// otherwise squash every other row into the bottom two notes.
export function setScale(allValues) {
  const numbers = (allValues || [])
    .filter((v) => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);

  if (numbers.length < 2) {
    scale = null;
    return;
  }
  let low = percentile(numbers, 0.05);
  let high = percentile(numbers, 0.95);
  if (high - low < Number.EPSILON) {
    // Every value the same: give the scale a little width so nothing divides by zero.
    low -= 0.5;
    high += 0.5;
  }
  scale = { low, high };
}

export function hasScale() {
  return scale !== null;
}

// Values outside the scale clamp to the end notes rather than disappearing off it.
// Exported so the pitch mapping can be tested without a browser.
export function frequencyFor(value) {
  if (!scale) return (LOW_HZ + HIGH_HZ) / 2;
  const clamped = Math.min(Math.max(value, scale.low), scale.high);
  const position = (clamped - scale.low) / (scale.high - scale.low);
  // Exponential in frequency = linear in perceived pitch, because hearing is
  // logarithmic: a linear sweep in Hz would make every high value sound alike.
  // Equal steps in value therefore give equal musical intervals, so a steadily
  // rising row sounds like a steadily rising scale. (Mapping equal *ratios* of
  // value to equal intervals instead would make a linear climb sound as though it
  // were slowing down.)
  return LOW_HZ * (HIGH_HZ / LOW_HZ) ** position;
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function format(value, unit) {
  const rounded = Math.round(value).toLocaleString("en-US");
  return unit ? `${unit}${rounded}` : rounded;
}

// The line app.js speaks before the tones. Pitch is relative, so without this a
// listener cannot tell €154,000 from €154.
export function describe({ values, label, unit } = {}) {
  const numbers = (values || []).filter(isNumber);
  if (!numbers.length) return label || "";
  const low = format(Math.min(...numbers), unit);
  const high = format(Math.max(...numbers), unit);
  return label ? `${label}. ${low} to ${high}.` : `${low} to ${high}.`;
}

function note({ at, freq, ms, pan, wave = "sine", gain = 0.22 }) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = wave;
  osc.frequency.setValueAtTime(freq, at);

  // Short fades, so notes don't click at their edges.
  amp.gain.setValueAtTime(0.0001, at);
  amp.gain.exponentialRampToValueAtTime(gain, at + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);

  let tail = amp;
  if (ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(pan, at);
    amp.connect(panner);
    tail = panner;
  }
  tail.connect(ctx.destination);
  osc.connect(amp);

  osc.start(at);
  osc.stop(at + ms / 1000 + 0.02);
  scheduled.push(osc);
}

// Play one row or column. Entries may be numbers, null for an empty cell, or a
// string for an error cell (its code). Returns how long the whole thing takes in ms,
// so the caller can wait for it the way cues.play() already does.
export function playSeries({ values, label, unit } = {}, { onDone } = {}) {
  stop();
  if (!AudioCtx) return 0;
  unlock();
  if (!ctx || !values || !values.length) return 0;

  // A context can still be "suspended" when it is created inside a key handler, and
  // resume() settles asynchronously. Notes scheduled before it settles are never
  // heard, which looks exactly like nothing happening.
  if (ctx.state === "suspended") {
    ctx.resume().then(() => schedule(values, onDone));
  } else {
    schedule(values, onDone);
  }
  return Math.round(values.length * NOTE_MS + 60);
}

function schedule(values, onDone) {
  const start = ctx.currentTime + 0.05;
  const last = values.length - 1;

  values.forEach((value, index) => {
    const at = start + (index * NOTE_MS) / 1000;
    // Left to right across the series: pitch carries the value, stereo carries
    // where you are in the row.
    const pan = last === 0 ? 0 : -0.8 + (1.6 * index) / last;

    if (isNumber(value)) {
      note({ at, freq: frequencyFor(value), ms: NOTE_MS - 20, pan });
    } else if (typeof value === "string" && value.trim()) {
      // An error cell: a rough low buzz nobody mistakes for a pitch.
      note({ at, freq: ERROR_HZ, ms: NOTE_MS - 20, pan, wave: "square", gain: 0.16 });
    }
    // An empty cell is silence, which reads correctly as a gap.
  });

  if (onDone) {
    scheduled.push(setTimeout(onDone, Math.round(values.length * NOTE_MS + 60)));
  }
}

export function stop() {
  for (const item of scheduled) {
    try {
      if (typeof item === "number") clearTimeout(item);
      else item.stop(0);
    } catch {
      // Already finished; nothing to cut off.
    }
  }
  scheduled = [];
}
