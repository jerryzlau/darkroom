//! Decoding: every supported file becomes a `SourceImage`: upright, linear,
//! 16-bit RGB in the source's own color space ("camera" for raw files, linear
//! sRGB or Display P3 for everything else), plus the color metadata the
//! renderer needs (XYZ->camera matrix, as-shot white balance multipliers).

use crate::error::{AppError, AppResult};
use fast_image_resize as fr;
use image::{DynamicImage, ImageDecoder};
use rawler::decoders::RawDecodeParams;
use rawler::imgop::develop::{Intermediate, ProcessingStep, RawDevelop};
use rawler::imgop::xyz::Illuminant;
use rawler::rawsource::RawSource;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceColor {
    pub is_raw: bool,
    /// Row-major XYZ(D65) -> camera matrix.
    pub xyz_to_cam: [f32; 9],
    /// As-shot WB multipliers, green normalized to 1.
    pub as_shot_mul: [f32; 3],
    /// "camera" | "srgb" | "p3"
    pub space: String,
}

pub struct SourceImage {
    pub width: usize,
    pub height: usize,
    /// Interleaved linear RGB, 0..65535.
    pub data: Vec<u16>,
    pub color: SourceColor,
}

// XYZ -> linear sRGB / Display P3 (D65)
const XYZ_TO_SRGB: [f32; 9] = [
    3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252,
];
const XYZ_TO_P3: [f32; 9] = [
    2.493_497, -0.931_383_6, -0.402_710_8, -0.829_489, 1.762_664, 0.0236247, 0.0358458, -0.0761724, 0.9568845,
];
const D65_XYZ: [f32; 3] = [0.95047, 1.0, 1.08883];

pub const RASTER_EXTS: &[&str] = &["jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "heif", "hif", "avif", "bmp", "gif"];

/// Classify a file by extension: "raw", "jpeg", "png", "tiff", "heic", "webp", or None.
pub fn format_for_path(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    let f = match ext.as_str() {
        "jpg" | "jpeg" => "jpeg",
        "png" => "png",
        "tif" | "tiff" => "tiff",
        "heic" | "heif" | "hif" | "avif" => "heic",
        "webp" => "webp",
        "bmp" | "gif" => "other",
        _ => {
            let upper = ext.to_ascii_uppercase();
            if rawler::decoders::supported_extensions().iter().any(|e| *e == upper) {
                "raw"
            } else {
                return None;
            }
        }
    };
    Some(f)
}

pub fn decode_file(path: &Path, format: &str) -> AppResult<SourceImage> {
    match format {
        "raw" => decode_raw(path),
        "heic" => {
            let tmp = sips_convert(path, None)?;
            let r = decode_raster(&tmp);
            let _ = std::fs::remove_file(&tmp);
            r
        }
        _ => decode_raster(path),
    }
}

// ---------------------------------------------------------------------------
// Raw
// ---------------------------------------------------------------------------

fn mat3_from_flat(m: &[f32]) -> [[f32; 3]; 3] {
    [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]]
}

pub fn raw_xyz_to_cam(raw: &rawler::RawImage) -> Option<[f32; 9]> {
    let (illu, m) = raw.color_matrix_find_first([
        Illuminant::D65,
        Illuminant::D55,
        Illuminant::D50,
        Illuminant::Daylight,
        Illuminant::D75,
        Illuminant::A,
        Illuminant::B,
        Illuminant::C,
        Illuminant::Flash,
    ])?;
    if m.len() < 9 {
        return None;
    }
    let m3 = mat3_from_flat(&m[..9]);
    let adapted = if illu == Illuminant::D65 {
        m3
    } else {
        rawler::imgop::chromatic_adaption::adapt_bradford(&illu, &Illuminant::D65, &m3)
    };
    let flat = [
        adapted[0][0], adapted[0][1], adapted[0][2], adapted[1][0], adapted[1][1], adapted[1][2], adapted[2][0],
        adapted[2][1], adapted[2][2],
    ];
    if flat.iter().all(|v| v.is_finite()) && flat.iter().any(|v| *v != 0.0) {
        Some(flat)
    } else {
        None
    }
}

