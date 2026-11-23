// Window logic. Talks to the main process only through window.hb (exposed by preload.js).
// Wrapped in a function so nothing here collides with the hb global.
// The window always shows one next step: install the plugins, or (when done) how to use them.
(() => {
  const api = window.hb;
  const $ = (id) => document.getElementById(id);
  const ADOBE = ['ae', 'ai', 'ps'];
  const ICON = { ae: 'Ae', ai: 'Ai', ps: 'Ps', figma: 'Fg' };
  const ICON_CLASS = { ae: 'ae', ai: 'ai', ps: 'ps', figma: 'fg' };
  const WHERE = { ae: 'Window → Extensions → Ascend', ai: 'Window → Extensions → Ascend', ps: 'Plugins → Ascend', figma: 'Plugins → Development → Ascend' };
  let state = null;
  let busy = null; // Set of app ids being installed
  let toastTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  }
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  const listNames = (apps) => {
    const n = apps.map((a) => a.name);
    return n.length < 2 ? n.join('') : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
  };

  // ---------------------------------------------------------------- loading screen
  const CAPTIONS = ['Starting up', 'Starting the relay', 'Looking for Adobe apps', 'Almost there'];
  let capIdx = 0;
  const capTimer = setInterval(() => {
    capIdx = Math.min(capIdx + 1, CAPTIONS.length - 1);
    $('splashCap').textContent = CAPTIONS[capIdx];
  }, 600);
  const shownAt = Date.now();
  let splashGone = false;
  function hideSplash() {
    if (splashGone) return;
    splashGone = true;
    const wait = Math.max(0, 1700 - (Date.now() - shownAt)); // let the logo finish drawing
    setTimeout(() => {
      clearInterval(capTimer);
      $('splash').classList.add('done');
      document.body.classList.add('ready');
      setTimeout(() => $('splash').remove(), 700);
    }, wait);
  }

  // ---------------------------------------------------------------- render
  const present = () => state.apps.filter((a) => ADOBE.includes(a.id) && a.status !== 'not-found');
  const todo = () => present().filter((a) => a.status === 'missing' || a.status === 'outdated');

  function renderTop() {
    const r = state.relay;
    const live = $('live');
    live.className = 'live k ' + (r.running ? 'on' : 'off');
    $('liveText').textContent = r.running ? '' : 'Offline';
    live.title = r.running ? 'Plugins connect on localhost:' + r.port : r.error || '';

    const cta = $('cta');
    const need = todo();
    if (!r.running) {
      $('step').textContent = 'Something went wrong';
      $('title').textContent = 'Ascend stopped.';
      $('lead').textContent = (r.error || 'The connection to your plugins stopped.') + ' Quit Ascend and open it again.';
      cta.hidden = true;
    } else if (!present().length) {
      $('step').textContent = 'Nothing to install';
      $('title').textContent = 'No Adobe apps found.';
      $('lead').textContent = 'Install After Effects, then open Ascend again. Figma works on its own (below).';
      cta.hidden = true;
    } else if (need.length || busy) {
      const updating = need.every((a) => a.status === 'outdated');
      $('step').textContent = 'Step 1 of 2';
      $('title').textContent = updating ? 'Update your plugins' : 'Install your plugins';
      $('lead').innerHTML = `Adds Ascend to <b>${esc(listNames(need.length ? need : present()))}</b>. One click does them all.`;
      cta.hidden = false;
      cta.disabled = !!busy;
      $('ctaText').innerHTML = busy ? '<span class="dots">Installing</span>' : `${updating ? 'Update' : 'Install'} ${need.length === 1 ? need[0].name : need.length + ' plugins'}`;
    } else {
      $('step').textContent = 'Step 2 of 2 · All set';
      $('title').textContent = 'You’re all set.';
      $('lead').innerHTML = 'Send from <b>Illustrator</b>, <b>Photoshop</b> or <b>Figma</b>, then click Pull in <b>After Effects</b>.';
      cta.hidden = true;
    }
  }

  function line(a) {
    if (busy && busy.has(a.id)) return '<span class="dots">Installing</span>';
    if (a.status === 'installed') return esc(WHERE[a.id] || 'Installed');
    if (a.status === 'outdated') return 'Update available';
    if (a.status === 'manual') return 'Import once inside Figma';
    return 'Not installed yet';
  }

  function renderApps() {
    const box = $('apps');
    box.innerHTML = '';
    const rows = present().concat(state.apps.filter((a) => a.id === 'figma'));
    for (const a of rows) {
      const row = document.createElement('div');
      row.className = 'app ' + a.status;
      let right = '';
      if (a.status === 'installed') right = '<svg class="i tick"><use href="#i-tick"/></svg>';
      else if (a.id === 'figma') right = `<button class="go" data-id="figma"${busy ? ' disabled' : ''}>Set up</button>`;
      row.innerHTML = `<div class="ico ${ICON_CLASS[a.id] || ''}">${esc(ICON[a.id] || a.badge)}</div>
        <div class="t"><b>${esc(a.name)}</b><small>${line(a)}</small></div>${right}`;
      box.appendChild(row);
    }
    box.querySelectorAll('button[data-id]').forEach((b) => b.addEventListener('click', () => setupFigma(b)));
    const absent = state.apps.filter((a) => ADOBE.includes(a.id) && a.status === 'not-found');
    $('missing').hidden = !absent.length;
    $('missing').textContent = absent.length ? 'Not on this computer: ' + absent.map((a) => a.name).join(', ') : '';
  }

  function renderLast() {
    const l = state.last;
    const el = $('lastRow');
    if (!l) { el.textContent = ''; return; }
    el.innerHTML = l.type === 'pull'
      ? `Last: <em>${esc(l.name)}</em> pulled into After Effects · ${ago(l.at)}`
      : `Last: <em>${esc(l.name)}</em> sent from ${esc(l.source || 'a design app')} · ${ago(l.at)}`;
  }

  function renderLogin() {
    $('login').classList.toggle('on', state.openAtLogin);
    $('login').setAttribute('aria-checked', String(!!state.openAtLogin));
    $('welcome').hidden = !state.firstRun;
  }

  function render() {
    renderTop();
    renderApps();
    renderLast();
    renderLogin();
  }

  async function refresh() {
    try {
      state = await api.state();
    } catch (e) {
      clearInterval(capTimer);
      $('splashCap').textContent = 'Could not start. Restart Ascend.';
      return;
    }
    render();
    hideSplash();
  }

  // ---------------------------------------------------------------- actions
  function toast(text, ok) {
    const t = $('toast');
    t.classList.toggle('err', !ok);
    $('toastText').textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 8000);
  }

  async function installAll() {
    const need = todo();
    if (!need.length || busy) return;
    busy = new Set(need.map((a) => a.id));
    render();
    const failed = [];
    for (const a of need) {
      let res;
      try {
        res = await api.install(a.id);
      } catch (e) {
        res = { ok: false, note: e.message };
      }
      if (!res || res.ok === false) failed.push(a.name + ': ' + ((res && res.note) || 'could not install.'));
      busy.delete(a.id);
      await refresh();
    }
    busy = null;
    render();
    if (failed.length) toast(failed.join(' '), false);
    else toast(`Done. Restart ${listNames(need)} to see Ascend.`, true);
  }

  async function setupFigma(btn) {
    btn.disabled = true;
    let res;
    try {
      res = await api.install('figma');
    } catch (e) {
      res = { ok: false, note: e.message };
    }
    if (res && res.note) toast(res.note, res.ok !== false);
    await refresh();
  }

  async function setLogin(on) {
    state.openAtLogin = await api.setLogin(on);
    state.firstRun = false;
    renderLogin();
  }

  $('cta').onclick = installAll;
  $('wYes').onclick = () => setLogin(true);
  $('wNo').onclick = () => setLogin(false);
  $('login').onclick = () => setLogin(!state.openAtLogin);
  $('toastX').onclick = () => $('toast').classList.remove('show');
  $('min').onclick = () => api.window('minimize');
  $('close').onclick = () => api.window('hide');
  $('quit').onclick = () => api.window('quit');

  api.onEvent((ev) => {
    if (!state) return;
    state.last = ev;
    renderLast();
    const el = $('lastRow');
    el.classList.remove('new');
    void el.offsetWidth; // restart the highlight
    el.classList.add('new');
  });
  setInterval(() => state && renderLast(), 30000);
  window.addEventListener('focus', () => splashGone && !busy && refresh());
  refresh();
})();
