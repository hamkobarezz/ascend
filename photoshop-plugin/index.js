// Ascend — Photoshop UXP panel.
// Reads the document's layers through the Photoshop DOM + batchPlay and sends an "hb-bridge"
// payload to the local relay. Shape layers become AE shape layers (parametric rect/ellipse when
// possible), text stays live text, groups become nulls, clipping masks become track mattes,
// and everything else is exported as a trimmed PNG.

// The Ascend app listens on the first free port from 7777 to 7781; remember the one that answers.
const PORTS = [7777, 7778, 7779, 7780, 7781];
let appBase = null;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
async function findApp() {
  const tries = [appBase].concat(PORTS.map((p) => 'http://localhost:' + p)).filter((u, i, a) => u && a.indexOf(u) === i);
  for (const base of tries) {
    try {
      const s = await withTimeout(fetch(base + '/status').then((r) => r.json()), 1500);
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

let ps = null;
let uxp = null;
try {
  ps = require('photoshop');
  uxp = require('uxp');
} catch (e) {
  /* loaded outside Photoshop (unit tests) */
}

// ---------------------------------------------------------------- pure helpers (unit-tested)

function round(v) {
  return Math.round(v * 1000) / 1000;
}

// Photoshop unit values -> pixels. `res` is the document resolution (ppi).
function px(v, res) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const val = Number(v._value) || 0;
  switch (v._unit) {
    case 'pixelsUnit':
      return val;
    case 'pointsUnit':
    case 'distanceUnit':
      return (val * res) / 72;
    case 'millimetersUnit':
      return (val * res) / 25.4;
    default:
      return val;
  }
}

function color(c) {
  if (!c || typeof c !== 'object') return null;
  if ('red' in c) {
    const g = 'grain' in c ? c.grain : c.green; // Photoshop calls green "grain"
    return { r: round(c.red / 255), g: round(g / 255), b: round(c.blue / 255) };
  }
  if ('brightness' in c) {
    const h = ((px(c.hue, 72) % 360) + 360) % 360 / 60;
    const s = c.saturation / 100, v = c.brightness / 100;
    const i = Math.floor(h), f = h - i, p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    const m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return { r: round(m[0]), g: round(m[1]), b: round(m[2]) };
  }
  if ('gray' in c) {
    const g = 1 - c.gray / 100;
    return { r: round(g), g: round(g), b: round(g) };
  }
  if ('cyan' in c) {
    const k = c.black / 100;
    return {
      r: round((1 - c.cyan / 100) * (1 - k)),
      g: round((1 - c.magenta / 100) * (1 - k)),
      b: round((1 - c.yellowColor / 100) * (1 - k)),
    };
  }
  return null;
}

// Photoshop sometimes reports path coordinates in points rather than pixels. Pick whichever
// scale makes the path's box match the layer's pixel bounds.
function calibrate(rawBox, bounds, res) {
  const bw = bounds.right - bounds.left, bh = bounds.bottom - bounds.top;
  let best = 1, err = Infinity;
  for (const f of [1, res / 72, 72 / res]) {
    const e = Math.abs(rawBox.w * f - bw) + Math.abs(rawBox.h * f - bh);
    if (e < err - 1e-9) { err = e; best = f; }
  }
  return best;
}

// pathComponents (already converted to px) -> AE paths relative to the box center.
function toAEPaths(subpaths, scale) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of subpaths) for (const p of sp.pts) {
    x0 = Math.min(x0, p.ax * scale); x1 = Math.max(x1, p.ax * scale);
    y0 = Math.min(y0, p.ay * scale); y1 = Math.max(y1, p.ay * scale);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const paths = subpaths.map((sp) => ({
    v: sp.pts.map((p) => [round(p.ax * scale - cx), round(p.ay * scale - cy)]),
    i: sp.pts.map((p) => [round((p.bx - p.ax) * scale), round((p.by - p.ay) * scale)]),
    o: sp.pts.map((p) => [round((p.fx - p.ax) * scale), round((p.fy - p.ay) * scale)]),
    c: sp.closed,
  }));
  return { paths, x: round(cx), y: round(cy), w: round(x1 - x0), h: round(y1 - y0) };
}

function rawBox(subpaths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of subpaths) for (const p of sp.pts) {
    x0 = Math.min(x0, p.ax); x1 = Math.max(x1, p.ax);
    y0 = Math.min(y0, p.ay); y1 = Math.max(y1, p.ay);
  }
  return { w: x1 - x0, h: y1 - y0 };
}