fn daylight_mul(xyz_to_cam: &[f32; 9]) -> [f32; 3] {
    let c = mat_vec(xyz_to_cam, &D65_XYZ);
    let m = [1.0 / c[0].max(1e-6), 1.0 / c[1].max(1e-6), 1.0 / c[2].max(1e-6)];
    [m[0] / m[1], 1.0, m[2] / m[1]]
}

fn mat_vec(m: &[f32; 9], v: &[f32; 3]) -> [f32; 3] {
    [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ]
}

pub fn decode_raw(path: &Path) -> AppResult<SourceImage> {
    let src = RawSource::new(path)?;
    let decoder = rawler::get_decoder(&src)?;
    let params = RawDecodeParams::default();
    let raw = decoder.raw_image(&src, &params, false)?;
    let orientation = raw.orientation.to_u16();

    if raw.cpp == 3 && raw.clean_make == "Canon" {
        if let Some(img) = decode_canon_sraw(&src, &raw, orientation)? {
            return Ok(img);
        }
    }

    let xyz_to_cam = raw_xyz_to_cam(&raw);
    let steps = [
        ProcessingStep::Rescale,
        ProcessingStep::Demosaic,
        ProcessingStep::FujiRotate,
        ProcessingStep::CropActiveArea,
        ProcessingStep::CropDefault,
    ];
    let inter = RawDevelop::new_with(&steps).develop_intermediate(&raw)?;

    let (w, h, data, color) = match inter {
        Intermediate::ThreeColor(px) if xyz_to_cam.is_some() => {
            let m = xyz_to_cam.unwrap();
            let wb = raw.wb_coeffs;
            let mul = if wb[0].is_finite() && wb[1].is_finite() && wb[2].is_finite() && wb[1] > 0.0 && wb[0] > 0.0 && wb[2] > 0.0 {
                [wb[0] / wb[1], 1.0, wb[2] / wb[1]]
            } else {
                daylight_mul(&m)
            };
            let data = f32_rgb_to_u16(px.data.iter().flat_map(|p| p.iter().copied()));
            (px.width, px.height, data, SourceColor { is_raw: true, xyz_to_cam: m, as_shot_mul: mul, space: "camera".into() })
        }
        Intermediate::Monochrome(px) => {
            let data: Vec<u16> =
                px.data.iter().flat_map(|v| { let u = to_u16(*v); [u, u, u] }).collect();
            (px.width, px.height, data, SourceColor { is_raw: true, xyz_to_cam: XYZ_TO_SRGB, as_shot_mul: [1.0, 1.0, 1.0], space: "srgb".into() })
        }
        _ => {
            // Four-color sensors or missing matrices: let rawler calibrate to
            // linear sRGB with the camera's own white balance.
            let steps = [
                ProcessingStep::Rescale,
                ProcessingStep::Demosaic,
                ProcessingStep::FujiRotate,
                ProcessingStep::CropActiveArea,
                ProcessingStep::WhiteBalance,
                ProcessingStep::Calibrate,
                ProcessingStep::CropDefault,
            ];
            let inter = RawDevelop::new_with(&steps).develop_intermediate(&raw)?;
            match inter {
                Intermediate::ThreeColor(px) => {
                    let data = f32_rgb_to_u16(px.data.iter().flat_map(|p| p.iter().copied()));
                    (px.width, px.height, data, SourceColor { is_raw: true, xyz_to_cam: XYZ_TO_SRGB, as_shot_mul: [1.0, 1.0, 1.0], space: "srgb".into() })
                }
                _ => return Err(AppError::Raw("unsupported raw layout".into())),
            }
        }
    };
    let (data, w, h) = orient_rgb(&data, w, h, orientation);
    Ok(SourceImage { width: w, height: h, data, color })
}

