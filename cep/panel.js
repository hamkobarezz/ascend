// Ascend CEP panel (After Effects + Illustrator). One file, two modes picked by the host app.
//   After Effects: shows what's waiting in the Ascend app and pulls it in (host/ae.jsx builds the layers).
//   Illustrator:   exports the artboard (host/ai.jsx) and sends it to the Ascend app.
// The panel does the networking (fetch to the local app) and file writing (CEP's Node.js), so the
// host scripts never need AE's "Allow Scripts to Write Files and Access Network" setting.
(() => {
  // The Ascend app listens on the first free port from 7777 to 7781; remember the one that answers.
  const PORTS = [7777, 7778, 7779, 7780, 7781];
  let appBase = null;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
  async function findApp() {
    const tries = [appBase].concat(PORTS.map((p) => 'http://127.0.0.1:' + p)).filter((u, i, a) => u && a.indexOf(u) === i);
    for (const base of tries) {
      try {
        const s = await withTimeout(fetch(base + '/status', { cache: 'no-store' }).then((r) => r.json()), 1500);
        if (s && s.app === 'hb-bridge') {
          appBase = base;
          return { base, status: s };
        }
      } catch (e) {}
    }
    appBase = null;
    throw new Error("Ascend isn't running");
  }
  const VERSION = '0.3.0';
  const $ = (id) => document.getElementById(id);
  const cep = window.__adobe_cep__;
  const nodeRequire = typeof require === 'function' ? require : window.cep_node && window.cep_node.require;
  const fs = nodeRequire('fs');
  const path = nodeRequire('path');
  const os = nodeRequire('os');

  const host = (() => {
    try { return JSON.parse(cep.getHostEnvironment()).appName; } catch (e) { return 'AEFT'; }
  })();
  const IS_AE = host === 'AEFT';

  // ---------------------------------------------------------------- helpers
  function evalHost(fn, ...args) {
    const call = `${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`;
    return new Promise((resolve) => {
      cep.evalScript(call, (out) => {
        try { resolve(JSON.parse(out)); } catch (e) { resolve({ ok: false, error: out === 'EvalScript error.' ? 'Ascend’s script didn’t load. Restart the app.' : String(out) }); }
      });
    });
  }
  async function app(pathname, opts) {
    const { base } = await findApp();
    const res = await fetch(base + pathname, opts);
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch (e) {}
    if (!res.ok) throw new Error((json && json.error) || 'Ascend answered ' + res.status);
    return { json, body };
  }
  const OFFLINE = 'Ascend isn’t running. Open the Ascend app, then try again.';
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const SOURCE = { illustrator: ['ai', 'Ai'], photoshop: ['ps', 'Ps'], figma: ['fg', 'Fg'] };

  let toastTimer = null;
  function toast(text, ok) {
    const t = $('toast');
    t.hidden = false;
    t.classList.toggle('err', !ok);
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
    $('toastText').textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ok ? 7000 : 12000);
  }
  $('toastX').onclick = () => ($('toast').hidden = true);

  function switchOpt(el, onChange) {
    el.onclick = () => {
      if (el.disabled) return;
      el.classList.toggle('on');
      el.setAttribute('aria-checked', String(el.classList.contains('on')));
      if (onChange) onChange();
    };
  }
  const isOn = (id) => $(id).classList.contains('on') && !$(id).disabled;

  let online = null;
  let relay = null;
  function setLive(ok) {
    online = ok;
    $('live').className = 'live k ' + (ok ? 'on' : 'off');
    $('liveText').textContent = ok ? 'Live' : 'Open Ascend';
    $('live').title = ok ? 'Connected to the Ascend app' : OFFLINE;
  }
  async function pollRelay() {
    try {
      relay = (await app('/status')).json;
      setLive(true);
    } catch (e) {
      relay = null;
      setLive(false);
    }
  }

  $('ver').textContent = 'v' + VERSION;

  // ---------------------------------------------------------------- After Effects
  let pulling = false;

  function renderAE() {
    const card = $('aeCard'), ico = $('aeIco');
    const has = !!(relay && relay.has);
    card.classList.toggle('empty', !has);
    if (!online) {
      $('aeStep').textContent = 'Not connected';
      $('aeStep').className = 'step quiet';
      ico.className = 'ico none'; ico.textContent = '—';
      $('aeName').textContent = 'Open the Ascend app';
      $('aeMeta').textContent = 'It connects this panel to your design apps';
    } else if (!has) {
      $('aeStep').textContent = 'Nothing waiting';
      $('aeStep').className = 'step quiet';
      ico.className = 'ico none'; ico.textContent = '—';
      $('aeName').textContent = 'Send something first';
      $('aeMeta').textContent = 'From Illustrator, Photoshop or Figma';
    } else {
      const [cls, label] = SOURCE[String(relay.source || '').toLowerCase()] || ['none', '?'];
      $('aeStep').textContent = 'Waiting in Ascend';
      $('aeStep').className = 'step';
      ico.className = 'ico ' + cls; ico.textContent = label;
      $('aeName').textContent = relay.name || 'Untitled';
      const what = relay.kind === 'comps' ? plural(relay.comps, 'comp') : plural(relay.layers, 'layer');
      $('aeMeta').textContent = `${relay.source} · ${what}${relay.at ? ' · ' + ago(relay.at) : ''}`;
    }
    const pull = $('pull');
    if (!pulling) {
      pull.disabled = !has;
      $('pullText').textContent = has && relay.kind === 'comps' ? `Make ${plural(relay.comps, 'comp')}` : 'Pull into After Effects';
    }
    $('hint').textContent = has ? 'Ready to pull' : 'Ascend';
  }

  async function refreshAEInfo() {
    const info = await evalHost('AscendAE.info');
    if (!info.ok) return;
    const opt = $('optActive');
    opt.disabled = !info.comp;
    $('optActiveSub').textContent = info.comp ? 'Builds into “' + info.comp + '”' : 'No comp open, makes a new one';
  }

  async function pull() {
    if (pulling) return;
    pulling = true;
    const btn = $('pull');
    btn.disabled = true;
    btn.classList.add('busy');
    $('pullText').innerHTML = '<span class="dots">Pulling</span>';
    try {
      const st = (await app('/status').catch(() => { throw new Error(OFFLINE); })).json;
      if (!st.has) throw new Error('Nothing waiting. Send from Illustrator, Photoshop or Figma first.');
      let dir = '';
      if (st.images > 0) {
        const r = await evalHost('AscendAE.assetDir');
        if (!r.ok) throw new Error(r.error);
        dir = r.dir;
        fs.mkdirSync(dir, { recursive: true });
      }
      const { body } = await app('/pull' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
      const file = path.join(os.tmpdir(), 'ascend-pull.json');
      fs.writeFileSync(file, body, 'utf8');
      $('pullText').innerHTML = '<span class="dots">Building</span>';
      const res = await evalHost('AscendAE.buildFile', file, dir, isOn('optActive'), isOn('optGroups'));
      if (!res.ok) throw new Error(res.error);
      if (res.kind === 'comps') {
        toast(`Made ${plural(res.comps.length, 'comp')}: ${res.comps.join(', ')}`, true);
      } else {
        const notes = (res.errors || []).concat(res.warnings || []);
        toast(`Built ${plural(res.count, 'layer')} in “${res.comp}”.` + (notes.length ? ` ${plural(notes.length, 'note')}: ${notes.slice(0, 3).join(' · ')}` : ''), !(res.errors && res.errors.length));
      }
    } catch (e) {
      toast(e.message || String(e), false);
    } finally {
      pulling = false;
      btn.classList.remove('busy');
      await pollRelay();
      renderAE();
    }
  }

  // ---------------------------------------------------------------- Illustrator
  let sending = false;
  let doc = null;
  let scale = 2;

  function renderAI() {
    const has = !!(doc && doc.doc);
    $('aiCard').classList.toggle('empty', !has);
    if (!has) {
      $('aiStep').textContent = 'No document';
      $('aiStep').className = 'step quiet';
      $('aiName').textContent = 'Open a document';
      $('aiMeta').textContent = 'Ascend sends the active artboard';
    } else {
      const sel = doc.selection;
      $('aiStep').textContent = online ? 'Ready to send' : 'Not connected';
      $('aiStep').className = online ? 'step' : 'step quiet';
      $('aiName').textContent = doc.artboard;
      $('aiMeta').textContent = `${doc.width}×${doc.height} · ${sel ? plural(sel, 'object') + ' selected' : 'whole artboard'}`;
    }
    const optSel = $('optSel');
    optSel.disabled = !(has && doc.selection);
    $('optSelSub').textContent = has && doc.selection ? `Only the ${plural(doc.selection, 'selected object')}` : 'Select something first';
    if (!sending) {
      $('send').disabled = !has || !online;
      $('comps').disabled = !has || !online;
      $('comps').textContent = has && doc.artboards > 1 ? `Make ${doc.artboards} comps (one per artboard)` : 'Make comp from artboard';
    }
    $('hint').textContent = online ? (has ? doc.name : 'Ascend') : 'Open the Ascend app';
  }

  async function refreshAIInfo() {
    const info = await evalHost('AscendAI.info');
    if (info.ok) doc = info;
  }

  async function send(kind) {
    if (sending) return;
    sending = true;
    const btn = kind === 'comps' ? $('comps') : $('send');
    $('send').disabled = $('comps').disabled = true;
    btn.classList.add('busy');
    const label = kind === 'comps' ? btn.textContent : null;
    if (kind === 'comps') btn.innerHTML = '<span class="dots">Sending</span>';
    else $('sendText').innerHTML = '<span class="dots">Exporting</span>';
    try {
      await app('/status').catch(() => { throw new Error(OFFLINE); });
      const res = kind === 'comps'
        ? await evalHost('AscendAI.comps')
        : await evalHost('AscendAI.exportLayers', scale, isOn('optSel'), isOn('optFlat'));
      if (!res.ok) throw new Error(res.error);
      if (kind !== 'comps') $('sendText').innerHTML = '<span class="dots">Sending</span>';
      const body = fs.readFileSync(res.file, 'utf8');
      await app('/push', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
      if (kind === 'comps') toast(`Sent ${plural(res.comps.length, 'comp')}. Click Pull in After Effects.`, true);
      else toast(`Sent ${plural(res.layers, 'layer')} (${res.width}×${res.height}). Click Pull in After Effects.` + (res.warnings && res.warnings.length ? ` ${plural(res.warnings.length, 'note')}: ${res.warnings.slice(0, 2).join(' · ')}` : ''), true);
    } catch (e) {
      toast(e.message || String(e), false);
    } finally {
      sending = false;
      btn.classList.remove('busy');
      if (label) btn.textContent = label;
      $('sendText').textContent = 'Send to After Effects';
      await pollRelay();
      await refreshAIInfo();
      renderAI();
    }
  }

  // ---------------------------------------------------------------- start
  async function tick() {
    await pollRelay();
    if (IS_AE) {
      await refreshAEInfo();
      renderAE();
    } else {
      if (!sending) await refreshAIInfo();
      renderAI();
    }
  }

  if (IS_AE) {
    $('ae').hidden = false;
    $('pull').onclick = pull;
    switchOpt($('optActive'));
    switchOpt($('optGroups'));
  } else {
    $('ai').hidden = false;
    $('send').onclick = () => send('layers');
    $('comps').onclick = () => send('comps');
    switchOpt($('optSel'));
    switchOpt($('optFlat'));
    $('scale').querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        scale = +b.dataset.v;
        $('scale').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
  }
  tick();
  setInterval(() => !pulling && !sending && tick(), 2000);
  window.addEventListener('focus', () => !pulling && !sending && tick());
})();
