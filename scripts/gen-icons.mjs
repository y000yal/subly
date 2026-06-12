// Generates placeholder extension icons (PNG) with zero dependencies.
// Design: dark rounded tile, outlined "screen", filled PiP window bottom-right,
// two subtitle bars bottom-left. Replace with designed icons before store submit.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src', 'public', 'icon');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function encodePng(size, pixels /* RGBA Uint8Array */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines with filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels
      .subarray(y * size * 4, (y + 1) * size * 4)
      .forEach((v, i) => (raw[y * (size * 4 + 1) + 1 + i] = v));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const fillRect = (x0, y0, x1, y1, r, g, b, a = 255) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++)
      for (let x = Math.round(x0); x < Math.round(x1); x++) put(x, y, r, g, b, a);
  };
  const s = size;
  const radius = s * 0.18;
  // rounded dark-blue tile
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const cx = Math.max(radius - x, x - (s - 1 - radius), 0);
      const cy = Math.max(radius - y, y - (s - 1 - radius), 0);
      if (Math.hypot(cx, cy) <= radius) put(x, y, 23, 37, 84); // #172554
      else if (cx === 0 || cy === 0) put(x, y, 23, 37, 84);
    }
  }
  // outlined screen
  const m = s * 0.18; // margin
  const t = Math.max(1, Math.round(s * 0.055)); // stroke
  const x0 = m, y0 = s * 0.24, x1 = s - m, y1 = s - s * 0.24;
  fillRect(x0, y0, x1, y0 + t, 147, 197, 253); // #93c5fd
  fillRect(x0, y1 - t, x1, y1, 147, 197, 253);
  fillRect(x0, y0, x0 + t, y1, 147, 197, 253);
  fillRect(x1 - t, y0, x1, y1, 147, 197, 253);
  // filled PiP window, bottom-right inside screen
  fillRect(x1 - s * 0.30, y1 - s * 0.20, x1 - t * 1.6, y1 - t * 1.6, 255, 255, 255);
  // subtitle bars, bottom-left inside screen
  const barH = Math.max(1, Math.round(s * 0.05));
  fillRect(x0 + t * 1.6, y1 - t * 1.6 - barH * 2.6, x0 + s * 0.34, y1 - t * 1.6 - barH * 1.6, 250, 204, 21); // #facc15
  fillRect(x0 + t * 1.6, y1 - t * 1.6 - barH, x0 + s * 0.42, y1 - t * 1.6, 250, 204, 21);
  return px;
}

for (const size of [16, 32, 48, 96, 128]) {
  writeFileSync(join(outDir, `${size}.png`), encodePng(size, drawIcon(size)));
  console.log(`icon/${size}.png`);
}