function blendName(mode) {
  const v = mode && mode._value;
  if (!v || v === 'normal' || v === 'passThrough') return undefined;
  return v.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(); // softLight -> SOFT_LIGHT
}

function toBase64(u8) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out = [];
  let chunk = '';
  const len = u8.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    chunk += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
    if (chunk.length > 32768) { out.push(chunk); chunk = ''; }
  }
  if (len - i === 1) {
    const n = u8[i] << 16;
    chunk += A[(n >> 18) & 63] + A[(n >> 12) & 63] + '==';
  } else if (len - i === 2) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8);
    chunk += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + '=';
  }
  out.push(chunk);
  return out.join('');
}

function toAsciiJSON(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (ch) => '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4));
}

function safeName(s) {
  return String(s || 'layer').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'layer';
}

if (typeof module !== 'undefined' && module.exports && !ps) {
  module.exports = { px, color, calibrate, toAEPaths, rawBox, blendName, toBase64, toAsciiJSON };
}

// ---------------------------------------------------------------- Photoshop access

async function batch(cmds) {
  return ps.action.batchPlay(cmds, {});
}

async function layerDesc(doc, id) {
  const [d] = await batch([
    { _obj: 'get', _target: [{ _ref: 'layer', _id: id }, { _ref: 'document', _id: doc.id }], _options: { dialogOptions: 'dontDisplay' } },
  ]);
  return d && d._obj !== 'error' ? d : null;
}

async function vectorMask(doc, id) {
  try {
    const [p] = await batch([
      {
        _obj: 'get',
        _target: [{ _ref: 'path', _enum: 'path', _value: 'vectorMask' }, { _ref: 'layer', _id: id }, { _ref: 'document', _id: doc.id }],
        _options: { dialogOptions: 'dontDisplay' },
      },
    ]);
    return p && p._obj !== 'error' && p.pathContents ? p.pathContents : null;
  } catch (e) {
    return null;
  }
}

function hasEffects(d) {
  if (!d.layerEffects || d.layerFXVisible === false) return false;
  return Object.keys(d.layerEffects).some((k) => {
    const v = d.layerEffects[k];
    if (Array.isArray(v)) return v.some((e) => e && e.enabled !== false);
    return v && typeof v === 'object' && v._obj && v.enabled !== false;
  });
}

function boundsOf(layer) {
  const b = layer.boundsNoEffects || layer.bounds;
  return { left: Number(b.left), top: Number(b.top), right: Number(b.right), bottom: Number(b.bottom) };
}

// ---------------------------------------------------------------- artboards

async function listArtboards(doc) {
  const list = [];
  for (const l of doc.layers) {
    const d = await layerDesc(doc, l.id);
    const r = d && d.artboardEnabled && d.artboard && d.artboard.artboardRect;
    if (!r) continue;
    const left = px(r.left, 72), top = px(r.top, 72);
    list.push({ layer: l, name: l.name, left, top, width: px(r.right, 72) - left, height: px(r.bottom, 72) - top });
  }
  return list;
}

function topLevel(layer) {
  let l = layer;
  while (l && l.parent && l.parent.typename !== 'Document' && l.parent.layers) l = l.parent;
  return l;
}

// The artboard holding the current selection, else the first one.
function activeArtboard(doc, boards) {
  const sel = doc.activeLayers || [];
  for (const s of sel) {
    const top = topLevel(s);
    const hit = boards.find((b) => top && b.layer.id === top.id);
    if (hit) return hit;
  }
  return boards[0];
}

async function compsPayload() {
  const doc = ps.app.activeDocument;
  if (!doc) throw new Error('Open a document first.');
  const boards = await listArtboards(doc);
  const title = doc.title.replace(/\.[^.]+$/, '');
  const comps = boards.length
    ? boards.map((b) => ({ name: b.name, width: Math.round(b.width), height: Math.round(b.height) }))
    : [{ name: title, width: Math.round(doc.width), height: Math.round(doc.height) }];
  return { format: 'hb-bridge', version: 2, kind: 'comps', source: 'Photoshop', name: title, comps, layers: [] };
}

