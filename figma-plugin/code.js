// Ascend — Figma plugin (main thread).
// Serializes the selection into an "hb-bridge" JSON payload that the After Effects panel
// rebuilds as native shape / text / image layers, with groups as nulls and masks as track mattes.

if (typeof figma !== 'undefined') {
  figma.showUI(__html__, { width: 320, height: 560, themeColors: false });

  const sendSelection = () => {
    const sel = figma.currentPage.selection;
    figma.ui.postMessage({
      type: 'selection',
      count: sel.length,
      name: sel.length === 1 ? sel[0].name : '',
    });
  };
  figma.on('selectionchange', sendSelection);
  sendSelection();

  figma.ui.onmessage = async (msg) => {
    if (msg.type === 'export') {
      try {
        const payload = await buildPayload({
          scale: msg.scale || 2,
          rasterizeAll: !!msg.rasterizeAll,
        });
        figma.ui.postMessage({
          type: 'payload',
          mode: msg.mode,
          name: payload.name,
          json: toAsciiJSON(payload),
          layers: payload.layers.length,
          images: payload.layers.filter((l) => l.type === 'image').length,
          warnings: payload.warnings,
        });
      } catch (e) {
        figma.ui.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
      }
    } else if (msg.type === 'notify') {
      figma.notify(msg.text, { error: !!msg.error });
    }
  };
}

// ---------------------------------------------------------------- payload

async function buildPayload(opts) {
  const sel = figma.currentPage.selection.filter((n) => n.visible !== false);
  if (!sel.length) throw new Error('Select a frame or some layers first.');

  const ctx = { opts, layers: [], groups: [], warnings: [], toRoot: null, root: null };
  const scope = { parent: undefined, matte: undefined };
  let name, width, height;

  if (sel.length === 1 && isContainer(sel[0]) && sel[0].type !== 'GROUP') {
    // A single frame becomes the comp: its own coordinate space is the origin.
    const f = sel[0];
    ctx.toRoot = invert(f.absoluteTransform);
    ctx.root = f;
    name = f.name;
    width = f.width;
    height = f.height;
    await walk(f, ctx, 1, scope);
  } else {
    const ordered = sortSelection(sel);
    const box = unionBounds(ordered);
    ctx.toRoot = [[1, 0, -box.x], [0, 1, -box.y]];
    name = ordered.length === 1 ? ordered[0].name : 'Figma selection';
    width = box.width;
    height = box.height;
    for (const n of ordered) await walk(n, ctx, 1, scope);
  }

  return {
    format: 'hb-bridge',
    version: 2,
    source: 'Figma',
    name,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    scale: opts.scale,
    layers: ctx.layers, // bottom-most first, same order as Figma's children arrays
    groups: ctx.groups, // outermost first
    warnings: ctx.warnings,
  };
}

function addLayer(ctx, layer, scope) {
  if (scope.parent !== undefined) layer.parent = scope.parent;
  if (scope.matte !== undefined) {
    layer.matte = scope.matte;
    if (scope.luma) layer.matteLuma = true;
  }
  if (scope.matteSource) layer.matteSource = true;
  ctx.layers.push(layer);
}

async function walk(node, ctx, parentOp, scope) {
  if (node.visible === false) return;
  const op = parentOp * nodeOpacity(node);

  const reason = rasterReason(node, ctx.opts, scope);
  if (reason) return rasterize(node, ctx, parentOp, reason, scope);

  switch (node.type) {
    case 'GROUP':
    case 'FRAME':
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE':
    case 'SECTION': {
      let inner = scope;
      if (node !== ctx.root) {
        const t = xform(node, ctx.toRoot);
        ctx.groups.push({ id: node.id, name: node.name, x: t.x, y: t.y, rotation: t.rotation, parent: scope.parent });
        inner = { parent: node.id, matte: scope.matte, luma: scope.luma };
      }
      if (node.type !== 'GROUP') await emitContainerBackground(node, ctx, parentOp, inner);
      if (node.clipsContent && overflows(node)) {
        ctx.warnings.push(`"${node.name}" clips its content; overflow isn't clipped in AE. Add #raster to its name to flatten it.`);
      }
      // A mask clips every sibling above it: it becomes a track matte for them.
      let cur = inner;
      for (const c of node.children) {
        if (c.isMask && c.visible !== false) {
          const src = { parent: inner.parent, matteSource: true };
          if (isContainer(c)) await rasterize(c, ctx, op, 'mask group', src);
          else await walk(c, ctx, op, src);
          cur = { parent: inner.parent, matte: c.id, luma: c.maskType === 'LUMINANCE' };
          continue;
        }
        await walk(c, ctx, op, cur);
      }
      return;
    }
    case 'RECTANGLE':
      return emitShape(node, ctx, parentOp, rectGeom(node), scope);
    case 'ELLIPSE':
      return emitShape(node, ctx, parentOp, ellipseGeom(node), scope);
    case 'VECTOR':
    case 'STAR':
    case 'POLYGON':
    case 'BOOLEAN_OPERATION':
    case 'LINE':
      return emitShape(node, ctx, parentOp, pathGeom(node), scope);
    case 'TEXT':
      return emitText(node, ctx, parentOp, scope);
    default:
      return rasterize(node, ctx, parentOp, 'unsupported type ' + node.type, scope);
  }
}

