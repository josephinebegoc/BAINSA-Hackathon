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

// The browser's default voice is often robotic. These name patterns mark the
// high-quality voices, best first.
const VOICE_PREFERENCES = [
  /natural/i, // Edge: "Microsoft Aria Online (Natural)"
  /premium/i, // Apple voices downloaded in System Settings: "Ava (Premium)"
  /enhanced/i, // Apple: "Samantha (Enhanced)"
  /neural/i,
  /^Google (UK|US) English/i, // Chrome's online voices
];

// We use a male voice. Browsers don't say which voices are male, so we go by
// the names of the common ones: Chrome's "Google UK English Male", Edge's
// Guy/Andrew/Brian/… (Natural), Apple's Daniel/Aaron/Arthur/…
// ("Female" doesn't match "male" because of the word boundary.)
const MALE_VOICE =
  /\b(male|guy|andrew|brian|christopher|eric|roger|steffan|ryan|thomas|william|liam|davis|tony|jason|david|mark|george|james|daniel|alex|aaron|arthur|evan|nathan|tom|oliver|rishi|gordon|lee|reed|fred)\b/i;

const settings = {
  mode: synth ? "self" : "sr", // no speech support: fall back to the screen reader
  rate: loadRate(),
  voice: null, // a SpeechSynthesisVoice, or null for the browser default
  voiceWanted: "", // name asked for with setVoice(), if any
};

if (synth) {
  // Some browsers (Chrome) load their voice list late, so pick again when it arrives.
  synth.addEventListener?.("voiceschanged", pickVoice);
  pickVoice();
}
let pending = null; // speech waiting for an earcon to finish

// delay: ms to wait before speaking, so a cue's sound plays first.
export function announce(text, { priority = "polite", delay = 0 } = {}) {
  captionEl.textContent = text;
  clearTimeout(pending);
  if (settings.mode === "self") {
    synth.cancel(); // silence the previous cell straight away
    if (delay > 0) {
      pending = setTimeout(() => {
        pending = null;
        speak(text);
      }, delay);
    }
    else speak(text);
  } else {
    writeLive(text, priority, delay);
  }
}

// True while self-voicing speech is playing or about to start.
export function isSpeaking() {
  if (settings.mode !== "self" || !synth) return false;
  return synth.speaking || synth.pending || pending !== null;
}

export function stop() {
  if (synth) synth.cancel();
  clearTimeout(pending);
  pending = null;
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

// Ask for a voice by (part of) its name, e.g. "Ava" or "Google UK".
export function setVoice(name) {
  settings.voiceWanted = name || "";
  pickVoice();
}

export function getVoiceName() {
  return settings.voice?.name || "browser default";
}

function pickVoice() {
  const voices = synth.getVoices().filter((v) => v.lang?.toLowerCase().startsWith("en"));
  if (!voices.length) return; // not loaded yet: voiceschanged will call us again

  const wanted = settings.voiceWanted.toLowerCase();
  const byName = wanted && voices.find((v) => v.name.toLowerCase().includes(wanted));
  settings.voice = byName || bestVoice(voices);

  console.info(
    `[voice] using "${getVoiceName()}". English voices available:`,
    voices.map((v) => v.name)
  );
}

// The best-sounding male voice; if the device has none, the best voice of any kind.
function bestVoice(voices) {
  const male = voices.filter((v) => MALE_VOICE.test(v.name));
  if (!male.length) console.info("[voice] no male voice on this device, using the best available");
  const pool = male.length ? male : voices;

  for (const pattern of VOICE_PREFERENCES) {
    const match = pool.find((v) => pattern.test(v.name));
    if (match) return match;
  }
  // No high-quality voice: take the default if it qualifies, and avoid robotic "Fred".
  return pool.find((v) => v.default) || pool.find((v) => !/fred/i.test(v.name)) || pool[0];
}

// ---------- Self-voicing ----------

function speak(text) {
  // Always cancel first, so speech never queues behind navigation.
  synth.cancel();
  for (const chunk of chunks(text)) {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.rate = settings.rate;
    if (settings.voice) utterance.voice = settings.voice;
    utterance.lang = settings.voice?.lang || document.documentElement.lang || "en";
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
