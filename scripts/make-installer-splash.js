// Renders build/installer-splash.bmp: the image the Windows installer fades in while it installs
// (see build/installer.nsh). It is the last frame of the app's own loading screen (app/ui/index.html).
// Run with Electron, not Node:  npx electron scripts/make-installer-splash.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const W = 380, H = 440;
const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${W}px;height:${H}px;background:#0d0d0f;overflow:hidden}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;
    font-family:"Inter Tight","Segoe UI Variable Display","Segoe UI",Arial,sans-serif;color:#efead8;-webkit-font-smoothing:antialiased}
  svg{width:124px;height:90px;overflow:visible}
  .word{font-weight:700;font-size:30px;line-height:1;letter-spacing:-.05em}
  .track{width:140px;height:1px;background:#2a2925;position:relative}
  .track i{position:absolute;left:0;top:0;height:1px;width:40%;background:#ff5a1f}
  .cap{font:10px/1.4 "Cascadia Mono",Consolas,monospace;letter-spacing:.1em;text-transform:uppercase;color:#8d897d}
</style>
<svg viewBox="0 0 368 268"><path d="M0 268 L132 80 L196 164 L264 52 L368 268 Z" fill="#efead8"/><circle cx="56" cy="28" r="28" fill="#ff5a1f"/></svg>
<div class="word">ascend</div><div class="track"><i></i></div><div class="cap">Installing</div>`;

// 24-bit bottom-up BMP from Electron's BGRA bitmap.
function bmp(bgra, w, h) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * h);
  out.write('BM', 0);
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) {
    const dst = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      out[dst + x * 3] = bgra[s];
      out[dst + x * 3 + 1] = bgra[s + 1];
      out[dst + x * 3 + 2] = bgra[s + 2];
    }
  }
  return out;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = (await win.capturePage()).resize({ width: W, height: H });
  const file = path.join(__dirname, '..', 'build', 'installer-splash.bmp');
  fs.writeFileSync(file, bmp(img.toBitmap(), W, H));
  fs.writeFileSync(file.replace(/\.bmp$/, '.png'), img.toPNG()); // preview only
  console.log('splash', path.relative(process.cwd(), file));
  app.quit();
});
