# Lightroom-style Photo Editor — Build Plan

Working name: **Darkroom** (the folder is `photoshop/`, but "Photoshop" is a trademark; rename the folder when you pick a name).

## Status (2026-10-09)

Built and tested: Phases 0–6, plus spot removal (heal/clone) from Phase 7 and catalog backups and DMG packaging from Phase 8.

Deviations from the original plan, decided during Phase 0:
- **WebGL2 instead of WebGPU.** WebGL2 with `EXT_color_buffer_float` is guaranteed in WKWebView and in every browser used for testing, and the stage design is the same. Intermediates are RGBA32F (RGBA16F for large zoom regions).
- **rawler (pure Rust) instead of LibRaw.** No C++ build, demosaic and camera matrices included. It is LGPL-2.1.
- **HEIC via macOS `sips`** instead of libheif, so there is no extra native dependency.
- **Hand-written validators** (`normalizeParams`) instead of zod.
- **Previews are built on first open**, then cached (zstd, 6 GB cap), rather than for every photo at import.

Still open from the roadmap: lens profile database (lensfun), ML subject/sky masks, ML denoise, perspective/upright, panorama/HDR merge, folder watching (there is a "Synchronize folder" action), and a Lightroom catalog importer.

## 0. Goals, assumptions, non-goals

**Goal.** A personal, local-first macOS app for importing, culling, organizing, non-destructively editing, and exporting photos (RAW, JPEG, HEIC). The editing model is Lightroom's: a photo is never modified; edits are a document of slider values that is re-rendered on demand.

**Assumptions** (change the plan if any are wrong):
- macOS only to start (Apple Silicon, macOS 26). The stack is cross-platform if you ever want Windows/Linux.
- Single user, single catalog, no accounts, no cloud sync.
- Photos stay where they are on disk (Lightroom "Add" semantics). The app never moves or rewrites originals.
- You shoot RAW on at least one camera, plus iPhone HEIC/JPEG.
- You will build it with Claude Code, so the plan optimizes for a stack where most code is TypeScript and the hard native pieces are isolated behind a small Rust API.

**Non-goals for v1.** Layers and pixel compositing (that is Photoshop, not Lightroom), cloud sync, mobile, tethering, printing, plugins, a Lightroom catalog importer. Each can be added later without changing the architecture.

## 1. Architecture

