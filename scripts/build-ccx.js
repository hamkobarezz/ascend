// Packs photoshop-plugin/ into dist-plugins/hb-bridge.ccx (a .ccx is a zip with manifest.json at
// its root), which Creative Cloud installs into Photoshop. No dependencies: a minimal zip writer.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'photoshop-plugin');
const OUT = path.join(ROOT, 'dist-plugins');

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

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const rel = base ? base + '/' + d.name : d.name;
    return d.isDirectory() ? walk(path.join(dir, d.name), rel) : [rel];
  });
}

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const name of files) {
    const data = fs.readFileSync(path.join(SRC, name));
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt32LE(0, 10); // time/date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const files = walk(SRC).sort((a, b) => (a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : a.localeCompare(b)));
fs.mkdirSync(OUT, { recursive: true });
const buf = zip(files);
fs.writeFileSync(path.join(OUT, 'hb-bridge.ccx'), buf);
fs.writeFileSync(path.join(OUT, 'ps-version.json'), JSON.stringify({ id: manifest.id, version: manifest.version }));
console.log(`ccx ${manifest.id} ${manifest.version}: ${files.length} files, ${buf.length} bytes`);
