# Ascend: Figma · Photoshop · Illustrator → After Effects

One app. Install it, click **Install** next to each Adobe app, and from then on: **Send** in your design app, **Pull** in After Effects. Layers arrive at the same size and position, as editable AE layers. The look follows hamkobarezz.com: ink `#0d0d0f`, off-white `#efead8`, orange `#ff5a1f`, Inter Tight.

```
Figma / Photoshop / Illustrator ──Send──▶  Ascend app (tray / menu bar)  ◀──Pull── After Effects
```

## Install (for users)

1. Run **Ascend-Setup-x.y.z.exe** (Windows) or open **Ascend-x.y.z.dmg** and drag it to Applications (Mac).
2. Ascend opens and asks **"Open at login?"**. Say yes, and it starts quietly in the tray / menu bar every time.
3. In the app, click **Install** next to After Effects, Illustrator and Photoshop. It finds every version on the computer. Windows or macOS may ask for your password once, because Adobe's plugin folders are protected.
   - **After Effects:** a signed extension panel, installed through Adobe's own plugin installer. Open it from **Window → Extensions → Ascend**. No script settings to change.
   - **Illustrator:** the same signed extension. Open it from **Window → Extensions → Ascend**.
   - **Photoshop:** installed through Creative Cloud. Open it from **Plugins → Ascend**.
   - **Figma:** Figma doesn't let other apps install plugins. Click **Set up**: the app shows the plugin's `manifest.json`. In Figma, go to *Plugins → Development → Import plugin from manifest…* and pick it. You only do this once.
4. Done. The plugins find the app on their own, with no address or server to set up. Each panel shows **APP ONLINE** while the app is running. When the app updates, it refreshes the installed plugins too.

## What stays editable

| From | Becomes in After Effects |
|---|---|
| Rectangles, rounded rectangles, ellipses (Figma native; Photoshop/Illustrator paths that are really one of these shapes) | Shape layer with a **parametric** Rectangle/Ellipse, so size and roundness stay live |
| Any other vector: paths, compound paths, booleans, Photoshop shape layers | Shape layer with **bezier paths** |
| Solid fills and strokes | Shape Fill / Stroke |
| Text | **Live text**: font, size, color, tracking, leading, alignment, rotation; mixed styles on AE 24.3+ |
| Groups, frames, layers | **Null layers** with children parented |
| Figma masks, Photoshop clipping masks, Illustrator clipping groups | **Track mattes** |
| Opacity, blend modes, rotation, flips, names, stacking order | The same on the AE layer |
| Gradients, images, smart objects, pixel layers, layer styles (when set to Flatten), layer masks | Trimmed PNG at the exact spot, saved in `./Ascend` next to the `.aep` |

**Make comp** (Photoshop, Illustrator): sends only artboard sizes. Pull then creates one empty AE comp per artboard (or one for the Photoshop canvas), with the same name and pixel size.

## Build the installers (for you)

```powershell
npm install
```
```powershell
npm run dist:win
```
This writes `dist/Ascend-Setup-<version>.exe`.

A **.dmg can only be built on a Mac**. Either run `npm run dist:mac` on a Mac, or push this folder to GitHub and run the **Build installers** workflow (`.github/workflows/build.yml`). It builds both the `.exe` and a universal `.dmg` (Apple silicon + Intel) and attaches them to the run.

To try it without installing, run `npm start`. Plugin source folders: `cep/` (After Effects + Illustrator panel: `index.html`/`panel.js` for the UI, `host/ae.jsx` and `host/ai.jsx` for the app side), `photoshop-plugin/`, `figma-plugin/`. The relay can still run on its own with `npm run relay` (handy for testing; the app normally runs it).

**Plugin signing:** `npm run dist:win` packs `cep/` into `dist-plugins/ascend.zxp` and signs it with Adobe's ZXPSignCmd (`tools/zxpsign/`, from Adobe's CEP-Resources repo). The first build creates a self-signed certificate at `tools/zxpsign/ascend-cert.p12`. Keep that file, use the same one for every release, and set its password with `ASCEND_CERT_PASSWORD` (it's excluded from git). Adobe recommends signing on the platform you ship to, so the Mac build signs with the macOS tool.

**App signing:** the app installers are unsigned. Windows SmartScreen will show "More info → Run anyway" on first install. On Mac, the first launch needs right-click → **Open**. To remove those warnings you need a code-signing certificate (Windows) and an Apple Developer ID with notarization (Mac). electron-builder picks both up from environment variables.

## Known limits
- Gradients are flattened to PNG. AE scripting can't write gradient stops.
- Dashed strokes come through solid. Only the top stroke transfers. Inside/outside stroke on free-form paths is drawn centered.
- Photoshop adjustment layers aren't transferred. Illustrator live effects aren't visible to scripts.
- Only one mask per layer (an AE limit). Nested masks are flattened.
- Port 7777 is fixed. If something else is using it, the app says so in its status card.
- Not yet tested inside the real Adobe apps or Figma. Offline tests cover the geometry, units, relay, installers and the AE preference patch.
