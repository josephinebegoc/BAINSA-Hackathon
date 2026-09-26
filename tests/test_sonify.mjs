// Tests for public/sonify.js — the pitch mapping, not the audio.
//
//     node tests/test_sonify.mjs
//
// Web Audio does not exist in Node, so this covers the part that decides whether
// Trend Scan is truthful: which value becomes which pitch. The sound itself has to
// be checked by ear in a browser.

// Stub the browser bits: we're testing the maths, not the audio.
globalThis.window = {};
const s = await import(new URL("../public/sonify.js", import.meta.url).href);

const fail = [];
const ok = (name, cond) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${name}`); if (!cond) fail.push(name); };

console.log("isSupported() is false without Web Audio:");
ok("no AudioContext -> unsupported", s.isSupported() === false);

// The demo sheet: eight countries x twelve months, plus one 390,000 outlier.
const revenue = [];
for (let row = 0; row < 8; row++)
  for (let m = 0; m < 12; m++) revenue.push(90000 + row * 9000 + m * 7000);
revenue.push(390000);

console.log("\nsetScale / frequencyFor:");
s.setScale(revenue);
ok("scale is set", s.hasScale());
const lowFreq = s.frequencyFor(Math.min(...revenue));
const highFreq = s.frequencyFor(Math.max(...revenue));
ok("smallest value sits at the bottom note (220 Hz)", Math.abs(lowFreq - 220) < 1);
ok("the 390,000 outlier clamps to the top note (880 Hz)", Math.abs(highFreq - 880) < 1);

const mid = s.frequencyFor((Math.min(...revenue) + 230000) / 2);
ok("a mid value lands between the two", mid > 220 && mid < 880);

console.log("\na steady climb sounds like a steady climb:");
s.setScale([0, 100]);
// Equal steps in value must give equal musical intervals (equal frequency ratios),
// so a linear ramp is heard as a linear ramp rather than one that decelerates.
const r1 = s.frequencyFor(20) / s.frequencyFor(10);
const r2 = s.frequencyFor(30) / s.frequencyFor(20);
const r3 = s.frequencyFor(90) / s.frequencyFor(80);
ok("equal value steps give equal pitch intervals", Math.abs(r1 - r2) < 1e-9 && Math.abs(r2 - r3) < 1e-9);
ok("the full range spans exactly two octaves", Math.abs(s.frequencyFor(100) / s.frequencyFor(0) - 4) < 1e-9);

console.log("\ncomparability: the same value sounds the same in any row");
s.setScale(revenue);
const italyAug = s.frequencyFor(120000);
const germanyAug = s.frequencyFor(120000);
ok("identical values -> identical pitch", italyAug === germanyAug);
ok("a bigger value is a higher pitch", s.frequencyFor(200000) > s.frequencyFor(100000));

console.log("\ndescribe() gives the listener the magnitude:");
const line = s.describe({ values: [100000, 62000, 154000, null], label: "Italy, January to December", unit: "€" });
console.log(`     "${line}"`);
ok("names the row and its own range", line === "Italy, January to December. €62,000 to €154,000.");
ok("handles a row with no numbers", s.describe({ values: [null, null], label: "Empty" }) === "Empty");

console.log("\nedge cases that must not throw:");
s.setScale([]);
ok("empty scale -> hasScale false", s.hasScale() === false);
s.setScale([5, 5, 5, 5]);
ok("all-identical values still scale", s.hasScale() === true && Number.isFinite(s.frequencyFor(5)));
ok("playSeries with no audio returns 0", s.playSeries({ values: [1, 2, 3] }) === 0);
ok("playSeries with nothing returns 0", s.playSeries() === 0);
s.stop();

console.log(fail.length ? `\n${fail.length} FAILED` : "\nall passed");
process.exit(fail.length ? 1 : 0);
