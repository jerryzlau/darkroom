//! Write a 1:1 crop of a decoded raw (engine default look approximation) next to
//! the same crop from the camera's embedded JPEG, to compare noise/detail.
//!
//!   cargo run --release --example crop_compare -- <raw> <out dir> [cx cy] [w h]
//!
//! cx, cy are fractions (0..1) of the image, default 0.5 0.5; crop is w x h raw pixels (default 480x360).

use rawler::decoders::RawDecodeParams;
use rawler::rawsource::RawSource;
use std::path::Path;

fn inv3(m: &[f64; 9]) -> [f64; 9] {
    let det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    let d = 1.0 / det;
    [
        (m[4] * m[8] - m[5] * m[7]) * d, (m[2] * m[7] - m[1] * m[8]) * d, (m[1] * m[5] - m[2] * m[4]) * d,
        (m[5] * m[6] - m[3] * m[8]) * d, (m[0] * m[8] - m[2] * m[6]) * d, (m[2] * m[3] - m[0] * m[5]) * d,
        (m[3] * m[7] - m[4] * m[6]) * d, (m[1] * m[6] - m[0] * m[7]) * d, (m[0] * m[4] - m[1] * m[3]) * d,
    ]
}
fn srgb(v: f64) -> f64 { if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 } }

fn main() -> anyhow::Result<()> {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let path = Path::new(&a[0]);
    let out = Path::new(&a[1]);
    std::fs::create_dir_all(out)?;
    let cx: f64 = a.get(2).map(|v| v.parse().unwrap()).unwrap_or(0.5);
    let cy: f64 = a.get(3).map(|v| v.parse().unwrap()).unwrap_or(0.5);
    let cw: usize = a.get(4).map(|v| v.parse().unwrap()).unwrap_or(480);
    let ch: usize = a.get(5).map(|v| v.parse().unwrap()).unwrap_or(360);

    let src = RawSource::new(path)?;
    let dec = rawler::get_decoder(&src)?;
    let p = RawDecodeParams::default();
    let md = dec.raw_metadata(&src, &p)?;
    println!("{} {} ISO {:?} exposure {:?} f/{:?}", md.make, md.model, md.exif.iso_speed_ratings, md.exif.exposure_time, md.exif.fnumber);

    let img = darkroom_lib::decode::decode_file(path, "raw").map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let (w, h) = (img.width, img.height);
    let x0 = ((w as f64 * cx) as usize).saturating_sub(cw / 2).min(w - cw);
    let y0 = ((h as f64 * cy) as usize).saturating_sub(ch / 2).min(h - ch);
    println!("raw {}x{} crop at {},{} {}x{}", w, h, x0, y0, cw, ch);

    let srgb_to_xyz = [0.4124564f64, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];
    let m = img.color.xyz_to_cam.map(|v| v as f64);
    let mut cam_rgb = [0f64; 9];
    for r in 0..3 {
        for c in 0..3 { cam_rgb[r * 3 + c] = (0..3).map(|k| m[r * 3 + k] * srgb_to_xyz[k * 3 + c]).sum(); }
        let s: f64 = cam_rgb[r * 3..r * 3 + 3].iter().sum();
        for c in 0..3 { cam_rgb[r * 3 + c] /= s; }
    }
    let rgb_cam = inv3(&cam_rgb);
    let mul = img.color.as_shot_mul.map(|v| v as f64);
    let is_cam = img.color.space == "camera";
    let gain = 2f64.powf(0.5);
    let mut rc = image::RgbImage::new(cw as u32, ch as u32);
    let mut lum = Vec::with_capacity(cw * ch);
    for y in 0..ch {
        for x in 0..cw {
            let i = ((y0 + y) * w + x0 + x) * 3;
            let mut v = [0f64; 3];
            for c in 0..3 { v[c] = img.data[i + c] as f64 / 65535.0 * if is_cam { mul[c] } else { 1.0 }; }
            let lin = if is_cam {
                [rgb_cam[0] * v[0] + rgb_cam[1] * v[1] + rgb_cam[2] * v[2],
                 rgb_cam[3] * v[0] + rgb_cam[4] * v[1] + rgb_cam[5] * v[2],
                 rgb_cam[6] * v[0] + rgb_cam[7] * v[1] + rgb_cam[8] * v[2]]
            } else { v };
            lum.push(0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]);
            let mut px = [0u8; 3];
            for c in 0..3 { px[c] = (srgb((lin[c] * gain).clamp(0.0, 1.0)) * 255.0 + 0.5) as u8; }
            rc.put_pixel(x as u32, y as u32, image::Rgb(px));
        }
    }
    rc.save(out.join("raw_crop.png"))?;
    // noise estimate: mean abs difference between horizontal neighbours in linear luma, relative to mean
    let mean = lum.iter().sum::<f64>() / lum.len() as f64;
    let mut d = 0.0;
    let mut n = 0;
    for y in 0..ch { for x in 1..cw { d += (lum[y * cw + x] - lum[y * cw + x - 1]).abs(); n += 1; } }
    println!("raw crop: mean lin luma {:.4}, neighbour diff / mean = {:.3}", mean, d / n as f64 / mean);

    let emb = dec.full_image(&src, &p).ok().flatten().or_else(|| dec.preview_image(&src, &p).ok().flatten());
    if let Some(full) = emb {
        let (fw, fh) = (full.width() as f64, full.height() as f64);
        let sx = fw / w as f64;
        let sy = fh / h as f64;
        println!("embedded jpeg {}x{} scale {:.3}", fw, fh, sx);
        let rgb = full.to_rgb8();
        let jx = (x0 as f64 * sx) as u32;
        let jy = (y0 as f64 * sy) as u32;
        let jw = (cw as f64 * sx) as u32;
        let jh = (ch as f64 * sy) as u32;
        let sub = image::imageops::crop_imm(&rgb, jx, jy, jw, jh).to_image();
        let small = image::imageops::resize(&sub, cw as u32, ch as u32, image::imageops::FilterType::CatmullRom);
        small.save(out.join("jpeg_crop.png"))?;
        let mut lj = Vec::with_capacity(cw * ch);
        for px in small.pixels() {
            let f = |v: u8| { let v = v as f64 / 255.0; if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) } };
            lj.push(0.2126 * f(px[0]) + 0.7152 * f(px[1]) + 0.0722 * f(px[2]));
        }
        let meanj = lj.iter().sum::<f64>() / lj.len() as f64;
        let mut d = 0.0; let mut n = 0;
        for y in 0..ch { for x in 1..cw { d += (lj[y * cw + x] - lj[y * cw + x - 1]).abs(); n += 1; } }
        println!("jpeg crop: mean lin luma {:.4}, neighbour diff / mean = {:.3}", meanj, d / n as f64 / meanj);
    }
    Ok(())
}