function rasterReason(node, opts, scope) {
  if (opts.rasterizeAll) return 'rasterize all';
  if (/#raster\b/i.test(node.name)) return '#raster tag';
  if (Array.isArray(node.effects) && node.effects.some((e) => e.visible !== false)) return 'effects';
  const hasMask = Array.isArray(node.children) && node.type !== 'BOOLEAN_OPERATION' && node.children.some((c) => c.isMask);
  if (hasMask && scope.matte !== undefined) return 'nested mask'; // AE allows one matte per layer
  if (isContainer(node)) return null; // container fills are handled as a background layer
  if ('fills' in node) {
    if (node.fills === figma.mixed) {
      if (node.type !== 'TEXT') return 'mixed fills';
    } else if (node.fills.some((p) => p.visible !== false && p.type !== 'SOLID')) {
      return 'gradient/image fill';
    }
  }
  if (Array.isArray(node.strokes) && node.strokes.some((p) => p.visible !== false && p.type !== 'SOLID')) {
    return 'gradient stroke';
  }
  return null;
}

// ---------------------------------------------------------------- emitters

async function rasterize(node, ctx, parentOp, reason, scope, as) {
  const bytes = await node.exportAsync({
    format: 'PNG',
    constraint: { type: 'SCALE', value: ctx.opts.scale },
  });
  const b = node.absoluteRenderBounds || node.absoluteBoundingBox;
  if (!b) return;
  const c = apply(ctx.toRoot, b.x + b.width / 2, b.y + b.height / 2);
  const id = as ? as.id : node.id;
  const name = as ? as.name : node.name;
  addLayer(
    ctx,
    {
      type: 'image',
      id,
      name,
      reason,
      opacity: pct(parentOp), // the PNG already contains the node's own opacity
      blend: blendOf(node),
      x: round(c.x),
      y: round(c.y),
      rotation: 0,
      w: round(b.width),
      h: round(b.height),
      image: { file: fileName(name, id), data: figma.base64Encode(bytes), scale: ctx.opts.scale },
    },
    scope
  );
}

async function emitContainerBackground(node, ctx, parentOp, scope) {
  if (node.type === 'SECTION') return;
  const fills = Array.isArray(node.fills) ? node.fills.filter((p) => p.visible !== false) : [];
  const strokes = Array.isArray(node.strokes) ? node.strokes.filter((p) => p.visible !== false) : [];
  if (!fills.length && !strokes.length) return;

  const bgName = node.name + ' (bg)';
  if (!fills.concat(strokes).some((p) => p.type !== 'SOLID')) {
    return emitShape(node, ctx, parentOp, rectGeom(node), scope, { id: node.id + '-bg', name: bgName });
  }

  // Gradient / image background: export a childless copy of the frame.
  let clone = node.clone();
  try {
    if (clone.type === 'INSTANCE') clone = clone.detachInstance();
    figma.currentPage.appendChild(clone);
    if ('layoutMode' in clone) clone.layoutMode = 'NONE';
    for (const ch of clone.children.slice()) ch.remove();
    clone.resize(Math.max(0.01, node.width), Math.max(0.01, node.height));
    clone.relativeTransform = node.absoluteTransform;
    await rasterize(clone, ctx, parentOp, 'gradient/image background', scope, { id: node.id + '-bg', name: bgName });
  } finally {
    clone.remove();
  }
}

async function emitShape(node, ctx, parentOp, geom, scope, as) {
  if (!geom || (geom.kind === 'path' && !geom.paths.length)) {
    return rasterize(node, ctx, parentOp, 'no vector geometry', scope);
  }
  const fills = solidPaints(node.fills).reverse(); // AE wants top-most first
  const strokes = solidPaints(node.strokes);
  const top = strokes[strokes.length - 1];
  const weight = typeof node.strokeWeight === 'number' ? node.strokeWeight : node.strokeTopWeight || 1;
  const stroke =
    top && weight > 0
      ? Object.assign({}, top, {
          width: weight,
          align: node.strokeAlign || 'CENTER',
          cap: typeof node.strokeCap === 'string' ? node.strokeCap : 'NONE',
          join: typeof node.strokeJoin === 'string' ? node.strokeJoin : 'MITER',
        })
      : null;
  if (!fills.length && !stroke && !scope.matteSource) return;

  if (strokes.length > 1) ctx.warnings.push(`"${node.name}": only the top stroke is transferred.`);
  if (Array.isArray(node.dashPattern) && node.dashPattern.length) {
    ctx.warnings.push(`"${node.name}": dashed strokes come through solid.`);
  }
  if (stroke && geom.kind === 'path' && stroke.align !== 'CENTER') {
    ctx.warnings.push(`"${node.name}": ${stroke.align.toLowerCase()} stroke on a path is drawn centered.`);
  }

  const t = xform(node, ctx.toRoot);
  addLayer(
    ctx,
    {
      type: 'shape',
      id: as ? as.id : node.id,
      name: as ? as.name : node.name,
      opacity: pct(parentOp * nodeOpacity(node)),
      blend: blendOf(node),
      x: t.x,
      y: t.y,
      rotation: t.rotation,
      flipX: t.flipX,
      w: round(node.width),
      h: round(node.height),
      geom,
      fills,
      stroke,
    },
    scope
  );
}

async function emitText(node, ctx, parentOp, scope) {
  const segs = node.getStyledTextSegments(['fontName', 'fontSize', 'fills', 'letterSpacing', 'lineHeight', 'textCase']);
  if (!segs.length) return;
  if (segs.some((s) => s.fills.some((p) => p.visible !== false && p.type !== 'SOLID'))) {
    return rasterize(node, ctx, parentOp, 'gradient text', scope);
  }

  const segments = segs.map((s) => {
    const f = solidPaints(s.fills);
    const c = f.length ? f[f.length - 1] : { r: 0, g: 0, b: 0, a: 1 };
    return {
      start: s.start,
      end: s.end,
      family: s.fontName.family,
      style: s.fontName.style,
      size: s.fontSize,
      color: [c.r, c.g, c.b],
      alpha: c.a,
      tracking: round(trackingOf(s.letterSpacing, s.fontSize)),
    };
  });
  const chars = segs.map((s) => applyCase(s.characters, s.textCase)).join('');
  const s0 = segs[0];
  const lh = s0.lineHeight;
  const leading = lh.unit === 'PIXELS' ? lh.value : lh.unit === 'PERCENT' ? (s0.fontSize * lh.value) / 100 : null;

  if (segs.length > 1) {
    ctx.warnings.push(`"${node.name}": mixed text styles need After Effects 24.3+ (older versions use the first style).`);
  }

  const t = xform(node, ctx.toRoot);
  addLayer(
    ctx,
    {
      type: 'text',
      id: node.id,
      name: node.name,
      opacity: pct(parentOp * nodeOpacity(node) * segments[0].alpha),
      blend: blendOf(node),
      x: t.x,
      y: t.y,
      rotation: t.rotation,
      flipX: t.flipX,
      w: round(node.width),
      h: round(node.height),
      text: {
        chars,
        mode: node.textAutoResize === 'WIDTH_AND_HEIGHT' ? 'point' : 'box',
        anchor: node.textAutoResize === 'WIDTH_AND_HEIGHT' ? 'center' : 'box',
        align: node.textAlignHorizontal,
        leading: leading == null ? null : round(leading),
        segments,
      },
    },
    scope
  );
}

// ---------------------------------------------------------------- geometry

function rectGeom(node) {
  const r = node.cornerRadius;
  if (r === figma.mixed || ((node.cornerSmoothing || 0) > 0 && r > 0)) return pathGeom(node);
  return {
    kind: 'rect',
    w: round(node.width),
    h: round(node.height),
    radius: round(Math.min(r || 0, node.width / 2, node.height / 2)),
  };
}

function ellipseGeom(node) {
  const a = node.arcData;
  const full = !a || (Math.abs(a.startingAngle) < 1e-6 && Math.abs(a.endingAngle - Math.PI * 2) < 1e-6 && !a.innerRadius);
  return full ? { kind: 'ellipse', w: round(node.width), h: round(node.height) } : pathGeom(node);
}

function pathGeom(node) {
  const w = node.width;
  const h = node.height;
  if (node.type === 'LINE') {
    return {
      kind: 'path',
      evenOdd: false,
      paths: [{ v: [[-w / 2, 0], [w / 2, 0]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], c: false }],
    };
  }
  const src = node.type === 'VECTOR' && node.vectorPaths && node.vectorPaths.length ? node.vectorPaths : node.fillGeometry || [];
  const paths = [];
  let evenOdd = false;
  for (const g of src) {
    if (g.windingRule === 'EVENODD') evenOdd = true;
    for (const sp of parsePath(g.data)) paths.push(toAEPath(sp, w, h));
  }
  return { kind: 'path', evenOdd, paths };
}

// Parses SVG path data into sub-paths of points with absolute bezier handles.
function parsePath(d) {
  const toks = String(d).match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || [];
  const subs = [];
  let i = 0, cmd = null, cx = 0, cy = 0, sx = 0, sy = 0, cur = null;
  const num = () => parseFloat(toks[i++]);
  const pt = (x, y) => ({ x, y, ix: 0, iy: 0, ox: 0, oy: 0 });
  const start = (x, y) => { cur = { pts: [pt(x, y)], closed: false }; subs.push(cur); };
  const ensure = () => { if (!cur) start(cx, cy); };
  const lineTo = (x, y) => { ensure(); cur.pts.push(pt(x, y)); cx = x; cy = y; };
  const cubic = (x1, y1, x2, y2, x, y) => {
    ensure();
    const last = cur.pts[cur.pts.length - 1];
    last.ox = x1 - last.x;
    last.oy = y1 - last.y;
    const p = pt(x, y);
    p.ix = x2 - x;
    p.iy = y2 - y;
    cur.pts.push(p);
    cx = x;
    cy = y;
  };
  const close = () => {
    if (cur) {
      cur.closed = true;
      const f = cur.pts[0];
      const l = cur.pts[cur.pts.length - 1];
      if (cur.pts.length > 1 && Math.abs(f.x - l.x) < 1e-4 && Math.abs(f.y - l.y) < 1e-4) {
        f.ix = l.ix;
        f.iy = l.iy;
        cur.pts.pop();
      }
    }
    cur = null;
    cx = sx;
    cy = sy;
  };

  while (i < toks.length) {
    const t = toks[i];
    if (/[a-zA-Z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === 'Z' || cmd === 'z') { close(); cmd = null; continue; }
    } else if (!cmd) {
      i++;
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        const x = num() + ox, y = num() + oy;
        start(x, y);
        cx = sx = x;
        cy = sy = y;
        cmd = rel ? 'l' : 'L'; // extra coordinate pairs are implicit line-tos
        break;
      }
      case 'L': { const x = num() + ox, y = num() + oy; lineTo(x, y); break; }
      case 'H': lineTo(num() + ox, cy); break;
      case 'V': lineTo(cx, num() + oy); break;
      case 'C': {
        const x1 = num() + ox, y1 = num() + oy, x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
        cubic(x1, y1, x2, y2, x, y);
        break;
      }
      case 'Q': {
        const qx = num() + ox, qy = num() + oy, x = num() + ox, y = num() + oy;
        cubic(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
        break;
      }
      case 'S': { i += 2; const x = num() + ox, y = num() + oy; lineTo(x, y); break; } // rare in Figma output
      case 'T': { const x = num() + ox, y = num() + oy; lineTo(x, y); break; }
      case 'A': { i += 5; const x = num() + ox, y = num() + oy; lineTo(x, y); break; }
      default: i++;
    }
    if (Number.isNaN(cx) || Number.isNaN(cy)) break;
  }
  return subs.filter((s) => s.pts.length > 0);
}

// AE path: vertices relative to the layer's center, tangents relative to their vertex.
function toAEPath(sp, w, h) {
  return {
    v: sp.pts.map((p) => [round(p.x - w / 2), round(p.y - h / 2)]),
    i: sp.pts.map((p) => [round(p.ix), round(p.iy)]),
    o: sp.pts.map((p) => [round(p.ox), round(p.oy)]),
    c: sp.closed,
  };
}

// ---------------------------------------------------------------- helpers

function isContainer(n) {
  return ['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION'].indexOf(n.type) >= 0;
}

function nodeOpacity(n) {
  return typeof n.opacity === 'number' ? n.opacity : 1;
}

function solidPaints(paints) {
  if (!Array.isArray(paints)) return [];
  return paints
    .filter((p) => p.visible !== false && p.type === 'SOLID')
    .map((p) => ({
      r: round(p.color.r),
      g: round(p.color.g),
      b: round(p.color.b),
      a: typeof p.opacity === 'number' ? p.opacity : 1,
    }));
}

function blendOf(n) {
  const b = n.blendMode;
  return b && b !== 'NORMAL' && b !== 'PASS_THROUGH' ? b : undefined;
}

function trackingOf(ls, size) {
  if (!ls || !size) return 0;
  return ls.unit === 'PIXELS' ? (ls.value / size) * 1000 : ls.value * 10;
}

function applyCase(s, c) {
  if (c === 'UPPER') return s.toUpperCase();
  if (c === 'LOWER') return s.toLowerCase();
  return s;
}

function xform(node, toRoot) {
  const m = multiply(toRoot, node.absoluteTransform);
  const a = m[0][0], c = m[0][1], tx = m[0][2];
  const b = m[1][0], d = m[1][1], ty = m[1][2];
  const w = node.width, h = node.height;
  const flipX = a * d - b * c < 0;
  const rot = (flipX ? Math.atan2(-b, -a) : Math.atan2(b, a)) * (180 / Math.PI);
  return {
    x: round(a * (w / 2) + c * (h / 2) + tx),
    y: round(b * (w / 2) + d * (h / 2) + ty),
    rotation: round(rot),
    flipX,
  };
}

function multiply(A, B) {
  return [
    [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1], A[0][0] * B[0][2] + A[0][1] * B[1][2] + A[0][2]],
    [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1], A[1][0] * B[0][2] + A[1][1] * B[1][2] + A[1][2]],
  ];
}

