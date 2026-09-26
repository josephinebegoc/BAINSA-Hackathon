// voice.js: every spoken message goes through announce().
// For now it writes to the aria-live regions (so a screen reader speaks it) and
// to the visible caption (so sighted judges can follow). Step 3 adds self-voicing
// with speechSynthesis behind this same function.

const regions = {
  polite: document.getElementById("live-polite"),
  assertive: document.getElementById("live-assertive"),
};
const captionEl = document.getElementById("caption");

export function announce(text, { priority = "polite" } = {}) {
  captionEl.textContent = text;

  const region = regions[priority] || regions.polite;
  // Clearing first makes screen readers repeat identical text (e.g. pressing O twice).
  region.textContent = "";
  setTimeout(() => {
    region.textContent = text;
  }, 50);
}

export function stop() {
  // Step 3: speechSynthesis.cancel().
}
