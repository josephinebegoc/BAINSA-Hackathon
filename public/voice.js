// voice.js: every spoken message goes through announce().
//
// Two output modes:
//   "self" (default): the browser speaks with speechSynthesis.
//   "sr": we stay silent and write to aria-live regions, so the user's own
//         screen reader (VoiceOver, NVDA) speaks. This shows we work *with*
//         existing assistive tech rather than replacing it.
// In both modes the visible caption shows the text for sighted viewers.

const synth = window.speechSynthesis || null;
const RATE_KEY = "voice.rate";
const MIN_RATE = 0.5;
const MAX_RATE = 2;

const regions = {
  polite: document.getElementById("live-polite"),
  assertive: document.getElementById("live-assertive"),
};
const captionEl = document.getElementById("caption");

const settings = {
  mode: synth ? "self" : "sr", // no speech support: fall back to the screen reader
  rate: loadRate(),
};
let pending = null; // speech waiting for an earcon to finish

// delay: ms to wait before speaking, so a cue's sound plays first.
export function announce(text, { priority = "polite", delay = 0 } = {}) {
  captionEl.textContent = text;
  clearTimeout(pending);
  if (settings.mode === "self") {
    synth.cancel(); // silence the previous cell straight away
    if (delay > 0) pending = setTimeout(() => speak(text), delay);
    else speak(text);
  } else {
    writeLive(text, priority, delay);
  }
}

export function stop() {
  if (synth) synth.cancel();
  clearTimeout(pending);
  regions.polite.textContent = "";
  regions.assertive.textContent = "";
}

export function setMode(mode) {
  if (mode === "self" && !synth) return; // can't self-voice without speech support
  stop();
  settings.mode = mode === "self" ? "self" : "sr";
}

export function getMode() {
  return settings.mode;
}

export function setRate(rate) {
  if (!Number.isFinite(rate)) return;
  settings.rate = Math.min(Math.max(rate, MIN_RATE), MAX_RATE);
  try {
    localStorage.setItem(RATE_KEY, String(settings.rate));
  } catch {
    // Private browsing can block storage; the rate still applies this session.
  }
}

export function getRate() {
  return settings.rate;
}

// ---------- Self-voicing ----------

function speak(text) {
  // Always cancel first, so speech never queues behind navigation.
  synth.cancel();
  for (const chunk of chunks(text)) {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.rate = settings.rate;
    utterance.lang = document.documentElement.lang || "en";
    synth.speak(utterance);
  }
}

// Chrome silently stops utterances longer than about 15 seconds, so long reads
// (R, C, the overview) are split at sentence ends into chunks of ~200 characters.
// Short announcements stay in one piece so they don't sound choppy.
function chunks(text, max = 200) {
  const out = [];
  let current = "";
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (current && current.length + 1 + sentence.length > max) {
      out.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) out.push(current);
  return out;
}

// ---------- Screen-reader mode ----------

function writeLive(text, priority, delay) {
  const region = priority === "assertive" ? regions.assertive : regions.polite;
  const other = region === regions.polite ? regions.assertive : regions.polite;
  other.textContent = "";
  // Clearing first makes screen readers repeat identical text (e.g. pressing O
  // twice). Only the latest message is written, so fast moves don't pile up.
  region.textContent = "";
  pending = setTimeout(() => {
    region.textContent = text;
  }, Math.max(50, delay));
}

function loadRate() {
  try {
    const saved = Number(localStorage.getItem(RATE_KEY));
    if (saved >= MIN_RATE && saved <= MAX_RATE) return saved;
  } catch {
    // Storage unavailable: use the default.
  }
  return 1;
}