/// Read the Canon "sRAW WB" coefficients (ColorData makernote entry, u16
/// indices 78..=81), mirroring rawler's `Cr2Decoder::get_sraw_wb`.
fn read_canon_sraw_wb(src: &RawSource) -> Option<[f32; 3]> {
    use rawler::formats::tiff::reader::TiffReader;
    use rawler::formats::tiff::{GenericTiffReader, IFD};
    use rawler::tags::TiffCommonTag;

    let tiff = match GenericTiffReader::new(&mut src.reader(), 0, 0, None, &[33424]) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("sRAW: cannot parse TIFF structure: {e:?}");
            return None;
        }
    };
    let root = tiff.root_ifd();
    let exif = root
        .sub_ifds()
        .get(&TiffCommonTag::ExifIFDPointer.into())
        .and_then(|s| s.first())
        .unwrap_or(root);
    let offset = exif.get_entry(TiffCommonTag::Makernote)?.offset()?;
    let makernote = match IFD::new(&mut src.reader(), offset as u32, 0, 0, exif.endian, &[]) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("sRAW: cannot parse makernote: {e:?}");
            return None;
        }
    };
    const COLOR_DATA: u16 = 0x4001;
    let levels = match makernote.get_entry_raw(COLOR_DATA, &mut src.reader()) {
        Ok(Some(l)) => l,
        Ok(None) => return None,
        Err(e) => {
            log::warn!("sRAW: cannot read ColorData: {e:?}");
            return None;
        }
    };
    let o = 78;
    Some([
        levels.get_force_u16(o) as f32,
        (levels.get_force_u16(o + 1) as f32 + levels.get_force_u16(o + 2) as f32) / 2.0,
        levels.get_force_u16(o + 3) as f32,
    ])
}

