// Synthetic, reproducible Node/wasm timing probe. No private photos or npm dependencies.
// Usage: node color-review-wasm-bench.cjs /path/to/nodejs/niho_develop_wasm.js [raster-engines] [legacy-raw-engines] [WIDTHxHEIGHT]
//   raster-engines: comma-separated, default "niho-6,niho-8" (the 2026-10-20 run)
//   Each row also drags the relative temperature (5 Interactive ticks) and releases it (#27).
//   legacy-raw-engines: comma-separated engines for a legacy unsigned RAW working copy, default none
// Node on Studio is a reference environment, not a browser/device performance claim.
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const wasm = require(path.resolve(process.argv[2]));
const rasterEngines = (process.argv[3] ?? 'niho-6,niho-8').split(',').filter(Boolean);
const rawEngines = (process.argv[4] ?? '').split(',').filter(Boolean);
//   WIDTHxHEIGHT: the synthetic scene's size, default 1024x768 (1280x960 is the editor's preview long edge)
const [WIDTH, HEIGHT] = (process.argv[5] ?? '1024x768').split('x').map(Number);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type);
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([header, tag, data, crc]);
}
function png(width, height, bitDepth, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = bitDepth; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
function photo() {
  const width = WIDTH, height = HEIGHT;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      const window = x > 640 && y < 320;
      raw[offset] = window ? 235 : 20 + Math.floor(x / 64);
      raw[offset + 1] = window ? 240 : 18 + Math.floor(y / 64);
      raw[offset + 2] = window ? 250 : 16;
    }
  }
  return png(width, height, 8, raw);
}
// The same kind of scene as a legacy unsigned RAW working copy: 16-bit linear
// ProPhoto encoded with gamma 1.8 over [0, 2] (`decode::encode_working_copy`).
function legacyRawWorkingCopy() {
  const width = WIDTH, height = HEIGHT;
  const raw = Buffer.alloc(height * (1 + width * 6));
  const encode = (linear) => Math.round(Math.pow(Math.min(Math.max(linear / 2, 0), 1), 1 / 1.8) * 65535);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 6 + 1) + 1 + x * 6;
      const window = x > 640 && y < 320;
      const rgb = window ? [0.85, 0.9, 0.95] : [0.01 + x / WIDTH * 0.08, 0.012 + y / HEIGHT * 0.06, 0.008];
      rgb.forEach((value, channel) => raw.writeUInt16BE(encode(value), offset + channel * 2));
    }
  }
  return png(width, height, 16, raw);
}
const LEGACY_RAW_META = JSON.stringify({kind:'raw',baselineEV:0,asShotWhite:{x:0.3457,y:0.3585},dcpSha256:'synthetic',lookTableIncluded:true});

function bench(open, engine, source) {
  const developer = open();
  const settings = {v:1, engine, look:'niho-standard-1', exposure:0.2, highlights:-75, shadows:55, blacks:40, vibrance:10, hsl:{orange:{hue:0,saturation:-10,luminance:20}}};
  const timings = {};
  for (const [name, interactive] of [['coldInteractive',true],['coldFinal',false],['cachedInteractive',true],['cachedFinal',false]]) {
    const start = performance.now();
    const frame = developer.render(JSON.stringify(settings),0,interactive);
    timings[name] = performance.now() - start;
    if (frame.width !== WIDTH || frame.height !== HEIGHT || frame.rgba.length !== WIDTH*HEIGHT*4) throw new Error('unexpected frame');
  }
  const warm = [];
  for (let i = 0; i < 5; i++) {
    settings.contrast = i + 1;
    const start = performance.now();
    developer.render(JSON.stringify(settings),0,true);
    warm.push(performance.now()-start);
  }
  warm.sort((a,b)=>a-b);
  timings.editedInteractiveMedian = warm[2];
  timings.editedInteractiveMax = warm[4];
  // The release after the drag: one Final with the last edited settings.
  const start = performance.now();
  developer.render(JSON.stringify(settings),0,false);
  timings.releasedFinal = performance.now() - start;
  // A drag of the relative temperature (#27: niho-13 balances the source, so
  // every tick changes what the analysis, statistics and local pass read),
  // then its release.
  settings.whiteBalance = {mode:'relative'};
  const wb = [];
  for (let i = 0; i < 5; i++) {
    settings.relativeTemperature = 6 * (i + 1);
    const tick = performance.now();
    developer.render(JSON.stringify(settings),0,true);
    wb.push(performance.now()-tick);
  }
  wb.sort((a,b)=>a-b);
  timings.whiteBalanceInteractiveMedian = wb[2];
  timings.whiteBalanceInteractiveMax = wb[4];
  const wbRelease = performance.now();
  developer.render(JSON.stringify(settings),0,false);
  timings.whiteBalanceReleasedFinal = performance.now() - wbRelease;
  developer.free();
  return {source,engine,timingsMs:timings,interactive100ms:timings.editedInteractiveMax<=100,whiteBalanceInteractive100ms:timings.whiteBalanceInteractiveMax<=100,final1000ms:timings.coldFinal<=1000&&timings.releasedFinal<=1000&&timings.whiteBalanceReleasedFinal<=1000};
}

const input = photo();
const workingCopy = legacyRawWorkingCopy();
const rows = [];
for (const engine of rasterEngines) rows.push(bench(() => new wasm.Developer(input, 0), engine, 'raster'));
for (const engine of rawEngines) rows.push(bench(() => wasm.Developer.openWorkingCopy(workingCopy, LEGACY_RAW_META), engine, 'legacyRaw'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
console.log(JSON.stringify({schema:'niho.color-review-wasm-timing.v3',environment:'Node wasm SIMD on Studio; browser/device performance remains separate',node:process.version,engineBundle:wasm.version(),dimensions:[WIDTH,HEIGHT],inputSha256:sha256(input),legacyRawWorkingCopySha256:rawEngines.length?sha256(workingCopy):null,order:'engines run in the listed order within one process; cold values include process-wide caches of earlier rows',rows},null,2));
