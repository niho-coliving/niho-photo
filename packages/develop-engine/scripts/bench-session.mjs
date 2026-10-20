// Latency / memory benchmark of a working-copy Developer, as the Web editor
// drives it (#17945). Every run is a fresh Node process (a cold wasm
// instance, single thread like the Web Worker); `paired` alternates the
// builds per trial so load and order bias both sides alike.
//
//   node scripts/bench-session.mjs paired --baseline <dir> --candidate <dir> \
//     --cases cases.json [--trials 5] [--scenarios ui,full] --out <dir>
//   node scripts/bench-session.mjs run --pkg <dir> --cases cases.json --case <id> --scenario ui
//
// <dir>: a build (scripts/build-wasm.sh pkg/) or a published directory with
// a versioned manifest (apps/web/public/develop-engine/niho-3/, its files' sha256
// are checked). cases.json (kept outside the repo with the photos):
//   [{ "id": "...", "png": "<working copy .png>", "meta": "<metadata .json>",
//      "settings": { developSettings } | "<settings .json>" }]
// The settings are given whole (not built from a preset) so both builds
// render the same JSON.
//
// Scenarios (maxDimension 1280 = the loupe, browser-photo-editing-model.ts):
//   ui:   open -> first (Final 1280: the first image the editor paints) ->
//         dragTail (6 Interactive frames moving Contrast) -> releaseTail
//         (Final) -> dragPrep (6 Interactive frames moving Highlights) ->
//         releasePrep (Final) -> reopen (free, open, Final 1280 again).
//         Each release becomes the next step's current settings; reopen keeps both edits.
//   full: open -> first (Final at the working size) -> reopen.
//   editor: what the editor's worker does after opening: open -> first ->
//         thumbnails (the bundled presets at 96px on thumbnail(256), as
//         use-browser-preset-thumbnails.ts) -> auto (autoSettings, warmed
//         after opening) -> dragTail -> releaseTail -> reopen.
// Each step records its time (wall and process CPU: on a loaded machine the
// two part), the wasm linear memory after it (it never shrinks: the
// high-water so far), the process RSS and the RGBA SHA-256.
// The editor's thumbnails step also records presetIds, frameMs and
// frameMemoryBytes so the preset that first raises the Wasm high-water is
// identifiable without sampling JS heap or RSS.
// The paired summary gives per-step medians / ranges and whether every
// frame of the candidate equals the baseline's.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const [mode, ...args] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const UI_MAX = 1280;
const DRAG_FRAMES = 6;

function readCases(path) {
  const base = dirname(resolve(path));
  return JSON.parse(readFileSync(path, "utf8")).map((c) => ({
    ...c,
    png: resolve(base, c.png),
    meta: resolve(base, c.meta),
    settings:
      typeof c.settings === "string" ? JSON.parse(readFileSync(resolve(base, c.settings), "utf8")) : c.settings,
  }));
}

