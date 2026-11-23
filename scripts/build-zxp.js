// Packs and signs cep/ (the After Effects + Illustrator panels) into dist-plugins/ascend.zxp with
// Adobe's ZXPSignCmd (tools/zxpsign/, from github.com/Adobe-CEP/CEP-Resources, ZXPSignCMD 4.1.3).
// The Ascend app installs the .zxp through Adobe's own installer (UPIA), like any commercial panel.
//
// Certificate: a self-signed one is created on first run at tools/zxpsign/ascend-cert.p12 and reused,
// so every build is signed by the same identity. Keep that file (and its password) safe and out of git.
// Password: ASCEND_CERT_PASSWORD, or a local default for development builds.
// Adobe recommends signing on the platform the ZXP ships to, so Windows and macOS builds each sign their own.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'cep');
const OUT_DIR = path.join(ROOT, 'dist-plugins');
const OUT = path.join(OUT_DIR, 'ascend.zxp');
const TOOLS = path.join(ROOT, 'tools', 'zxpsign');
const CERT = path.join(TOOLS, 'ascend-cert.p12');
const PASSWORD = process.env.ASCEND_CERT_PASSWORD || 'ascend-local-dev';
const TSA = 'http://timestamp.digicert.com';

const BIN = process.platform === 'win32' ? path.join(TOOLS, 'win', 'ZXPSignCmd.exe') : process.platform === 'darwin' ? path.join(TOOLS, 'mac', 'ZXPSignCmd') : null;
if (!BIN || !fs.existsSync(BIN)) {
  console.error('zxp: ZXPSignCmd not found for ' + process.platform + ' (expected ' + BIN + ')');
  process.exit(1);
}
if (process.platform === 'darwin') fs.chmodSync(BIN, 0o755);

function run(args, opts = {}) {
  const r = cp.spawnSync(BIN, args, { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 && !opts.allowFail) throw new Error('ZXPSignCmd ' + args[0] + ' failed:\n' + out);
  return { ok: r.status === 0, out };
}

// Version must match package.json, or the app would keep "updating" the panels.
const version = require(path.join(ROOT, 'package.json')).version;
const manifest = fs.readFileSync(path.join(SRC, 'CSXS', 'manifest.xml'), 'utf8');
const m = manifest.match(/ExtensionBundleVersion="([^"]+)"/);
if (!m || m[1] !== version) {
  console.error(`zxp: cep/CSXS/manifest.xml ExtensionBundleVersion (${m && m[1]}) must match package.json (${version})`);
  process.exit(1);
}

// Stage a plain copy: no symlinks, no .DS_Store (both break signature checks after install).
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ascend-zxp-'));
function copy(from, to) {
  for (const d of fs.readdirSync(from, { withFileTypes: true })) {
    if (d.name === '.DS_Store' || d.name === '__MACOSX' || d.name === '.debug') continue;
    const a = path.join(from, d.name), b = path.join(to, d.name);
    if (d.isDirectory()) { fs.mkdirSync(b); copy(a, b); }
    else if (d.isFile()) fs.copyFileSync(a, b);
  }
}
copy(SRC, stage);

if (!fs.existsSync(CERT)) {
  run(['-selfSignedCert', 'US', 'NY', 'Hamko Barez', 'Ascend', PASSWORD, CERT, '-validityDays', '3650']);
  console.log('zxp: created certificate', path.relative(ROOT, CERT));
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(OUT, { force: true });
let signed = run(['-sign', stage, OUT, CERT, PASSWORD, '-tsa', TSA], { allowFail: true });
if (!signed.ok) {
  // Timestamping needs the internet; without it the signature is still valid until the certificate expires.
  console.warn('zxp: timestamp server unreachable, signing without -tsa');
  fs.rmSync(OUT, { force: true });
  run(['-sign', stage, OUT, CERT, PASSWORD]);
}
const verify = run(['-verify', OUT], { allowFail: true });
fs.rmSync(stage, { recursive: true, force: true });
if (!verify.ok || !/verified/i.test(verify.out)) {
  console.error('zxp: signature check failed:\n' + verify.out);
  process.exit(1);
}
fs.writeFileSync(path.join(OUT_DIR, 'cep-version.json'), JSON.stringify({ id: 'com.hamkobarezz.ascend', version }) + '\n');
console.log(`zxp com.hamkobarezz.ascend ${version}: ${path.relative(ROOT, OUT)} (${fs.statSync(OUT).size} bytes, signed)`);
