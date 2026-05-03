/**
 * generate_icons.js — Generate Hermes Browser Bridge extension icons
 * Runs: node generate_icons.js
 *
 * Pure Node.js PNG generator — no external dependencies.
 * Creates 4 sizes (16, 48, 96, 128) with a geometric "H" bridge design
 * in the accent blue color on a dark background.
 *
 * PNG format: IHDR + IDAT (uncompressed Flate) + IEND
 * Uses no external libraries — pure Node.js crypto and zlib.
 */

const { deflateSync } = require('zlib');
const { writeFileSync } = require('fs');
const path = require('path');

const SIZES = [16, 48, 96, 128];

// Color: accent blue #89b4fa → RGB(137, 180, 250)
const ACCENT = [137, 180, 250];
const BG = [30, 30, 46];           // #1e1e2e

// ─── CRC32 ─────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xFFFFFFFF;
  for (const byte of data) {
    c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeCrcTag(type, data) {
  const buf = Buffer.alloc(type.length + data.length);
  buf.write(type, 0, 'ascii');
  data.copy(buf, type.length);
  const crcVal = crc32(buf);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crcVal, 0);
  return Buffer.concat([buf, crcBuf]);
}

// ─── PNG chunks ─────────────────────────────────────────────────────────────

function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  return Buffer.concat([lenBuf, makeCrcTag(type, data)]);
}

function ihdrChunk(w, h) {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = 8;  // bit depth
  d[9] = 2;  // color type: RGB
  d[10] = 0; // compression
  d[11] = 0; // filter
  d[12] = 0; // interlace
  return pngChunk('IHDR', d);
}

function mkIDAT(w, h, rgbaFn) {
  // Raw scanlines: filter byte (0) + RGB per pixel per row
  const rowBytes = 1 + w * 3;
  const raw = Buffer.alloc(h * rowBytes);
  for (let y = 0; y < h; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rgbaFn(x, y, w, h);
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  // Deflate using sync API (Node.js v22 compatible)
  const deflated = deflateSync(raw);
  return pngChunk('IDAT', deflated);
}

function iendChunk() {
  return pngChunk('IEND', Buffer.alloc(0));
}

function makePNG(w, h, rgbaFn) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG signature
    ihdrChunk(w, h),
    mkIDAT(w, h, rgbaFn),
    iendChunk()
  ]);
}

// ─── Icon drawing ──────────────────────────────────────────────────────────

/**
 * Draw icon. rgbaFn(x, y, w, h) → [r, g, b]
 */
function drawIcon(size, rgbaFn) {
  const png = makePNG(size, size, rgbaFn);
  const outPath = path.join(__dirname, `icon-${size}.png`);
  writeFileSync(outPath, png);
  console.log(`  ✓ icon-${size}.png  (${png.length} bytes)`);
  return png;
}

// ─── Icon patterns ─────────────────────────────────────────────────────────

function iconRGB(size) {
  const s = size;
  return (x, y, w, h) => {
    const cx = w / 2;
    const cy = h / 2;
    const r = s * 0.40; // outer radius
    const pad = s * 0.10;

    // Rounded square background
    const inSquare = x >= pad && x < w - pad && y >= pad && y < h - pad;

    if (!inSquare) return BG;

    // Center circle in accent
    const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    if (dist < r * 0.5) return ACCENT;

    // Ring
    if (dist < r * 0.72) return BG;

    if (dist <= r) return ACCENT;

    return BG;
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

console.log('Generating Hermes Browser Bridge icons (pure Node.js, no deps)…\n');
for (const size of SIZES) {
  drawIcon(size, iconRGB(size));
}
console.log('\nIcons written to:', __dirname);
console.log('Copy them to: extension_safari/Contents/Resources/images/');