```
┌──────────────────────────── Tauri 2 app (macOS) ────────────────────────────┐
│  WebView: React + TypeScript                 Rust core (tokio, rayon)        │
│  ├─ Library UI: grid, filmstrip, loupe       ├─ Catalog: SQLite (rusqlite)   │
│  ├─ Develop UI: panels, sliders, masks       ├─ Import + folder watcher      │
│  ├─ Render engine: WebGPU / WGSL   ◄──IPC──► ├─ Decoders: LibRaw, libheif,   │
│  │     one pipeline for preview + export     │     JPEG/PNG/TIFF             │
│  ├─ Edit state: zustand + zod schema         ├─ Thumbnail + preview cache    │
│  └─ Histogram, clipping, before/after        ├─ Metadata: EXIF / XMP         │
│                                              └─ Export encoders + ICC        │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Three rules that keep this tractable:**
1. **Edits are data.** A photo's edit is a versioned JSON document (`EditParams`). Everything else (history, presets, copy/paste, sync, XMP sidecars) is just manipulating that document.
2. **Rendering is a pure function** `render(sourcePixels, params, outputSize) -> pixels`, implemented once in GPU shaders. Preview and export go through the same shaders, so what you see is what you get.
3. **Rust does I/O and decoding; the webview does pixels and UI.** Rust never applies edits. The webview never touches the filesystem directly.

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri 2 | Small binary, native WKWebView, Rust backend with typed IPC. You know Electron; Tauri is the same shape with a better native story for heavy work. |
| UI | React 19, TypeScript, Vite, Tailwind, zustand | Fastest way to build dense panel UIs. zustand for edit/UI state (no server state to speak of). |
| Edit schema | zod | Versioned `EditParams` with migrations, validated at every boundary (catalog, presets, XMP, IPC). |
| GPU | WebGPU (WGSL) in the webview | Compute shaders for histogram and blurs, `rgba16float` textures, modern API. **Phase 0 must verify WebGPU is on in WKWebView on your macOS build; fallback is WebGL2 with the same stage design.** |
| RAW decode | LibRaw via Rust FFI (static, vendored) | Mature demosaic and camera support. Pure-Rust `rawler` is the swap-in later if you want to drop C. |
| HEIC | libheif (`libheif-rs`) | iPhone photos, 10-bit. WKWebView can also display HEIC natively for quick previews. |
| JPEG/PNG/TIFF | `image`, `zune-jpeg`, `tiff` crates | Decode and 8/16-bit encode. `mozjpeg` for high-quality JPEG export. |
| Metadata | `kamadak-exif` (read), `img-parts` (write EXIF/ICC into JPEG/PNG), own XMP writer | Preserve camera metadata on export; write Lightroom-compatible XMP sidecars. |
| Color | `lcms2` for ICC on export; matrices in shaders at runtime | Camera matrix → linear working space → display/output. |
| Catalog | SQLite via `rusqlite` (bundled), migrations in Rust | Single file, fast, trivially backed up. |
| Thumbnails | `fast_image_resize` + `mozjpeg`, rayon worker pool | SIMD downscale, parallel generation. |
| ML (later) | `ort` (ONNX Runtime) with CoreML provider | Subject/sky masks, denoise, upscaling. |
| Tests | Vitest, Rust `cargo test`, golden-image tests | See §8. |

**Alternatives considered.**
- *Swift + SwiftUI + Core Image.* Core Image's RAW filter gives demosaic, WB, and noise reduction for free, and PhotoKit integration is easy. Rejected because the dense Lightroom-style UI is slower to build in SwiftUI, you would be writing Swift instead of TypeScript, and it locks you to Apple forever. Worth revisiting only if LibRaw coverage of your camera is poor.
- *Electron + LibRaw compiled to WASM.* Familiar, but WASM LibRaw is slow on 50MP files, single-threaded unless you fight for SharedArrayBuffer, and you still need native code for HEIC and 16-bit export. Tauri gives you real threads for free.
- *Pure web app (Next.js on Vercel).* No access to the filesystem at scale, no RAW decoding worth using, and uploading 40MB files to edit them is a non-starter. A web viewer for exported JPEGs could be a later add-on.

## 3. Data model

### 3.1 On disk

```
~/Library/Application Support/Darkroom/
  catalog.sqlite                 # everything structured
  cache/
    thumbs/<sha1[:2]>/<sha1>/256.jpg   # grid thumbnails
    thumbs/<sha1[:2]>/<sha1>/1024.jpg  # loupe / filmstrip
    previews/<sha1[:2]>/<sha1>/2560.rgb16   # linear camera-space RGB, 16-bit, long edge 2560
    masks/<edit_id>/<mask_id>.r8        # rasterized brush masks
  presets/*.json
```

- The 2560 preview is the key performance trick. Decoding a RAW takes roughly a second; the preview is built once at import (background) so opening Develop is instant. It is stored *pre white balance, post demosaic, in camera RGB*, so WB and camera matrix are applied in the shader and remain fully editable. Full-resolution decode happens only for 1:1 zoom and export.
- JPEG/HEIC sources get no 16-bit preview; they decode fast enough on the fly. They enter the pipeline as sRGB/Display P3 and are linearized in the shader.
- Optional: write an XMP sidecar next to each edited photo (`IMG_1234.xmp`) so edits survive catalog loss and Lightroom can read ratings, labels, and keywords.

### 3.2 SQLite schema (initial)

```sql
folders(id, path UNIQUE, parent_id, last_scanned_at)
photos(id, folder_id, filename, path UNIQUE, sha1, size, mtime,
       format, width, height, orientation,
       captured_at, camera_make, camera_model, lens, focal_length, aperture,
       shutter, iso, gps_lat, gps_lon,
       rating 0..5, flag (-1 reject, 0 none, 1 pick), color_label,
       preview_state, thumb_state, created_at, updated_at)
edits(id, photo_id, name /* for virtual copies */, is_default,
      params_json, params_version, updated_at)