function invert(M) {
  const a = M[0][0], c = M[0][1], tx = M[0][2];
  const b = M[1][0], d = M[1][1], ty = M[1][2];
  const det = a * d - b * c || 1;
  return [
    [d / det, -c / det, (c * ty - d * tx) / det],
    [-b / det, a / det, (b * tx - a * ty) / det],
  ];
}

function apply(M, x, y) {
  return { x: M[0][0] * x + M[0][1] * y + M[0][2], y: M[1][0] * x + M[1][1] * y + M[1][2] };
}

function sortSelection(sel) {
  const p = sel[0].parent;
  if (!p || !sel.every((n) => n.parent === p)) return sel.slice();
  return sel.slice().sort((x, y) => p.children.indexOf(x) - p.children.indexOf(y));
}

function unionBounds(nodes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const b = n.absoluteBoundingBox;
    if (!b) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  if (x0 === Infinity) return { x: 0, y: 0, width: 100, height: 100 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function overflows(frame) {
  const f = frame.absoluteBoundingBox;
  if (!f) return false;
  return frame.children.some((c) => {
    const b = c.visible !== false && c.absoluteBoundingBox;
    return b && (b.x < f.x - 0.5 || b.y < f.y - 0.5 || b.x + b.width > f.x + f.width + 0.5 || b.y + b.height > f.y + f.height + 0.5);
  });
}

function fileName(name, id) {
  const base = String(name).replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'layer';
  return base + '_' + String(id).replace(/[^\w]+/g, '-') + '.png';
}

function pct(v) {
  return round(Math.max(0, Math.min(1, v)) * 100);
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

// JSON with every non-ASCII char escaped, so ExtendScript can read it as plain bytes.
function toAsciiJSON(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (ch) => '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parsePath, toAEPath, xform, invert, multiply, toAsciiJSON, fileName, trackingOf };
}
