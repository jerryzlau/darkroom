//! Synthetic sample images for tests and demos: a scene with sky, sun,
//! foliage, a ColorChecker-style chart and a deep-shadow area, written as
//! DNG raw files (daylight and tungsten, one rotated), a JPEG with an EXIF
//! orientation tag, a 16-bit PNG, and a HEIC (via sips).

use crate::error::{AppError, AppResult};
use std::path::{Path, PathBuf};

pub const CHART: [[u8; 3]; 24] = [
    [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
    [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
    [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
    [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
];

/// Canon-like XYZ(D65) -> camera matrix.
pub const XYZ_TO_CAM: [f64; 9] = [0.6446, -0.0366, -0.0864, -0.4436, 1.2204, 0.2513, -0.0952, 0.2496, 0.6348];
const SRGB_TO_XYZ: [f64; 9] = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];

fn lin(v: u8) -> f64 {
    let x = v as f64 / 255.0;
    if x <= 0.04045 { x / 12.92 } else { ((x + 0.055) / 1.055).powf(2.4) }
}

fn enc(x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    if x <= 0.0031308 { 12.92 * x } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 }
}

fn mv(m: &[f64; 9], v: [f64; 3]) -> [f64; 3] {
    [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ]
}

fn hash(x: u32, y: u32) -> f64 {
    let mut h = x.wrapping_mul(374761393).wrapping_add(y.wrapping_mul(668265263));
    h = (h ^ (h >> 13)).wrapping_mul(1274126177);
    ((h ^ (h >> 16)) & 0xffff) as f64 / 65535.0
}

/// Chart patch geometry, shared with tests: (x0, y0, size) in pixels.
pub fn chart_layout(w: usize, h: usize) -> (usize, usize, usize) {
    let size = w / 24;
    (w / 20, h * 58 / 100, size)
}

/// Linear sRGB scene radiance (1.0 = diffuse white) at pixel (x, y).
pub fn scene(x: usize, y: usize, w: usize, h: usize) -> [f64; 3] {
    let fx = x as f64 / w as f64;
    let fy = y as f64 / h as f64;
    let (cx, cy, s) = chart_layout(w, h);
    // chart: 6 x 4 patches with gaps
    if x >= cx && y >= cy && x < cx + 6 * s && y < cy + 4 * s {
        let col = (x - cx) / s;
        let row = (y - cy) / s;
        let inner = (x - cx) % s > s / 10 && (y - cy) % s > s / 10;
        if inner {
            let c = CHART[row * 6 + col];
            return [lin(c[0]), lin(c[1]), lin(c[2])];
        }
        return [0.02, 0.02, 0.02];
    }
    // sun
    let sx = 0.78 * w as f64;
    let sy = 0.16 * h as f64;
    let d = ((x as f64 - sx).powi(2) + (y as f64 - sy).powi(2)).sqrt() / h as f64;
    let horizon = 0.42 + 0.05 * (fx * 7.0).sin() + 0.02 * (fx * 23.0).sin();
    if fy < horizon {
        let t = fy / horizon;
        let sky = [0.05 + 0.4 * t, 0.12 + 0.43 * t, 0.38 + 0.32 * t];
        let glow = 0.6 * (-d * 9.0).exp();
        let sun = if d < 0.03 { 12.0 } else { 0.0 };
        return [sky[0] + glow + sun, sky[1] + glow * 0.85 + sun, sky[2] + glow * 0.6 + sun];
    }
    // deep shadow area with detail (bottom right)
    if fx > 0.62 && fy > 0.6 {
        let stripes = if ((x / 12) + (y / 40)) % 2 == 0 { 1.0 } else { 0.55 };
        let ramp = ((fx - 0.62) / 0.38).clamp(0.0, 1.0);
        let v = 0.004 + 0.02 * ramp * stripes;
        return [v * 1.05, v, v * 0.9];
    }
    // foliage with texture
    let n = hash(x as u32 / 3, y as u32 / 3) * 0.6 + hash(x as u32 / 17, y as u32 / 11) * 0.4;
    let g = 0.04 + 0.1 * n;
    [g * 0.55, g, g * 0.3]
}

pub struct SampleSet {
    pub dir: PathBuf,
    pub dng_daylight: PathBuf,
    pub dng_tungsten: PathBuf,
    pub jpeg: PathBuf,
    pub jpeg_rotated: PathBuf,
    pub png16: PathBuf,
    pub heic: Option<PathBuf>,
}

fn mm(a: &[f64; 9], b: &[f64; 9]) -> [f64; 9] {
    let mut r = [0.0; 9];
    for i in 0..3 {
        for j in 0..3 {
            r[i * 3 + j] = (0..3).map(|k| a[i * 3 + k] * b[k * 3 + j]).sum();
        }
    }
    r
}

/// Bradford chromatic adaptation from white `src` to white `dst` (XYZ).
fn bradford(src: [f64; 3], dst: [f64; 3]) -> [f64; 9] {
    const M: [f64; 9] = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
    const MI: [f64; 9] = [0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428, 0.9684867];
    let s = mv(&M, src);
    let d = mv(&M, dst);
    let scale = [d[0] / s[0], 0.0, 0.0, 0.0, d[1] / s[1], 0.0, 0.0, 0.0, d[2] / s[2]];
    mm(&MI, &mm(&scale, &M))
}

/// Illuminant white points in XYZ for the synthetic lighting.
fn white_xyz(kelvin: f64) -> [f64; 3] {
    // Kim et al. Planckian locus approximation
    let t = kelvin;
    let x = if t <= 4000.0 {
        -0.2661239e9 / t.powi(3) - 0.2343589e6 / t.powi(2) + 0.8776956e3 / t + 0.179910
    } else {
        -3.0258469e9 / t.powi(3) + 2.1070379e6 / t.powi(2) + 0.2226347e3 / t + 0.240390
    };
    let y = if t <= 2222.0 {
        -1.1063814 * x.powi(3) - 1.34811020 * x.powi(2) + 2.18555832 * x - 0.20219683
    } else if t <= 4000.0 {
        -0.9549476 * x.powi(3) - 1.37418593 * x.powi(2) + 2.09137015 * x - 0.16748867
    } else {
        3.0817580 * x.powi(3) - 5.87338670 * x.powi(2) + 3.75112997 * x - 0.37001483
    };
    [x / y, 1.0, (1.0 - x - y) / y]
}

/// Write a synthetic Bayer (RGGB) DNG. `kelvin` is the scene illuminant.
pub fn write_dng(path: &Path, w: usize, h: usize, kelvin: Option<f64>, rotate_cw: bool) -> AppResult<()> {
    use tiff::encoder::{colortype, Rational, SRational, TiffEncoder};
    use tiff::tags::Tag;
    let black = 512.0;
    let white = 15000.0;
    // Illuminant: adapt the D65 scene to the target white with Bradford.
    let d65 = [0.95047, 1.0, 1.08883];
    let illum = kelvin.map(white_xyz).unwrap_or(d65);
    let adapt = bradford(d65, illum);
    let cam_white = mv(&XYZ_TO_CAM, illum);
    let k = 0.38 / cam_white.iter().cloned().fold(0.0, f64::max); // diffuse white at 38% of range
    // stored dims (rotated CCW if the file carries orientation 6)
    let (sw, sh) = if rotate_cw { (h, w) } else { (w, h) };
    let mut data = vec![0u16; sw * sh];
    for sy in 0..sh {
        for sx in 0..sw {
            // map stored pixel to upright scene pixel
            let (ux, uy) = if rotate_cw { (sh - 1 - sy, sx) } else { (sx, sy) };
            let rgb = scene(ux, uy, w, h);
            let xyz = mv(&adapt, mv(&SRGB_TO_XYZ, rgb));
            let cam = mv(&XYZ_TO_CAM, xyz);
            let ch = (sy % 2) * 2 + (sx % 2); // RGGB: 0=R,1=G,2=G,3=B
            let ci = [0, 1, 1, 2][ch];
            let v = (cam[ci] * k).max(0.0);
            let noise = (hash(sx as u32, sy as u32 * 7 + 3) - 0.5) * (0.0004 + 0.004 * v.sqrt());
            let raw = (black + (v + noise).max(0.0) * (white - black)).min(white);
            data[sy * sw + sx] = raw as u16;
        }
    }
    let neutral = {
        let n = mv(&XYZ_TO_CAM, illum);
        [n[0] / n[1], 1.0, n[2] / n[1]]
    };
    let r = |v: f64| Rational { n: (v * 1_000_000.0).round() as u32, d: 1_000_000 };
    let sr = |v: f64| SRational { n: (v * 10000.0).round() as i32, d: 10000 };
    let terr = |e: tiff::TiffError| AppError::Other(e.to_string());
    let file = std::io::BufWriter::new(std::fs::File::create(path)?);
    let mut enc = TiffEncoder::new(file).map_err(terr)?;
    let mut img = enc.new_image::<colortype::Gray16>(sw as u32, sh as u32).map_err(terr)?;
    {
        let e = img.encoder();
        e.write_tag(Tag::Unknown(254), 0u32).map_err(terr)?;
        e.write_tag(Tag::PhotometricInterpretation, 32803u16).map_err(terr)?;
        e.write_tag(Tag::Make, "Darkroom").map_err(terr)?;
        e.write_tag(Tag::Model, "Synthetic").map_err(terr)?;
        e.write_tag(Tag::Orientation, if rotate_cw { 6u16 } else { 1u16 }).map_err(terr)?;
        e.write_tag(Tag::Unknown(306), "2024:06:01 18:30:00").map_err(terr)?;
        e.write_tag(Tag::Unknown(33421), &[2u16, 2][..]).map_err(terr)?;
        e.write_tag(Tag::Unknown(33422), &[0u8, 1, 1, 2][..]).map_err(terr)?;
        e.write_tag(Tag::Unknown(50706), &[1u8, 4, 0, 0][..]).map_err(terr)?;
        e.write_tag(Tag::Unknown(50707), &[1u8, 1, 0, 0][..]).map_err(terr)?;
        e.write_tag(Tag::Unknown(50708), "Darkroom Synthetic").map_err(terr)?;
        e.write_tag(Tag::Unknown(50714), black as u32).map_err(terr)?;
        e.write_tag(Tag::Unknown(50717), white as u32).map_err(terr)?;
        let cm: Vec<SRational> = XYZ_TO_CAM.iter().map(|v| sr(*v)).collect();
        e.write_tag(Tag::Unknown(50721), &cm[..]).map_err(terr)?;
        e.write_tag(Tag::Unknown(50778), 21u16).map_err(terr)?;
        let asn: Vec<Rational> = neutral.iter().map(|v| r(*v)).collect();
        e.write_tag(Tag::Unknown(50728), &asn[..]).map_err(terr)?;
    }
    img.write_data(&data).map_err(terr)?;
    Ok(())
}

/// Render the scene as a display-referred sRGB image (simple tone mapping).
pub fn render_srgb(w: usize, h: usize) -> image::RgbImage {
    image::RgbImage::from_fn(w as u32, h as u32, |x, y| {
        let c = scene(x as usize, y as usize, w, h);
        let px = c.map(|v| {
            let t = v * 0.9 / (1.0 + v * 0.25);
            (enc(t) * 255.0 + 0.5) as u8
        });
        image::Rgb(px)
    })
}

fn write_jpeg_with_orientation(img: &image::RgbImage, path: &Path, orientation: u16) -> AppResult<()> {
    use img_parts::{Bytes, ImageEXIF};
    let mut buf = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 92).encode_image(img)?;
    let mut jpeg = img_parts::jpeg::Jpeg::from_bytes(Bytes::from(buf)).map_err(|e| AppError::Other(e.to_string()))?;
    let f1 = exif::Field { tag: exif::Tag::Orientation, ifd_num: exif::In::PRIMARY, value: exif::Value::Short(vec![orientation]) };
    let f2 = exif::Field { tag: exif::Tag::Make, ifd_num: exif::In::PRIMARY, value: exif::Value::Ascii(vec![b"Darkroom".to_vec()]) };
    let f3 = exif::Field {
        tag: exif::Tag::DateTimeOriginal,
        ifd_num: exif::In::PRIMARY,
        value: exif::Value::Ascii(vec![b"2024:06:02 09:15:00".to_vec()]),
    };
    let mut wr = exif::experimental::Writer::new();
    wr.push_field(&f1);
    wr.push_field(&f2);
    wr.push_field(&f3);
    let mut out = std::io::Cursor::new(Vec::new());
    wr.write(&mut out, false).map_err(|e| AppError::Other(e.to_string()))?;
    jpeg.set_exif(Some(Bytes::from(out.into_inner())));
    jpeg.encoder().write_to(std::fs::File::create(path)?)?;
    Ok(())
}

pub fn generate(dir: &Path, w: usize, h: usize) -> AppResult<SampleSet> {
    std::fs::create_dir_all(dir)?;
    let set = SampleSet {
        dir: dir.to_path_buf(),
        dng_daylight: dir.join("synthetic-daylight.dng"),
        dng_tungsten: dir.join("synthetic-tungsten-portrait.dng"),
        jpeg: dir.join("synthetic-scene.jpg"),
        jpeg_rotated: dir.join("synthetic-rotated.jpg"),
        png16: dir.join("synthetic-16bit.png"),
        heic: None,
    };
    write_dng(&set.dng_daylight, w, h, None, false)?;
    write_dng(&set.dng_tungsten, w, h, Some(3200.0), true)?;
    let srgb = render_srgb(w, h);
    srgb.save(&set.jpeg)?;
    // stored rotated 90° CCW, EXIF orientation 6 rotates it back upright
    let stored = image::imageops::rotate270(&srgb);
    write_jpeg_with_orientation(&stored, &set.jpeg_rotated, 6)?;
    let png16 = image::ImageBuffer::<image::Rgb<u16>, Vec<u16>>::from_fn(w as u32, h as u32, |x, y| {
        let p = srgb.get_pixel(x, y).0;
        image::Rgb(p.map(|v| v as u16 * 257))
    });
    png16.save(&set.png16)?;
    let heic = dir.join("synthetic-scene.heic");
    let ok = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "heic"])
        .arg(&set.jpeg)
        .arg("--out")
        .arg(&heic)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    Ok(SampleSet { heic: if ok && heic.exists() { Some(heic) } else { None }, ..set })
}