// ---------------------------------------------------------------- export

async function exportDocument(opts) {
  const doc = ps.app.activeDocument;
  if (!doc) throw new Error('Open a document first.');
  const ctx = {
    doc,
    opts,
    res: doc.resolution || 72,
    W: doc.width, // comp size (canvas, or the active artboard)
    H: doc.height,
    docW: doc.width,
    docH: doc.height,
    ox: 0, // artboard offset inside the canvas
    oy: 0,
    clip: { left: 0, top: 0, right: doc.width, bottom: doc.height },
    layers: [],
    groups: [],
    warnings: [],
    seq: 0,
  };
  let name = doc.title.replace(/\.[^.]+$/, '');

  await ps.core.executeAsModal(
    async () => {
      let roots = doc.layers;
      const boards = await listArtboards(doc);
      if (boards.length) {
        const ab = activeArtboard(doc, boards);
        Object.assign(ctx, { W: ab.width, H: ab.height, ox: ab.left, oy: ab.top });
        ctx.clip = { left: ab.left, top: ab.top, right: ab.left + ab.width, bottom: ab.top + ab.height };
        ctx.docW = Math.max(ctx.docW, ctx.clip.right);
        ctx.docH = Math.max(ctx.docH, ctx.clip.bottom);
        roots = ab.layer.layers || [];
        name = ab.name;
      }
      if (opts.selectedOnly) {
        const sel = doc.activeLayers.filter((l) => !boards.some((b) => b.layer.id === l.id));
        if (!sel.length) throw new Error('Select some layers, or turn off "Selected layers only".');
        const withIndex = [];
        for (const l of sel) {
          const d = await layerDesc(doc, l.id);
          withIndex.push({ l, i: d && d.itemIndex ? d.itemIndex : 0 });
        }
        roots = withIndex.sort((a, b) => b.i - a.i).map((x) => x.l); // top first, like doc.layers
      }
      await walk(roots, ctx, 1, {});
      ps.app.activeDocument = doc;
    },
    { commandName: 'Ascend: export layers' }
  );

  return {
    format: 'hb-bridge',
    version: 2,
    source: 'Photoshop',
    name,
    width: Math.round(ctx.W),
    height: Math.round(ctx.H),
    scale: 1,
    layers: ctx.layers,
    groups: ctx.groups,
    warnings: ctx.warnings,
  };
}

function add(ctx, layer, scope) {
  layer.x = round(layer.x - ctx.ox); // canvas -> artboard coordinates
  layer.y = round(layer.y - ctx.oy);
  if (scope.parent !== undefined) layer.parent = scope.parent;
  if (scope.matte !== undefined) layer.matte = scope.matte;
  ctx.layers.push(layer);
}

// `layers` is top-first (Photoshop order); AE wants bottom-first.
async function walk(layers, ctx, parentOp, scope) {
  let base = null; // the layer that clipped layers above it are clipped to
  for (const layer of layers.slice().reverse()) {
    const d = await layerDesc(ctx.doc, layer.id);
    if (!d) continue;
    const clipped = !!d.group;
    if (d.visible === false) {
      if (!clipped) base = { hidden: true };
      continue;
    }
    let my = scope;
    if (clipped) {
      if (!base || base.hidden) continue; // hidden base hides its clipped layers in Photoshop too
      if (base.id !== undefined) my = Object.assign({}, scope, { matte: base.id });
      else ctx.warnings.push(`"${layer.name}": clipped to a group; the clipping is not kept.`);
    }
    const before = ctx.layers.length;
    try {
      await emit(layer, d, ctx, parentOp, my);
    } catch (e) {
      ctx.warnings.push(`"${layer.name}": ${e.message}`);
    }
    if (!clipped) {
      const n = ctx.layers.length - before;
      base = n === 1 ? { id: ctx.layers[before].id } : {};
    }
  }
}