history(id, edit_id, seq, label, params_json, created_at)
snapshots(id, edit_id, name, params_json, created_at)
presets(id, group_name, name, params_json /* partial */, created_at)
collections(id, name, parent_id, is_smart, rule_json)
collection_photos(collection_id, photo_id, position)
keywords(id, name, parent_id); photo_keywords(photo_id, keyword_id)
jobs(id, kind, payload_json, state, error, created_at)  -- import/thumb/preview/export queue
```

### 3.3 EditParams (the heart of the app)

```ts
type EditParams = {
  version: 1,
  // geometry
  crop: { x, y, w, h, angle, aspect? } | null,
  flipH: boolean, flipV: boolean, rotate90: 0|1|2|3,
  // white balance (camera space)
  wb: { mode: 'asShot'|'custom', temperature: number, tint: number },
  // tone
  exposure: number, contrast: number, highlights: number, shadows: number,
  whites: number, blacks: number,
  // presence
  texture: number, clarity: number, dehaze: number, vibrance: number, saturation: number,
  // curves
  toneCurve: { parametric: {highlights, lights, darks, shadows}, points: {rgb, r, g, b: Pt[]} },
  // color
  hsl: { hue: number[8], saturation: number[8], luminance: number[8] },
  colorGrading: { shadows: HS, midtones: HS, highlights: HS, blending, balance },
  // detail
  sharpening: { amount, radius, detail, masking },
  noise: { luminance, luminanceDetail, color, colorDetail },
  // optics
  lens: { profileCorrection: boolean, chromaticAberration: boolean, vignette: number, distortion: number },
  // effects
  vignette: { amount, midpoint, roundness, feather }, grain: { amount, size, roughness },
  // local
  masks: Mask[],   // each: { id, name, kind: brush|linear|radial|luminance|color|subject|sky, ...geometry, invert, adjustments: Partial<LocalParams> }
}
```

Every slider is a field here. Presets are `Partial<EditParams>`. "Copy settings" is a field-mask. History is a list of full snapshots (they are tiny). A `migrate(params)` function moves old versions forward; never change semantics of an existing field, add a new one.

## 4. Image pipeline

All stages run in WGSL on `rgba16float` textures unless noted. Order matters and mirrors Lightroom's processing order closely enough that sliders feel familiar.

| # | Stage | Where | Notes |
|---|---|---|---|
| 1 | Decode | Rust | LibRaw: black/white level, demosaic (AHD or DCB), output linear camera RGB 16-bit, plus `cam_xyz` matrix, as-shot WB multipliers, orientation. JPEG/HEIC: decode to 8/10-bit, record color space. |
| 2 | Upload | JS | Camera RGB as `rgba16float` (preview) or tiles of up to 4096² (export). |
| 3 | White balance | GPU | Per-channel multiply in camera space. Temperature/tint UI maps to multipliers via the camera matrix (standard CCT math). |
| 4 | Camera → working space | GPU | 3x3 matrix: camera → XYZ(D50) → linear ProPhoto RGB. Lightroom's working space; wide enough that nothing clips. |
| 5 | Lens corrections | GPU | Distortion and CA as a texture-coordinate remap, vignette as radial gain. Profiles from lensfun database (Phase 7). |
| 6 | Exposure | GPU | `rgb *= 2^exposure`. |
| 7 | Highlights / Shadows / Whites / Blacks | GPU | Luminance-weighted soft masks (blurred luminance for H/S so halos stay small); whites/blacks move the endpoints. Start simple, tune by eye against Lightroom on the same file. |
| 8 | Contrast + base tone curve | GPU | S-curve around middle grey in a perceptual space, then the user's parametric and point curves via a 1-D LUT texture. |
| 9 | Presence | GPU | Clarity = local contrast (large-radius unsharp on luminance). Texture = same at small radius. Dehaze = dark-channel-prior approximation. Vibrance/saturation in an OKLab-ish space to avoid hue shifts. |
| 10 | HSL + color grading | GPU | Hue-range weighted adjustments; 3-way wheels blend by luminance. |
| 11 | Local adjustments | GPU | For each mask: rasterize to R8 texture (brush strokes, gradients, range masks, ML masks), then re-run a subset of stages 6–10 blended by the mask. |
| 12 | Detail | GPU | Sharpening = unsharp mask on luminance with edge masking. Noise reduction: start with bilateral/guided filter; swap in an ML denoiser later. Applied before sharpening. |
| 13 | Effects | GPU | Post-crop vignette, film grain (hash noise). |
| 14 | Geometry | GPU | Crop, rotate, straighten, flip as the sampling transform of the final pass (so earlier passes work on uncropped data and edges stay clean). |
| 15 | Output transform | GPU | Working space → display (sRGB or Display P3 canvas) with proper OETF, soft-clip out-of-gamut, dither to 8-bit. For export: → sRGB / Display P3 / ProPhoto as chosen. |
| 16 | Histogram + clipping | GPU compute | 256-bin RGB+L histogram from the final texture; clipping overlays from stage 15 input. |
| 17 | Encode | Rust | Readback 16-bit tiles → stitch → JPEG (mozjpeg, quality, chroma subsampling), TIFF 8/16-bit, PNG. Embed ICC + copied EXIF/XMP via lcms2 and img-parts. Resize with Lanczos before encode when exporting at reduced size. |

**Performance strategy.**
- Three resolutions: *fit* (what fills the viewport, usually ≤ 2560), *1:1* (full-res tiles around the viewport), *export* (full-res, all tiles). Sliders always drag against *fit*; 1:1 re-renders on release.
- Cache intermediate textures per stage. Dragging "vibrance" must not re-run demosaic or lens correction; invalidate from the changed stage onward.
- Blurs (clarity, H/S masks, noise) run on a downscaled copy and upsample; this is what Lightroom does and it is 10× cheaper.
- Budget: any slider drag re-renders fit view in < 16 ms on Apple Silicon. Opening Develop on a cached preview < 100 ms. Export of a 24MP RAW to JPEG < 3 s.

**Color management.** Treat the canvas as Display P3 when the display supports it (`canvas.getContext('webgpu')` + `configure({ format, colorSpace: 'display-p3' })`), otherwise sRGB; macOS ColorSync handles the display profile. Export embeds the chosen ICC profile. Working space is linear ProPhoto; never do math in gamma-encoded space except where Lightroom deliberately does (contrast, curves).

## 5. UI

**Modules** (top-right switcher, like Lightroom): **Library** and **Develop**. Everything else (Export, Presets, Import) is a dialog or a panel.

**Layout.**
- Left panel: Folders tree, Collections, Presets (Develop only), Navigator thumbnail with zoom level.
- Center: Grid (Library) or Loupe/Develop canvas; Filmstrip along the bottom, collapsible.
- Right panel (Library): Histogram, Quick Develop, Metadata, Keywords.
- Right panel (Develop): Histogram, tool strip (crop, heal, masks, red-eye), then collapsible sections: Basic, Tone Curve, Color Mixer (HSL), Color Grading, Detail, Lens Corrections, Effects. Each section has a power toggle and a reset.
- Top bar: module switcher, view modes (grid/loupe/compare/survey), sort, filter bar (rating, flag, color, text).

**Interactions to get right early** (they define the feel):
- Sliders: drag, scroll-wheel nudge, double-click to reset, shift for fine, arrow keys, numeric entry.
- `\` before/after, `Y` side-by-side, `Cmd+Z` undo through history, `Cmd+Shift+C/V` copy/paste settings with a field picker.
- Keys: `G` grid, `E` loupe, `D` develop, `1–5` stars, `P/X/U` pick/reject/unflag, `6–9` color labels, `R` crop, `K` brush mask, `M` linear gradient, `Shift+M` radial, space to toggle zoom, arrows to move.
- Grid: virtualized (thousands of photos), lazy thumbs, multi-select, drag to collections.
- Crop tool: overlay with rule-of-thirds, aspect lock, straighten by dragging a line, angle wheel.

**Import.** Pick folders; scan recursively; hash + read EXIF; enqueue thumbnail and preview jobs; watch folders for new files (`notify` crate). Show progress in the top bar. Re-import is idempotent (keyed by path + mtime, sha1 on change).

## 6. Roadmap

Each phase ends with a usable app. Rough durations assume one person with Claude Code, part-time; they are guesses, not commitments.

| Phase | Deliverable | Done when | Rough time |
|---|---|---|---|
| 0 | Spikes + scaffold | Tauri app opens; WebGPU renders a triangle in WKWebView (or WebGL2 fallback decided); Rust decodes one RAW via LibRaw and the webview displays it; SQLite migration runs; repo has lint/test/CI scripts. | 2–4 days |
| 1 | Library MVP | Import a folder of mixed RAW/JPEG/HEIC; grid with virtualized thumbnails; loupe with zoom/pan; EXIF panel; rating/flag/color labels; filter bar; folders tree; filmstrip. Catalog survives restart. | 1–2 weeks |
| 2 | Develop MVP | Basic panel end-to-end on GPU: WB, exposure, contrast, H/S/W/B, vibrance, saturation. Histogram + clipping. Before/after. Undo. 2560 previews built at import. Edits persist. | 2 weeks |
| 3 | Export | Export dialog: format, quality, color space, resize, sharpening-for-output, filename template, destination. Metadata and ICC embedded. Batch export with queue + progress. Full-res tiled render matches preview. | 3–5 days |
| 4 | Full Develop | Tone curve (parametric + point), Color Mixer, Color Grading, Clarity/Texture/Dehaze, Sharpening, basic NR, Vignette/Grain, Crop/Straighten/Rotate/Flip. Per-section reset and toggles. | 2–3 weeks |
| 5 | Workflow | Presets (save/apply/groups), copy/paste/sync settings, history panel, snapshots, virtual copies, compare/survey views, keywords, smart collections, XMP sidecar write/read, auto-advance culling. | 1–2 weeks |
| 6 | Local adjustments | Mask system: brush (pressure, feather, flow, erase), linear + radial gradients, luminance/color range masks, mask overlay, add/subtract/intersect, per-mask local params. | 2 weeks |
| 7 | Advanced | Lens profiles (lensfun), CA removal, ML subject/sky masks (ONNX), spot heal/clone (content-aware is stretch), ML denoise, perspective/upright, panorama/HDR merge (stretch). | ongoing, 3–7 days each |
| 8 | Polish + ship | App icon, signed + notarized DMG, crash-safe catalog (WAL, backups on launch), preferences, performance pass on 50MP files, memory caps, keyboard reference. | 1 week |

Stop after Phase 3 and you already have something you can use daily for RAW → JPEG. Phases 4–6 are what make it feel like Lightroom.

## 7. Repo layout

```
photoshop/
  package.json  pnpm-workspace.yaml  tsconfig.base.json
  apps/desktop/                 # Tauri app
    src/                        # React
      app/                      # routes/modules: library, develop
      components/               # panels, sliders, grid, canvas
      engine/                   # WebGPU pipeline: stages/, shaders/*.wgsl, textures, histogram
      state/                    # zustand stores, selectors
      ipc/                      # typed wrappers over tauri invoke (one file per Rust command group)
    src-tauri/
      src/
        main.rs  commands/      # catalog, import, decode, cache, export, metadata
        catalog/ (schema.rs, migrations/, queries.rs)
        decode/  (raw.rs, heic.rs, image.rs)
        cache/   (thumbs.rs, previews.rs)
        export/  (encode.rs, color.rs, metadata.rs)
        jobs/    (queue.rs, worker.rs)
      Cargo.toml  tauri.conf.json
  packages/edit-schema/         # zod EditParams, migrations, presets format, XMP mapping (shared, pure TS)
  packages/color/               # pure-TS color math (CCT↔WB, matrices, OKLab) with tests; mirrored in WGSL
  test-images/                  # a few CC0 RAWs from raw.pixls.us + JPEG/HEIC samples (git-lfs or download script)
  PLAN.md  CLAUDE.md
