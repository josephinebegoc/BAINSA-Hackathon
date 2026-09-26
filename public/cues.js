// cues.js: short sounds (and vibration) played before speech. NOTICE.
//
// type is "tick" for a normal cell, or one of the four cues (visual, anomaly,
// trend, error). All four cues share one sound, a phone-message chime: it says
// "stop, something is here", and the voice then says which kind of cue it is.
// play() returns how long the sound lasts in ms, so speech can start after it.

const AudioCtx = window.AudioContext || window.webkitAudioContext;
let ctx = null;

// Each sound is a list of tones: when it starts, how long it lasts (seconds),
// the waveform, the pitch (optionally gliding to endFreq), and the volume.
const TICK = [{ start: 0, dur: 0.03, wave: "sine", freq: 1200, gain: 0.04 }];

// A bell-like note: a pure tone plus a quiet overtone four times higher,
// which gives the bright "ting" of a marimba or phone chime.
function bell(start, freq, dur = 0.22) {
  return [
    { start, dur, wave: "sine", freq, gain: 0.35 },
    { start, dur: dur * 0.4, wave: "sine", freq: freq * 4, gain: 0.05 },
  ];
}

// "You've got a message": three quick rising notes (A, C#, E), the last one
// ringing a little longer. Our own chime, in the style of a phone notification.
const MESSAGE_CHIME = [
  ...bell(0, 880),
  ...bell(0.1, 1109),
  ...bell(0.2, 1319, 0.35),
];

const VIBRATION = { error: [200], flagged: [60, 40, 60] };

// Browsers only allow sound after a click or key press (a mouse move doesn't
// count), so call this from those handlers. Safe to call often.
export function unlock() {
  if (!AudioCtx) return;
  if (!ctx) ctx = new AudioCtx();
  if (ctx.state === "suspended") ctx.resume();
}

export function play(type) {
  vibrate(type);
  const tones = type === "tick" ? TICK : MESSAGE_CHIME;
  if (!ctx) return 0; // audio not unlocked yet: stay silent, don't delay speech
  whenRunning(() => tones.forEach(playTone));
  // The tick is so short that speech doesn't need to wait for it.
  if (type === "tick") return 0;
  return Math.round(Math.max(...tones.map((t) => t.start + t.dur)) * 1000);
}

function playTone({ start, dur, wave, freq, endFreq, gain }) {
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();

  osc.type = wave;
  osc.frequency.setValueAtTime(freq, t0);
  // A curved glide sounds more natural than a straight one.
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur * 0.6);

  // Quick fade in and out, so tones don't click.
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(amp).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// Vibration only exists on Android Chrome, so always feature-detect.
function vibrate(type) {
  if (!navigator.vibrate || type === "tick") return;
  navigator.vibrate(type === "error" ? VIBRATION.error : VIBRATION.flagged);
}

// One note at a given pitch, for sweeping a chart like Piano mode: higher values
// play higher notes, and pan (-1 left … 1 right) follows the point's position.
// Returns how long it lasts in ms. Silent until audio is unlocked.
export function note(freq, { pan = 0, gain = 0.2, ms = 120 } = {}) {
  if (!ctx || !freq) return 0;
  whenRunning(() => playNote(freq, pan, gain, ms));
  return ms;
}

function playNote(freq, pan, gain, ms) {
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t0);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
  let tail = osc.connect(amp);
  if (ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), t0);
    tail = tail.connect(panner);
  }
  tail.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + ms / 1000 + 0.02);
}

// Sounds sent while the audio context is still "suspended" (just woken by a key
// press, or paused by the browser after a quiet spell) are never heard. Resume
// first and play once it is really running.
function whenRunning(playNow) {
  if (ctx.state === "running") playNow();
  else ctx.resume().then(playNow).catch(() => {});
}

// How long play(type) lasts, for scheduling something straight after it.
export function length(type) {
  const tones = type === "tick" ? TICK : MESSAGE_CHIME;
  return Math.round(Math.max(...tones.map((t) => t.start + t.dur)) * 1000);
}