async function emit(layer, d, ctx, parentOp, scope) {
  const opacity = (d.opacity == null ? 255 : d.opacity) / 255;
  const fillOp = (d.fillOpacity == null ? 255 : d.fillOpacity) / 255;
  const op = parentOp * opacity;
  const isGroup = layer.kind === 'group' || (d.layerSection && d.layerSection._value === 'layerSectionStart');
  const fx = hasEffects(d);

  if (ctx.opts.rasterizeAll) return raster(layer, ctx, parentOp, d, 'rasterize all', scope);
  if (fx && ctx.opts.effects === 'raster') return raster(layer, ctx, parentOp, d, 'layer style', scope);
  if (fx) ctx.warnings.push(`"${layer.name}": layer style not transferred (Keep live).`);
  if (d.hasUserMask || d.hasFilterMask) return raster(layer, ctx, parentOp, d, 'layer mask', scope);

  if (isGroup) {
    const mode = d.mode && d.mode._value;
    if (mode && mode !== 'passThrough' && mode !== 'normal') return raster(layer, ctx, parentOp, d, 'group blend mode', scope);
    const b = boundsOf(layer);
    const id = 'g' + layer.id;
    ctx.groups.push({ id, name: layer.name, x: round((b.left + b.right) / 2 - ctx.ox), y: round((b.top + b.bottom) / 2 - ctx.oy), parent: scope.parent });
    return walk(layer.layers || [], ctx, op, { parent: id, matte: scope.matte });
  }

  if (d.textKey) return text(layer, d, ctx, parentOp, op * fillOp, scope);

  const adj = d.adjustment && d.adjustment[0];
  if (adj && adj._obj === 'solidColorLayer') return shape(layer, d, adj, ctx, parentOp, op, fillOp, scope);
  if (adj && (adj._obj === 'gradientLayer' || adj._obj === 'patternLayer')) {
    return raster(layer, ctx, parentOp, d, adj._obj === 'gradientLayer' ? 'gradient fill' : 'pattern fill', scope);
  }
  if (adj) {
    ctx.warnings.push(`"${layer.name}": adjustment layers aren't transferred.`);
    return;
  }
  return raster(layer, ctx, parentOp, d, d.smartObject ? 'smart object' : 'pixel layer', scope);
}

async function shape(layer, d, adj, ctx, parentOp, op, fillOp, scope) {
  const st = d.AGMStrokeStyleInfo || {};
  const pc = await vectorMask(ctx.doc, layer.id);
  const base = {
    type: 'shape',
    id: 'p' + layer.id,
    name: layer.name,
    opacity: round(Math.min(1, op) * 100),
    blend: blendName(d.mode),
    rotation: 0,
  };

  let geom, x, y, w, h;
  if (!pc || !pc.pathComponents || !pc.pathComponents.length) {
    // A color fill layer without a vector mask covers the whole canvas.
    w = ctx.W; h = ctx.H; x = ctx.ox + w / 2; y = ctx.oy + h / 2;
    geom = { kind: 'rect', w, h, radius: 0 };
  } else {
    const comps = pc.pathComponents;
    const opsUsed = comps.map((c) => (c.shapeOperation && c.shapeOperation._value) || 'add');
    if (opsUsed.slice(1).some((o) => o === 'interfaceIconFrameDimmed' || o === 'intersect')) {
      return raster(layer, ctx, parentOp, d, 'intersected shapes', scope);
    }
    const subpaths = [];
    for (const comp of comps) {
      for (const sp of comp.subpathListKey || []) {
        const pts = (sp.points || []).map((p) => {
          const ax = px(p.anchor.horizontal, ctx.res), ay = px(p.anchor.vertical, ctx.res);
          return {
            ax, ay,
            fx: p.forward ? px(p.forward.horizontal, ctx.res) : ax,
            fy: p.forward ? px(p.forward.vertical, ctx.res) : ay,
            bx: p.backward ? px(p.backward.horizontal, ctx.res) : ax,
            by: p.backward ? px(p.backward.vertical, ctx.res) : ay,
          };
        });
        if (pts.length) subpaths.push({ pts, closed: !!sp.closedSubpath });
      }
    }
    if (!subpaths.length) return raster(layer, ctx, parentOp, d, 'empty path', scope);
    const scale = calibrate(rawBox(subpaths), boundsOf(layer), ctx.res);
    const conv = toAEPaths(subpaths, scale);
    ({ x, y, w, h } = conv);
    geom = { kind: 'path', detect: true, evenOdd: opsUsed.some((o) => o === 'subtract' || o === 'xor'), paths: conv.paths };
  }

  const fills = [];
  if (st.fillEnabled !== false) {
    const c = color(adj.color);
    if (c) fills.push(Object.assign(c, { a: round(fillOp) }));
  }
  let stroke = null;
  if (st.strokeEnabled) {
    const content = st.strokeStyleContent || {};
    if (content._obj && content._obj !== 'solidColorLayer') return raster(layer, ctx, parentOp, d, 'gradient stroke', scope);
    const c = color(content.color);
    const width = px(st.strokeStyleLineWidth, ctx.res);
    if (c && width > 0) {
      const align = { strokeStyleAlignInside: 'INSIDE', strokeStyleAlignOutside: 'OUTSIDE' }[st.strokeStyleLineAlignment && st.strokeStyleLineAlignment._value] || 'CENTER';
      const cap = { strokeStyleRoundCap: 'ROUND', strokeStyleSquareCap: 'SQUARE' }[st.strokeStyleLineCapType && st.strokeStyleLineCapType._value] || 'NONE';
      const join = { strokeStyleRoundJoin: 'ROUND', strokeStyleBevelJoin: 'BEVEL' }[st.strokeStyleLineJoinType && st.strokeStyleLineJoinType._value] || 'MITER';
      const sop = st.strokeStyleOpacity ? px(st.strokeStyleOpacity, ctx.res) / 100 : 1;
      stroke = Object.assign(c, { a: round(sop * fillOp), width: round(width), align, cap, join });
      // Photoshop stores dash and gap lengths as multiples of the stroke width.
      const dashSet = st.strokeStyleLineDashSet;
      if (Array.isArray(dashSet) && dashSet.length) {
        const unit = (v) => round((typeof v === 'number' ? v : (v && v._value) || 0) * width);
        stroke.dashes = dashSet.map(unit);
        if (st.strokeStyleLineDashOffset) stroke.dashOffset = unit(st.strokeStyleLineDashOffset);
      }
    }
  }
  if (!fills.length && !stroke) return;
  add(ctx, Object.assign(base, { x, y, w, h, geom, fills, strokes: stroke ? [stroke] : [], stroke }), scope);
}

