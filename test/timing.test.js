// Timing tests for the flicker core.
//
// Run:  osascript -l JavaScript test/timing.test.js
//
// There is no Node in this project (no build step, no package.json), so these run
// on the JavaScriptCore engine macOS already ships via osascript. The test pulls
// the <script id="flicker-core"> block straight out of index.html and evaluates
// it, so it exercises the shipped code rather than a copy of it, then drives the
// engine with synthetic requestAnimationFrame timestamps.

ObjC.import("Foundation");

// Locate index.html whether the test is run from the project root or from test/.
function findIndex() {
  const fileManager = $.NSFileManager.defaultManager;
  const cwd = fileManager.currentDirectoryPath.js;
  const candidates = [cwd + "/index.html", cwd + "/../index.html"];
  const found = candidates.find((path) => fileManager.fileExistsAtPath(path));
  if (!found) throw new Error("could not find index.html; looked in:\n  " + candidates.join("\n  "));
  return found;
}

function loadCore() {
  const indexPath = findIndex();
  const html = $.NSString.stringWithContentsOfFileEncodingError(indexPath, $.NSUTF8StringEncoding, null).js;
  const match = html.match(/<script id="flicker-core">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("could not find <script id='flicker-core'> in " + indexPath);
  eval(match[1]); // the block ends by assigning globalThis.FlickerCore
  if (!globalThis.FlickerCore) throw new Error("flicker-core block did not export FlickerCore");
  return globalThis.FlickerCore;
}

const core = loadCore();

// ---- tiny assertion harness ----
let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(name + (detail ? " — " + detail : ""));
  }
}

function near(a, b, tolerance) {
  return Math.abs(a - b) <= (tolerance === undefined ? 1e-9 : tolerance);
}

// Drive the engine frame by frame at a given refresh rate.
// `script` maps a frame index to a divisor the "user" selects on that frame.
function run(refreshRate, seconds, startDivisor, script) {
  const frameMs = 1000 / refreshRate;
  const totalFrames = Math.round(refreshRate * seconds);
  const selected = { value: startDivisor };
  const frames = [];
  let active = startDivisor;
  let on = true;

  const engine = core.createFlickerEngine({
    getSelectedDivisor: () => selected.value,
    onPhaseChange: (next) => {
      on = next;
    },
    onActiveDivisorChange: (next) => {
      active = next;
    },
  });

  for (let i = 0; i < totalFrames; i++) {
    if (script && script[i] !== undefined) selected.value = script[i];
    const timestamp = i * frameMs;
    const opacity = engine.tick(timestamp);
    frames.push({ i, timestamp, opacity, on, active });
  }
  return frames;
}

// ---- 1. Sinusoid is balanced, because framesPerCycle is even ----
core.DIVISORS.forEach((N) => {
  check("divisor " + N + " is even", N % 2 === 0);

  const cycle = [];
  for (let f = 0; f < N; f++) cycle.push(core.computeOpacity(f, N));

  const mean = cycle.reduce((a, b) => a + b, 0) / N;
  check("N=" + N + ": mean opacity is 0.5", near(mean, 0.5, 1e-12), "got " + mean);

  check(
    "N=" + N + ": opacity stays within [0, 1]",
    cycle.every((o) => o >= 0 && o <= 1)
  );

  // The symmetry the even-N constraint buys: every sample at phase φ is matched
  // by one at φ + π, and sin(φ) + sin(φ + π) = 0, so the pair sums to exactly 1.
  let symmetric = true;
  for (let f = 0; f < N / 2; f++) {
    if (!near(cycle[f] + cycle[f + N / 2], 1, 1e-12)) symmetric = false;
  }
  check("N=" + N + ": φ and φ+π samples pair to 1.0", symmetric);

  // Cycle repeats exactly.
  check(
    "N=" + N + ": frame N repeats frame 0",
    near(core.computeOpacity(N, N), core.computeOpacity(0, N), 1e-12)
  );
});

// Full sweep of a 4-frame cycle, spelled out.
check(
  "N=4 cycle is [0.5, 1, 0.5, 0]",
  [0, 1, 2, 3].every((f) => near(core.computeOpacity(f, 4), [0.5, 1, 0.5, 0][f], 1e-12))
);

