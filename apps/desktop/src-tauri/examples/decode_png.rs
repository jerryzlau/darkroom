//! Decode an image through Darkroom's decoder and write a quick-look PNG.
//!
//!   cargo run --release --example decode_png -- <input> <output.png> [format]
//!
//! format defaults to "raw". The PNG is downsampled 8x (nearest) and gets an
//! approximation of the engine's default look: as-shot WB, camera matrix, x 2^0.5, sRGB gamma.
//! Prints per-channel means of the decoded linear data and the decode time.

use std::path::Path;
use std::time::Instant;

fn inv3(m: &[f64; 9]) -> [f64; 9] {
    let det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    let d = 1.0 / det;
    [
        (m[4] * m[8] - m[5] * m[7]) * d,
        (m[2] * m[7] - m[1] * m[8]) * d,
        (m[1] * m[5] - m[2] * m[4]) * d,
        (m[5] * m[6] - m[3] * m[8]) * d,
        (m[0] * m[8] - m[2] * m[6]) * d,
        (m[2] * m[3] - m[0] * m[5]) * d,
        (m[3] * m[7] - m[4] * m[6]) * d,
        (m[1] * m[6] - m[0] * m[7]) * d,
        (m[0] * m[4] - m[1] * m[3]) * d,
    ]
}

fn srgb(v: f32) -> f32 {
    if v <= 0.0031308 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        anyhow::bail!("usage: decode_png <input> <output.png> [format]");
    }
    let format = args.get(2).map(String::as_str).unwrap_or("raw");
    let t = Instant::now();
    let img = darkroom_lib::decode::decode_file(Path::new(&args[0]), format).map_err(|e| anyhow::anyhow!("{e:?}"))?;
    let dt = t.elapsed();
    let (w, h) = (img.width, img.height);
    let mut sum = [0f64; 3];
    for px in img.data.chunks_exact(3) {
        for c in 0..3 {
            sum[c] += px[c] as f64 / 65535.0;
        }
    }
    let n = (w * h) as f64;
    println!(
        "{}x{} space={} as_shot_mul={:?} decode={:.2}s means(lin)=[{:.4}, {:.4}, {:.4}]",
        w, h, img.color.space, img.color.as_shot_mul, dt.as_secs_f64(), sum[0] / n, sum[1] / n, sum[2] / n
    );

    let mut g: Vec<u16> = img.data.iter().skip(1).step_by(3).copied().collect();
    g.sort_unstable();
    let pct = |q: f64| g[((g.len() - 1) as f64 * q) as usize] as f64 / 65535.0;
    println!(
        "G percentiles: p1={:.4} p50={:.4} p99={:.4} p99.9={:.4} max={:.4} zeros={:.1}%",
        pct(0.01), pct(0.5), pct(0.99), pct(0.999), pct(1.0),
        g.iter().take_while(|v| **v == 0).count() as f64 * 100.0 / g.len() as f64
    );

    // Emulate the engine: as-shot multipliers, then the white-preserving camera
    // matrix (rows of xyz_to_cam * sRGB->XYZ normalised, inverted), like core's camToPro.
    let srgb_to_xyz = [0.4124564f64, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];
    let m = img.color.xyz_to_cam.map(|v| v as f64);
    let mut cam_rgb = [0f64; 9];
    for r in 0..3 {
        for c in 0..3 {
            cam_rgb[r * 3 + c] = (0..3).map(|k| m[r * 3 + k] * srgb_to_xyz[k * 3 + c]).sum();
        }
        let s: f64 = cam_rgb[r * 3..r * 3 + 3].iter().sum();
        for c in 0..3 {
            cam_rgb[r * 3 + c] /= s;
        }
    }
    let rgb_cam = inv3(&cam_rgb);
    let mul = img.color.as_shot_mul.map(|v| v as f64);
    let is_cam = img.color.space == "camera";

    let step = 8;
    let (ow, oh) = (w / step, h / step);
    let gain = 2f64.powf(0.5);
    let mut out = image::RgbImage::new(ow as u32, oh as u32);
    for y in 0..oh {
        for x in 0..ow {
            let i = ((y * step) * w + x * step) * 3;
            let mut v = [0f64; 3];
            for c in 0..3 {
                v[c] = img.data[i + c] as f64 / 65535.0 * if is_cam { mul[c] } else { 1.0 };
            }
            let lin = if is_cam {
                [
                    rgb_cam[0] * v[0] + rgb_cam[1] * v[1] + rgb_cam[2] * v[2],
                    rgb_cam[3] * v[0] + rgb_cam[4] * v[1] + rgb_cam[5] * v[2],
                    rgb_cam[6] * v[0] + rgb_cam[7] * v[1] + rgb_cam[8] * v[2],
                ]
            } else {
                v
            };
            let mut p = [0u8; 3];
            for c in 0..3 {
                p[c] = (srgb((lin[c] * gain).clamp(0.0, 1.0) as f32) * 255.0 + 0.5) as u8;
            }
            out.put_pixel(x as u32, y as u32, image::Rgb(p));
        }
    }
    out.save(&args[1])?;
    println!("wrote {}", args[1]);
    Ok(())
}