async function text(layer, d, ctx, parentOp, contentOp, scope) {
  const tk = d.textKey;
  const shapeKind = tk.textShape && tk.textShape[0] && tk.textShape[0].char && tk.textShape[0].char._value;
  if (shapeKind && shapeKind !== 'paint' && shapeKind !== 'box') return raster(layer, ctx, parentOp, d, 'type on a path', scope);

  const tf = tk.transform || { xx: 1, xy: 0, yx: 0, yy: 1 };
  const sx = Math.hypot(tf.xx, tf.xy) || 1;
  const sy = Math.hypot(tf.yx, tf.yy) || 1;
  const rotation = round((Math.atan2(tf.xy, tf.xx) * 180) / Math.PI);
  const ranges = tk.textStyleRange && tk.textStyleRange.length ? tk.textStyleRange : [{ from: 0, to: tk.textKey.length, textStyle: {} }];
  const first = ranges[0].textStyle || {};

  const sizeOf = (s) => {
    if (s.impliedFontSize) return px(s.impliedFontSize, ctx.res);
    if (s.size) return px(s.size, ctx.res) * sy;
    return first.impliedFontSize ? px(first.impliedFontSize, ctx.res) : 12;
  };
  const segments = ranges.map((r) => {
    const s = r.textStyle || {};
    const c = color(s.color) || color(first.color) || { r: 0, g: 0, b: 0 };
    return {
      start: r.from,
      end: r.to,
      ps: s.fontPostScriptName || first.fontPostScriptName,
      family: s.fontName || first.fontName,
      style: s.fontStyleName || first.fontStyleName,
      size: round(sizeOf(s)),
      color: [c.r, c.g, c.b],
      tracking: s.tracking || 0,
    };
  });

  let leading = null;
  if (first.autoLeading === false) {
    leading = first.impliedLeading ? px(first.impliedLeading, ctx.res) : px(first.leading, ctx.res) * sy;
  }
  const align = tk.paragraphStyleRange && tk.paragraphStyleRange[0] && tk.paragraphStyleRange[0].paragraphStyle && tk.paragraphStyleRange[0].paragraphStyle.align;
  const alignMap = { left: 'LEFT', center: 'CENTER', right: 'RIGHT' };
  const a = align && align._value;

  const b = boundsOf(layer);
  let w = b.right - b.left, h = b.bottom - b.top;
  const box = shapeKind === 'box';
  if (box && tk.textShape[0].bounds) {
    const tb = tk.textShape[0].bounds;
    const bw = (px(tb.right, ctx.res) - px(tb.left, ctx.res)) * sx;
    const bh = (px(tb.bottom, ctx.res) - px(tb.top, ctx.res)) * sy;
    if (bw > 1) w = Math.max(bw, w);
    if (bh > 1) h = Math.max(bh, h);
  }

  add(
    ctx,
    {
      type: 'text',
      id: 't' + layer.id,
      name: layer.name,
      opacity: round(Math.min(1, contentOp) * 100),
      blend: blendName(d.mode),
      x: round((b.left + b.right) / 2),
      y: round((b.top + b.bottom) / 2),
      rotation,
      w: round(w),
      h: round(h),
      text: {
        chars: tk.textKey,
        mode: box ? 'box' : 'point',
        anchor: 'center', // Photoshop reports the visible text bounds
        align: a ? alignMap[a] || (a.indexOf('justify') === 0 ? 'JUSTIFIED' : 'LEFT') : 'LEFT',
        leading: leading ? round(leading) : null,
        segments,
      },
    },
    scope
  );
}