/// Decode a Canon sRAW/mRAW CR2 (3 components per pixel) ourselves.
///
/// rawler 0.8.0 converts the YCbCr lossless-JPEG data to RGB and multiplies
/// each channel by an integer gain derived from the ColorData "sRAW WB"
/// entry. For bodies with the `invert_sraw_wb` camera hint (5D III/IV, 6D,
/// 80D, 1DX II, 5DS, ...) it inverts the R/B gains (see dnglab issue #842),
/// then `Rescale` subtracts one black level from every channel after those
/// unequal gains, and the regular path applies white balance and the camera
/// matrix on top. The result is a strong teal/green (or magenta) cast.
///
/// The YCbCr->RGB output of an sRAW is in fact already white-balanced,
/// display-space (sRGB-primaries) linear RGB. So we undo rawler's per-channel
/// gains, subtract the black level in that space, normalise to the white
/// level, and skip both white balance and the camera matrix.
///
/// Returns `Ok(None)` when the needed metadata is missing so the caller can
/// fall back to the generic path.
fn decode_canon_sraw(src: &RawSource, raw: &rawler::RawImage, orientation: u16) -> AppResult<Option<SourceImage>> {
    use rawler::RawImageData;
    use rayon::prelude::*;

    let Some(coef) = read_canon_sraw_wb(src) else {
        log::warn!("sRAW: no sRAW WB in ColorData; using generic raw path");
        return Ok(None);
    };
    if coef.iter().any(|c| !c.is_finite() || *c <= 0.0) {
        log::warn!("sRAW: invalid sRAW WB {coef:?}; using generic raw path");
        return Ok(None);
    }
    let invert = raw.camera.find_hint("invert_sraw_wb");
    let gain = |v: f32| if invert { (1024.0f32 * 1024.0 / v) as i32 } else { v as i32 };
    let c = [gain(coef[0]), coef[1] as i32, gain(coef[2])];
    if c.iter().any(|v| *v <= 0) {
        log::warn!("sRAW: invalid gains {c:?}; using generic raw path");
        return Ok(None);
    }

    let g_gain = c[1] as f64 / 256.0;
    let bl = &raw.blacklevel.levels;
    let black16 = if bl.is_empty() {
        0.0
    } else {
        bl.iter().map(|r| if r.d == 0 { 0.0 } else { r.n as f64 / r.d as f64 }).sum::<f64>() / bl.len() as f64
    };
    let black_y = black16 / g_gain;
    let white_y = match raw.whitelevel.0.first() {
        Some(w) => *w as f64 / g_gain,
        None => return Ok(None),
    };
    if !(white_y > black_y) {
        log::warn!("sRAW: white {white_y} <= black {black_y}; using generic raw path");
        return Ok(None);
    }

    let data = match &raw.data {
        RawImageData::Integer(v) => v,
        _ => return Ok(None),
    };
    let (rw, rh) = (raw.width, raw.height);
    if data.len() != rw * rh * 3 {
        log::warn!("sRAW: unexpected buffer size {} for {}x{}x3; using generic raw path", data.len(), rw, rh);
        return Ok(None);
    }

    let (x0, y0, w, h) = match raw.crop_area {
        Some(r) if r.d.w > 0 && r.d.h > 0 && r.p.x + r.d.w <= rw && r.p.y + r.d.h <= rh => (r.p.x, r.p.y, r.d.w, r.d.h),
        _ => (0, 0, rw, rh),
    };

    let scale = [256.0 / c[0] as f64, 256.0 / c[1] as f64, 256.0 / c[2] as f64];
    let inv_range = 1.0 / (white_y - black_y);
    let mut out = vec![0u16; w * h * 3];
    out.par_chunks_exact_mut(w * 3).enumerate().for_each(|(y, row)| {
        let s = (y0 + y) * rw * 3 + x0 * 3;
        let srow = &data[s..s + w * 3];
        for (i, (o, v)) in row.iter_mut().zip(srow).enumerate() {
            let p = *v as f64 * scale[i % 3];
            let lin = ((p - black_y) * inv_range).clamp(0.0, 1.0);
            *o = (lin * 65535.0 + 0.5) as u16;
        }
    });

    log::info!(
        "sRAW {} {}: coef={:?} invert={} gains={:?} black_y={:.1} white_y={:.1} {}x{}",
        raw.clean_make, raw.clean_model, coef, invert, c, black_y, white_y, w, h
    );

    let (data, w, h) = orient_rgb(&out, w, h, orientation);
    Ok(Some(SourceImage {
        width: w,
        height: h,
        data,
        color: SourceColor { is_raw: true, xyz_to_cam: XYZ_TO_SRGB, as_shot_mul: [1.0, 1.0, 1.0], space: "srgb".into() },
    }))
}

#[inline]
fn to_u16(v: f32) -> u16 {
    (v.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16
}

fn f32_rgb_to_u16(it: impl Iterator<Item = f32>) -> Vec<u16> {
    it.map(to_u16).collect()
}

/// Apply an EXIF orientation (1..8) to an interleaved RGB buffer.
pub fn orient_rgb<T: Copy + Default>(src: &[T], w: usize, h: usize, orientation: u16) -> (Vec<T>, usize, usize) {
    if orientation <= 1 || orientation > 8 {
        return (src.to_vec(), w, h);
    }
    let (ow, oh) = if orientation >= 5 { (h, w) } else { (w, h) };
    let mut out = vec![T::default(); ow * oh * 3];
    for y in 0..oh {
        for x in 0..ow {
            let (sx, sy) = match orientation {
                2 => (w - 1 - x, y),
                3 => (w - 1 - x, h - 1 - y),
                4 => (x, h - 1 - y),
                5 => (y, x),
                6 => (y, h - 1 - x),
                7 => (w - 1 - y, h - 1 - x),
                8 => (w - 1 - y, x),
                _ => (x, y),
            };
            let si = (sy * w + sx) * 3;
            let di = (y * ow + x) * 3;
            out[di..di + 3].copy_from_slice(&src[si..si + 3]);
        }
    }
    (out, ow, oh)
}

// ---------------------------------------------------------------------------
// Raster (JPEG, PNG, TIFF, WebP, and HEIC via sips)
// ---------------------------------------------------------------------------

fn srgb_lut() -> &'static [u16] {
    static LUT: OnceLock<Vec<u16>> = OnceLock::new();
    LUT.get_or_init(|| {
        (0..65536u32)
            .map(|i| {
                let x = i as f64 / 65535.0;
                let l = if x <= 0.04045 { x / 12.92 } else { ((x + 0.055) / 1.055).powf(2.4) };
                (l * 65535.0 + 0.5) as u16
            })
            .collect()
    })
}

