// Finds After Effects, Illustrator and Photoshop on this machine and installs / updates the Ascend
// plugins through Adobe's own installer (UPIA), the same way commercial plugins install:
//   After Effects + Illustrator: one signed CEP extension, ascend.zxp (Window > Extensions > Ascend)
//   Photoshop:                   a UXP plugin, hb-bridge.ccx (Plugins > Ascend)
// Older Ascend / HB Bridge versions shipped as loose .jsx scripts; those are removed on install so
// nobody ends up with two Ascends. Removals that need admin rights share one prompt.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const WIN = process.platform === 'win32';
const CEP_ID = 'com.hamkobarezz.ascend';
const PS_PLUGIN_ID = 'com.hamkobarezz.hbbridge';
const LEGACY_SCRIPTS = ['Ascend.jsx', 'HB Bridge.jsx'];

// ---------------------------------------------------------------- helpers

function dirs(base, re) {
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && re.test(d.name))
      .map((d) => path.join(base, d.name));
  } catch (e) {
    return [];
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

function adobeRoots() {
  if (WIN) {
    const roots = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Adobe')];
    if (process.env.ProgramW6432) roots.push(path.join(process.env.ProgramW6432, 'Adobe'));
    return [...new Set(roots)];
  }
  return ['/Applications'];
}

function apps(re) {
  return adobeRoots().flatMap((r) => dirs(r, re));
}

// "Adobe After Effects 2025" -> "2025", "Adobe After Effects (Beta)" -> "(Beta)"
function shortName(dir, prefix) {
  return path.basename(dir).replace(prefix, '').trim() || path.basename(dir);
}

// ---------------------------------------------------------------- what's installed

function aeApps() {
  return apps(/^Adobe After Effects/).map((dir) => ({ version: shortName(dir, 'Adobe After Effects'), dir }));
}
function aiApps() {
  return apps(/^Adobe Illustrator/).map((dir) => ({ version: shortName(dir, 'Adobe Illustrator'), dir }));
}
function psApps() {
  return apps(/^Adobe Photoshop/).map((d) => shortName(d, 'Adobe Photoshop'));
}

// Where pre-plugin versions put their .jsx files.
function legacyScriptFiles() {
  const folders = [];
  for (const a of aeApps()) folders.push(WIN ? path.join(a.dir, 'Support Files', 'Scripts', 'ScriptUI Panels') : path.join(a.dir, 'Scripts', 'ScriptUI Panels'));
  for (const a of aiApps()) {
    for (const presets of ['Presets', 'Presets.localized']) {
      for (const locale of dirs(path.join(a.dir, presets), /^[a-z]{2}_[A-Z]{2}$/)) folders.push(path.join(locale, 'Scripts'));
    }
  }
  return folders.flatMap((d) => LEGACY_SCRIPTS.map((n) => path.join(d, n))).filter(exists);
}

function cepDirs() {
  return WIN
    ? [
        path.join(process.env['CommonProgramFiles(x86)'] || 'C:\\Program Files (x86)\\Common Files', 'Adobe', 'CEP', 'extensions'),
        path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'Adobe', 'CEP', 'extensions'),
        path.join(process.env.APPDATA || '', 'Adobe', 'CEP', 'extensions'),
      ]
    : ['/Library/Application Support/Adobe/CEP/extensions', path.join(os.homedir(), 'Library/Application Support/Adobe/CEP/extensions')];
}

// Version of the installed Ascend CEP extension, read from its manifest (UPIA names the folder itself).
function cepInstalledVersion() {
  for (const base of cepDirs()) {
    for (const d of dirs(base, /./)) {
      try {
        const xml = fs.readFileSync(path.join(d, 'CSXS', 'manifest.xml'), 'utf8');
        if (!xml.includes('ExtensionBundleId="' + CEP_ID + '"')) continue;
        const m = xml.match(/ExtensionBundleVersion="([^"]+)"/);
        return m ? m[1] : '?';
      } catch (e) {}
    }
  }
  return null;
}

function uxpPluginDirs() {
  const list = WIN
    ? [
        path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'Adobe', 'UXP', 'Plugins', 'External'),
        path.join(process.env.APPDATA || '', 'Adobe', 'UXP', 'Plugins', 'External'),
      ]
    : ['/Library/Application Support/Adobe/UXP/Plugins/External', path.join(os.homedir(), 'Library/Application Support/Adobe/UXP/Plugins/External')];
  return list.flatMap((base) => dirs(base, new RegExp('^' + PS_PLUGIN_ID.replace(/\./g, '\\.'))));
}

function psVersionInstalled() {
  const d = uxpPluginDirs()[0];
  if (!d) return null;
  const m = path.basename(d).match(/_(\d+\.\d+\.\d+)$/);
  return m ? m[1] : '?';
}

// ---------------------------------------------------------------- Adobe's installer (UPIA)

function upiaPath() {
  const p = WIN
    ? path.join(process.env.CommonProgramFiles || 'C:\\Program Files\\Common Files', 'Adobe', 'Adobe Desktop Common', 'RemoteComponents', 'UPI', 'UnifiedPluginInstallerAgent', 'UnifiedPluginInstallerAgent.exe')
    : '/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent';
  return exists(p) ? p : null;
}