```

Rust ↔ TS contract: every IPC command has a zod schema on the TS side and a serde struct on the Rust side; binary payloads (pixels) go through Tauri's binary IPC response or a custom `darkroom://` URI scheme served by Rust, never base64.

## 8. Testing and quality

- **Decode**: Rust tests over `test-images/` asserting dimensions, matrix presence, WB values, orientation, and a checksum of the first rows.
- **Pipeline golden tests**: render `(image, params)` pairs headless and compare to stored PNGs with a PSNR threshold. Run in CI on a Mac runner. Any intentional change to a stage regenerates goldens with a reviewed diff.
- **Preview ≡ export**: a test exports a crop at 1:1 and compares it to the fit-view render of the same region; max per-pixel delta must be tiny.
- **Schema**: Vitest for `EditParams` migrations, preset merging, copy/paste field masks, XMP round-trip.
- **Catalog**: Rust tests over migrations and queries on a temp DB; import idempotency; moved-file detection.
- **UI**: a few Playwright flows against the Vite dev build with a mocked IPC layer (import → rate → edit → export). Keep it small.
- **Lint/format**: ESLint + Prettier, `cargo clippy -D warnings`, `cargo fmt --check`, in a pre-commit hook and CI.

## 9. Risks

| Risk | Mitigation |
|---|---|
| WebGPU not available or buggy in WKWebView | Phase 0 spike decides. Stage design is API-agnostic; WebGL2 fallback costs mostly histogram and blur performance. |
| LibRaw lacks your newest camera | Check `raw.pixls.us` coverage for your bodies before Phase 0; fallback is `rawler` or Apple's RAW decoder via a tiny Swift helper. |
| Looks don't match Lightroom | They will not match exactly; Adobe's tone math is proprietary. Aim for "pleasing and predictable", tune H/S/W/B and contrast curves side by side with Lightroom on a dozen reference images. |
| Memory on 50MP files | Tile everything above 4096², cap concurrent decodes, drop intermediate caches under pressure. |
| Rust learning curve | Keep Rust surface small (I/O, decode, encode, DB). All image math and UI live in TS/WGSL. |
| Catalog corruption | SQLite WAL mode, daily backup copy on launch, XMP sidecars as the second source of truth. |
| Scope creep | Ship Phase 3 and use it for a month before Phase 6+. |

