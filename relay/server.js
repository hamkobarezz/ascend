#!/usr/bin/env node
// Ascend relay — a tiny local mailbox between Figma / Photoshop / Illustrator and After Effects.
// The Ascend desktop app embeds it (createRelay); it can also run on its own: `node relay/server.js`.
//   GET  /status       anyone: is the app running, and is something waiting?
//   POST /push         a design app sends the latest payload (JSON body)
//   GET  /pull?dir=…   After Effects fetches it; PNGs are written into `dir` and replaced by file paths
// No dependencies. Listens on 127.0.0.1 only.

const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_PORT = 7777;
const MAX_BODY = 300 * 1024 * 1024;
const FORMATS = new Set(['hb-bridge', 'overlord-mvp']);
const ALLOWED_WEB_ORIGINS = new Set(['https://www.figma.com', 'https://figma.com']);

// Ordinary websites send an http(s) Origin: block them so random pages can't use the relay.
// The Figma plugin iframe sends "null"; Photoshop UXP and the AE / Illustrator sockets send none
// or a non-web origin.
function originAllowed(origin) {
  if (!origin || origin === 'null') return true;
  if (!/^https?:/i.test(origin)) return true;
  return ALLOWED_WEB_ORIGINS.has(origin);
}

// Non-ASCII escaped so ExtendScript can read the response as raw bytes.
function asciiJSON(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

function safePng(name) {
  let n = path.basename(String(name || 'layer')).replace(/[^\w.-]+/g, '_');
  if (!/\.png$/i.test(n)) n += '.png';
  return n;
}

function createRelay({ port = DEFAULT_PORT, host = '127.0.0.1', version = '', log = console.log, onEvent = () => {} } = {}) {
  let latest = null; // { payload, at }

  function summary() {
    const base = { ok: true, app: 'hb-bridge', version };
    if (!latest) return Object.assign(base, { has: false });
    const p = latest.payload;
    const layers = p.layers || [];
    return Object.assign(base, {
      has: true,
      source: p.source,
      kind: p.kind || 'layers',
      comps: Array.isArray(p.comps) ? p.comps.length : 0,
      name: p.name,
      at: latest.at,
      layers: layers.length,
      images: layers.filter((l) => l.type === 'image').length,
    });
  }

  function send(res, code, obj) {
    const body = asciiJSON(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      Connection: 'close',
    });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    if (!originAllowed(req.headers.origin)) return send(res, 403, { ok: false, error: 'Origin not allowed' });
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    if (req.method === 'POST' && url.pathname === '/push') {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          send(res, 413, { ok: false, error: 'Payload too large' });
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!payload || !FORMATS.has(payload.format) || !Array.isArray(payload.layers)) {
            return send(res, 400, { ok: false, error: 'Not an Ascend payload' });
          }
          latest = { payload, at: Date.now() };
          const s = summary();
          log(`[send] ${s.source || '?'} "${s.name}": ${s.kind === 'comps' ? s.comps + ' comps' : s.layers + ' layers, ' + s.images + ' images'}`);
          onEvent(Object.assign({ type: 'send' }, s));
          send(res, 200, s);
        } catch (e) {
          send(res, 400, { ok: false, error: 'Invalid JSON: ' + e.message });
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, summary());

    if (req.method === 'GET' && url.pathname === '/pull') {
      if (!latest) {
        return send(res, 404, { ok: false, error: 'Nothing sent yet. Click "Send to After Effects" in Figma, Photoshop or Illustrator.' });
      }
      const out = JSON.parse(JSON.stringify(latest.payload));
      const dir = url.searchParams.get('dir');
      if (dir) {
        if (!path.isAbsolute(dir)) return send(res, 400, { ok: false, error: 'dir must be an absolute path' });
        try {
          fs.mkdirSync(dir, { recursive: true });
          for (const l of out.layers) {
            if (l.type !== 'image' || !l.image) continue;
            const file = path.join(dir, safePng(l.image.file));
            if (l.image.data) {
              fs.writeFileSync(file, Buffer.from(l.image.data, 'base64'));
            } else if (l.image.src && /\.png$/i.test(l.image.src) && fs.existsSync(l.image.src)) {
              fs.copyFileSync(l.image.src, file); // Illustrator exports PNGs into its temp folder
            } else continue;
            l.image.path = file;
            delete l.image.data;
            delete l.image.src;
          }
        } catch (e) {
          return send(res, 500, { ok: false, error: 'Could not write images: ' + e.message });
        }
      }
      log(`[pull] "${out.name}"${dir ? ' -> ' + dir : ''}`);
      onEvent({ type: 'pull', source: out.source, name: out.name, kind: out.kind || 'layers', layers: out.layers.length, at: Date.now() });
      return send(res, 200, out);
    }

    send(res, 404, { ok: false, error: 'Not found' });
  });

  return {
    port,
    status: summary,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// The app takes the first free port in this range; the plugins look for it in the same range.
const PORTS = [7777, 7778, 7779, 7780, 7781];

module.exports = { createRelay, DEFAULT_PORT, PORTS };

if (require.main === module) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const relay = createRelay({ port });
  relay
    .start()
    .then(() => {
      console.log(`Ascend relay listening on http://localhost:${port}`);
      console.log('Send from Figma, Photoshop or Illustrator, then click "Pull" in After Effects. Ctrl+C to stop.');
    })
    .catch((e) => {
      console.error(e.code === 'EADDRINUSE' ? `Port ${port} is in use (is the Ascend app already running?)` : e.message);
      process.exit(1);
    });
}
