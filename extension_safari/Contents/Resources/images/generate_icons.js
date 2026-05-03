/**
 * generate_icons.js — Generates extension icon PNG files
 * Run: node images/generate_icons.js
 * Requires: Node.js (no external deps — uses built-in Buffer)
 *
 * Creates: icon-16.png, icon-48.png, icon-96.png, icon-128.png
 */

// Minimal valid PNG generator (no external deps)
// Creates a solid-color square PNG with rounded appearance using raw PNG encoding

function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function createPNG(size) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);  // width
  ihdr.writeUInt32BE(size, 4);  // height
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Image data: solid #89b4fa (Hermes blue)
  const raw = [];
  const color = [137, 180, 250]; // #89b4fa in RGB
  const cx = size / 2;
  const radius = size / 2 - 2;
  for (let y = 0; y < size; y++) {
    raw.push(0); // filter byte
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cx;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= radius) {
        // Gradient: lighter center
        const t = 1 - (dist / radius) * 0.4;
        const r = Math.round(color[0] * t + 255 * (1 - t));
        const g = Math.round(color[1] * t + 255 * (1 - t));
        const b = Math.round(color[2] * t + 250 * (1 - t));
        raw.push(r, g, b);
      } else {
        raw.push(30, 30, 46); // transparent-ish background #1e1e2e
      }
    }
  }

  // Compress with zlib (built-in Node.js)
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(Buffer.from(raw));

  const idat = chunk('IDAT', compressed);
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, chunk('IHDR', ihdr), idat, iend]);
}

// Generate icons
const sizes = [16, 48, 96, 128];
const fs = require('fs');
const path = require('path');

const outDir = __dirname;
for (const size of sizes) {
  const png = createPNG(size);
  const filePath = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Created ${filePath} (${png.length} bytes)`);
}

console.log('\nIcons generated. Now build the Safari extension package.');
