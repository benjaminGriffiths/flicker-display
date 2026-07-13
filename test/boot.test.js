// Boot tests: does index.html actually start in a browser?
//
// Run:  osascript -l JavaScript test/boot.test.js
//
// The timing tests cover the maths; these cover the thing that actually broke —
// the page loading at all. A blank page shipped once because the JSX block
// re-declared identifiers the flicker-core block had already declared. Both are
// classic scripts, so they share one global lexical scope, and the clash was a
// SyntaxError that killed Babel's appendChild before the block ever ran.
//
// The trap: plain eval() gives each block its own scope, so it cannot reproduce
// that. These tests use *indirect* eval — (0, eval)(src) — which evaluates in
// global scope and shares the global lexical environment, exactly like the browser.

ObjC.import("Foundation");

function read(path) {
  const contents = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (!contents.js) throw new Error("could not read " + path);
  return contents.js;
}

function findProjectRoot() {
  const fileManager = $.NSFileManager.defaultManager;
  const cwd = fileManager.currentDirectoryPath.js;
  const candidates = [cwd, cwd + "/.."];
  const found = candidates.find((dir) => fileManager.fileExistsAtPath(dir + "/index.html"));
  if (!found) throw new Error("could not find index.html; looked in:\n  " + candidates.join("\n  "));
  return found;
}

const ROOT = findProjectRoot();
const html = read(ROOT + "/index.html");

let passed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) passed += 1;
  else failures.push(name + (detail ? " — " + detail : ""));
}

function extract(pattern, what) {
  const match = html.match(pattern);
  if (!match) throw new Error("could not find " + what + " in index.html");
  return match[1];
}

const coreSrc = extract(/<script id="flicker-core">([\s\S]*?)<\/script>/, "the flicker-core block");
const jsxSrc = extract(/<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/, "the text/babel block");

// ---- 1. Vendored libraries are present and expose what the page uses ----
["react.production.min.js", "react-dom.production.min.js", "babel.min.js"].forEach((file) => {
  const path = ROOT + "/vendor/" + file;
  check("vendor/" + file + " exists", $.NSFileManager.defaultManager.fileExistsAtPath(path));
  check("index.html loads vendor/" + file, html.indexOf('src="vendor/' + file + '"') !== -1);
});

// ---- 2. Babel is real, and compiles the JSX block ----
(0, eval)(read(ROOT + "/vendor/babel.min.js"));
check("Babel standalone loads", typeof globalThis.Babel !== "undefined");

let compiled = null;
try {
  compiled = Babel.transform(jsxSrc, { presets: ["react"] }).code;
  check("the JSX block compiles", typeof compiled === "string" && compiled.length > 0);
} catch (e) {
  check("the JSX block compiles", false, e.message);
}

// ---- 3. Both blocks share one scope without colliding ----
//
// This is the regression test for the blank page. In the browser, flicker-core is a
// classic script and Babel appends the compiled JSX as a second classic script; both
// put their top-level `const`s in the one global lexical scope, so a name declared
// twice is a SyntaxError.
//
// eval() cannot model that: per spec, `const` in eval code — indirect eval included —
// lands in the eval's own declarative environment, so two evals never collide. The
// faithful model is to parse both blocks as a *single* script, which puts their
// declarations in one shared scope, exactly as the browser does.

// Minimal stand-ins for the browser APIs the compiled block touches on load. App()
// itself is never invoked — render() is a no-op — so this only exercises the blocks'
// top level, which is where the collision happened.
globalThis.React = {
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  createElement: () => ({}),
};
globalThis.ReactDOM = { createRoot: () => ({ render: () => {} }) };
globalThis.document = { getElementById: () => ({}) };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

let bootError = null;
if (compiled !== null) {
  try {
    (0, eval)(coreSrc + "\n;\n" + compiled);
  } catch (e) {
    bootError = e;
  }
}
check(
  "flicker-core and the compiled JSX block share a scope without re-declaring anything",
  bootError === null,
  bootError && String(bootError)
);
check("flicker-core exports FlickerCore", typeof globalThis.FlickerCore === "object");
check("the JSX block runs to completion", globalThis.__jsxBlockRan === true);

