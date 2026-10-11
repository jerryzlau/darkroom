# Darkroom

Local-first, non-destructive photo editor (Lightroom-style) for macOS. See PLAN.md for the design.

## Layout
- `packages/core` — pure TS shared logic: `EditParams` schema + normalization (`params.ts`), color science / white balance (`color.ts`), tone curves (`curves.ts`), crop geometry (`geometry.ts`), built-in presets. Vitest.
- `apps/desktop/src` — React UI.
  - `engine/` — WebGL2 render pipeline. `shaders.ts` holds every pass; `Engine.ts` caches per-stage textures keyed by the params each stage depends on.
  - `ipc/` — `Backend` interface; `tauri.ts` (real) and `mock.ts` (synthetic photos for `pnpm web`).
  - `state/` — zustand stores: `library.ts`, `develop.ts` (params, history, tools), `ui.ts`.
  - `lib/background.ts` — off-screen engine for tiled export and batch thumbnails. `lib/selftest.ts` — in-app E2E test.
  - AI Edit chat — `lib/ai.ts` (tool schema, patch sanitize/merge, model loop; DOM-free, tested), `lib/aiContext.ts` (render + metadata context), `state/aiChat.ts` (store), `components/develop/AiChat.tsx` (dock). Calls api.anthropic.com from the webview with the user's key.
  - Guided AI edit — `lib/guided.ts` (propose_options tool, round protocol, filter builder; tested), `state/guided.ts` (session store), `components/develop/GuidedPanel.tsx` (Guided tab of the AI dock). `lib/renderPreview.ts` renders arbitrary params to thumbnails through the on-screen engine (serialized, per-scope cancel).
  - Generative Fill — `lib/gemini.ts` (Nano Banana / Gemini image models via `@google/genai`: crop planning, prompt, request/response; DOM-free, tested), `lib/patchAssets.ts` (decoded fill PNG cache shared by engines), `state/generate.ts` (store), `components/develop/GeneratePanel.tsx` (Generate tab). Fills are `EditParams.patches` (sha256 of a PNG in `<data_dir>/patches/`, Rust `patches.rs`) composited in `Engine.runInput` after spots, through the selection's mask layer.
  - Filter library — user presets (`presets` table with description/favorite/source) shown as cards in `PresetsPanel`, managed in `components/dialogs/FilterLibraryDialog.tsx`; shared actions in `lib/presetActions.ts`.
- `apps/desktop/src-tauri` — Rust: SQLite catalog (`db.rs`), decoding via rawler / image / sips (`decode.rs`), import (`import.rs`), thumbnails, preview cache + full-res regions (`source.rs`), export encoders with ICC/EXIF (`export.rs`), XMP sidecars.

## Rules
1. Edits are data. Never modify originals. Everything is a function of `EditParams`.
2. One render pipeline for screen, thumbnails and export (WYSIWYG). Export renders tiles via `Engine.renderTile`.
3. Rust does I/O, decoding, encoding and the catalog. It never applies edits.
4. Params from disk go through `normalizeParams`; add fields with defaults, bump `PARAMS_VERSION` + `migrateParams` if semantics change.

## Commands
Rust needs `PATH=/opt/homebrew/opt/rustup/bin:$PATH` (scripts already set it).
- `pnpm dev` — run the app (Tauri dev, hot reload).
- `pnpm build` — release `.app` + `.dmg` in `apps/desktop/src-tauri/target/release/bundle/`.
- `pnpm web` — UI in a browser with the mock backend (http://localhost:1420). `window.__darkroom` exposes the stores in dev.
- `pnpm test` — core vitest + Rust unit/integration tests.
- `scripts/selftest.sh` — launches the release binary against an isolated catalog with synthetic raws, edits/exports, checks logs.
- Sample images: `cargo run --release --example make_samples -- <dir>` (in src-tauri).

## Gotchas
- WebGL2 + `EXT_color_buffer_float` is required (WKWebView on macOS supports it).
- Texture v=0 is the image top everywhere; only the on-screen final pass flips Y.
- No React StrictMode: double-mounted effects would recreate the GL context.
- rawler is LGPL-2.1 (fine for personal use; check before distributing).