// Duplicates the layer into a scratch document, trims it and saves a PNG.
async function raster(layer, ctx, parentOp, d, reason, scope) {
  const { app, action } = ps;
  const fs = uxp.storage.localFileSystem;
  const formats = uxp.storage.formats;
  const lb = layer.bounds;
  const b = {
    left: Math.max(ctx.clip.left, Number(lb.left)),
    top: Math.max(ctx.clip.top, Number(lb.top)),
    right: Math.min(ctx.clip.right, Number(lb.right)),
    bottom: Math.min(ctx.clip.bottom, Number(lb.bottom)),
  };
  if (b.right - b.left < 1 || b.bottom - b.top < 1) return;

  const tmp = await app.createDocument({
    width: ctx.docW,
    height: ctx.docH,
    resolution: ctx.res,
    mode: 'RGBColorMode',
    fill: 'transparent',
  });
  let bytes;
  try {
    const dup = await layer.duplicate(tmp);
    if (dup) {
      dup.visible = true;
      if (dup.allLocked) dup.allLocked = false;
    }
    await action.batchPlay(
      [{ _obj: 'trim', trimBasedOn: { _enum: 'trimBasedOn', _value: 'transparency' }, top: true, bottom: true, left: true, right: true }],
      {}
    );
    const folder = await fs.getTemporaryFolder();
    const file = await folder.createFile('hb_ps_' + layer.id + '.png', { overwrite: true });
    await tmp.saveAs.png(file, { compression: 6 }, true);
    bytes = new Uint8Array(await file.read({ format: formats.binary }));
  } finally {
    await tmp.closeWithoutSaving();
    app.activeDocument = ctx.doc;
  }

  const id = 'i' + layer.id;
  add(
    ctx,
    {
      type: 'image',
      id,
      name: layer.name,
      reason,
      opacity: round(Math.min(1, parentOp) * 100), // the PNG already has the layer's own opacity
      blend: blendName(d && d.mode),
      x: round((b.left + b.right) / 2),
      y: round((b.top + b.bottom) / 2),
      rotation: 0,
      w: round(b.right - b.left),
      h: round(b.bottom - b.top),
      image: { file: safeName(layer.name) + '_ps' + layer.id + '.png', data: toBase64(bytes), scale: 1 },
    },
    scope
  );
}

// ---------------------------------------------------------------- panel UI