## 10. Day-one task list (Phase 0)

1. Install Rust (`rustup`) and Tauri prerequisites; `pnpm create tauri-app` with React + TS; commit.
2. Spike: WebGPU triangle in the Tauri window on your macOS build. Record the result in `CLAUDE.md`. If missing, enable it in `tauri.conf.json` webview flags or fall back to WebGL2.
3. Spike: add `libraw-sys` (or bindgen against a vendored LibRaw), decode one of your RAWs to 16-bit linear camera RGB, measure time.
4. Spike: send that buffer to the webview as a `rgba16float` texture and draw it with a trivial WB + gamma shader. This is the whole app in miniature.
5. Create `packages/edit-schema` with `EditParams` v1 and a default; wire a single exposure slider end-to-end.
6. Create the SQLite schema + migration runner; implement `import_folder` for JPEGs only; show a grid.
7. Download 5–10 CC0 RAWs (different makers) into `test-images/`; add the decode tests.
8. Write `CLAUDE.md`: stack, commands, the three rules from §1, how to run tests, where goldens live.
9. Set up CI (GitHub Actions, macOS runner): typecheck, vitest, cargo test, clippy.
10. Decide the app name and bundle id; set the icon placeholder.

After that, work the roadmap top to bottom. Each phase should get its own short spec file under `docs/` before coding, listing the IPC commands, schema changes, and acceptance checks for that phase.