/// Guess the color space of an embedded ICC profile from its description.
pub fn icc_space(icc: Option<&[u8]>) -> &'static str {
    let Some(icc) = icc else { return "srgb" };
    let text: String = icc.iter().filter(|b| b.is_ascii_graphic() || **b == b' ').map(|b| *b as char).collect();
    let utf16: String = icc.chunks_exact(2).filter_map(|c| if c[0] == 0 && c[1].is_ascii_graphic() { Some(c[1] as char) } else { None }).collect();
    if text.contains("P3") || utf16.contains("P3") {
        "p3"
    } else {
        "srgb"
    }
}

pub fn read_raster(path: &Path) -> AppResult<(DynamicImage, Option<Vec<u8>>)> {
    let reader = image::ImageReader::open(path)?.with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let icc = decoder.icc_profile().ok().flatten();
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok((img, icc))
}

pub fn decode_raster(path: &Path) -> AppResult<SourceImage> {
    let (img, icc) = read_raster(path)?;
    let space = icc_space(icc.as_deref());
    let rgb = img.into_rgb16();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let lut = srgb_lut();
    let data: Vec<u16> = rgb.into_raw().into_iter().map(|v| lut[v as usize]).collect();
    let xyz_to_cam = if space == "p3" { XYZ_TO_P3 } else { XYZ_TO_SRGB };
    Ok(SourceImage {
        width: w,
        height: h,
        data,
        color: SourceColor { is_raw: false, xyz_to_cam, as_shot_mul: [1.0, 1.0, 1.0], space: space.into() },
    })
}

/// Convert an image macOS can read (HEIC etc.) to PNG with `sips`.
pub fn sips_convert(path: &Path, max_size: Option<u32>) -> AppResult<PathBuf> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let out = std::env::temp_dir().join(format!("darkroom-{}-{}.png", std::process::id(), n));
    let mut cmd = Command::new("/usr/bin/sips");
    cmd.arg("-s").arg("format").arg("png");
    if let Some(m) = max_size {
        cmd.arg("-Z").arg(m.to_string());
    }
    let status = cmd.arg(path).arg("--out").arg(&out).output()?;
    if !status.status.success() || !out.exists() {
        return Err(AppError::Other(format!(
            "sips failed: {}",
            String::from_utf8_lossy(&status.stderr).trim()
        )));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Resampling helpers
// ---------------------------------------------------------------------------

fn u16_as_bytes(v: &[u16]) -> &[u8] {
    // SAFETY: u16 has no padding and u8 has alignment 1.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}

/// Resize (and optionally crop) an interleaved u16 RGB buffer.
pub fn resize_u16_rgb(
    src: &[u16],
    w: usize,
    h: usize,
    crop: Option<(f64, f64, f64, f64)>,
    ow: usize,
    oh: usize,
) -> AppResult<Vec<u16>> {
    let src_img = fr::images::ImageRef::new(w as u32, h as u32, u16_as_bytes(src), fr::PixelType::U16x3)
        .map_err(|e| AppError::Other(e.to_string()))?;
    let mut dst = fr::images::Image::new(ow as u32, oh as u32, fr::PixelType::U16x3);
    let mut opts = fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::CatmullRom));
    if let Some((x, y, cw, ch)) = crop {
        opts = opts.crop(x, y, cw, ch);
    }
    fr::Resizer::new().resize(&src_img, &mut dst, &opts).map_err(|e| AppError::Other(e.to_string()))?;
    let bytes = dst.into_vec();
    Ok(bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect())
}