// The names flicker-core puts in global scope are the ones the JSX block must not
// re-declare. Catch a reintroduced destructuring binding directly, too.
const coreGlobals = ["DIVISORS", "DEFAULT_DIVISOR", "STANDARD_REFRESH_RATES", "FALLBACK_REFRESH_RATE",
  "ON_MS", "OFF_MS", "DETECTION_FRAMES", "REFRESH_TOLERANCE", "formatHz", "computeOpacity",
  "refreshEstimateFromIntervals", "createFlickerEngine"];
const redeclared = coreGlobals.filter((name) =>
  new RegExp("(?:const|let|var|function)\\s+" + name + "\\b").test(jsxSrc) ||
  new RegExp("^\\s*" + name + ",?\\s*$", "m").test(jsxSrc) // a destructuring list entry
);
check(
  "the JSX block re-declares none of flicker-core's globals",
  redeclared.length === 0,
  redeclared.length ? "re-declares: " + redeclared.join(", ") : ""
);

// ---- 4. The mount point and the safety gate exist ----
check("index.html has the #root mount point", /<div id="root">/.test(html));
check("the JSX block mounts into #root", /getElementById\("root"\)/.test(jsxSrc));
check("a boot-failure reporter is present", /reportBootFailure/.test(html));
check("the photosensitivity warning is present", /5–15 Hz/.test(jsxSrc));
check("the flicker is gated behind the warning", /ready\s*=\s*estimate !== null && dismissed/.test(jsxSrc));
check("an unreliable refresh estimate is surfaced", /!estimate\.reliable/.test(jsxSrc));

// ---- 5. The built artefact, if one exists ----
//
// docs/index.html is what actually gets hosted, and it is a different file: Babel is
// gone and the JSX is already compiled. Verifying the source says nothing about it, so
// check it boots on its own terms — same shared-scope trap, same mount point.
const distPath = ROOT + "/docs/index.html";
if ($.NSFileManager.defaultManager.fileExistsAtPath(distPath)) {
  const dist = read(distPath);

  check("docs/index.html is self-contained (no external references)", !/src="/.test(dist) && dist.indexOf("vendor/") === -1);
  check("docs/index.html ships no Babel", dist.indexOf("text/babel") === -1 && !/data-presets/.test(dist));
  check("docs/index.html has the compiled app", /React\.createElement/.test(dist));
  check("docs/index.html has the #root mount point", /<div id="root">/.test(dist));
  check("docs/index.html keeps the boot-failure reporter", /reportBootFailure/.test(dist));
  // Babel escapes non-ASCII in string literals, so the en dash arrives as –.
  check("docs/index.html keeps the photosensitivity warning", /5(–|\\u2013)15 Hz/.test(dist));
  check("docs/index.html warns on an unreliable refresh estimate", /reliable/.test(dist));

  const distCore = (dist.match(/<script id="flicker-core">([\s\S]*?)<\/script>/) || [])[1];
  const distApp = (dist.match(/<script id="flicker-app">([\s\S]*?)<\/script>/) || [])[1];
  check("docs/index.html has both script blocks", !!distCore && !!distApp);

  if (distCore && distApp) {
    // Same trick as above: one parse, one shared scope, exactly as the browser sees it.
    globalThis.__jsxBlockRan = false;
    let distError = null;
    try {
      (0, eval)(distCore + "\n;\n" + distApp);
    } catch (e) {
      distError = e;
    }
    check("dist's blocks share a scope without colliding", distError === null, distError && String(distError));
    check("dist's app block runs to completion", globalThis.__jsxBlockRan === true);
  }

  const staleness = "docs/index.html is older than index.html — run `osascript -l JavaScript build.js`";
  const mtime = (path) =>
    $.NSFileManager.defaultManager
      .attributesOfItemAtPathError(path, null)
      .objectForKey("NSFileModificationDate").timeIntervalSince1970;
  check("docs/index.html is not stale", mtime(distPath) >= mtime(ROOT + "/index.html"), staleness);
}

// ---- report ----
const total = passed + failures.length;
let report = "\n" + passed + "/" + total + " checks passed\n";
report += failures.length
  ? "\nFAILED:\n" + failures.map((f) => "  ✗ " + f).join("\n") + "\n"
  : "\nindex.html boots.\n";
console.log(report);
if (failures.length) throw new Error(failures.length + " boot check(s) failed");
report;
