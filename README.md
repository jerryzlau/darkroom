# Darkroom

A personal, Lightroom-style photo editor for macOS: catalog, cull, develop RAW/JPEG/HEIC non-destructively, and export.

## Features
- **Library**: import folders (recursive), virtualized grid, loupe, filmstrip, ratings, picks/rejects, color labels, keywords, filters and search, collections and smart collections, virtual copies, XMP sidecars.
- **Develop** (GPU, real time): white balance (temperature/tint, eyedropper, auto), exposure, contrast, highlights, shadows, whites, blacks, texture, clarity, dehaze, vibrance, saturation, parametric + point tone curves (per channel), color mixer (HSL), B&W mix, color grading wheels, sharpening, noise reduction, lens distortion/vignetting/CA, post-crop vignette, grain, crop/straighten/rotate/flip, local masks (linear, radial, brush) with luminance/color range, presets, snapshots, unlimited history, copy/paste settings, before/after, clipping display, 100%+ zoom with full-resolution rendering.
- **Export**: JPEG, PNG, TIFF (8/16-bit), sRGB/Display P3/ProPhoto with embedded ICC profile and EXIF, resizing, file name templates. Rendered through the same pipeline as the screen.
- **Formats**: RAW from most cameras via rawler (CR2/CR3/NEF/ARW/RAF/ORF/RW2/DNG/…), JPEG, PNG, TIFF, WebP, HEIC/HEIF (via macOS).

## Run
```bash
pnpm install
pnpm dev          # development app
pnpm build        # Darkroom.app in apps/desktop/src-tauri/target/release/bundle/macos
```
Requires Rust (`brew install rustup && rustup-init`), Node 20+, pnpm, Xcode command line tools.

Your originals are never modified. The catalog lives in `~/Library/Application Support/app.darkroom.editor/`.