if (ps && typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const opts = { selectedOnly: false, rasterizeAll: false, effects: 'raster' };
  let busy = false;

  const status = (t, kind) => {
    $('statusText').textContent = t;
    $('status').className = 'row status ' + (kind || '');
  };
  const showWarnings = (list) => {
    const box = $('warnings');
    box.innerHTML = '';
    (list || []).slice(0, 25).forEach((w) => {
      const el = document.createElement('div');
      el.textContent = w;
      box.appendChild(el);
    });
  };
  const toggle = (rowId, key) => {
    $(rowId).addEventListener('click', () => {
      opts[key] = !opts[key];
      $(rowId).className = 'row opt' + (opts[key] ? ' on' : '');
    });
  };
  toggle('optSel', 'selectedOnly');
  toggle('optRaster', 'rasterizeAll');
  Array.from($('fxSeg').children).forEach((el) =>
    el.addEventListener('click', () => {
      opts.effects = el.getAttribute('data-v');
      Array.from($('fxSeg').children).forEach((c) => (c.className = c === el ? 'on' : ''));
    })
  );

  const refreshDoc = async () => {
    const doc = ps.app.activeDocument;
    $('docName').textContent = doc ? doc.title : 'No document open';
    if (!doc) {
      $('docMeta').textContent = 'DOCUMENT';
      return;
    }
    try {
      const boards = await listArtboards(doc);
      const n = boards.length;
      if (n) {
        const ab = activeArtboard(doc, boards);
        $('docMeta').textContent = `${n} ARTBOARD${n === 1 ? '' : 'S'} · ${Math.round(doc.width)}×${Math.round(doc.height)}`;
        $('docIco').src = 'icons/artboard.svg';
        $('sendSub').textContent = `Active artboard: ${ab.name} · ${Math.round(ab.width)}×${Math.round(ab.height)}`;
        $('compTitle').textContent = n === 1 ? 'Make comp' : `Make ${n} comps`;
        $('compHint').textContent = n === 1 ? `${ab.name} · ${Math.round(ab.width)}×${Math.round(ab.height)} px` : 'One comp per artboard, same size';
      } else {
        $('docMeta').textContent = `CANVAS · ${Math.round(doc.width)}×${Math.round(doc.height)} · ${doc.resolution} PPI`;
        $('docIco').src = 'icons/doc.svg';
        $('sendSub').textContent = 'Shapes, text, groups, clipping masks';
        $('compTitle').textContent = 'Make comp';
        $('compHint').textContent = `Canvas size · ${Math.round(doc.width)}×${Math.round(doc.height)} px`;
      }
    } catch (e) {}
  };
  refreshDoc();
  try {
    ps.action.addNotificationListener(['select', 'open', 'close', 'make', 'set'], refreshDoc);
  } catch (e) {}

  // "ASCEND APP" light in the header: is the desktop app running?
  const ping = async () => {
    try {
      await findApp();
      $('relay').className = 'row chip mono on';
      $('relayText').textContent = 'APP ONLINE';
    } catch (e) {
      $('relay').className = 'row chip mono';
      $('relayText').textContent = 'OPEN ASCEND APP';
    }
  };
  ping();
  setInterval(ping, 3000);

  const push = async (json) => {
    const { base } = await findApp();
    const res = await fetch(base + '/push', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: json });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || 'HTTP ' + res.status);
  };

  const run = async (mode) => {
    if (busy) return;
    busy = true;
    $('send').classList.add('busy');
    $('comp').classList.add('busy');
    showWarnings([]);
    try {
      if (mode === 'comp') {
        // One AE comp per artboard (or the canvas), same pixel size.
        status('Reading artboards…', 'busy');
        const payload = await compsPayload();
        await push(toAsciiJSON(payload));
        const n = payload.comps.length;
        const sizes = payload.comps.map((c) => `${c.width}×${c.height}`).join(', ');
        status(`Sent ${n} comp${n === 1 ? '' : 's'} (${sizes}) to After Effects.`, 'ok');
        return;
      }
      status('Reading layers…', 'busy');
      const payload = await exportDocument(opts);
      const images = payload.layers.filter((l) => l.type === 'image').length;
      const summary = `${payload.layers.length} layers, ${images} images`;
      showWarnings(payload.warnings);
      status(`Sending ${summary}…`, 'busy');
      await push(toAsciiJSON(payload));
      status(`Sent ${summary} (${payload.name}, ${payload.width}×${payload.height}) to After Effects.`, 'ok');
    } catch (e) {
      const msg = String((e && e.message) || e);
      status(/fetch|network|Failed/i.test(msg) ? "Ascend isn't running. Open the Ascend app and try again." : msg, 'err');
    } finally {
      busy = false;
      $('send').classList.remove('busy');
      $('comp').classList.remove('busy');
    }
  };
  $('send').addEventListener('click', () => run('send'));
  $('comp').addEventListener('click', () => run('comp'));
  status(`Ready · v${VERSION}`);
}
