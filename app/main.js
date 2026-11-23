// Ascend desktop app: lives in the tray / menu bar, runs the relay the plugins talk to,
// installs and updates the plugins, and (optionally) starts at login.

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { createRelay, DEFAULT_PORT, PORTS } = require('../relay/server');
const installers = require('./installers');

const VERSION = app.getVersion();
const MAC = process.platform === 'darwin';

// Keep the pre-rename settings folder (settings.json, and the Figma plugin copy Figma was pointed at).
app.setPath('userData', path.join(app.getPath('appData'), 'HB Bridge'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------- settings (tiny JSON file)

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { firstRunDone: false, last: null };
function loadSettings() {
  try {
    settings = Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch (e) {}
}
function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (e) {}
}

// ---------------------------------------------------------------- bundled plugins

function pluginsDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'plugins') : path.join(__dirname, '..');
}
function resources() {
  const base = pluginsDir();
  const packaged = app.isPackaged;
  const built = packaged ? base : path.join(base, 'dist-plugins'); // scripts/build-ccx.js + build-zxp.js output
  const version = (file) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(built, file), 'utf8')).version;
    } catch (e) {
      return null;
    }
  };
  return {
    zxp: path.join(built, 'ascend.zxp'), // After Effects + Illustrator panels (signed CEP extension)
    zxpVersion: version('cep-version.json'),
    ccx: path.join(built, 'hb-bridge.ccx'), // Photoshop (UXP)
    ccxVersion: version('ps-version.json'),
    figma: path.join(base, 'figma-plugin'),
  };
}

// ---------------------------------------------------------------- relay

let relay = null;
let relayState = { running: false, port: DEFAULT_PORT, error: null };

// Takes the first free port from PORTS (7777 first); the plugins search the same range.
async function startRelay() {
  let lastError = null;
  for (const port of PORTS) {
    relay = createRelay({
      port,
      version: VERSION,
      log: () => {},
      onEvent: (ev) => {
        settings.last = ev;
        saveSettings();
        send('event', ev);
        updateTray();
      },
    });
    try {
      await relay.start();
      relayState = { running: true, port, error: null };
      return;
    } catch (e) {
      lastError = e;
      if (e.code !== 'EADDRINUSE') break;
    }
  }
  relayState = {
    running: false,
    port: DEFAULT_PORT,
    error:
      lastError && lastError.code === 'EADDRINUSE'
        ? `Ports ${PORTS[0]}–${PORTS[PORTS.length - 1]} are all in use. Close any other Ascend window, then restart.`
        : (lastError && lastError.message) || 'The relay could not start.',
  };
}

// ---------------------------------------------------------------- window + tray

let win = null;
let tray = null;

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({
      width: 380,
      height: 720,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      backgroundColor: '#0d0d0f',
      title: 'Ascend',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.loadFile(path.join(__dirname, 'ui', 'index.html'));
    win.once('ready-to-show', () => win.show());
    win.on('close', (e) => {
      if (!app.isQuitting) {
        e.preventDefault();
        win.hide();
      }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  } else {
    win.show();
    win.focus();
  }
  if (MAC && app.dock) app.dock.show();
}

function trayImage() {
  const file = MAC ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', file));
  if (MAC) img.setTemplateImage(true);
  return img;
}

function lastLine() {
  const l = settings.last;
  if (!l) return 'Nothing sent yet';
  if (l.type === 'pull') return `Pulled into AE: ${l.name}`;
  return `${l.source} sent: ${l.name}`;
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Ascend · ${relayState.running ? 'running' : 'relay stopped'} · ${lastLine()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: relayState.running ? 'Ascend is running' : 'Relay stopped', enabled: false },
      { label: lastLine(), enabled: false },
      { type: 'separator' },
      { label: 'Open Ascend', click: showWindow },
      {
        label: 'Open at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => setLogin(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit Ascend', click: quit },
    ])
  );
}

function setLogin(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: ['--hidden'] });
  settings.firstRunDone = true;
  saveSettings();
  updateTray();
}

function quit() {
  app.isQuitting = true;
  if (relay) relay.stop();
  app.quit();
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('state', () => ({
  version: VERSION,
  platform: process.platform,
  relay: relayState,
  last: settings.last,
  firstRun: !settings.firstRunDone,
  openAtLogin: app.getLoginItemSettings().openAtLogin,
  apps: installers.detect(resources()),
}));
ipcMain.handle('set-login', (e, on) => {
  setLogin(on);
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('install', (e, id) => {
  if (id === 'figma') return setupFigma();
  return installers.install(id, resources(), (p) => shell.openPath(p));
});
ipcMain.handle('window', (e, action) => {
  if (action === 'hide' && win) win.hide();
  if (action === 'minimize' && win) win.minimize();
  if (action === 'quit') quit();
});
ipcMain.handle('open-url', (e, url) => {
  if (/^https:\/\/hamkobarezz\.com/.test(url)) shell.openExternal(url);
});

// Figma can't be installed from outside Figma: copy the plugin somewhere stable and show it.
function setupFigma() {
  const dest = path.join(app.getPath('userData'), 'figma-plugin');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(resources().figma)) fs.copyFileSync(path.join(resources().figma, f), path.join(dest, f));
  shell.showItemInFolder(path.join(dest, 'manifest.json'));
  return {
    ok: true,
    note: 'In Figma: Plugins > Development > Import plugin from manifest…, then pick the highlighted manifest.json. Only needed once.',
    manifest: path.join(dest, 'manifest.json'),
  };
}

// ---------------------------------------------------------------- lifecycle

app.on('second-instance', showWindow);
app.on('window-all-closed', () => {
  /* keep running in the tray */
});
app.on('before-quit', () => {
  app.isQuitting = true;
});
app.on('activate', showWindow);

app.whenReady().then(async () => {
  loadSettings();
  if (MAC && app.dock) app.dock.hide();
  await startRelay();
  tray = new Tray(trayImage());
  tray.on('click', showWindow);
  updateTray();

  try {
    const updated = installers.autoUpdate(resources());
    if (updated.length) settings.lastUpdate = { at: Date.now(), updated };
  } catch (e) {}

  const atLogin = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  if (!atLogin || !settings.firstRunDone || !relayState.running) showWindow();
});
