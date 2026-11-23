/*
  Ascend for After Effects: CEP host script (loaded by the Ascend panel, see ../CSXS/manifest.xml).
  Rebuilds layers sent from Figma, Photoshop or Illustrator as native, editable AE layers:
  shape layers (parametric rectangles / ellipses or bezier paths), live text, images,
  null layers for groups, and track mattes for masks / clipping.
  The panel (panel.js) does the networking and file writing; this file only reads and builds.
*/
(function (G) {
    var FORMATS = { "hb-bridge": 1, "overlord-mvp": 1 };
    var BIN_NAME = "Ascend Assets";

    // ------------------------------------------------------------ JSON (ExtendScript has no JSON object)

    function parseJSON(text) {
        var i = 0, n = text.length;
        var bpos = text.indexOf("\\"); // next backslash, cached so long strings stay O(n)

        function err(m) { throw new Error("JSON parse error at " + i + ": " + m); }
        function ws() {
            while (i < n) {
                var c = text.charCodeAt(i);
                if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break;
            }
        }
        function str() {
            i++;
            var out = "";
            while (true) {
                var q = text.indexOf('"', i);
                if (q < 0) err("unterminated string");
                if (bpos !== -1 && bpos < i) bpos = text.indexOf("\\", i);
                if (bpos === -1 || bpos > q) { out += text.substring(i, q); i = q + 1; return out; }
                out += text.substring(i, bpos);
                var e = text.charAt(bpos + 1);
                i = bpos + 2;
                switch (e) {
                    case '"': out += '"'; break;
                    case "\\": out += "\\"; break;
                    case "/": out += "/"; break;
                    case "b": out += "\b"; break;
                    case "f": out += "\f"; break;
                    case "n": out += "\n"; break;
                    case "r": out += "\r"; break;
                    case "t": out += "\t"; break;
                    case "u": out += String.fromCharCode(parseInt(text.substr(i, 4), 16)); i += 4; break;
                    default: err("bad escape \\" + e);
                }
            }
        }
        function val() {
            ws();
            var ch = text.charAt(i);
            if (ch === "{") {
                i++;
                var o = {};
                ws();
                if (text.charAt(i) === "}") { i++; return o; }
                while (true) {
                    ws();
                    if (text.charAt(i) !== '"') err("expected key");
                    var k = str();
                    ws();
                    if (text.charAt(i) !== ":") err("expected :");
                    i++;
                    o[k] = val();
                    ws();
                    ch = text.charAt(i++);
                    if (ch === "}") return o;
                    if (ch !== ",") err("expected , or }");
                }
            }
            if (ch === "[") {
                i++;
                var a = [];
                ws();
                if (text.charAt(i) === "]") { i++; return a; }
                while (true) {
                    a.push(val());
                    ws();
                    ch = text.charAt(i++);
                    if (ch === "]") return a;
                    if (ch !== ",") err("expected , or ]");
                }
            }
            if (ch === '"') return str();
            if (text.substr(i, 4) === "true") { i += 4; return true; }
            if (text.substr(i, 5) === "false") { i += 5; return false; }
            if (text.substr(i, 4) === "null") { i += 4; return null; }
            var s = i;
            while (i < n && "+-0123456789.eE".indexOf(text.charAt(i)) >= 0) i++;
            if (s === i) err("unexpected '" + ch + "'");
            var num = parseFloat(text.substring(s, i));
            if (isNaN(num)) err("bad number");
            return num;
        }
        var result = val();
        ws();
        if (i < n) err("trailing data");
        return result;
    }

    // ------------------------------------------------------------ base64 -> binary string

    function b64decode(input) {
        var A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        var lut = [], k;
        for (k = 0; k < 256; k++) lut[k] = -1;
        for (k = 0; k < 64; k++) lut[A.charCodeAt(k)] = k;
        var s = input.replace(/[^A-Za-z0-9+\/]/g, "");
        var len = s.length, out = [], buf = [], i, n, fc = String.fromCharCode;
        for (i = 0; i + 3 < len; i += 4) {
            n = (lut[s.charCodeAt(i)] << 18) | (lut[s.charCodeAt(i + 1)] << 12) | (lut[s.charCodeAt(i + 2)] << 6) | lut[s.charCodeAt(i + 3)];
            buf.push(fc((n >> 16) & 255, (n >> 8) & 255, n & 255));
            if (buf.length >= 4096) { out.push(buf.join("")); buf = []; }
        }
        var rem = len - i;
        if (rem === 2) {
            n = (lut[s.charCodeAt(i)] << 18) | (lut[s.charCodeAt(i + 1)] << 12);
            buf.push(fc((n >> 16) & 255));
        } else if (rem === 3) {
            n = (lut[s.charCodeAt(i)] << 18) | (lut[s.charCodeAt(i + 1)] << 12) | (lut[s.charCodeAt(i + 2)] << 6);
            buf.push(fc((n >> 16) & 255, (n >> 8) & 255));
        }
        out.push(buf.join(""));
        return out.join("");
    }

    // ------------------------------------------------------------ primitive detection
    // Photoshop and Illustrator only hand over bezier paths. If a closed path is really an
    // axis-aligned rectangle, rounded rectangle or ellipse, rebuild it as AE's parametric shape
    // so its size and roundness stay editable. Vertices are relative to the layer center.

    function detectPrimitive(g) {
        if (!g || g.kind !== "path" || !g.detect || g.paths.length !== 1) return null;
        var p = g.paths[0];
        if (!p.c) return null;
        var v = p.v, n = v.length, k;
        var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (k = 0; k < n; k++) {
            x0 = Math.min(x0, v[k][0]); x1 = Math.max(x1, v[k][0]);
            y0 = Math.min(y0, v[k][1]); y1 = Math.max(y1, v[k][1]);
        }
        var w = x1 - x0, h = y1 - y0;
        if (w <= 0 || h <= 0) return null;
        var eps = Math.max(0.05, Math.min(w, h) * 0.004);
        function near(a, b) { return Math.abs(a - b) <= eps; }
        function hlen(t) { return Math.sqrt(t[0] * t[0] + t[1] * t[1]); }
        if (!near((x0 + x1) / 2, 0) || !near((y0 + y1) / 2, 0)) return null;
        var hw = w / 2, hh = h / 2, flat = true;
        for (k = 0; k < n; k++) if (hlen(p.i[k]) > eps || hlen(p.o[k]) > eps) { flat = false; break; }

        if (n === 4 && flat) {
            for (k = 0; k < n; k++) if (!near(Math.abs(v[k][0]), hw) || !near(Math.abs(v[k][1]), hh)) return null;
            return { kind: "rect", w: w, h: h, radius: 0 };
        }
        var KAPPA = 0.5523;
        if (n === 4 && !flat) {
            for (k = 0; k < n; k++) {
                var onX = near(Math.abs(v[k][0]), hw) && near(v[k][1], 0);
                var onY = near(v[k][0], 0) && near(Math.abs(v[k][1]), hh);
                if (!onX && !onY) return null;
                var want = KAPPA * (onX ? hh : hw);
                if (Math.abs(hlen(p.o[k]) - want) > want * 0.06 || Math.abs(hlen(p.i[k]) - want) > want * 0.06) return null;
            }
            return { kind: "ellipse", w: w, h: h };
        }
        if (n === 8) {
            var r = -1;
            for (k = 0; k < n; k++) {
                var ax = Math.abs(v[k][0]), ay = Math.abs(v[k][1]), rr;
                if (near(ay, hh) && !near(ax, hw)) rr = hw - ax;
                else if (near(ax, hw) && !near(ay, hh)) rr = hh - ay;
                else return null;
                if (r < 0) r = rr; else if (!near(r, rr)) return null;
            }
            if (r <= eps) return null;
            return { kind: "rect", w: w, h: h, radius: r };
        }
        return null;
    }


    // ------------------------------------------------------------ AE helpers

    function clampDim(v) { v = Math.round(v || 0); return Math.max(4, Math.min(30000, v)); }


    // The panel picks this folder (AscendAE.assetDir), creates it and has the app write the PNGs
    // into it before calling buildFile, so the host itself never writes files or opens sockets.
    var pulledDir = null;
    function assetFolder() {
        if (!pulledDir) throw new Error("No image folder was chosen.");
        return pulledDir;
    }

    function binFolder() {
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FolderItem && it.name === BIN_NAME) return it;
        }
        return app.project.items.addFolder(BIN_NAME);
    }

    function importFootage(file, ctx) {
        var p = file.fsName;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof FootageItem && it.file && it.file.fsName === p) {
                try { it.mainSource.reload(); } catch (e) {}
                return it;
            }
        }
        var item = app.project.importFile(new ImportOptions(file));
        item.parentFolder = ctx.bin();
        return item;
    }

    function fontPS(seg) {
        if (seg.ps) return seg.ps;
        try {
            if (app.fonts && app.fonts.getFontsByFamilyNameAndStyleName) {
                var f = app.fonts.getFontsByFamilyNameAndStyleName(seg.family, seg.style);
                if (f && f.length) return f[0].postScriptName;
            }
        } catch (e) {}
        return (seg.family + "-" + seg.style).replace(/\s+/g, "");
    }

    function rgb(c) { return [c.r, c.g, c.b]; }

    // ------------------------------------------------------------ layer builders

    // Payload v3 sends L.strokes (top-most first); older payloads send a single L.stroke.
    function strokeList(L) {
        if (L.strokes instanceof Array) return L.strokes;
        return L.stroke ? [L.stroke] : [];
    }

    function addGeometry(vecs, g) {
        var k;
        if (g.kind === "rect") {
            var r = vecs.addProperty("ADBE Vector Shape - Rect");
            r.property("ADBE Vector Rect Size").setValue([Math.max(0, g.w), Math.max(0, g.h)]);
            r.property("ADBE Vector Rect Roundness").setValue(Math.max(0, g.radius || 0));
        } else if (g.kind === "ellipse") {
            var el = vecs.addProperty("ADBE Vector Shape - Ellipse");
            el.property("ADBE Vector Ellipse Size").setValue([Math.max(0, g.w), Math.max(0, g.h)]);
        } else {
            for (k = 0; k < g.paths.length; k++) {
                var p = g.paths[k];
                var sh = new Shape();
                sh.vertices = p.v;
                sh.inTangents = p.i;
                sh.outTangents = p.o;
                sh.closed = p.c;
                vecs.addProperty("ADBE Vector Shape - Group").property("ADBE Vector Shape").setValue(sh);
            }
        }
    }

    function isClosed(g) {
        if (g.kind !== "path") return true;
        for (var k = 0; k < g.paths.length; k++) if (!g.paths[k].c) return false;
        return true;
    }

    var CAPS = { ROUND: 2, SQUARE: 3 }, JOINS = { ROUND: 2, BEVEL: 3 };

    // Native AE dashes: up to three dash/gap pairs plus an offset. An odd-length pattern repeats
    // once to become even (the SVG / Figma / Illustrator rule).
    function addDashes(s, st, ctx, name) {
        var d = st.dashes;
        if (!(d instanceof Array) || !d.length) return;
        var arr = d.length % 2 ? d.concat(d) : d.slice(0);
        if (arr.length > 6) ctx.warn(name + ": dash pattern has more than 3 dash/gap pairs; AE keeps the first 3.");
        var grp = s.property("ADBE Vector Stroke Dashes");
        for (var i = 0; i < Math.min(arr.length, 6); i += 2) {
            grp.addProperty("ADBE Vector Stroke Dash " + (i / 2 + 1)).setValue(Math.max(0, arr[i]));
            grp.addProperty("ADBE Vector Stroke Gap " + (i / 2 + 1)).setValue(Math.max(0, arr[i + 1]));
        }
        if (st.dashOffset) grp.addProperty("ADBE Vector Stroke Offset").setValue(st.dashOffset);
    }

    function addStroke(vecs, st, ctx, name) {
        var s = vecs.addProperty("ADBE Vector Graphic - Stroke");
        s.property("ADBE Vector Stroke Color").setValue(rgb(st));
        s.property("ADBE Vector Stroke Opacity").setValue((st.a === undefined ? 1 : st.a) * 100);
        s.property("ADBE Vector Stroke Width").setValue(st.width);
        if (CAPS[st.cap]) s.property("ADBE Vector Stroke Line Cap").setValue(CAPS[st.cap]);
        if (JOINS[st.join]) s.property("ADBE Vector Stroke Line Join").setValue(JOINS[st.join]);
        if (st.miter) s.property("ADBE Vector Stroke Miter Limit").setValue(st.miter);
        addDashes(s, st, ctx, name);
        return s;
    }

    function makeShape(comp, L, ctx) {
        var layer = comp.layers.addShape();
        var root = layer.property("ADBE Root Vectors Group");
        var g = detectPrimitive(L.geom) || L.geom;
        var strokes = L.matteSource ? [] : strokeList(L);
        var fills = L.fills || [];
        var k, s;
        if (L.matteSource && !fills.length) fills = [{ r: 1, g: 1, b: 1, a: 1 }]; // a mask needs alpha

        // AE has no stroke alignment, so an inside / outside stroke gets its own group: a copy of the
        // geometry, Offset Paths by half the width, then the stroke. Fills and the editable rect /
        // ellipse stay exactly as designed. Groups higher in the list render on top.
        var aligned = false, closed = isClosed(g);
        for (k = 0; k < strokes.length; k++) if (closed && strokes[k].align && strokes[k].align !== "CENTER") aligned = true;

        if (aligned) {
            for (k = 0; k < strokes.length; k++) {
                s = strokes[k];
                var sg = root.addProperty("ADBE Vector Group");
                sg.name = strokes.length > 1 ? "Stroke " + (k + 1) : "Stroke";
                var sv = sg.property("ADBE Vectors Group");
                addGeometry(sv, g);
                if (s.align === "INSIDE" || s.align === "OUTSIDE") {
                    var off = sv.addProperty("ADBE Vector Filter - Offset");
                    off.property("ADBE Vector Offset Amount").setValue((s.align === "INSIDE" ? -1 : 1) * s.width / 2);
                    off.property("ADBE Vector Offset Line Join").setValue(JOINS[s.join] || 1);
                }
                addStroke(sv, s, ctx, L.name);
            }
        }

        var grp = root.addProperty("ADBE Vector Group");
        grp.name = L.name;
        var vecs = grp.property("ADBE Vectors Group");
        addGeometry(vecs, g);
        // Items higher in the group render on top: strokes first (top-most first), then fills.
        if (!aligned) for (k = 0; k < strokes.length; k++) addStroke(vecs, strokes[k], ctx, L.name);
        for (k = 0; k < fills.length; k++) {
            var f = vecs.addProperty("ADBE Vector Graphic - Fill");
            f.property("ADBE Vector Fill Color").setValue(rgb(fills[k]));
            f.property("ADBE Vector Fill Opacity").setValue(fills[k].a * 100);
            if (g.evenOdd) f.property("ADBE Vector Fill Rule").setValue(2);
        }
        return layer;
    }

    function makeText(comp, L, ctx) {
        var t = L.text;
        var str = t.chars.replace(/\r\n|\n/g, "\r");
        var box = t.mode === "box";
        var bw = Math.max(1, L.w + 2), bh = Math.max(1, L.h);
        var layer = box ? comp.layers.addBoxText([bw, bh], str) : comp.layers.addText(str);
        var prop = layer.property("ADBE Text Properties").property("ADBE Text Document");
        var td = prop.value;
        var s0 = t.segments[0];
        var ps = fontPS(s0);

        try { td.resetCharStyle(); td.resetParagraphStyle(); } catch (e) {}
        td.font = ps;
        td.fontSize = s0.size;
        td.applyFill = true;
        td.fillColor = s0.color;
        td.applyStroke = false;
        td.tracking = Math.round(s0.tracking || 0);
        if (t.leading) {
            try { td.autoLeading = false; } catch (e) {}
            td.leading = t.leading;
        }
        var just = {
            LEFT: ParagraphJustification.LEFT_JUSTIFY,
            CENTER: ParagraphJustification.CENTER_JUSTIFY,
            RIGHT: ParagraphJustification.RIGHT_JUSTIFY,
            JUSTIFIED: ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT
        }[t.align];
        if (just) td.justification = just;
        prop.setValue(td);

        if (prop.value.font !== ps) ctx.warn('Font "' + (s0.ps || s0.family + " " + s0.style) + '" isn\'t installed; AE substituted one.');

        // Per-character styling (AE 24.3+).
        if (t.segments.length > 1) {
            try {
                td = prop.value;
                for (var k = 1; k < t.segments.length; k++) {
                    var sg = t.segments[k];
                    var cr = td.characterRange(sg.start, sg.end);
                    cr.font = fontPS(sg);
                    cr.fontSize = sg.size;
                    cr.fillColor = sg.color;
                    cr.tracking = Math.round(sg.tracking || 0);
                }
                prop.setValue(td);
            } catch (e) {
                ctx.warn('"' + L.name + '": mixed styles need AE 24.3+; used the first style.');
            }
        }

        // Anchor:  "baseline" = position is the first baseline origin (Illustrator point text),
        //          "box"      = position is the center of the text box,
        //          otherwise  = position is the center of the visible text.
        var anchor = t.anchor || (box ? "box" : "center");
        var ax, ay;
        if (anchor === "baseline") {
            ax = 0; ay = 0;
        } else {
            if (anchor === "box" && box) {
                try {
                    var bp = prop.value.boxTextPos;
                    ax = bp[0] + bw / 2;
                    ay = bp[1] + bh / 2;
                } catch (e) {}
            }
            if (ax === undefined) {
                var rc = layer.sourceRectAtTime(0, false);
                ax = rc.left + rc.width / 2;
                ay = rc.top + rc.height / 2;
            }
        }
        layer.transform.anchorPoint.setValue([ax, ay]);
        return layer;
    }

    function makeImage(comp, L, ctx) {
        var img = L.image, file;
        if (img.path) {
            file = new File(img.path);
        } else if (img.src) {
            var src = new File(img.src);
            if (!src.exists) throw new Error("Image not found: " + img.src);
            file = new File(ctx.dir().fsName + "/" + img.file);
            if (!src.copy(file.fsName)) throw new Error("Couldn't copy " + img.src);
        } else if (img.data) {
            file = new File(ctx.dir().fsName + "/" + img.file);
            file.encoding = "BINARY";
            if (!file.open("w")) throw new Error("Can't write " + file.fsName);
            file.write(b64decode(img.data));
            file.close();
        } else {
            throw new Error("image has no data");
        }
        if (!file.exists) throw new Error("Image file missing: " + file.fsName);
        var layer = comp.layers.add(importFootage(file, ctx));
        var s = 100 / (img.scale || 1);
        layer.transform.scale.setValue([s, s]);
        if (L.reason) layer.comment = "Ascend: rasterized (" + L.reason + ")";
        return layer;
    }

    function applyCommon(layer, L) {
        if (L.name) layer.name = L.name;
        layer.transform.position.setValue([L.x, L.y]);
        if (L.rotation) layer.transform.rotation.setValue(L.rotation);
        if (L.flipX) {
            var sc = layer.transform.scale.value;
            layer.transform.scale.setValue([-sc[0], sc[1]]);
        }
        if (L.opacity !== undefined && L.opacity < 100) layer.transform.opacity.setValue(Math.max(0, L.opacity));
        if (L.blend && BlendingMode[L.blend] !== undefined) layer.blendingMode = BlendingMode[L.blend];
    }

    function applyMatte(layer, src, luma) {
        var type = luma ? TrackMatteType.LUMA : TrackMatteType.ALPHA;
        if (typeof layer.setTrackMatte === "function") {
            // AE 2023+: any layer can be the matte, and several layers can share it.
            layer.setTrackMatte(src, type);
            return null;
        }
        // Older AE: the matte must sit directly above, so each clipped layer gets its own copy.
        var dup = src.duplicate();
        dup.name = src.name + " (matte)";
        dup.moveBefore(layer);
        layer.trackMatteType = type;
        dup.enabled = false;
        return dup;
    }

    // ------------------------------------------------------------ build

    function build(data, opts) {
        if (!data || !FORMATS[data.format] || !(data.layers instanceof Array)) {
            throw new Error("This isn't an Ascend export.");
        }
        var warnings = [], errors = [], count = 0, dirCache = null, binCache = null, i, L;
        var ctx = {
            warn: function (m) { warnings.push(m); },
            dir: function () { return dirCache || (dirCache = assetFolder()); },
            bin: function () { return binCache || (binCache = binFolder()); }
        };
        var built = {}; // payload id -> AE layer
        var mattesUsed = {};

        app.beginUndoGroup("Ascend: Build");
        try {
            var comp = opts.useActive && app.project.activeItem instanceof CompItem ? app.project.activeItem : null;
            if (!comp) {
                comp = app.project.items.addComp(data.name || "Ascend", clampDim(data.width), clampDim(data.height), 1, 10, 30);
                try { comp.openInViewer(); } catch (e) {}
            }

            for (i = 0; i < data.layers.length; i++) {
                L = data.layers[i];
                try {
                    var layer = null;
                    if (L.type === "shape") layer = makeShape(comp, L, ctx);
                    else if (L.type === "text") layer = makeText(comp, L, ctx);
                    else if (L.type === "image") layer = makeImage(comp, L, ctx);
                    if (layer) {
                        applyCommon(layer, L);
                        if (L.id !== undefined) built[L.id] = layer;
                        count++;
                    }
                } catch (e) {
                    errors.push((L.name || "layer " + i) + ": " + e.message);
                }
            }

            // Masks / clipping groups -> track mattes.
            for (i = 0; i < data.layers.length; i++) {
                L = data.layers[i];
                if (L.matte === undefined || L.matte === null) continue;
                var target = built[L.id], src = built[L.matte];
                if (!target || !src) continue;
                try {
                    applyMatte(target, src, L.matteLuma);
                    mattesUsed[L.matte] = true;
                } catch (e) {
                    errors.push(L.name + ": couldn't set track matte (" + e.message + ")");
                }
            }
            for (i = 0; i < data.layers.length; i++) {
                L = data.layers[i];
                var m = built[L.id];
                if (!m || !mattesUsed[L.id]) continue;
                // Figma masks / Illustrator clipping paths are invisible; Photoshop clipping bases stay visible.
                m.enabled = !L.matteSource;
            }

            // Groups -> null layers, parented so the hierarchy survives.
            if (opts.groups && data.groups instanceof Array && data.groups.length) {
                var nulls = {}, g;
                for (i = data.groups.length - 1; i >= 0; i--) {
                    g = data.groups[i];
                    var nl = comp.layers.addNull();
                    nl.name = g.name || "Group";
                    nl.transform.position.setValue([g.x, g.y]);
                    if (g.rotation) nl.transform.rotation.setValue(g.rotation);
                    nl.label = 2; // yellow
                    nulls[g.id] = nl;
                }
                for (i = 0; i < data.groups.length; i++) {
                    g = data.groups[i];
                    if (g.parent !== undefined && nulls[g.parent]) nulls[g.id].parent = nulls[g.parent];
                }
                for (i = 0; i < data.layers.length; i++) {
                    L = data.layers[i];
                    if (built[L.id] && L.parent !== undefined && nulls[L.parent]) built[L.id].parent = nulls[L.parent];
                }
            }
        } finally {
            app.endUndoGroup();
        }
        return { comp: comp, count: count, errors: errors, warnings: warnings.concat(data.warnings || []) };
    }

    // "Make comp" from Photoshop / Illustrator: one empty comp per artboard (or the canvas),
    // same pixel size. Frame rate and duration follow the active comp if there is one.
    function makeComps(data) {
        if (!(data.comps instanceof Array) || !data.comps.length) throw new Error("No artboards were sent.");
        var ref = app.project.activeItem instanceof CompItem ? app.project.activeItem : null;
        var fps = ref ? ref.frameRate : 30, dur = ref ? ref.duration : 10;
        var names = [], last = null;
        app.beginUndoGroup("Ascend: Make comps");
        try {
            for (var i = 0; i < data.comps.length; i++) {
                var c = data.comps[i];
                last = app.project.items.addComp(c.name || "Ascend", clampDim(c.width), clampDim(c.height), 1, dur, fps);
                names.push(last.name + " " + last.width + "\u00D7" + last.height);
            }
        } finally {
            app.endUndoGroup();
        }
        try { if (last) last.openInViewer(); } catch (e) {}
        return names;
    }

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


    // ------------------------------------------------------------ API used by panel.js
    function call(fn) {
        try { return toJSON(fn()); } catch (e) { return toJSON({ ok: false, error: String(e.message || e) }); }
    }
    function readText(path) {
        var f = new File(path);
        f.encoding = "UTF-8";
        if (!f.open("r")) throw new Error("Couldn't read " + path);
        var t = f.read();
        f.close();
        return t;
    }

    G.AscendAE = {
        // Where pulled PNGs go: ./Ascend next to the saved project, or a folder the user picks.
        assetDir: function () {
            return call(function () {
                if (app.project.file) return { ok: true, dir: app.project.file.parent.fsName + "/Ascend" };
                var f = Folder.selectDialog("Save the project first, or choose a folder for Ascend's images.");
                return f ? { ok: true, dir: f.fsName } : { ok: false, cancelled: true, error: "No image folder chosen." };
            });
        },
        info: function () {
            return call(function () {
                var c = app.project && app.project.activeItem instanceof CompItem ? app.project.activeItem : null;
                return { ok: true, comp: c ? c.name : "", saved: !!(app.project && app.project.file) };
            });
        },
        // path: the pulled payload (JSON file written by the panel); dir: folder holding its PNGs.
        buildFile: function (path, dir, useActive, groups) {
            return call(function () {
                pulledDir = dir ? new Folder(dir) : null;
                var data = parseJSON(readText(path));
                if (data.kind === "comps") {
                    var made = makeComps(data);
                    return { ok: true, kind: "comps", comps: made };
                }
                var res = build(data, { useActive: !!useActive, groups: !!groups });
                return { ok: true, kind: "layers", count: res.count, comp: res.comp.name, source: data.source || "", errors: res.errors, warnings: res.warnings };
            });
        }
    };
})($.global);
