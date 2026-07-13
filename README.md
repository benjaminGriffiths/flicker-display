# Flicker Display

A single-screen tool that shows a sinusoidally flickering black patch with a fixation marker, plus a frequency selector. Built for timing accuracy: opacity is frame-locked to the display refresh cycle, not to wall-clock time.

## Running it

Open `index.html` in Chrome, Safari or Firefox. There is no build step and no install.

Double-clicking the file works. If you prefer to serve it over HTTP:

```sh
cd ~/Documents/flicker-display
python3 -m http.server 8000
# then open http://localhost:8000
```

## How it works

**Refresh-rate detection.** On load, the app samples 60 `requestAnimationFrame` timestamps, takes the median inter-frame interval, and snaps the implied rate to the nearest of 60/72/90/120/144/240 Hz. It falls back to 60 Hz if that fails. The detected rate is shown in the status line under the buttons.

**Frequencies.** Each button is a divisor `N` from {4, 6, 8, 10, 12}, and its frequency is `refreshRate / N` — so the labels are 15/10/7.5/6/5 Hz on a 60 Hz display and recompute automatically on anything else. `N` *is* the frames-per-cycle count. Keeping it even means every sample at phase φ is matched by one at φ + π, so the opacity distribution stays balanced around 0.5.

**Opacity.** Per rendered frame during an on period:

```
phase   = (frameCount % N) / N * 2π
opacity = (1 + sin(phase)) / 2
```

`frameCount` counts rendered frames — the rAF timestamp is deliberately *not* used here, since wall-clock time introduces jitter relative to the display's own refresh cycle. The timestamp is used only for the on/off interval boundaries.

**On/off cycle.** 5 s flickering, 5 s held at opacity 0 (only the marker and white background visible), repeating. `frameCount` resets to 0 at the start of each on period, so the sinusoid always begins from the same phase.

**Frequency switching.** Tapping a button highlights it immediately but does not interrupt the flicker. The new frequency is applied at the start of the next off period, and takes effect when the following on period begins. The status line shows the queued change while it is pending. Switching during an off period applies right away.

## Live at https://geoffles.com

Hosted on GitHub Pages from the `/docs` folder of `main`, at the apex domain. To deploy a change:

```sh
cd ~/Documents/flicker-display
osascript -l JavaScript build.js          # regenerate docs/
osascript -l JavaScript test/boot.test.js # includes a staleness check on docs/
git add -A && git commit -m "…" && git push
```

Pages rebuilds within a minute or so of the push.

`build.js` writes **`docs/index.html`** — one self-contained ~155 KB file with React inlined, the JSX pre-compiled, and no external references of any kind — plus **`docs/CNAME`**, which is what tells Pages to serve at `geoffles.com`. Both are regenerated every build, so a rebuild can never silently drop the domain.

Why a build at all: `index.html` compiles its own JSX in the browser via Babel, which is what makes it a no-build-step file you can just double-click. But Babel is 2.8 MB — a lot to push to a phone on mobile data, and useless once the code has stopped changing. The build strips it. **`index.html` is the source of truth; never edit `docs/index.html`,** it is overwritten on every build.

### DNS

The apex `geoffles.com` resolves via four `A` records to GitHub's Pages IPs (`185.199.108–111.153`). DNS is managed by Squarespace, whose nameservers are `*.googledomains.com`. HTTPS is enforced and the certificate is issued by GitHub.

`www.geoffles.com` is **not** configured. To add it, create a `CNAME` record in Squarespace with Name `www` pointing to `benjaminGriffiths.github.io`.

### Before you rely on it on a phone

Phones are a genuinely worse timing environment than a desktop, and the app now tells you when it cannot be trusted. If the status area shows a **red warning** that the measured rate is not a standard refresh rate, the frequency labels are wrong and the data is not usable. The usual cause is **iOS Low Power Mode**, which throttles the browser to ~30 fps: the detector measures 30 Hz, snaps it to the nearest standard rate (60), and every frequency then runs at *half* its stated value. Turn Low Power Mode off and reload.

