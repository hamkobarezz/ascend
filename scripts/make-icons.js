// Draws the Ascend icons (twin peaks + sun, see brand/ascend-mark.svg) straight to PNG, no dependencies.
//   build/icon.png              1024 px app icon (electron-builder makes .ico / .icns from it)
//   app/assets/icon.png         256 px window icon
//   app/assets/tray.png         32 px mark for the Windows tray
//   app/assets/trayTemplate*.png  black mark for the macOS menu bar (template image, 1x + 2x)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const INK = [13, 13, 15];
const ACCENT = [255, 90, 31];
const PAPER = [239, 234, 216];

// ---- PNG encoder
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- shapes, in unit coordinates centered on 0 (the mark spans x -1..1)
// brand/ascend-mark.svg is 368 x 268: x' = x / 184 - 1, y' = (y - 134) / 184.
const PEAKS = [[0, 268], [132, 80], [196, 164], [264, 52], [368, 268]].map(([x, y]) => [x / 184 - 1, (y - 134) / 184]);
const SUN = { x: 56 / 184 - 1, y: (28 - 134) / 184, r: 28 / 184 };
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// 0 = empty, 1 = peaks, 2 = sun
function mark(x, y) {
  if (Math.hypot(x - SUN.x, y - SUN.y) <= SUN.r) return 2;
  return inPolygon(x, y, PEAKS) ? 1 : 0;
}

// Renders with 4x4 supersampling. bg: rounded tile colour or null; peak / sun: fill colours.
function render(size, { bg, peak, sun, scale, radius }) {
  const out = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (px + (sx + 0.5) / S) / size * 2 - 1; // -1..1
          const v = (py + (sy + 0.5) / S) / size * 2 - 1;
          const m = mark(u / scale, v / scale);
          let c = m === 1 ? peak : m === 2 ? sun : null;
          if (!c && bg) {
            const ax = Math.max(Math.abs(u) - (1 - radius), 0), ay = Math.max(Math.abs(v) - (1 - radius), 0);
            if (Math.hypot(ax, ay) <= radius) c = bg;
          }
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const i = (py * size + px) * 4;
      if (a) { out[i] = Math.round(r / a); out[i + 1] = Math.round(g / a); out[i + 2] = Math.round(b / a); }
      out[i + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return png(size, out);
}

function write(rel, buf) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log('icon', rel, buf.length, 'bytes');
}

const app = { bg: INK, peak: PAPER, sun: ACCENT, scale: 0.6, radius: 0.44 };
write('build/icon.png', render(1024, app));
write('app/assets/icon.png', render(256, app));
write('app/assets/tray.png', render(32, { peak: PAPER, sun: ACCENT, scale: 0.94 }));
const black = [0, 0, 0];
write('app/assets/trayTemplate.png', render(22, { peak: black, sun: black, scale: 0.94 }));
write('app/assets/trayTemplate@2x.png', render(44, { peak: black, sun: black, scale: 0.94 }));
// CEP panel icons (After Effects / Illustrator panel tabs): light UI and dark UI variants.
write('cep/icons/icon-dark.png', render(23, { peak: PAPER, sun: ACCENT, scale: 0.9 }));
write('cep/icons/icon-light.png', render(23, { peak: INK, sun: ACCENT, scale: 0.9 }));