// ---- 2. Refresh-rate detection ----
const rateCases = [
  { label: "60 Hz", intervals: Array(60).fill(1000 / 60), rate: 60, reliable: true },
  { label: "120 Hz", intervals: Array(60).fill(1000 / 120), rate: 120, reliable: true },
  { label: "144 Hz", intervals: Array(60).fill(1000 / 144), rate: 144, reliable: true },
  { label: "90 Hz", intervals: Array(60).fill(1000 / 90), rate: 90, reliable: true },
  // A handful of dropped frames should not drag the median off 60.
  {
    label: "60 Hz with dropped frames",
    intervals: Array(50).fill(1000 / 60).concat([33.3, 50.1, 33.4, 66.8, 41.2, 33.3, 90.0, 33.3, 33.3, 120.5]),
    rate: 60,
    reliable: true,
  },
  // Small deviations are still trusted: real displays are not exactly 60.000 Hz.
  { label: "59.9 Hz is still 60", intervals: Array(60).fill(1000 / 59.9), rate: 60, reliable: true },
  // The one that matters on a phone. Low Power Mode throttles rAF to ~30 fps, which
  // would snap to 60 and run every frequency at half its label. It must be flagged.
  { label: "30 Hz (throttled phone) is flagged", intervals: Array(60).fill(1000 / 30), rate: 60, reliable: false },
  { label: "45 Hz is flagged", intervals: Array(60).fill(1000 / 45), rate: 60, reliable: false },
  { label: "no samples falls back, unreliable", intervals: [], rate: 60, reliable: false },
  { label: "zero intervals fall back, unreliable", intervals: Array(60).fill(0), rate: 60, reliable: false },
];

rateCases.forEach((c) => {
  const got = core.refreshEstimateFromIntervals(c.intervals);
  check("refresh detection: " + c.label, got.rate === c.rate && got.reliable === c.reliable,
    "got rate " + got.rate + ", reliable " + got.reliable);
});

check(
  "the raw measurement is reported, not just the snapped rate",
  near(core.refreshEstimateFromIntervals(Array(60).fill(1000 / 30)).measured, 30, 1e-6)
);

// ---- 3. Labels ----
check("60 Hz display labels", core.DIVISORS.map((N) => core.formatHz(60 / N)).join(" ") === "15 10 7.5 6 5");
check("default is 10 Hz at 60 Hz", 60 / core.DEFAULT_DIVISOR === 10);
check("144 Hz display relabels", core.formatHz(144 / 4) === "36" && core.formatHz(144 / 8) === "18");

// ---- 4. On/off cycle at 60 Hz ----
const steady = run(60, 12, 6);

const onFrames = steady.filter((f) => f.on);
const offFrames = steady.filter((f) => !f.on);

check("off frames are fully transparent", offFrames.every((f) => f.opacity === 0));
check("on frames actually flicker", new Set(onFrames.map((f) => f.opacity)).size > 1);

// Sampled extremes. Frame 0 sits at phase 0, so a sample only lands exactly on the
// sine's peak (φ = π/2) when N is divisible by 4. N = 6 and N = 10 therefore never
// reach full opacity or full transparency: they top out at (1 + sin(2π/3))/2 ≈ 0.933
// and bottom out at ≈ 0.067. The modulation is still symmetric about 0.5, and the
// amplitude at the flicker frequency itself is unaffected — only the visible
// peak-to-trough range differs between frequencies.
core.DIVISORS.forEach((N) => {
  const cycle = [];
  for (let f = 0; f < N; f++) cycle.push(core.computeOpacity(f, N));
  const max = Math.max.apply(null, cycle);
  const min = Math.min.apply(null, cycle);

  // How close the nearest sample gets to the peak at φ = π/2, in units of the
  // frame step 2π/N: exact for N divisible by 4, half a step short otherwise.
  const stepsToPeak = N / 4;
  const offset = Math.abs(stepsToPeak - Math.round(stepsToPeak)); // 0 or 0.5 frames
  const expectedMax = (1 + Math.cos((offset * 2 * Math.PI) / N)) / 2;

  if (N % 4 === 0) {
    check("N=" + N + ": reaches full opacity and full transparency", near(max, 1, 1e-12) && near(min, 0, 1e-12));
  } else {
    check(
      "N=" + N + ": peaks short of full opacity, as the phase sampling implies",
      near(max, expectedMax, 1e-12) && max < 1,
      "range " + min.toFixed(4) + "–" + max.toFixed(4)
    );
  }
  check("N=" + N + ": extremes stay symmetric about 0.5", near(min + max, 1, 1e-12));
});

