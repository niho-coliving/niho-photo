// Synthetic, reproducible Node/wasm timing probe. No private photos or npm dependencies.
// Usage: node color-review-wasm-bench.cjs /path/to/nodejs/niho_develop_wasm.js
// Node on Studio is a reference environment, not a browser/device performance claim.
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const wasm = require(path.resolve(process.argv[2]));

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
function photo() {
  const width = 1024, height = 768;
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
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const input = photo();
const rows = [];
for (const engine of ['niho-6','niho-8']) {
  const developer = new wasm.Developer(input, 0);
  const settings = {v:1, engine, look:'niho-standard-1', exposure:0.2, highlights:-75, shadows:55, blacks:40, vibrance:10, hsl:{orange:{hue:0,saturation:-10,luminance:20}}};
  const timings = {};
  for (const [name, interactive] of [['coldInteractive',true],['coldFinal',false],['cachedInteractive',true],['cachedFinal',false]]) {
    const start = performance.now();
    const frame = developer.render(JSON.stringify(settings),0,interactive);
    timings[name] = performance.now() - start;
    if (frame.width !== 1024 || frame.height !== 768 || frame.rgba.length !== 1024*768*4) throw new Error('unexpected frame');
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
  rows.push({engine,timingsMs:timings,interactive100ms:timings.editedInteractiveMax<=100,final1000ms:timings.coldFinal<=1000});
  developer.free();
}
console.log(JSON.stringify({schema:'niho.color-review-wasm-timing.v1',environment:'Node wasm SIMD on Studio; browser/device performance remains separate',node:process.version,engineBundle:wasm.version(),dimensions:[1024,768],inputSha256:crypto.createHash('sha256').update(input).digest('hex'),rows},null,2));