Also worth knowing: browsers throttle or suspend `requestAnimationFrame` in backgrounded tabs, so the flicker will stall if the participant switches apps. And a 120 Hz ProMotion iPhone will legitimately detect 120 Hz and relabel the buttons (30/20/15/12/10 Hz), since the frequencies are always `refreshRate / N`.

## Tests

```sh
cd ~/Documents/flicker-display
osascript -l JavaScript test/boot.test.js     # does the page start at all?
osascript -l JavaScript test/timing.test.js   # is the timing right?
```

There is no Node here and no build step, so the tests run on the JavaScriptCore engine macOS already ships. Both pull the real script blocks straight out of `index.html`, so they exercise the shipped code rather than a copy.

[test/timing.test.js](test/timing.test.js) drives the flicker engine with synthetic frame timestamps: the sinusoid's symmetry, refresh-rate detection (including dropped frames and non-standard rates), the 5 s on / 5 s off boundaries, phase reset at each on period, deferred frequency switching, and switching while already in an off period.

[test/boot.test.js](test/boot.test.js) checks the page actually starts: the vendored libraries are present, Babel compiles the JSX, and — the one that matters — the two script blocks coexist in one scope. If `docs/` exists it checks the built file too, since that is a different artifact and passing tests on the source say nothing about it; it also fails if `docs/` is older than `index.html`, so a stale upload gets caught.

**The scope trap.** `flicker-core` is a classic script, and Babel appends the compiled JSX as a *second* classic script. Their top-level `const`s share one global lexical scope, so declaring a name in both is a `SyntaxError`. That kills Babel's `appendChild` before the JSX block ever runs, and the page renders white with nothing in it. This shipped once, via a `const { DIVISORS, … } = globalThis.FlickerCore` in the JSX block that re-declared what `flicker-core` had already declared. **The JSX block must reference `flicker-core`'s names directly and never re-declare them.**

Note that `eval()` cannot reproduce this — `const` in eval code lands in the eval's own scope, so two evals never collide. `boot.test.js` parses both blocks as a single script instead, which does share a scope and does throw.

If the page ever fails to start, it says so in red rather than showing a blank screen; the reporter is at the top of `index.html`.

What the tests cannot cover: that the browser actually presents one frame per refresh interval. Verify that by eye.

## Known property: peak opacity varies with frequency

Frame 0 sits at phase 0, so a sample lands exactly on the sine's peak (φ = π/2) only when the frames-per-cycle count N is divisible by 4. The frequencies therefore do not all span the same opacity range:

| Frequency | N   | Sampled range   | Peak-to-trough |
|-----------|-----|-----------------|----------------|
| 15 Hz     | 4   | 0.000 – 1.000   | 1.000          |
| 10 Hz     | 6   | 0.067 – 0.933   | 0.866          |
| 7.5 Hz    | 8   | 0.000 – 1.000   | 1.000          |
| 6 Hz      | 10  | 0.024 – 0.976   | 0.951          |
| 5 Hz      | 12  | 0.000 – 1.000   | 1.000          |

This follows directly from the specified formula and is not a bug. The modulation stays symmetric about 0.5 at every frequency, and the amplitude *at the flicker frequency itself* is unaffected — a phase offset would change which samples you get, not the fundamental. Only the visible peak-to-trough range differs. If equal peak-to-trough contrast across conditions matters for your use, say so and it can be normalised.

## Notes

- React 18 and Babel are vendored in `vendor/` so the app runs offline. Babel is an in-browser JSX transpiler only — it runs once at load, well before the flicker starts, so it has no bearing on timing. If you ever move this into a bundled React app, drop the Babel script and lift the component out of the `<script type="text/babel">` block unchanged.
- The frame loop writes `backgroundColor` straight to the patch DOM node via a ref. It deliberately does not go through React state, which would mean a re-render on every frame.
- Browsers throttle or pause `requestAnimationFrame` in background tabs. Keep the window focused during a run.
- A photosensitivity warning blocks the screen on load; the rAF loop does not start until it is dismissed.