// First on period should be 5 s = 300 frames at 60 Hz, then 5 s off, then on again.
const firstOff = steady.findIndex((f) => !f.on);
const secondOn = steady.findIndex((f) => f.i > firstOff && f.on);
check("first on period is 300 frames", firstOff === 300, "off began at frame " + firstOff);
check("off period is 300 frames", secondOn - firstOff === 300, "on resumed at frame " + secondOn);
check(
  "on period lasts 5 s",
  near(steady[firstOff].timestamp - steady[0].timestamp, core.ON_MS, 1000 / 60),
  "got " + (steady[firstOff].timestamp - steady[0].timestamp) + " ms"
);
check(
  "off period lasts 5 s",
  near(steady[secondOn].timestamp - steady[firstOff].timestamp, core.OFF_MS, 1000 / 60)
);

// Phase resets: each on period must start from the same phase.
check(
  "each on period starts at phase 0",
  near(steady[0].opacity, core.computeOpacity(0, 6), 1e-12) &&
    near(steady[secondOn].opacity, core.computeOpacity(0, 6), 1e-12)
);

// Within an on period, opacity is a pure function of the frame counter.
let framePerfect = true;
for (let i = 0; i < 300; i++) {
  if (!near(steady[i].opacity, core.computeOpacity(i, 6), 1e-12)) framePerfect = false;
}
check("on-period opacity is frame-locked to the counter", framePerfect);

// ---- 5. Frequency switch mid-flicker is deferred to the next off period ----
const deferred = run(60, 12, 6, { 100: 4 }); // user taps 15 Hz at frame 100, mid on period

check(
  "active frequency is unchanged for the rest of the on period",
  deferred.slice(100, 300).every((f) => f.active === 6)
);
check(
  "flicker continues at the old frequency until the on period ends",
  deferred.slice(100, 300).every((f) => near(f.opacity, core.computeOpacity(f.i, 6), 1e-12))
);
check("pending frequency is applied at the start of the off period", deferred[300].active === 4);

const resumed = deferred.findIndex((f) => f.i > 300 && f.on);
check("next on period runs at the new frequency, from frame 0", resumed === 600 &&
  deferred.slice(600, 900).every((f) => near(f.opacity, core.computeOpacity(f.i - 600, 4), 1e-12)));

// ---- 6. Switching while already off applies immediately ----
const whileOff = run(60, 12, 6, { 400: 12 }); // frame 400 is mid off period
check("switch during an off period applies immediately", whileOff[400].active === 12);
check("patch stays transparent through the switch", whileOff.slice(300, 600).every((f) => f.opacity === 0));
check(
  "next on period runs at the newly selected frequency",
  whileOff.slice(600, 900).every((f) => near(f.opacity, core.computeOpacity(f.i - 600, 12), 1e-12))
);

// A change on the very last frame of the off period must not be missed.
const lastFrame = run(60, 12, 6, { 599: 4 });
check("switch on the final off frame still applies", lastFrame[600].active === 4);
check(
  "…and the next on period uses it",
  lastFrame.slice(600, 900).every((f) => near(f.opacity, core.computeOpacity(f.i - 600, 4), 1e-12))
);

// ---- 7. Non-60 Hz displays ----
const at120 = run(120, 12, 6, null);
const firstOff120 = at120.findIndex((f) => !f.on);
check("120 Hz: on period is still 5 s (600 frames)", firstOff120 === 600, "got " + firstOff120);
check(
  "120 Hz: N=6 gives a 20 Hz flicker, still frame-locked",
  at120.slice(0, 600).every((f) => near(f.opacity, core.computeOpacity(f.i, 6), 1e-12))
);

// ---- report ----
const total = passed + failures.length;
let report = "\n" + passed + "/" + total + " checks passed\n";
if (failures.length) {
  report += "\nFAILED:\n" + failures.map((f) => "  ✗ " + f).join("\n") + "\n";
} else {
  report += "\nAll timing checks passed.\n";
}
console.log(report);
if (failures.length) throw new Error(failures.length + " timing check(s) failed"); // non-zero exit
report;