async function loadBuild(dir) {
  const versionedManifests = readdirSync(dir)
    .map((name) => ({ name, version: /^manifest-(\d+)\.(\d+)\.(\d+)\.json$/.exec(name)?.slice(1).map(Number) }))
    .filter((entry) => entry.version)
    .sort((a, b) => a.version[0] - b.version[0] || a.version[1] - b.version[1] || a.version[2] - b.version[2]);
  const manifestPath = versionedManifests.length
    ? join(dir, versionedManifests.at(-1).name)
    : join(dir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const names = manifest ?? { js: "niho_develop_wasm.js", wasm: "niho_develop_wasm_bg.wasm" };
  const wasmBytes = readFileSync(join(dir, names.wasm));
  if (manifest && sha256(wasmBytes) !== manifest.files[names.wasm].sha256) {
    throw new Error(`${names.wasm} does not match ${manifestPath.split("/").at(-1)}`);
  }
  const jsPath = join(dir, names.js);
  const jsBytes = readFileSync(jsPath);
  if (manifest && sha256(jsBytes) !== manifest.files[names.js].sha256) {
    throw new Error(`${names.js} does not match ${manifestPath.split("/").at(-1)}`);
  }
  // Through a .mjs copy: the published directory has no "type": "module".
  const glue = join(mkdtempSync(join(tmpdir(), "niho-bench-")), "niho_develop_wasm.mjs");
  copyFileSync(jsPath, glue);
  const pkg = await import(pathToFileURL(glue).href);
  const start = performance.now();
  const exports = pkg.initSync({ module: wasmBytes });
  return { pkg, exports, initMs: performance.now() - start, wasmSha256: sha256(wasmBytes) };
}

async function run() {
  const scenario = flag("--scenario", "ui");
  const kase = readCases(flag("--cases")).find((c) => c.id === flag("--case"));
  if (!kase) throw new Error(`no case ${flag("--case")}`);
  const { pkg, exports, initMs, wasmSha256 } = await loadBuild(resolve(flag("--pkg")));
  const png = readFileSync(kase.png);
  const meta = readFileSync(kase.meta, "utf8");
  const steps = [{ step: "init", ms: initMs, memory: exports.memory.buffer.byteLength }];
  const cpu = () => {
    const { user, system } = process.cpuUsage();
    return (user + system) / 1000;
  };
  const record = (step, [ms, cpuMs], frames = []) => {
    const hash = createHash("sha256");
    for (const f of frames) hash.update(`${f.width}x${f.height}`).update(f.rgba);
    steps.push({
      step,
      ms,
      cpuMs,
      memory: exports.memory.buffer.byteLength,
      rss: process.memoryUsage().rss,
      ...(frames.length && { size: `${frames.at(-1).width}x${frames.at(-1).height}`, rgbaSha256: hash.digest("hex") }),
    });
  };
  const timed = (fn) => {
    const [start, startCpu] = [performance.now(), cpu()];
    const value = fn();
    return [value, [performance.now() - start, cpu() - startCpu]];
  };
  const sum = (a, b) => [a[0] + b[0], a[1] + b[1]];
  let currentSettings = { ...kase.settings };
  const json = (overrides = {}) => JSON.stringify({ ...currentSettings, ...overrides });
  const firstMax = scenario === "full" ? 0 : UI_MAX;

  let [developer, ms] = timed(() => pkg.Developer.openWorkingCopy(png, meta));
  record("open", ms);
  let [frame, firstMs] = timed(() => developer.render(json(), firstMax, false));
  record("first", firstMs, [frame]);
  if (scenario === "editor") {
    const asShot = developer.asShotWhite();
    const presets = JSON.parse(pkg.builtinPresets()).map((p) => ({
      id: p.id,
      settings: JSON.stringify(JSON.parse(pkg.applyPreset(p.xmp, json(), 1, asShot)).settings),
    }));
    const [thumbnail, thumbnailMs] = timed(() => developer.thumbnail(256));
    const frames = [];
    let total = thumbnailMs;
    const times = [];
    const memory = [];
    for (const preset of presets) {
      const [f, t] = timed(() => thumbnail.render(preset.settings, 96, false));
      frames.push(f);
      times.push(t[0]);
      memory.push(exports.memory.buffer.byteLength);
      total = sum(total, t);
    }
    record("thumbnails", total, frames);
    steps.at(-1).frameMs = times;
    steps.at(-1).presetIds = presets.map((preset) => preset.id);
    steps.at(-1).frameMemoryBytes = memory;
    let auto;
    [auto, ms] = timed(() => developer.autoSettings(json()));
    record("auto", ms);
    steps.at(-1).autoSha256 = sha256(auto);
    thumbnail.free();
  }
  if (scenario === "ui" || scenario === "editor") {
    for (const [name, key] of [
      ["Tail", "contrast"],
      ["Prep", "highlights"],
    ].slice(0, scenario === "ui" ? 2 : 1)) {
      const frames = [];
      const times = [];
      const startValue = currentSettings[key] ?? 0;
      const valueAt = (i) =>
        key === "contrast" ? startValue + 3 * (i + 1) : Math.max(-100, startValue - 3 * (i + 1));
      for (let i = 0; i < DRAG_FRAMES; i++) {
        const [f, t] = timed(() => developer.render(json({ [key]: valueAt(i) }), UI_MAX, true));
        frames.push(f);
        times.push(t);
      }
      const total = times.reduce(sum);
      record(`drag${name}`, [total[0] / times.length, total[1] / times.length], frames);
      steps.at(-1).frameMs = times.map((t) => t[0]);
      const releasedSettings = { ...currentSettings, [key]: valueAt(DRAG_FRAMES - 1) };
      [frame, ms] = timed(() => developer.render(JSON.stringify(releasedSettings), UI_MAX, false));
      record(`release${name}`, ms, [frame]);
      currentSettings = releasedSettings;
    }
  } else if (scenario !== "full") {
    throw new Error(`unknown scenario ${scenario}`);
  }
  developer.free();
  [developer, ms] = timed(() => pkg.Developer.openWorkingCopy(png, meta));
  [frame, firstMs] = timed(() => developer.render(json(), firstMax, false));
  record("reopen", sum(ms, firstMs), [frame]);
  developer.free();
  const result = { case: kase.id, scenario, version: pkg.version(), wasmSha256, pngSha256: sha256(png), steps };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function paired() {
  const builds = { baseline: resolve(flag("--baseline")), candidate: resolve(flag("--candidate")) };
  const casesPath = resolve(flag("--cases"));
  const cases = readCases(casesPath);
  const trials = Number(flag("--trials", "5"));
  const scenarios = flag("--scenarios", "ui,full").split(",");
  const out = resolve(flag("--out"));
  mkdirSync(out, { recursive: true });
  const records = [];
  for (let trial = 0; trial < trials; trial++) {
    const order = trial % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const kase of cases) {
      for (const scenario of scenarios) {
        for (const label of order) {
          const child = spawnSync(
            process.execPath,
            [script, "run", "--pkg", builds[label], "--cases", casesPath, "--case", kase.id, "--scenario", scenario],
            { encoding: "utf8", maxBuffer: 1 << 24 },
          );
          if (child.status !== 0) throw new Error(`${label} ${kase.id} ${scenario}: ${child.stderr.slice(-2000)}`);
          const result = { label, trial: trial + 1, ...JSON.parse(child.stdout) };
          records.push(result);
          const first = result.steps.find((s) => s.step === "first");
          console.log(
            `${trial + 1} ${label.padEnd(9)} ${kase.id} ${scenario}: first ${first.ms.toFixed(0)} ms, ` +
              `memory ${(Math.max(...result.steps.map((s) => s.memory)) / 1e6).toFixed(1)} MB`,
          );
        }
      }
    }
  }
  const groups = [];
  let identical = true;
  for (const kase of cases) {
    for (const scenario of scenarios) {
      const of = (label) => records.filter((r) => r.label === label && r.case === kase.id && r.scenario === scenario);
      const stepNames = of("baseline")[0].steps.map((s) => s.step);
      const steps = stepNames.map((step) => {
        const row = { step };
        for (const label of ["baseline", "candidate"]) {
          const xs = of(label).map((r) => r.steps.find((s) => s.step === step));
          row[label] = {
            medianMs: median(xs.map((s) => s.ms)),
            ...(xs[0].cpuMs !== undefined && { medianCpuMs: median(xs.map((s) => s.cpuMs)) }),
            rangeMs: [Math.min(...xs.map((s) => s.ms)), Math.max(...xs.map((s) => s.ms))],
            memory: Math.max(...xs.map((s) => s.memory)),
            // The frames' RGBA, or autoSettings' JSON.
            rgbaSha256: [...new Set(xs.map((s) => s.rgbaSha256 ?? s.autoSha256))],
          };
        }
        row.rgbaIdentical =
          row.baseline.rgbaSha256.length === 1 &&
          JSON.stringify(row.baseline.rgbaSha256) === JSON.stringify(row.candidate.rgbaSha256);
        identical &&= row.rgbaIdentical;
        row.changePercent = (row.candidate.medianMs / row.baseline.medianMs - 1) * 100;
        return row;
      });
      groups.push({ case: kase.id, scenario, steps });
    }
  }
  const summary = {
    createdAt: new Date().toISOString(),
    node: process.version,
    trials,
    builds: Object.fromEntries(
      Object.keys(builds).map((label) => {
        const r = records.find((x) => x.label === label);
        return [label, { dir: builds[label], version: r.version, wasmSha256: r.wasmSha256 }];
      }),
    ),
    rgbaIdentical: identical,
    groups,
  };
  writeFileSync(join(out, "records.json"), `${JSON.stringify(records, null, 2)}\n`);
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  for (const g of groups) {
    console.log(`\n${g.case} ${g.scenario}`);
    for (const s of g.steps) {
      const fmt = (x) =>
        `${x.medianMs.toFixed(0)} ms [${x.rangeMs.map((v) => v.toFixed(0)).join("-")}]` +
        `${x.medianCpuMs === undefined ? "" : ` cpu ${x.medianCpuMs.toFixed(0)}`} ${(x.memory / 1e6).toFixed(1)} MB`;
      console.log(
        `  ${s.step.padEnd(12)} ${fmt(s.baseline)} -> ${fmt(s.candidate)} (${s.changePercent.toFixed(1)}%)` +
          `${s.baseline.rgbaSha256[0] ? (s.rgbaIdentical ? " rgba=" : " RGBA DIFFERS") : ""}`,
      );
    }
  }
  if (!identical) {
    console.error("RGBA differs between the builds");
    process.exitCode = 1;
  }
}

if (mode === "run") await run();
else if (mode === "paired") paired();
else throw new Error("usage: bench-session.mjs paired|run ... (see the header)");