pub fn resize_rgb8(img: &image::RgbImage, ow: u32, oh: u32) -> AppResult<image::RgbImage> {
    let src = fr::images::ImageRef::new(img.width(), img.height(), img.as_raw(), fr::PixelType::U8x3)
        .map_err(|e| AppError::Other(e.to_string()))?;
    let mut dst = fr::images::Image::new(ow, oh, fr::PixelType::U8x3);
    fr::Resizer::new()
        .resize(&src, &mut dst, &fr::ResizeOptions::new().resize_alg(fr::ResizeAlg::Convolution(fr::FilterType::Lanczos3)))
        .map_err(|e| AppError::Other(e.to_string()))?;
    image::RgbImage::from_raw(ow, oh, dst.into_vec()).ok_or_else(|| AppError::Other("resize".into()))
}

pub fn fit_dims(w: usize, h: usize, max: usize) -> (usize, usize) {
    if w.max(h) <= max {
        return (w, h);
    }
    if w >= h {
        (max, ((h as f64 * max as f64 / w as f64).round() as usize).max(1))
    } else {
        (((w as f64 * max as f64 / h as f64).round() as usize).max(1), max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orientation_6_rotates_clockwise() {
        // 2x1 image: [A, B] -> rotated CW becomes 1x2: [A; B]
        let src: Vec<u16> = vec![1, 1, 1, 2, 2, 2];
        let (out, w, h) = orient_rgb(&src, 2, 1, 6);
        assert_eq!((w, h), (1, 2));
        assert_eq!(out, vec![1, 1, 1, 2, 2, 2]);
        // 2x2: [A B; C D] -> CW: [C A; D B]
        let src: Vec<u16> = [1, 2, 3, 4].iter().flat_map(|v| [*v, *v, *v]).collect();
        let (out, _, _) = orient_rgb(&src, 2, 2, 6);
        let firsts: Vec<u16> = out.chunks(3).map(|c| c[0]).collect();
        assert_eq!(firsts, vec![3, 1, 4, 2]);
        let (out, _, _) = orient_rgb(&src, 2, 2, 8);
        let firsts: Vec<u16> = out.chunks(3).map(|c| c[0]).collect();
        assert_eq!(firsts, vec![2, 4, 1, 3]);
    }

    #[test]
    fn srgb_lut_endpoints() {
        let l = srgb_lut();
        assert_eq!(l[0], 0);
        assert_eq!(l[65535], 65535);
        // mid grey 0.5 encoded -> ~0.214 linear
        let mid = l[32768] as f64 / 65535.0;
        assert!((mid - 0.214).abs() < 0.002);
    }

    #[test]
    fn resize_keeps_flat_color() {
        let src = vec![1000u16; 64 * 32 * 3];
        let out = resize_u16_rgb(&src, 64, 32, None, 16, 8).unwrap();
        assert_eq!(out.len(), 16 * 8 * 3);
        assert!(out.iter().all(|v| (*v as i32 - 1000).abs() <= 1));
    }

    #[test]
    fn decodes_png_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.png");
        let mut img = image::RgbImage::new(4, 2);
        img.put_pixel(0, 0, image::Rgb([255, 128, 0]));
        img.save(&p).unwrap();
        let s = decode_raster(&p).unwrap();
        assert_eq!((s.width, s.height), (4, 2));
        assert_eq!(s.data[0], 65535);
        assert!((s.data[1] as f64 / 65535.0 - 0.2158).abs() < 0.002);
        assert_eq!(s.color.space, "srgb");
        assert_eq!(format_for_path(&p), Some("png"));
        assert_eq!(format_for_path(Path::new("x.CR2")), Some("raw"));
        assert_eq!(format_for_path(Path::new("x.NEF")), Some("raw"));
        assert_eq!(format_for_path(Path::new("x.txt")), None);
    }
}