// UPIA wants "/install" on Windows and "--install" on macOS. It exits 0 even when it fails,
// so success is read from its output, not from the exit code.
function upiaInstall(pkg) {
  const upia = upiaPath();
  if (!upia) return { ok: false, out: 'no-upia' };
  try {
    const out = cp.execFileSync(upia, [WIN ? '/install' : '--install', pkg], { windowsHide: true, encoding: 'utf8', timeout: 180000 });
    return { ok: /Installation Successful/i.test(out), out };
  } catch (e) {
    return { ok: false, out: String((e.stdout || '') + (e.stderr || '') || e.message) };
  }
}

// ---------------------------------------------------------------- removing old scripts

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Deletes the given files; anything that needs admin rights is removed in one elevated step.
function removeFiles(files, { elevate }) {
  const left = [];
  for (const f of files) {
    try {
      fs.unlinkSync(f);
    } catch (e) {
      if (exists(f)) left.push(f);
    }
  }
  if (!left.length || !elevate) return left.filter(exists);
  if (WIN) {
    const ps1 = path.join(os.tmpdir(), 'ascend-cleanup-' + process.pid + '.ps1');
    fs.writeFileSync(ps1, '\ufeff' + left.map((f) => `Remove-Item -LiteralPath ${psQuote(f)} -Force -ErrorAction SilentlyContinue`).join('\r\n'), 'utf8');
    try {
      cp.execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote('"' + ps1 + '"')}`],
        { windowsHide: true }
      );
    } catch (e) {
      /* declined: reported below */
    } finally {
      try { fs.unlinkSync(ps1); } catch (e) {}
    }
  } else {
    const sh = 'rm -f ' + left.map(shQuote).join(' ');
    const script = 'do shell script "' + sh.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '" with administrator privileges with prompt "Ascend wants to remove its old scripts from your Adobe apps."';
    try { cp.execFileSync('osascript', ['-e', script]); } catch (e) {}
  }
  return left.filter(exists);
}

// ---------------------------------------------------------------- public API

// res = { zxp, zxpVersion, ccx, ccxVersion, figma } absolute paths / versions of the bundled plugins
function detect(res) {
  const ae = aeApps(), ai = aiApps(), ps = psApps();
  const cepHave = cepInstalledVersion();
  const legacy = legacyScriptFiles();
  const cepStatus = (found) =>
    !found ? 'not-found' : cepHave === res.zxpVersion && !legacy.length ? 'installed' : cepHave || legacy.length ? 'outdated' : 'missing';
  const psHave = psVersionInstalled();
  return [
    { id: 'ae', name: 'After Effects', badge: 'Ae', versions: ae.map((a) => a.version), status: cepStatus(ae.length) },
    { id: 'ai', name: 'Illustrator', badge: 'Ai', versions: ai.map((a) => a.version), status: cepStatus(ai.length) },
    {
      id: 'ps',
      name: 'Photoshop',
      badge: 'Ps',
      versions: ps,
      status: !ps.length && !psHave ? 'not-found' : psHave === res.ccxVersion ? 'installed' : psHave ? 'outdated' : 'missing',
    },
    { id: 'figma', name: 'Figma', badge: 'Fg', versions: [], status: 'manual' },
  ];
}

const NO_UPIA = 'Adobe’s plugin installer wasn’t found. Install or update the Creative Cloud app, then try again.';

function install(id, res, openPath) {
  if (id === 'ae' || id === 'ai') {
    // One package serves both apps; skip UPIA when the current version is already there.
    if (cepInstalledVersion() !== res.zxpVersion) {
      if (!upiaPath()) return { ok: false, note: NO_UPIA };
      const r = upiaInstall(res.zxp);
      if (!r.ok) {
        openPath(res.zxp); // let Creative Cloud's own installer window try
        return { ok: false, note: 'Adobe’s installer couldn’t install the panel. If Creative Cloud opened, accept its prompt.' };
      }
    }
    const left = removeFiles(legacyScriptFiles(), { elevate: true });
    const where = id === 'ae' ? 'Restart After Effects, then open Window > Extensions > Ascend.' : 'Restart Illustrator, then open Window > Extensions > Ascend.';
    return { ok: true, note: where + (left.length ? ' (Couldn’t remove the old Ascend script; you can delete it from the Scripts folder.)' : '') };
  }
  if (id === 'ps') {
    if (upiaPath() && upiaInstall(res.ccx).ok) return { ok: true, note: 'Restart Photoshop, then open Plugins > Ascend.' };
    openPath(res.ccx); // fall back to Creative Cloud's own installer window
    return { ok: true, note: 'Creative Cloud is installing the plugin. Accept its prompt, then open Plugins > Ascend in Photoshop.' };
  }
  return { ok: false, note: 'Unknown app' };
}

// On launch: quietly update plugins that are installed but older than the bundled ones.
function autoUpdate(res) {
  const updated = [];
  const cepHave = cepInstalledVersion();
  if (cepHave && cepHave !== res.zxpVersion && upiaPath() && upiaInstall(res.zxp).ok) updated.push('After Effects / Illustrator panel ' + res.zxpVersion);
  if (cepInstalledVersion() === res.zxpVersion) removeFiles(legacyScriptFiles(), { elevate: false });
  const psHave = psVersionInstalled();
  if (psHave && psHave !== res.ccxVersion && upiaPath() && upiaInstall(res.ccx).ok) updated.push('Photoshop plugin ' + res.ccxVersion);
  return updated;
}

module.exports = { detect, install, autoUpdate, legacyScriptFiles, cepInstalledVersion };
