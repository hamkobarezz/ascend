/*
  Ascend for Illustrator: CEP host script (loaded by the Ascend panel, see ../CSXS/manifest.xml).
  Exports the active artboard (or the selection) as an Ascend payload: native paths, live text,
  groups, clipping masks, and PNGs for anything After Effects can't rebuild natively.
  The panel (panel.js) sends the payload to the Ascend app; this file never opens sockets.
*/
(function (G) {
    // ------------------------------------------------------------ JSON out (ES3, ASCII only)

    function quote(s) {
        var out = ['"'];
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c === 34) out.push('\\"');
            else if (c === 92) out.push("\\\\");
            else if (c < 32 || c > 126) out.push("\\u" + ("0000" + c.toString(16)).slice(-4));
            else out.push(s.charAt(i));
        }
        out.push('"');
        return out.join("");
    }
    function toJSON(v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t === "number") return isFinite(v) ? String(Math.round(v * 10000) / 10000) : "null";
        if (t === "boolean") return v ? "true" : "false";
        if (t === "string") return quote(v);
        var parts = [], i;
        if (v instanceof Array) {
            for (i = 0; i < v.length; i++) parts.push(toJSON(v[i]));
            return "[" + parts.join(",") + "]";
        }
        for (var k in v) {
            if (v.hasOwnProperty(k) && v[k] !== undefined && typeof v[k] !== "function") parts.push(quote(k) + ":" + toJSON(v[k]));
        }
        return "{" + parts.join(",") + "}";
    }

    // ------------------------------------------------------------ helpers

    var BLENDS = [
        ["MULTIPLY", "MULTIPLY"], ["SCREEN", "SCREEN"], ["OVERLAY", "OVERLAY"], ["SOFTLIGHT", "SOFT_LIGHT"],
        ["HARDLIGHT", "HARD_LIGHT"], ["COLORDODGE", "COLOR_DODGE"], ["COLORBURN", "COLOR_BURN"], ["DARKEN", "DARKEN"],
        ["LIGHTEN", "LIGHTEN"], ["DIFFERENCE", "DIFFERENCE"], ["EXCLUSION", "EXCLUSION"], ["HUE", "HUE"],
        ["SATURATIONBLEND", "SATURATION"], ["COLORBLEND", "COLOR"], ["LUMINOSITY", "LUMINOSITY"]
    ];
    function blendOf(item) {
        try {
            for (var i = 0; i < BLENDS.length; i++) if (item.blendingMode == BlendModes[BLENDS[i][0]]) return BLENDS[i][1];
        } catch (e) {}
        return undefined;
    }

    // Returns {r,g,b} (0-1), null for "no color", or false for gradients/patterns (needs a PNG).
    function col(c) {
        if (!c) return null;
        var t = c.typename, rgb;
        if (t === "NoColor") return null;
        if (t === "RGBColor") return { r: c.red / 255, g: c.green / 255, b: c.blue / 255 };
        if (t === "GrayColor") { var g = 1 - c.gray / 100; return { r: g, g: g, b: g }; }
        try {
            if (t === "CMYKColor") {
                rgb = app.convertSampleColor(ImageColorSpace.CMYK, [c.cyan, c.magenta, c.yellow, c.black], ImageColorSpace.RGB, ColorConvertPurpose.defaultpurpose);
                return { r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255 };
            }
            if (t === "LabColor") {
                rgb = app.convertSampleColor(ImageColorSpace.LAB, [c.l, c.a, c.b], ImageColorSpace.RGB, ColorConvertPurpose.defaultpurpose);
                return { r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255 };
            }
        } catch (e) {
            if (t === "CMYKColor") {
                var k = c.black / 100;
                return { r: (1 - c.cyan / 100) * (1 - k), g: (1 - c.magenta / 100) * (1 - k), b: (1 - c.yellow / 100) * (1 - k) };
            }
        }
        if (t === "SpotColor") {
            var base = col(c.spot.color), tint = (c.tint === undefined ? 100 : c.tint) / 100;
            if (!base) return base;
            return { r: 1 - (1 - base.r) * tint, g: 1 - (1 - base.g) * tint, b: 1 - (1 - base.b) * tint };
        }
        return false; // GradientColor, PatternColor
    }

    function safeName(s) {
        var n = String(s || "item").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "");
        return (n || "item").substring(0, 40);
    }
    function itemName(item, fallback) {
        try { if (item.name) return item.name; } catch (e) {}
        return fallback;
    }

    // ------------------------------------------------------------ export

    function exportDoc(opts) {
        var doc = app.activeDocument;
        var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
        var R = ab.artboardRect; // [left, top, right, bottom], y grows upward
        var L0 = R[0], T0 = R[1];
        var ctx = { doc: doc, opts: opts, layers: [], groups: [], warnings: [], seq: 0, tmpDir: null };

        function X(x) { return x - L0; }
        function Y(y) { return T0 - y; }
        function nextId(prefix) { ctx.seq++; return prefix + ctx.seq; }
        function add(layer, scope) {
            if (scope.parent !== undefined) layer.parent = scope.parent;
            if (scope.matte !== undefined) layer.matte = scope.matte;
            if (scope.matteSource) layer.matteSource = true;
            ctx.layers.push(layer);
        }
        function tmpDir() {
            if (!ctx.tmpDir) {
                ctx.tmpDir = new Folder(Folder.temp.fsName + "/hb-bridge-ai");
                if (!ctx.tmpDir.exists) ctx.tmpDir.create();
            }
            return ctx.tmpDir;
        }

        // ---- PNG export of one item through a scratch document
        function raster(item, scope, parentOp, reason) {
            var vb = item.visibleBounds;
            var w = vb[2] - vb[0], h = vb[1] - vb[3];
            if (w <= 0 || h <= 0) return;
            var id = nextId("i");
            var name = itemName(item, reason);
            var file = new File(tmpDir().fsName + "/" + safeName(name) + "_" + id + ".png");
            var tmp = app.documents.add(DocumentColorSpace.RGB, Math.max(1, w), Math.max(1, h));
            try {
                var dup = item.duplicate(tmp.layers[0], ElementPlacement.PLACEATBEGINNING);
                try { dup.hidden = false; } catch (e) {}
                tmp.artboards[0].artboardRect = dup.visibleBounds;
                var o = new ExportOptionsPNG24();
                o.antiAliasing = true;
                o.transparency = true;
                o.artBoardClipping = true;
                o.horizontalScale = o.verticalScale = ctx.opts.scale * 100;
                tmp.exportFile(file, ExportType.PNG24, o);
            } finally {
                tmp.close(SaveOptions.DONOTSAVECHANGES);
                doc.activate();
            }
            add({
                type: "image", id: id, name: name, reason: reason,
                opacity: Math.min(1, parentOp) * 100, // the PNG already has the item's own opacity
                blend: blendOf(item),
                x: X((vb[0] + vb[2]) / 2), y: Y((vb[1] + vb[3]) / 2), rotation: 0, w: w, h: h,
                image: { file: file.name, src: file.fsName, scale: ctx.opts.scale }
            }, scope);
        }

        // ---- paths
        function aePath(p, cx, cy) {
            var pts = p.pathPoints, v = [], ins = [], outs = [];
            for (var k = 0; k < pts.length; k++) {
                var a = pts[k].anchor, ld = pts[k].leftDirection, rd = pts[k].rightDirection;
                v.push([X(a[0]) - cx, Y(a[1]) - cy]);
                ins.push([ld[0] - a[0], -(ld[1] - a[1])]);
                outs.push([rd[0] - a[0], -(rd[1] - a[1])]);
            }
            return { v: v, i: ins, o: outs, c: p.closed };
        }

        function shape(item, paths, style, scope, parentOp) {
            var fill = style.filled ? col(style.fillColor) : null;
            var strokeCol = style.stroked && style.strokeWidth > 0 ? col(style.strokeColor) : null;
            if (fill === false || strokeCol === false) return raster(item, scope, parentOp, "gradient or pattern");
            if (!fill && !strokeCol && !scope.matteSource) return;
            var gb = item.geometricBounds;
            var cx = X((gb[0] + gb[2]) / 2), cy = Y((gb[1] + gb[3]) / 2);
            var list = [];
            for (var k = 0; k < paths.length; k++) if (paths[k].pathPoints.length > 1) list.push(aePath(paths[k], cx, cy));
            if (!list.length) return;
            var stroke = null;
            if (strokeCol) {
                var cap = style.strokeCap == StrokeCap.ROUNDENDCAP ? "ROUND" : style.strokeCap == StrokeCap.PROJECTINGENDCAP ? "SQUARE" : "NONE";
                var join = style.strokeJoin == StrokeJoin.ROUNDENDJOIN ? "ROUND" : style.strokeJoin == StrokeJoin.BEVELENDJOIN ? "BEVEL" : "MITER";
                stroke = { r: strokeCol.r, g: strokeCol.g, b: strokeCol.b, a: 1, width: style.strokeWidth, align: "CENTER", cap: cap, join: join };
                if (style.strokeDashes && style.strokeDashes.length) ctx.warnings.push('"' + itemName(item, "path") + '": dashed strokes come through solid.');
            }
            add({
                type: "shape", id: nextId("p"), name: itemName(item, item.typename === "CompoundPathItem" ? "Compound path" : "Path"),
                opacity: Math.min(1, parentOp * item.opacity / 100) * 100,
                blend: blendOf(item),
                x: cx, y: cy, rotation: 0, w: gb[2] - gb[0], h: gb[1] - gb[3],
                geom: { kind: "path", detect: true, evenOdd: !!style.evenodd, paths: list },
                fills: fill ? [{ r: fill.r, g: fill.g, b: fill.b, a: 1 }] : [],
                stroke: stroke
            }, scope);
        }

        // ---- text
        function justName(j) {
            if (j == Justification.CENTER) return "CENTER";
            if (j == Justification.RIGHT) return "RIGHT";
            if (j == Justification.LEFT) return "LEFT";
            return "JUSTIFIED";
        }
        function text(tf, scope, parentOp) {
            if (tf.kind == TextType.PATHTEXT) return raster(tf, scope, parentOp, "type on a path");
            var str = tf.contents;
            if (!str.length) return;
            var m = tf.matrix;
            var sx = Math.sqrt(m.mValueA * m.mValueA + m.mValueB * m.mValueB) || 1;
            var sy = Math.sqrt(m.mValueC * m.mValueC + m.mValueD * m.mValueD) || 1;
            var rotation = -Math.atan2(m.mValueB, m.mValueA) * 180 / Math.PI;

            function seg(ca, start, end) {
                var c = col(ca.fillColor);
                if (c === false) return false;
                if (!c) c = { r: 0, g: 0, b: 0 };
                var f = ca.textFont;
                return { start: start, end: end, ps: f.name, family: f.family, style: f.style, size: ca.size * sy, color: [c.r, c.g, c.b], tracking: ca.tracking };
            }
            var segments = [], k;
            var chars = tf.characters;
            if (chars.length === str.length && chars.length <= 4000) {
                var cur = null, key = null;
                for (k = 0; k < chars.length; k++) {
                    var ca = chars[k].characterAttributes;
                    var s = seg(ca, k, k + 1);
                    if (s === false) return raster(tf, scope, parentOp, "gradient text");
                    var kk = [s.ps, s.size, s.color.join(","), s.tracking].join("|");
                    if (kk === key) cur.end = k + 1;
                    else { cur = s; key = kk; segments.push(cur); }
                }
            } else {
                var s0 = seg(tf.textRange.characterAttributes, 0, str.length);
                if (s0 === false) return raster(tf, scope, parentOp, "gradient text");
                segments.push(s0);
            }
            var a0 = tf.textRange.characterAttributes;
            var leading = a0.autoLeading ? null : a0.leading * sy;
            var align = "LEFT";
            try { if (tf.paragraphs.length) align = justName(tf.paragraphs[0].paragraphAttributes.justification); } catch (e) {}

            var layer = {
                type: "text", id: nextId("t"), name: itemName(tf, str.substring(0, 30)),
                opacity: Math.min(1, parentOp * tf.opacity / 100) * 100,
                blend: blendOf(tf), rotation: rotation,
                text: { chars: str, align: align, leading: leading, segments: segments }
            };
            if (tf.kind == TextType.AREATEXT) {
                var gb = tf.textPath.geometricBounds;
                layer.x = X((gb[0] + gb[2]) / 2); layer.y = Y((gb[1] + gb[3]) / 2);
                layer.w = gb[2] - gb[0]; layer.h = gb[1] - gb[3];
                layer.text.mode = "box"; layer.text.anchor = "box";
            } else {
                // Point text: Illustrator's anchor is the first baseline origin, same as AE's.
                var vb = tf.geometricBounds;
                layer.x = X(tf.anchor[0]); layer.y = Y(tf.anchor[1]);
                layer.w = vb[2] - vb[0]; layer.h = vb[1] - vb[3];
                layer.text.mode = "point"; layer.text.anchor = "baseline";
            }
            add(layer, scope);
        }

        // ---- containers
        function children(container) {
            // pageItems / layers are top-first; return bottom-first.
            var list = [], k;
            for (k = container.pageItems.length - 1; k >= 0; k--) list.push(container.pageItems[k]);
            return list;
        }

        function group(g, scope, parentOp) {
            var op = parentOp * g.opacity / 100;
            var kids = children(g), k, mask = null;
            if (g.clipped) {
                for (k = kids.length - 1; k >= 0; k--) {
                    var c = kids[k];
                    var isClip = c.typename === "PathItem" ? c.clipping : (c.typename === "CompoundPathItem" && c.pathItems.length && c.pathItems[0].clipping);
                    if (isClip) { mask = c; break; }
                }
                if (mask && scope.matte !== undefined) return raster(g, scope, parentOp, "nested clipping");
            }
            var gb = g.geometricBounds;
            var id = nextId("g");
            ctx.groups.push({ id: id, name: itemName(g, "Group"), x: X((gb[0] + gb[2]) / 2), y: Y((gb[1] + gb[3]) / 2), parent: scope.parent });
            var inner = { parent: id, matte: scope.matte };
            if (mask) {
                var before = ctx.layers.length;
                item(mask, { parent: id, matteSource: true }, op, true);
                if (ctx.layers.length > before) inner = { parent: id, matte: ctx.layers[ctx.layers.length - 1].id };
            }
            for (k = 0; k < kids.length; k++) if (kids[k] !== mask) item(kids[k], inner, op, false);
        }

        function item(it, scope, parentOp, asMask) {
            try {
                if (it.hidden && !asMask) return;
                if (it.typename === "PathItem" && it.guides) return;
                if (ctx.opts.rasterizeAll && !asMask) return raster(it, scope, parentOp, "rasterize all");
                switch (it.typename) {
                    case "GroupItem": return group(it, scope, parentOp);
                    case "PathItem": return shape(it, [it], it, scope, parentOp);
                    case "CompoundPathItem":
                        if (!it.pathItems.length) return;
                        var paths = [];
                        for (var k = 0; k < it.pathItems.length; k++) paths.push(it.pathItems[k]);
                        return shape(it, paths, it.pathItems[0], scope, parentOp);
                    case "TextFrame": return text(it, scope, parentOp);
                    default: return raster(it, scope, parentOp, it.typename);
                }
            } catch (e) {
                ctx.warnings.push('"' + itemName(it, it.typename) + '": ' + e.message);
            }
        }

        function layer(l, scope) {
            if (!l.visible) return;
            var id = nextId("L");
            ctx.groups.push({ id: id, name: l.name, x: (R[2] - R[0]) / 2, y: (R[1] - R[3]) / 2, parent: scope.parent });
            var inner = { parent: id };
            var op = l.opacity / 100;
            for (var k = l.layers.length - 1; k >= 0; k--) layer(l.layers[k], inner);
            var kids = children(l);
            for (var j = 0; j < kids.length; j++) item(kids[j], inner, op, false);
        }

        if (opts.selectionOnly && doc.selection && doc.selection.length) {
            var sel = [];
            for (var s = 0; s < doc.selection.length; s++) sel.push(doc.selection[s]);
            sel.sort(function (a, b) { return a.absoluteZOrderPosition - b.absoluteZOrderPosition; }); // bottom first
            for (s = 0; s < sel.length; s++) item(sel[s], {}, 1, false);
        } else {
            for (var li = doc.layers.length - 1; li >= 0; li--) layer(doc.layers[li], {});
        }

        return {
            format: "hb-bridge", version: 2, source: "Illustrator",
            name: doc.name.replace(/\.[^.]+$/, "") + (doc.artboards.length > 1 ? " - " + ab.name : ""),
            width: Math.round(R[2] - R[0]), height: Math.round(R[1] - R[3]),
            scale: opts.scale, layers: ctx.layers, groups: ctx.groups, warnings: ctx.warnings
        };
    }

    // ------------------------------------------------------------ API used by panel.js
    function call(fn) {
        try { return toJSON(fn()); } catch (e) { return toJSON({ ok: false, error: String(e.message || e) }); }
    }
    function writeTemp(name, text) {
        var f = new File(Folder.temp.fsName + "/" + name);
        f.encoding = "UTF-8";
        if (!f.open("w")) throw new Error("Couldn't write " + f.fsName);
        f.write(text);
        f.close();
        return f.fsName;
    }
    function selCount(doc) {
        try { var s = doc.selection; return s && s.length ? s.length : 0; } catch (e) { return 0; }
    }
    function baseName(doc) { return doc.name.replace(/\.[^.]+$/, ""); }

    G.AscendAI = {
        info: function () {
            return call(function () {
                if (!app.documents.length) return { ok: true, doc: false };
                var doc = app.activeDocument;
                var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()], R = ab.artboardRect;
                return {
                    ok: true, doc: true, name: baseName(doc), artboard: ab.name,
                    width: Math.round(R[2] - R[0]), height: Math.round(R[1] - R[3]),
                    artboards: doc.artboards.length, selection: selCount(doc)
                };
            });
        },
        // Writes the payload to a temp file (it can be large) and returns its path for the panel to send.
        exportLayers: function (scale, selectionOnly, rasterizeAll) {
            return call(function () {
                if (!app.documents.length) throw new Error("Open a document first.");
                var payload = exportDoc({ scale: scale, selectionOnly: !!selectionOnly, rasterizeAll: !!rasterizeAll });
                var images = 0;
                for (var i = 0; i < payload.layers.length; i++) if (payload.layers[i].type === "image") images++;
                return {
                    ok: true, file: writeTemp("ascend-ai-payload.json", toJSON(payload)),
                    name: payload.name, layers: payload.layers.length, images: images,
                    width: payload.width, height: payload.height, warnings: payload.warnings
                };
            });
        },
        // One AE comp per artboard, same size (1 pt = 1 px).
        comps: function () {
            return call(function () {
                if (!app.documents.length) throw new Error("Open a document first.");
                var doc = app.activeDocument, comps = [];
                for (var a = 0; a < doc.artboards.length; a++) {
                    var R = doc.artboards[a].artboardRect;
                    comps.push({ name: doc.artboards[a].name, width: Math.round(R[2] - R[0]), height: Math.round(R[1] - R[3]) });
                }
                var payload = { format: "hb-bridge", version: 2, kind: "comps", source: "Illustrator", name: baseName(doc), comps: comps, layers: [] };
                return { ok: true, file: writeTemp("ascend-ai-comps.json", toJSON(payload)), comps: comps };
            });
        }
    };
})($.global);
